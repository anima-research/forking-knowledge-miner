/**
 * LocalFilesModule — raw filesystem access for reading local files.
 *
 * Tools:
 *   local:read  — Read a file from the local filesystem
 *   local:list  — List directory contents
 *   local:glob  — Find files matching a glob pattern
 *
 * Unlike the agent-framework FilesModule (Chronicle-backed workspace),
 * this module provides direct read-only access to the real filesystem.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { glob as globFn } from 'node:fs/promises';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@connectome/agent-framework';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

interface ListInput {
  path?: string;
  recursive?: boolean;
}

interface GlobInput {
  pattern: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LocalFilesModule implements Module {
  readonly name = 'local';

  private ctx: ModuleContext | null = null;
  private basePath: string;

  constructor(opts?: { basePath?: string }) {
    this.basePath = opts?.basePath ?? process.cwd();
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // =========================================================================
  // Tools
  // =========================================================================

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description:
          'Read a file from the local filesystem. Returns the file content as text. ' +
          'Supports optional line offset and limit for large files.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (absolute, or relative to the working directory)',
            },
            offset: {
              type: 'number',
              description: 'Line number to start reading from (0-based). Omit to read from the beginning.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of lines to return. Omit to read the entire file.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'list',
        description: 'List contents of a directory on the local filesystem.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (absolute, or relative to the working directory). Defaults to working directory.',
            },
            recursive: {
              type: 'boolean',
              description: 'If true, list recursively. Default: false.',
            },
          },
        },
      },
      {
        name: 'glob',
        description: 'Find files matching a glob pattern on the local filesystem.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern (e.g. "**/*.md", "src/**/*.ts")',
            },
            cwd: {
              type: 'string',
              description: 'Directory to search in. Defaults to working directory.',
            },
          },
          required: ['pattern'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'read':
        return this.handleRead(call.input as ReadInput);
      case 'list':
        return this.handleList(call.input as ListInput);
      case 'glob':
        return this.handleGlob(call.input as GlobInput);
      default:
        return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
    }
  }

  // =========================================================================
  // Handlers
  // =========================================================================

  private resolvePath(p: string): string {
    if (p.startsWith('/')) return p;
    return resolve(this.basePath, p);
  }

  private async handleRead(input: ReadInput): Promise<ToolResult> {
    try {
      const fullPath = this.resolvePath(input.path);
      const content = await readFile(fullPath, 'utf-8');

      if (input.offset !== undefined || input.limit !== undefined) {
        const lines = content.split('\n');
        const start = input.offset ?? 0;
        const end = input.limit !== undefined ? start + input.limit : lines.length;
        const sliced = lines.slice(start, end);
        return {
          success: true,
          data: {
            path: fullPath,
            content: sliced.join('\n'),
            totalLines: lines.length,
            fromLine: start,
            toLine: Math.min(end, lines.length),
          },
        };
      }

      return {
        success: true,
        data: { path: fullPath, content },
      };
    } catch (err: any) {
      return { success: false, isError: true, error: `Failed to read ${input.path}: ${err.message}` };
    }
  }

  private async handleList(input: ListInput): Promise<ToolResult> {
    try {
      const dirPath = this.resolvePath(input.path ?? '.');

      if (input.recursive) {
        const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
        const items = entries.slice(0, 500).map(e => ({
          name: join(e.parentPath ? relative(dirPath, e.parentPath) : '', e.name),
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return {
          success: true,
          data: { path: dirPath, entries: items, truncated: entries.length > 500 },
        };
      }

      const entries = await readdir(dirPath, { withFileTypes: true });
      const items = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
      return {
        success: true,
        data: { path: dirPath, entries: items },
      };
    } catch (err: any) {
      return { success: false, isError: true, error: `Failed to list ${input.path ?? '.'}: ${err.message}` };
    }
  }

  private async handleGlob(input: GlobInput): Promise<ToolResult> {
    try {
      const cwd = this.resolvePath(input.cwd ?? '.');
      const matches: string[] = [];
      for await (const entry of globFn(input.pattern, { cwd })) {
        matches.push(entry);
        if (matches.length >= 500) break;
      }
      return {
        success: true,
        data: { pattern: input.pattern, cwd, matches, truncated: matches.length >= 500 },
      };
    } catch (err: any) {
      return { success: false, isError: true, error: `Glob failed: ${err.message}` };
    }
  }
}

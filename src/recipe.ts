/**
 * Recipe system — config-driven agent bootstrapping.
 *
 * A recipe defines everything domain-specific about an agent session:
 * system prompt, MCP servers, which modules to enable, and naming hints.
 *
 * Recipes can be loaded from:
 *   - HTTP(S) URLs
 *   - Local file paths
 *   - Saved state from a previous run (data/.recipe.json)
 *   - Built-in default (generic assistant)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipeStrategy {
  type: 'autobiographical' | 'passthrough';
  headWindowTokens?: number;
  recentWindowTokens?: number;
  compressionModel?: string;
  maxMessageTokens?: number;
}

export interface RecipeAgent {
  name?: string;
  model?: string;
  systemPrompt: string;
  maxTokens?: number;
  strategy?: RecipeStrategy;
}

export interface RecipeMcpServer {
  /** Command to spawn (stdio transport). Mutually exclusive with url. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** WebSocket URL (WebSocket transport). Mutually exclusive with command. */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth (appended as ?token= query param). */
  token?: string;
  toolPrefix?: string;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  reconnect?: boolean;
  reconnectIntervalMs?: number;
}

/**
 * Subset of MountConfig exposed to recipes.
 * Intentionally omits watchDebounceMs, followSymlinks, and maxFileSize —
 * these are implementation details best left to framework defaults.
 */
export interface RecipeWorkspaceMount {
  name: string;
  path: string;
  mode?: 'read-write' | 'read-only';
  watch?: 'always' | 'on-agent-action' | 'never';
  ignore?: string[];
}

export interface RecipeModules {
  subagents?: boolean | { defaultModel?: string };
  lessons?: boolean;
  retrieval?: boolean | { model?: string; maxInjected?: number };
  wake?: boolean;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[] };
}

export interface Recipe {
  name: string;
  description?: string;
  version?: string;
  agent: RecipeAgent;
  mcpServers?: Record<string, RecipeMcpServer>;
  modules?: RecipeModules;
  sessionNaming?: { examples?: string[] };
}

// ---------------------------------------------------------------------------
// Default recipe
// ---------------------------------------------------------------------------

export const DEFAULT_RECIPE: Recipe = {
  name: 'Agent',
  description: 'General-purpose assistant with tool access',
  agent: {
    name: 'agent',
    systemPrompt: [
      'You are a helpful assistant. You have access to tools provided by connected MCP servers.',
      'Use them to help the user with their tasks.',
      '',
      'You can fork subagents for parallel work, create persistent notes, and write files to `products/` as outputs of your work.',
    ].join('\n'),
  },
  modules: {
    subagents: true,
    lessons: true,
    retrieval: true,
    wake: true,
    workspace: true,
  },
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a recipe from a URL or local file path.
 * If the systemPrompt value is an HTTP(S) URL, fetches the text.
 */
export async function loadRecipe(source: string): Promise<Recipe> {
  let raw: unknown;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`);
    raw = await res.json();
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  }

  const recipe = validateRecipe(raw);
  return resolveSystemPrompt(recipe);
}

/**
 * If systemPrompt is an HTTP(S) URL, fetch its contents as plain text.
 * Only treated as a URL if it looks like a single URL (no spaces/newlines).
 */
async function resolveSystemPrompt(recipe: Recipe): Promise<Recipe> {
  const prompt = recipe.agent.systemPrompt;
  const isUrl = (prompt.startsWith('http://') || prompt.startsWith('https://'))
    && !prompt.includes(' ') && !prompt.includes('\n');
  if (isUrl) {
    const res = await fetch(prompt);
    if (!res.ok) throw new Error(`Failed to fetch system prompt from ${prompt}: ${res.status} ${res.statusText}`);
    return {
      ...recipe,
      agent: { ...recipe.agent, systemPrompt: await res.text() },
    };
  }
  return recipe;
}

/**
 * Validate raw JSON and fill defaults.
 */
export function validateRecipe(raw: unknown): Recipe {
  if (!raw || typeof raw !== 'object') throw new Error('Recipe must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Recipe must have a "name" string');
  }
  if (!obj.agent || typeof obj.agent !== 'object') {
    throw new Error('Recipe must have an "agent" object');
  }

  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.systemPrompt !== 'string' || !agent.systemPrompt) {
    throw new Error('Recipe agent must have a "systemPrompt" string');
  }

  // Validate strategy type if present
  if (agent.strategy) {
    const strategy = agent.strategy as Record<string, unknown>;
    if (strategy.type && strategy.type !== 'autobiographical' && strategy.type !== 'passthrough') {
      throw new Error(`Invalid strategy type "${strategy.type}". Must be "autobiographical" or "passthrough".`);
    }
  }

  // Validate mcpServers entries if present
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [id, entry] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`mcpServers.${id} must be an object`);
      }
      const server = entry as Record<string, unknown>;
      const hasCommand = typeof server.command === 'string' && server.command;
      const hasUrl = typeof server.url === 'string' && server.url;
      if (!hasCommand && !hasUrl) {
        throw new Error(`mcpServers.${id} must have a "command" string (stdio) or "url" string (websocket)`);
      }
      if (server.args !== undefined && !Array.isArray(server.args)) {
        throw new Error(`mcpServers.${id}.args must be an array`);
      }
    }
  }

  // Validate workspace mounts if present
  if (obj.modules && typeof obj.modules === 'object') {
    const mods = obj.modules as Record<string, unknown>;
    if (mods.workspace && typeof mods.workspace === 'object') {
      const ws = mods.workspace as Record<string, unknown>;
      if (!Array.isArray(ws.mounts) || ws.mounts.length === 0) {
        throw new Error('workspace.mounts must be a non-empty array');
      }
      for (let i = 0; i < ws.mounts.length; i++) {
        const m = ws.mounts[i] as Record<string, unknown>;
        if (!m || typeof m !== 'object') {
          throw new Error(`workspace.mounts[${i}] must be an object`);
        }
        if (typeof m.name !== 'string' || !m.name) {
          throw new Error(`workspace.mounts[${i}].name must be a non-empty string`);
        }
        if (typeof m.path !== 'string' || !m.path) {
          throw new Error(`workspace.mounts[${i}].path must be a non-empty string`);
        }
        if (m.mode !== undefined && m.mode !== 'read-write' && m.mode !== 'read-only') {
          throw new Error(`workspace.mounts[${i}].mode must be "read-write" or "read-only"`);
        }
      }
    }
  }

  return obj as unknown as Recipe;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function savedRecipePath(dataDir: string): string {
  return resolve(dataDir, '.recipe.json');
}

export function saveRecipe(dataDir: string, recipe: Recipe): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(savedRecipePath(dataDir), JSON.stringify(recipe, null, 2) + '\n', 'utf-8');
}

export function loadSavedRecipe(dataDir: string): Recipe | null {
  const path = savedRecipePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return validateRecipe(raw);
  } catch {
    return null;
  }
}

export function clearSavedRecipe(dataDir: string): void {
  const path = savedRecipePath(dataDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Parse argv to find a recipe source. Returns null if none provided.
 * Skips known flags (--no-tui, --no-recipe).
 */
export function parseRecipeArg(argv: string[]): { source: string | null; noRecipe: boolean } {
  const noRecipe = argv.includes('--no-recipe');
  let source: string | null = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    // First positional arg is the recipe source
    source = arg;
    break;
  }

  return { source, noRecipe };
}

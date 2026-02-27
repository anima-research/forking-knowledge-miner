/**
 * Zulip Knowledge Extraction App
 *
 * TUI-driven social knowledge extraction from Zulip.
 *
 * Usage:
 *   bun src/index.ts            # OpenTUI mode (requires TTY)
 *   bun src/index.ts --no-tui   # Readline mode (works in pipes/CI)
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required
 *   ZULIP_MCP_CMD       - Path to Zulip MCP server (default: node ../zulip-mcp/build/index.js)
 *   ZULIP_RC_PATH       - Path to .zuliprc file (for Zulip MCP)
 *   MODEL               - Model to use (default: claude-sonnet-4-5-20250929)
 *   STORE_PATH          - Chronicle store path (default: ./data/store)
 */

import { Membrane, AnthropicAdapter, NativeFormatter } from 'membrane';
import { AgentFramework, PassthroughStrategy } from '@connectome/agent-framework';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_PROMPT } from './prompts/system.js';
import { SubagentModule } from './modules/subagent-module.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';
import { TuiModule } from './modules/tui-module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const noTui = process.argv.includes('--no-tui') || !process.stdin.isTTY;

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL || 'claude-sonnet-4-5-20250929',
  storePath: process.env.STORE_PATH || './data/store',
  zulipMcpCmd: process.env.ZULIP_MCP_CMD || 'node',
  zulipMcpArgs: process.env.ZULIP_MCP_ARGS?.split(' ') || [resolve(__dirname, '../../zulip-mcp/build/index.js')],
  zuliprc: process.env.ZULIP_RC_PATH || resolve(process.cwd(), '.zuliprc'),
};

if (!config.apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in .env or environment.');
  process.exit(1);
}

async function createFramework(membrane: Membrane) {
  const zulipEnv: Record<string, string> = {
    ENABLE_ZULIP: 'true',
    ENABLE_DISCORD: 'false',
  };
  if (config.zuliprc) {
    zulipEnv.ZULIP_RC_PATH = config.zuliprc;
  }

  const subagentModule = new SubagentModule({
    parentAgentName: 'researcher',
    defaultModel: config.model,
  });
  const lessonsModule = new LessonsModule();
  const retrievalModule = new RetrievalModule({ membrane });

  const framework = await AgentFramework.create({
    storePath: config.storePath,
    membrane,
    agents: [
      {
        name: 'researcher',
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        strategy: new PassthroughStrategy(),
      },
    ],
    modules: [new TuiModule(), subagentModule, lessonsModule, retrievalModule],
    mcplServers: [
      {
        id: 'zulip',
        command: config.zulipMcpCmd,
        args: config.zulipMcpArgs,
        env: zulipEnv,
      },
    ],
  });

  subagentModule.setFramework(framework);
  return framework;
}

// ---------------------------------------------------------------------------
// Piped/headless mode (--no-tui or non-TTY stdin)
// ---------------------------------------------------------------------------

async function runPiped(framework: AgentFramework) {
  const { createInterface } = await import('node:readline');
  const { handleCommand } = await import('./commands.js');

  let inferenceResolve: (() => void) | null = null;

  framework.onTrace((event) => {
    const e = event as unknown as Record<string, unknown>;
    switch (event.type) {
      case 'inference:started':
        process.stdout.write('\n');
        break;
      case 'inference:tokens': {
        const content = e.content as string;
        if (content) process.stdout.write(content);
        break;
      }
      case 'inference:completed':
        process.stdout.write('\n');
        inferenceResolve?.();
        inferenceResolve = null;
        break;
      case 'inference:failed':
        console.error(`\nError: ${e.error}`);
        inferenceResolve?.();
        inferenceResolve = null;
        break;
      case 'inference:tool_calls_yielded': {
        const calls = e.calls as Array<{ name: string }>;
        console.log(`\n[tools] ${calls.map(c => c.name).join(', ')}`);
        break;
      }
      case 'tool:started': {
        const toolInput = e.input ? JSON.stringify(e.input) : '';
        const truncated = toolInput.length > 120 ? toolInput.slice(0, 120) + '...' : toolInput;
        console.log(`[tool] ${e.tool}${truncated ? ' ' + truncated : ''}`);
        break;
      }
    }
  });

  function waitForInference(): Promise<void> {
    return new Promise(resolve => {
      inferenceResolve = resolve;
      setTimeout(() => {
        if (inferenceResolve === resolve) { inferenceResolve = null; resolve(); }
      }, 120_000);
    });
  }

  async function processLine(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/')) {
      const result = handleCommand(trimmed, framework);
      if (result.quit) return true;
      for (const l of result.lines) console.log(l.text);
    } else {
      framework.pushEvent({
        type: 'external-message', source: 'cli',
        content: trimmed, metadata: {}, triggerInference: true,
      });
      await waitForInference();
    }
    return false;
  }

  // Piped: read all then process
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) lines.push(line);
    console.log(`Processing ${lines.length} commands...`);
    for (const line of lines) {
      console.log(`> ${line}`);
      if (await processLine(line)) break;
    }
    console.log('Done.');
    await framework.stop();
    return;
  }

  // Interactive TTY readline (fallback if --no-tui is explicit on a TTY)
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log('Zulip Knowledge App (readline mode). Type /help for commands.');
  rl.prompt();
  rl.on('line', async (line: string) => {
    if (await processLine(line)) { rl.close(); return; }
    rl.prompt();
  });
  await new Promise<void>(r => rl.on('close', r));
  console.log('\nShutting down...');
  await framework.stop();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const adapter = new AnthropicAdapter({ apiKey: config.apiKey! });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const framework = await createFramework(membrane);

  framework.start();

  if (noTui) {
    await runPiped(framework);
  } else {
    const { runTui } = await import('./tui.js');
    await runTui(framework);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

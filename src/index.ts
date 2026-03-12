/**
 * Forking Knowledge Miner
 *
 * TUI-driven knowledge extraction using forking LLM agents.
 *
 * Usage:
 *   bun src/index.ts            # OpenTUI mode (requires TTY)
 *   bun src/index.ts --no-tui   # Readline mode (works in pipes/CI)
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required
 *   ZULIP_MCP_CMD       - Path to Zulip MCP server (default: node ../zulip-mcp/build/index.js)
 *   ZULIP_RC_PATH       - Path to .zuliprc file (for Zulip MCP)
 *   MODEL               - Model to use (default: claude-opus-4-6)
 *   DATA_DIR            - Data directory for sessions (default: ./data)
 */

import { Membrane, AnthropicAdapter, NativeFormatter } from 'membrane';
import { AgentFramework, KnowledgeStrategy, FilesModule } from '@connectome/agent-framework';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { SYSTEM_PROMPT } from './prompts/system.js';
import { SubagentModule } from './modules/subagent-module.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';
import { WakeModule } from './modules/wake-module.js';
import { LocalFilesModule } from './modules/local-files-module.js';
import { TuiModule } from './modules/tui-module.js';
import { loadMcplServers, saveMcplServers, DEFAULT_CONFIG_PATH } from './mcpl-config.js';
import { SessionManager } from './session-manager.js';
import { generateSessionName } from './synesthete.js';

export type { AppContext };

const __dirname = dirname(fileURLToPath(import.meta.url));

const noTui = process.argv.includes('--no-tui') || !process.stdin.isTTY;

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL || 'claude-opus-4-6',
  dataDir: process.env.DATA_DIR || './data',
};

if (!config.apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in .env or environment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AppContext — mutable container for session switching
// ---------------------------------------------------------------------------

interface AppContext {
  framework: AgentFramework;
  membrane: Membrane;
  sessionManager: SessionManager;
  userMessageCount: number;

  /** Stop current framework, switch to a different session, start new framework. */
  switchSession(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Framework factory
// ---------------------------------------------------------------------------

/**
 * Seed mcpl-servers.json on first run using legacy env vars.
 */
function seedMcplConfig(): void {
  if (existsSync(DEFAULT_CONFIG_PATH)) return;

  const cmd = process.env.ZULIP_MCP_CMD || 'node';
  const args = process.env.ZULIP_MCP_ARGS?.split(' ')
    || [resolve(__dirname, '../../zulip_mcp/build/index.js')];
  const zuliprc = process.env.ZULIP_RC_PATH || resolve(process.cwd(), '.zuliprc');

  const env: Record<string, string> = {
    ENABLE_ZULIP: 'true',
    ENABLE_DISCORD: 'false',
  };
  if (zuliprc) env.ZULIP_RC_PATH = zuliprc;

  saveMcplServers(DEFAULT_CONFIG_PATH, {
    zulip: { command: cmd, args, env },
  });
}

async function createFramework(membrane: Membrane, storePath: string): Promise<AgentFramework> {
  seedMcplConfig();
  const mcplServers = loadMcplServers(DEFAULT_CONFIG_PATH);

  const subagentModule = new SubagentModule({
    parentAgentName: 'researcher',
    defaultModel: config.model,
    defaultMaxTokens: 4096,
  });
  const lessonsModule = new LessonsModule();
  const retrievalModule = new RetrievalModule({ membrane });
  const filesModule = new FilesModule({ namespace: 'products' });
  const localFilesModule = new LocalFilesModule();

  // WakeModule — onWake callback wired after framework creation
  let emitWakeTrace: ((subs: string[], summary: string) => void) | undefined;
  const wakeModule = new WakeModule({
    agentName: 'researcher',
    onWake: (subs, summary) => emitWakeTrace?.(subs, summary),
  });

  // Augment MCPL server configs with wake filtering
  const augmentedServers = mcplServers.map(server => ({
    ...server,
    shouldTriggerInference: wakeModule.shouldTrigger,
  }));

  const framework = await AgentFramework.create({
    storePath,
    membrane,
    agents: [
      {
        name: 'researcher',
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        maxTokens: 16384,
        strategy: new KnowledgeStrategy({
          headWindowTokens: 4000,
          recentWindowTokens: 30000,
          compressionModel: config.model,
          autoTickOnNewMessage: true,
          maxMessageTokens: 10000,
        }),
      },
    ],
    modules: [new TuiModule(), subagentModule, lessonsModule, retrievalModule, wakeModule, filesModule, localFilesModule],
    mcplServers: augmentedServers,
  });

  // Wire onWake → framework trace emission
  emitWakeTrace = (subs, summary) => {
    // Emit as a custom trace event via pushEvent (process:received trace)
    // TUI picks this up via the onTrace listener
    framework.pushEvent({
      type: 'external-message',
      source: 'wake:triggered',
      content: summary,
      metadata: { subscriptions: subs, eventSummary: summary },
      triggerInference: false,
    } as any);
  };

  subagentModule.setFramework(framework);
  wakeModule.setFramework(framework);
  filesModule.initStore(framework.getStore());
  return framework;
}

// ---------------------------------------------------------------------------
// Synesthete auto-naming hook
// ---------------------------------------------------------------------------

function setupSynesthete(app: AppContext): void {
  app.framework.onTrace((event) => {
    if (event.type !== 'message:added') return;
    const e = event as unknown as { source: string };
    if (e.source !== 'external-message') return;

    app.userMessageCount++;
    if (app.userMessageCount !== 3) return;

    const session = app.sessionManager.getActiveSession();
    if (!session || session.manuallyNamed) return;

    // Fire-and-forget: generate name in background
    const agent = app.framework.getAgent('researcher');
    const cm = agent?.getContextManager();
    if (!cm) return;

    const { messages } = cm.queryMessages({});
    const summary = messages
      .filter(m => m.content.some((b: { type: string }) => b.type === 'text'))
      .slice(0, 6)
      .map(m => {
        const text = m.content
          .filter((b: { type: string }): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join(' ');
        return `${m.participant}: ${text.slice(0, 200)}`;
      })
      .join('\n');

    generateSessionName(app.membrane, summary).then(name => {
      if (name) {
        app.sessionManager.renameSession(session.id, name, false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Piped/headless mode (--no-tui or non-TTY stdin)
// ---------------------------------------------------------------------------

async function runPiped(app: AppContext) {
  const { createInterface } = await import('node:readline');
  const { handleCommand } = await import('./commands.js');

  let inferenceResolve: (() => void) | null = null;

  app.framework.onTrace((event) => {
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
      const result = handleCommand(trimmed, app);
      if (result.quit) return true;
      for (const l of result.lines) console.log(l.text);
      if (result.switchToSessionId) {
        await app.switchSession(result.switchToSessionId);
        console.log('Session switched.');
      }
    } else {
      app.framework.pushEvent({
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
    await app.framework.stop();
    return;
  }

  // Interactive TTY readline (fallback if --no-tui is explicit on a TTY)
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log('Forking Knowledge Miner (readline mode). Type /help for commands.');
  rl.prompt();
  rl.on('line', async (line: string) => {
    if (await processLine(line)) { rl.close(); return; }
    rl.prompt();
  });
  await new Promise<void>(r => rl.on('close', r));
  console.log('\nShutting down...');
  await app.framework.stop();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const adapter = new AnthropicAdapter({ apiKey: config.apiKey! });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

  // Session management
  const sessionManager = new SessionManager(config.dataDir);
  sessionManager.migrateIfNeeded();

  let activeSession = sessionManager.getActiveSession();
  if (!activeSession) {
    activeSession = sessionManager.createSession();
  }

  const storePath = sessionManager.getStorePath(activeSession.id);
  const framework = await createFramework(membrane, storePath);

  // Build app context
  const app: AppContext = {
    framework,
    membrane,
    sessionManager,
    userMessageCount: 0,

    async switchSession(id: string) {
      await this.framework.stop();
      sessionManager.setActiveSession(id);
      const newStorePath = sessionManager.getStorePath(id);
      this.framework = await createFramework(membrane, newStorePath);
      this.framework.start();
      this.userMessageCount = 0;
      setupSynesthete(this);
    },
  };

  framework.start();
  setupSynesthete(app);

  if (noTui) {
    await runPiped(app);
  } else {
    const { runTui } = await import('./tui.js');
    await runTui(app);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

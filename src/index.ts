/**
 * connectome-host — General-purpose agent TUI host with recipe-based configuration.
 *
 * Usage:
 *   bun src/index.ts                           # Start with saved/default recipe
 *   bun src/index.ts <recipe-url-or-path>      # Load recipe from URL or file
 *   bun src/index.ts --no-recipe               # Start fresh with default recipe
 *   bun src/index.ts --no-tui                  # Readline mode (works in pipes/CI)
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required
 *   MODEL               - Override model (default: from recipe or claude-opus-4-6)
 *   DATA_DIR            - Data directory for sessions (default: ./data)
 */

import { Membrane, AnthropicAdapter, NativeFormatter } from 'membrane';
import { AgentFramework, AutobiographicalStrategy, PassthroughStrategy, WorkspaceModule, type Module, type MountConfig } from '@connectome/agent-framework';
import { resolve } from 'node:path';
import { SubagentModule } from './modules/subagent-module.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';
import { WakeModule } from './modules/wake-module.js';
import type { RecipeWorkspaceMount } from './recipe.js';
import { TuiModule } from './modules/tui-module.js';
import { loadMcplServers, DEFAULT_CONFIG_PATH } from './mcpl-config.js';
import { SessionManager } from './session-manager.js';
import { generateSessionName } from './synesthete.js';
import {
  type Recipe,
  DEFAULT_RECIPE,
  loadRecipe,
  saveRecipe,
  loadSavedRecipe,
  clearSavedRecipe,
  parseRecipeArg,
} from './recipe.js';
import { createBranchState, resetBranchState, type BranchState } from './commands.js';

export type { AppContext };

const noTui = process.argv.includes('--no-tui') || !process.stdin.isTTY;

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL,
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
  recipe: Recipe;
  branchState: BranchState;
  userMessageCount: number;

  /** Stop current framework, switch to a different session, start new framework. */
  switchSession(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Recipe resolution
// ---------------------------------------------------------------------------

async function resolveRecipe(): Promise<Recipe> {
  const { source, noRecipe } = parseRecipeArg(process.argv);

  if (noRecipe) {
    clearSavedRecipe(config.dataDir);
    console.log('Starting with default recipe.');
    return DEFAULT_RECIPE;
  }

  if (source) {
    try {
      const recipe = await loadRecipe(source);
      saveRecipe(config.dataDir, recipe);
      console.log(`Loaded recipe: ${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`);
      return recipe;
    } catch (err) {
      console.error(`Failed to load recipe from ${source}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // Try saved recipe
  const saved = loadSavedRecipe(config.dataDir);
  if (saved) {
    console.log(`Resuming recipe: ${saved.name}`);
    return saved;
  }

  return DEFAULT_RECIPE;
}

// ---------------------------------------------------------------------------
// Framework factory
// ---------------------------------------------------------------------------

async function createFramework(membrane: Membrane, storePath: string, recipe: Recipe): Promise<AgentFramework> {
  const agentName = recipe.agent.name || 'agent';
  const model = config.model || recipe.agent.model || 'claude-opus-4-6';
  const modules = recipe.modules ?? {};

  // -- Build module list --
  const moduleInstances: Module[] = [new TuiModule()];

  // Subagents
  let subagentModule: SubagentModule | null = null;
  if (modules.subagents !== false) {
    const subagentConfig = typeof modules.subagents === 'object' ? modules.subagents : {};
    subagentModule = new SubagentModule({
      parentAgentName: agentName,
      defaultModel: subagentConfig.defaultModel || model,
      defaultMaxTokens: 4096,
    });
    moduleInstances.push(subagentModule);
  }

  // Lessons
  let lessonsModule: LessonsModule | null = null;
  if (modules.lessons !== false) {
    lessonsModule = new LessonsModule();
    moduleInstances.push(lessonsModule);
  }

  // Retrieval (requires lessons)
  if (modules.retrieval !== false && lessonsModule) {
    const retrievalConfig = typeof modules.retrieval === 'object' ? modules.retrieval : {};
    moduleInstances.push(new RetrievalModule({
      membrane,
      retrievalModel: retrievalConfig.model,
      maxInjectedLessons: retrievalConfig.maxInjected,
    }));
  }

  // Wake
  let wakeModule: WakeModule | null = null;
  let emitWakeTrace: ((subs: string[], summary: string) => void) | undefined;
  if (modules.wake !== false) {
    wakeModule = new WakeModule({
      agentName,
      onWake: (subs, summary) => emitWakeTrace?.(subs, summary),
    });
    moduleInstances.push(wakeModule);
  }

  // Workspace (replaces FilesModule + LocalFilesModule)
  // Note: workspace: false disables ALL filesystem access (both read and write).
  // Previously LocalFilesModule was always-on; this is an intentional change —
  // recipes that need read-only access should keep workspace enabled (the default).
  let workspaceModule: WorkspaceModule | null = null;
  if (modules.workspace !== false) {
    let mounts: MountConfig[];
    if (typeof modules.workspace === 'object' && modules.workspace.mounts) {
      // Only pass fields the recipe explicitly provides; let WorkspaceModule default the rest.
      // We override watch to 'never' since FKM doesn't need chokidar filesystem watchers.
      mounts = modules.workspace.mounts.map((m: RecipeWorkspaceMount) => {
        const mount: MountConfig = {
          name: m.name,
          path: resolve(m.path),
          mode: m.mode ?? 'read-write',
          watch: m.watch ?? 'never', // FKM: no chokidar watchers by default
        };
        if (m.ignore) mount.ignore = m.ignore;
        return mount;
      });
    } else {
      // Default: read-only local mount + read-write products mount
      mounts = [
        { name: 'local', path: resolve('.'), mode: 'read-only', watch: 'never' },
        { name: 'products', path: resolve('./output'), mode: 'read-write', watch: 'never' },
      ];
    }
    workspaceModule = new WorkspaceModule({ mounts });
    moduleInstances.push(workspaceModule);
  }

  // -- Build MCP server list (recipe + file, file wins on conflict) --
  const recipeServers = recipe.mcpServers ?? {};
  const fileServers = loadMcplServers(DEFAULT_CONFIG_PATH);
  const fileServerIds = new Set(fileServers.map(s => s.id));

  // Convert recipe servers to LoadedServerConfig shape
  const recipeServerList = Object.entries(recipeServers)
    .filter(([id]) => !fileServerIds.has(id)) // file wins on conflict
    .map(([id, entry]) => ({ id, ...entry }));

  const allServers = [...recipeServerList, ...fileServers];

  // Augment with wake filtering if wake module is active
  const augmentedServers = allServers.map(server => ({
    ...server,
    ...(wakeModule ? { shouldTriggerInference: wakeModule.shouldTrigger } : {}),
  }));

  // -- Build strategy --
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';
  const strategy = strategyType === 'passthrough'
    ? new PassthroughStrategy()
    : new AutobiographicalStrategy({
        headWindowTokens: strategyConfig?.headWindowTokens ?? 4000,
        recentWindowTokens: strategyConfig?.recentWindowTokens ?? 30000,
        compressionModel: strategyConfig?.compressionModel ?? model,
        autoTickOnNewMessage: true,
        maxMessageTokens: strategyConfig?.maxMessageTokens ?? 10000,
      });

  // -- Create framework --
  const framework = await AgentFramework.create({
    storePath,
    membrane,
    agents: [
      {
        name: agentName,
        model,
        systemPrompt: recipe.agent.systemPrompt,
        maxTokens: recipe.agent.maxTokens ?? 16384,
        strategy,
      },
    ],
    modules: moduleInstances,
    mcplServers: augmentedServers,
  });

  // Wire post-creation hooks
  if (wakeModule) {
    emitWakeTrace = (subs, summary) => {
      framework.pushEvent({
        type: 'external-message',
        source: 'wake:triggered',
        content: summary,
        metadata: { subscriptions: subs, eventSummary: summary },
        triggerInference: false,
      } as any);
    };
    wakeModule.setFramework(framework);
  }

  if (subagentModule) {
    subagentModule.setFramework(framework);
  }

  if (workspaceModule) {
    workspaceModule.initStore(framework.getStore());
  }

  return framework;
}

// ---------------------------------------------------------------------------
// Synesthete auto-naming hook
// ---------------------------------------------------------------------------

function setupSynesthete(app: AppContext): void {
  const agentName = app.recipe.agent.name || 'agent';
  const namingExamples = app.recipe.sessionNaming?.examples;

  app.framework.onTrace((event) => {
    if (event.type !== 'message:added') return;
    const e = event as unknown as { source: string };
    if (e.source !== 'external-message') return;

    app.userMessageCount++;
    if (app.userMessageCount !== 3) return;

    const session = app.sessionManager.getActiveSession();
    if (!session || session.manuallyNamed) return;

    const agent = app.framework.getAgent(agentName);
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

    generateSessionName(app.membrane, summary, namingExamples).then(name => {
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
  console.log('connectome-host (readline mode). Type /help for commands.');
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
  const recipe = await resolveRecipe();

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
  const framework = await createFramework(membrane, storePath, recipe);

  // Build app context
  const app: AppContext = {
    framework,
    membrane,
    sessionManager,
    recipe,
    branchState: createBranchState(),
    userMessageCount: 0,

    async switchSession(id: string) {
      await this.framework.stop();
      sessionManager.setActiveSession(id);
      const newStorePath = sessionManager.getStorePath(id);
      this.framework = await createFramework(membrane, newStorePath, recipe);
      this.framework.start();
      this.userMessageCount = 0;
      resetBranchState(this.branchState);
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

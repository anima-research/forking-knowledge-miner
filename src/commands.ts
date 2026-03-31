/**
 * Slash command handler for Chronicle-backed reversibility.
 *
 * Commands:
 *   /undo          — Revert to state before last agent turn
 *   /redo          — Re-apply last undone action
 *   /checkpoint N  — Save current state as named checkpoint
 *   /restore N     — Branch from checkpoint, switch to it
 *   /branches      — List all Chronicle branches
 *   /checkout N    — Switch to named branch
 *   /history       — Show recent state transitions
 *   /lessons       — Show current lesson library
 *   /status        — Show agent/module status
 *   /clear         — Clear conversation display
 *   /mcp list|add|remove|env — Manage MCPL server config
 *   /budget [N]    — Show/set stream token budget (e.g. /budget 1m)
 *   /session       — Session management (list, new, switch, rename, delete)
 *   /recipe        — Show current recipe info
 *   /newtopic      — Reset head window (auto-summarize or with user context)
 *   /help          — List commands
 */

import type { AgentFramework } from '@connectome/agent-framework';
import type { ContextManager } from '@connectome/context-manager';
import type { Recipe } from './recipe.js';
import { readMcplServersFile, saveMcplServers, DEFAULT_CONFIG_PATH } from './mcpl-config.js';

/** Imported lazily to avoid circular deps — index.ts re-exports the type. */
interface AppContext {
  framework: AgentFramework;
  sessionManager: import('./session-manager.js').SessionManager;
  recipe: Recipe;
  branchState: BranchState;
  switchSession(id: string): Promise<void>;
}

export type Line = { text: string; style?: 'user' | 'agent' | 'tool' | 'system' };

// Undo/redo stacks: track (branchId, messageId) pairs for time-travel
export interface StatePoint {
  branchId: string;
  branchName: string;
  messageId?: string;
}

/**
 * Mutable branch-related state. Lives on AppContext so it can be
 * reset consistently on session switch, MCPL branch operations, etc.
 */
export interface BranchState {
  undoStack: StatePoint[];
  redoStack: StatePoint[];
  checkpoints: Map<string, StatePoint>;
}

export function createBranchState(): BranchState {
  return {
    undoStack: [],
    redoStack: [],
    checkpoints: new Map(),
  };
}

export function resetBranchState(bs: BranchState): void {
  bs.undoStack.length = 0;
  bs.redoStack.length = 0;
  bs.checkpoints.clear();
}

export interface CommandResult {
  lines: Line[];
  quit?: boolean;
  /** Session ID to switch to — caller performs the async switch. */
  switchToSessionId?: string;
  /** True when a Chronicle branch switch occurred — TUI should refreshFromStore(). */
  branchChanged?: boolean;
  /** Async follow-up work — TUI shows status while awaiting, then displays result lines. */
  asyncWork?: Promise<CommandResult>;
}

/**
 * Get the context manager for the main agent.
 * Falls back to the first registered agent if the named one isn't found.
 */
function getAgentCM(framework: AgentFramework, agentName?: string): ContextManager | null {
  if (agentName) {
    const agent = framework.getAgent(agentName);
    if (agent) return agent.getContextManager() ?? null;
  }
  // Fallback: first agent
  const all = framework.getAllAgents();
  return all[0]?.getContextManager() ?? null;
}

export function handleCommand(command: string, app: AppContext): CommandResult {
  const parts = command.slice(1).split(/\s+/);
  const cmd = parts[0]!;
  const args = parts.slice(1);
  const framework = app.framework;

  switch (cmd) {
    case 'quit':
    case 'q':
      return { lines: [], quit: true };

    case 'help':
      return {
        lines: [
          { text: '--- Commands ---', style: 'system' },
          { text: '  /quit, /q              Exit the app', style: 'system' },
          { text: '  /status                Show agent status', style: 'system' },
          { text: '  /clear                 Clear conversation', style: 'system' },
          { text: '  /lessons               Show lesson library', style: 'system' },
          { text: '  /undo                  Revert last agent turn', style: 'system' },
          { text: '  /redo                  Re-apply undone action', style: 'system' },
          { text: '  /checkpoint <name>     Save current state', style: 'system' },
          { text: '  /restore <name>        Restore to checkpoint', style: 'system' },
          { text: '  /branches              List Chronicle branches', style: 'system' },
          { text: '  /checkout <name>       Switch to branch', style: 'system' },
          { text: '  /history               Show state transitions', style: 'system' },
          { text: '  /mcp list              List MCPL servers', style: 'system' },
          { text: '  /mcp add <id> <cmd>    Add/overwrite server', style: 'system' },
          { text: '  /mcp remove <id>       Remove a server', style: 'system' },
          { text: '  /mcp env <id> K=V ...  Set env vars on server', style: 'system' },
          { text: '  /budget [tokens]       Show/set stream token budget', style: 'system' },
          { text: '  /session               Show current session', style: 'system' },
          { text: '  /session list          List all sessions', style: 'system' },
          { text: '  /session new [name]    Create new session', style: 'system' },
          { text: '  /session switch <name> Switch to session', style: 'system' },
          { text: '  /session rename <name> Rename current session', style: 'system' },
          { text: '  /session delete <name> Delete a session', style: 'system' },
          { text: '  /recipe                Show current recipe info', style: 'system' },
          { text: '  /newtopic [context]    Reset head window (auto-summarize if empty)', style: 'system' },
        ],
      };

    case 'clear':
      return { lines: [{ text: '(cleared)', style: 'system' }] };

    case 'status':
      return handleStatus(framework);

    case 'lessons':
      return handleLessons(framework);

    case 'undo':
      return handleUndo(app);

    case 'redo':
      return handleRedo(app);

    case 'checkpoint':
      return handleCheckpoint(app, args[0]);

    case 'restore':
      return handleRestore(app, args[0]);

    case 'branches':
      return handleBranches(framework);

    case 'checkout':
      return handleCheckout(framework, args[0]);

    case 'history':
      return handleHistory(framework);

    case 'mcp':
      return handleMcp(args);

    case 'budget':
      return handleBudget(framework, args[0]);

    case 'session':
      return handleSession(app, args);

    case 'recipe':
      return handleRecipe(app);

    case 'newtopic':
      return handleNewTopic(app, args);

    default:
      return {
        lines: [{ text: `Unknown command: /${cmd}. Type /help.`, style: 'system' }],
      };
  }
}

// ---------------------------------------------------------------------------
// /session subcommands
// ---------------------------------------------------------------------------

function handleSession(app: AppContext, args: string[]): CommandResult {
  const sub = args[0];
  switch (sub) {
    case undefined:
      return handleSessionInfo(app);
    case 'list':
    case 'ls':
      return handleSessionList(app);
    case 'new':
    case 'create':
      return handleSessionNew(app, args.slice(1).join(' ') || undefined);
    case 'switch':
    case 'sw':
      return handleSessionSwitch(app, args[1]);
    case 'rename':
      return handleSessionRename(app, args.slice(1).join(' ') || undefined);
    case 'delete':
    case 'rm':
      return handleSessionDelete(app, args[1]);
    default:
      return { lines: [{ text: `Unknown /session subcommand: ${sub}. Try /session list.`, style: 'system' }] };
  }
}

function handleSessionInfo(app: AppContext): CommandResult {
  const session = app.sessionManager.getActiveSession();
  if (!session) {
    return { lines: [{ text: 'No active session.', style: 'system' }] };
  }

  const lines: Line[] = [
    { text: '--- Current Session ---', style: 'system' },
    { text: `  Name: ${session.name}${session.manuallyNamed ? '' : ' (auto)'}`, style: 'system' },
    { text: `  ID: ${session.id}`, style: 'system' },
    { text: `  Created: ${session.createdAt}`, style: 'system' },
    { text: `  Last accessed: ${session.lastAccessedAt}`, style: 'system' },
  ];

  if (session.messageCount !== undefined) {
    lines.push({ text: `  Messages: ${session.messageCount}`, style: 'system' });
  }

  return { lines };
}

function handleSessionList(app: AppContext): CommandResult {
  const sessions = app.sessionManager.listSessions();
  const active = app.sessionManager.getActiveSession();

  if (sessions.length === 0) {
    return { lines: [{ text: 'No sessions.', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- Sessions (${sessions.length}) ---`, style: 'system' }];
  for (const s of sessions) {
    const marker = s.id === active?.id ? ' *' : '';
    const msgs = s.messageCount !== undefined ? ` (${s.messageCount} msgs)` : '';
    const naming = s.manuallyNamed ? '' : ' (auto)';
    lines.push({
      text: `  ${s.name}${naming} [${s.id}]${msgs}${marker}`,
      style: 'system',
    });
  }

  return { lines };
}

function handleSessionNew(app: AppContext, name?: string): CommandResult {
  const session = app.sessionManager.createSession(name);
  resetBranchState(app.branchState);

  return {
    lines: [{ text: `Switching to new session: ${session.name} [${session.id}]...`, style: 'system' }],
    switchToSessionId: session.id,
  };
}

function handleSessionSwitch(app: AppContext, nameOrId?: string): CommandResult {
  if (!nameOrId) {
    return { lines: [{ text: 'Usage: /session switch <name or id>', style: 'system' }] };
  }

  const session = app.sessionManager.findSession(nameOrId);
  if (!session) {
    return { lines: [{ text: `Session "${nameOrId}" not found. Use /session list.`, style: 'system' }] };
  }

  const active = app.sessionManager.getActiveSession();
  if (active && session.id === active.id) {
    return { lines: [{ text: `Already on session "${session.name}".`, style: 'system' }] };
  }

  resetBranchState(app.branchState);

  return {
    lines: [{ text: `Switching to session: ${session.name} [${session.id}]...`, style: 'system' }],
    switchToSessionId: session.id,
  };
}

function handleSessionRename(app: AppContext, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /session rename <name>', style: 'system' }] };
  }

  const session = app.sessionManager.getActiveSession();
  if (!session) {
    return { lines: [{ text: 'No active session.', style: 'system' }] };
  }

  app.sessionManager.renameSession(session.id, name);
  return { lines: [{ text: `Session renamed to "${name}".`, style: 'system' }] };
}

function handleSessionDelete(app: AppContext, nameOrId?: string): CommandResult {
  if (!nameOrId) {
    return { lines: [{ text: 'Usage: /session delete <name or id>', style: 'system' }] };
  }

  const session = app.sessionManager.findSession(nameOrId);
  if (!session) {
    return { lines: [{ text: `Session "${nameOrId}" not found.`, style: 'system' }] };
  }

  try {
    app.sessionManager.deleteSession(session.id);
    return { lines: [{ text: `Deleted session "${session.name}" [${session.id}].`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Delete failed: ${err instanceof Error ? err.message : err}`, style: 'system' }] };
  }
}

// ---------------------------------------------------------------------------
// /recipe
// ---------------------------------------------------------------------------

function handleRecipe(app: AppContext): CommandResult {
  const r = app.recipe;
  const lines: Line[] = [
    { text: '--- Recipe ---', style: 'system' },
    { text: `  Name: ${r.name}`, style: 'system' },
  ];
  if (r.description) {
    lines.push({ text: `  Description: ${r.description}`, style: 'system' });
  }
  if (r.version) {
    lines.push({ text: `  Version: ${r.version}`, style: 'system' });
  }
  lines.push({ text: `  Agent: ${r.agent.name || 'agent'} (${r.agent.model || 'default'})`, style: 'system' });

  const mods = r.modules ?? {};
  const enabled = Object.entries(mods)
    .filter(([, v]) => v !== false)
    .map(([k]) => k);
  lines.push({ text: `  Modules: ${enabled.join(', ') || 'none'}`, style: 'system' });

  const mcpCount = r.mcpServers ? Object.keys(r.mcpServers).length : 0;
  lines.push({ text: `  MCP servers (recipe): ${mcpCount}`, style: 'system' });

  return { lines };
}

// ---------------------------------------------------------------------------
// Existing handlers (unchanged logic, take framework directly)
// ---------------------------------------------------------------------------

function handleStatus(framework: AgentFramework): CommandResult {
  const agents = framework.getAllAgents();
  const lines: Line[] = [{ text: '--- Status ---', style: 'system' }];

  for (const agent of agents) {
    lines.push({ text: `  ${agent.name}: ${agent.state.status} (${agent.model})`, style: 'system' });
  }

  const cm = getAgentCM(framework);
  if (cm) {
    const branch = cm.currentBranch();
    lines.push({ text: `  Branch: ${branch.name} (head: ${branch.head})`, style: 'system' });
  }

  lines.push({ text: `  Queue depth: ${framework.getQueueDepth()}`, style: 'system' });

  return { lines };
}

function handleBudget(framework: AgentFramework, arg?: string): CommandResult {
  const agents = framework.getAllAgents();
  if (agents.length === 0) {
    return { lines: [{ text: 'No agents.', style: 'system' }] };
  }

  if (!arg) {
    // Show current budgets
    const lines: Line[] = [{ text: '--- Stream Token Budgets ---', style: 'system' }];
    for (const agent of agents) {
      const budget = agent.maxStreamTokens;
      const last = agent.lastStreamInputTokens;
      const pct = budget > 0 ? ((last / budget) * 100).toFixed(0) : '—';
      lines.push({
        text: `  ${agent.name}: ${(budget / 1000).toFixed(0)}k (last: ${(last / 1000).toFixed(0)}k, ${pct}%)`,
        style: 'system',
      });
    }
    return { lines };
  }

  // Parse token count — accept "150k", "150000", "1m", etc.
  let tokens: number;
  const lower = arg.toLowerCase();
  if (lower.endsWith('m')) {
    tokens = parseFloat(lower.slice(0, -1)) * 1_000_000;
  } else if (lower.endsWith('k')) {
    tokens = parseFloat(lower.slice(0, -1)) * 1_000;
  } else {
    tokens = parseInt(arg, 10);
  }

  if (isNaN(tokens) || tokens <= 0) {
    return { lines: [{ text: `Invalid token count: "${arg}". Examples: 150k, 1m, 200000`, style: 'system' }] };
  }

  for (const agent of agents) {
    agent.maxStreamTokens = tokens;
  }

  const display = tokens >= 1_000_000
    ? `${(tokens / 1_000_000).toFixed(1)}m`
    : `${(tokens / 1_000).toFixed(0)}k`;

  return {
    lines: [{ text: `Stream budget set to ${display} tokens for all agents.`, style: 'system' }],
  };
}

function handleLessons(framework: AgentFramework): CommandResult {
  const modules = framework.getAllModules();
  const lessonsModule = modules.find(m => m.name === 'lessons') as
    { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean }> } | undefined;

  if (!lessonsModule) {
    return { lines: [{ text: 'Lessons module not loaded.', style: 'system' }] };
  }

  const lessons = lessonsModule.getLessons();
  const active = lessons.filter(l => !l.deprecated);

  if (active.length === 0) {
    return { lines: [{ text: 'No lessons yet. The agent will create them during analysis.', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- Lessons (${active.length}) ---`, style: 'system' }];
  for (const l of active.sort((a, b) => b.confidence - a.confidence)) {
    const conf = (l.confidence * 100).toFixed(0);
    lines.push({
      text: `  [${conf}%] ${l.id}: ${l.content.slice(0, 80)}${l.content.length > 80 ? '...' : ''} (${l.tags.join(', ')})`,
      style: 'system',
    });
  }

  return { lines };
}

function handleUndo(app: AppContext): CommandResult {
  const { framework, branchState: bs } = app;
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  if (messages.length === 0) {
    return { lines: [{ text: 'Nothing to undo.', style: 'system' }] };
  }

  // Find the last agent message (working backwards)
  let undoPoint: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.participant !== 'user') {
      // Found an agent message — undo to the message before it
      undoPoint = i > 0 ? messages[i - 1]!.id : undefined;
      break;
    }
  }

  if (!undoPoint) {
    return { lines: [{ text: 'Nothing to undo (no agent messages found).', style: 'system' }] };
  }

  try {
    // Save current state for redo
    const currentBranch = cm.currentBranch();
    bs.redoStack.push({
      branchId: currentBranch.id,
      branchName: currentBranch.name,
    });

    // Create a new branch from the undo point
    const newBranchId = cm.branchAt(undoPoint, `undo-${Date.now()}`);
    cm.switchBranch(newBranchId);

    bs.undoStack.push({
      branchId: newBranchId,
      branchName: `undo-${Date.now()}`,
      messageId: undoPoint,
    });

    return { lines: [{ text: `Undone. Switched to branch ${newBranchId}.`, style: 'system' }], branchChanged: true };
  } catch (err) {
    return { lines: [{ text: `Undo failed: ${err}`, style: 'system' }] };
  }
}

function handleRedo(app: AppContext): CommandResult {
  const { framework, branchState: bs } = app;
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  if (bs.redoStack.length === 0) {
    return { lines: [{ text: 'Nothing to redo.', style: 'system' }] };
  }

  const point = bs.redoStack.pop()!;
  try {
    cm.switchBranch(point.branchId);
    return { lines: [{ text: `Redone. Switched to branch ${point.branchName}.`, style: 'system' }], branchChanged: true };
  } catch (err) {
    return { lines: [{ text: `Redo failed: ${err}`, style: 'system' }] };
  }
}

function handleCheckpoint(app: AppContext, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkpoint <name>', style: 'system' }] };
  }

  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branch = cm.currentBranch();
  app.branchState.checkpoints.set(name, {
    branchId: branch.id,
    branchName: branch.name,
  });

  return { lines: [{ text: `Checkpoint "${name}" saved at branch ${branch.name} (head: ${branch.head}).`, style: 'system' }] };
}

function handleRestore(app: AppContext, name?: string): CommandResult {
  if (!name) {
    const names = [...app.branchState.checkpoints.keys()];
    if (names.length === 0) {
      return { lines: [{ text: 'No checkpoints saved. Use /checkpoint <name> to create one.', style: 'system' }] };
    }
    return {
      lines: [
        { text: 'Available checkpoints:', style: 'system' },
        ...names.map(n => ({ text: `  ${n}`, style: 'system' as const })),
      ],
    };
  }

  const point = app.branchState.checkpoints.get(name);
  if (!point) {
    return { lines: [{ text: `Checkpoint "${name}" not found.`, style: 'system' }] };
  }

  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  try {
    cm.switchBranch(point.branchId);
    return { lines: [{ text: `Restored to checkpoint "${name}" (branch: ${point.branchName}).`, style: 'system' }], branchChanged: true };
  } catch (err) {
    return { lines: [{ text: `Restore failed: ${err}`, style: 'system' }] };
  }
}

function handleBranches(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const current = cm.currentBranch();

  const lines: Line[] = [{ text: `--- Branches (${branches.length}) ---`, style: 'system' }];
  for (const b of branches) {
    const marker = b.id === current.id ? ' *' : '';
    lines.push({
      text: `  ${b.name} (head: ${b.head})${marker}`,
      style: 'system',
    });
  }

  return { lines };
}

function handleCheckout(framework: AgentFramework, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkout <branch-name>', style: 'system' }] };
  }

  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const target = branches.find(b => b.name === name || b.id === name);
  if (!target) {
    return { lines: [{ text: `Branch "${name}" not found. Use /branches to list.`, style: 'system' }] };
  }

  try {
    cm.switchBranch(target.id);
    return { lines: [{ text: `Switched to branch ${target.name}.`, style: 'system' }], branchChanged: true };
  } catch (err) {
    return { lines: [{ text: `Checkout failed: ${err}`, style: 'system' }] };
  }
}

function handleHistory(framework: AgentFramework): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  const lines: Line[] = [{ text: `--- History (${messages.length} messages) ---`, style: 'system' }];

  // Show the last 20 messages in summary form
  const recent = messages.slice(-20);
  for (const msg of recent) {
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .slice(0, 60);
    const suffix = text.length >= 60 ? '...' : '';
    lines.push({
      text: `  [${msg.id}] ${msg.participant}: ${text}${suffix}`,
      style: 'system',
    });
  }

  return { lines };
}

// ---------------------------------------------------------------------------
// /newtopic — reset head window with topic transition
// ---------------------------------------------------------------------------

function handleNewTopic(app: AppContext, args: string[]): CommandResult {
  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No context manager.', style: 'system' }] };

  const userContext = args.join(' ').trim() || undefined;

  const asyncWork = cm.resetHeadWindow(userContext).then(summary => ({
    lines: [
      { text: 'Topic reset. Transition summary:', style: 'system' as const },
      { text: summary.slice(0, 300) + (summary.length > 300 ? '...' : ''), style: 'system' as const },
    ],
  })).catch(err => ({
    lines: [{ text: `Topic reset failed: ${err instanceof Error ? err.message : err}`, style: 'system' as const }],
  }));

  return {
    lines: [{ text: userContext
      ? 'Resetting topic with provided context...'
      : 'Generating transition summary...', style: 'system' }],
    asyncWork,
  };
}

// ---------------------------------------------------------------------------
// /mcp subcommands
// ---------------------------------------------------------------------------

function handleMcp(args: string[]): CommandResult {
  const sub = args[0];
  switch (sub) {
    case 'list':
    case undefined:
      return handleMcpList();
    case 'add':
      return handleMcpAdd(args.slice(1));
    case 'remove':
      return handleMcpRemove(args[1]);
    case 'env':
      return handleMcpEnv(args[1], args.slice(2));
    default:
      return { lines: [{ text: `Unknown /mcp subcommand: ${sub}. Try /mcp list.`, style: 'system' }] };
  }
}

function handleMcpList(): CommandResult {
  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    return { lines: [{ text: 'No MCPL servers configured. Use /mcp add <id> <command> [args...].', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- MCPL Servers (${entries.length}) ---`, style: 'system' }];
  for (const [id, entry] of entries) {
    const cmdLine = [entry.command, ...(entry.args ?? [])].join(' ');
    lines.push({ text: `  ${id}: ${cmdLine}`, style: 'system' });
    if (entry.env && Object.keys(entry.env).length > 0) {
      const envStr = Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push({ text: `    env: ${envStr}`, style: 'system' });
    }
    if (entry.toolPrefix) {
      lines.push({ text: `    toolPrefix: ${entry.toolPrefix}`, style: 'system' });
    }
  }
  return { lines };
}

function handleMcpAdd(args: string[]): CommandResult {
  if (args.length < 2) {
    return { lines: [{ text: 'Usage: /mcp add <id> <command> [args...]', style: 'system' }] };
  }

  const [id, command, ...cmdArgs] = args;
  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  const isOverwrite = id! in servers;
  servers[id!] = { command: command!, ...(cmdArgs.length > 0 ? { args: cmdArgs } : {}) };
  saveMcplServers(DEFAULT_CONFIG_PATH, servers);

  return {
    lines: [
      { text: `${isOverwrite ? 'Updated' : 'Added'} server "${id}". Restart to apply.`, style: 'system' },
    ],
  };
}

function handleMcpRemove(id?: string): CommandResult {
  if (!id) {
    return { lines: [{ text: 'Usage: /mcp remove <id>', style: 'system' }] };
  }

  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  if (!(id in servers)) {
    return { lines: [{ text: `Server "${id}" not found.`, style: 'system' }] };
  }

  delete servers[id];
  saveMcplServers(DEFAULT_CONFIG_PATH, servers);
  return { lines: [{ text: `Removed server "${id}". Restart to apply.`, style: 'system' }] };
}

function handleMcpEnv(id: string | undefined, pairs: string[]): CommandResult {
  if (!id || pairs.length === 0) {
    return { lines: [{ text: 'Usage: /mcp env <id> KEY=VALUE [KEY=VALUE ...]', style: 'system' }] };
  }

  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  if (!(id in servers)) {
    return { lines: [{ text: `Server "${id}" not found.`, style: 'system' }] };
  }

  const entry = servers[id]!;
  if (!entry.env) entry.env = {};

  const set: string[] = [];
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) {
      return { lines: [{ text: `Invalid env pair: "${pair}". Expected KEY=VALUE.`, style: 'system' }] };
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    entry.env[key] = value;
    set.push(key);
  }

  saveMcplServers(DEFAULT_CONFIG_PATH, servers);
  return { lines: [{ text: `Set ${set.join(', ')} on "${id}". Restart to apply.`, style: 'system' }] };
}

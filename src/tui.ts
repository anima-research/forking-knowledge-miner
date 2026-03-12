/**
 * OpenTUI-based terminal interface.
 *
 * Layout (top to bottom):
 *   ┌─────────────────────────────┐
 *   │  ScrollBox (conversation)   │  ← flexGrow, stickyScroll
 *   │  └─ TextRenderable per msg  │
 *   ├─────────────────────────────┤
 *   │  Status bar (1 row)         │  ← [status | tool | N sub]
 *   ├─────────────────────────────┤
 *   │  InputRenderable            │  ← user input
 *   └─────────────────────────────┘
 *
 * Tab toggles between conversation and agent fleet tree view.
 * Fleet view: interactive tree with expand/collapse (↑↓ navigate, ⏎ toggle).
 */

import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  bold,
  dim,
  fg,
} from '@opentui/core';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { AgentFramework } from '@connectome/agent-framework';
import type { AutobiographicalStrategy } from '@connectome/context-manager';
import type { Membrane, NormalizedRequest } from 'membrane';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { handleCommand } from './commands.js';

interface AppContext {
  framework: AgentFramework;
  membrane: Membrane;
  sessionManager: import('./session-manager.js').SessionManager;
  userMessageCount: number;
  switchSession(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface TuiState {
  status: string;
  tool: string | null;
  subagents: ActiveSubagent[];
  viewMode: 'chat' | 'fleet' | 'peek';
  tokens: TokenUsage;
  peekTarget: string | null;
}

// ---------------------------------------------------------------------------
// Fleet tree types
// ---------------------------------------------------------------------------

interface FleetNode {
  /** Short display name */
  name: string;
  /** Full agent name (for lookups in transcript/token maps) */
  fullName: string;
  /** Whether this is the root researcher node */
  isResearcher: boolean;
  /** ActiveSubagent data (undefined for researcher) */
  agent?: ActiveSubagent;
  /** Child nodes */
  children: FleetNode[];
}

/** A single line in the fleet view with its color. */
interface FleetLine {
  text: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Colours (hex strings for OpenTUI)
// ---------------------------------------------------------------------------

const GREEN = '#00cc00';
const YELLOW = '#cccc00';
const CYAN = '#00cccc';
const MAGENTA = '#cc00cc';
const RED = '#cc0000';
const GRAY = '#888888';
const DIM_GRAY = '#555555';
const WHITE = '#cccccc';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runTui(app: AppContext): Promise<void> {
  const membrane = app.membrane;

  // Redirect stderr to a log file — console.error is invisible once the TUI owns the terminal
  const logDir = process.env.DATA_DIR || './data';
  mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/tui-error.log`;
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- session ${new Date().toISOString()} ---\n`);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    logStream.write(chunk);
    return true;
  }) as typeof process.stderr.write;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  // Set terminal title
  process.stdout.write('\x1b]0;Forking Knowledge Miner\x07');

  const state: TuiState = {
    status: 'idle',
    tool: null,
    subagents: [],
    viewMode: 'chat',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    peekTarget: null,
  };

  let streaming = false;
  let currentStreamText: TextRenderable | null = null;
  let backgrounded = false;       // researcher pushed to background via Ctrl+B
  let backgroundBuffer = '';      // accumulates tokens while backgrounded
  let currentStreamBuffer = '';
  let verboseChat = false;

  // Main agent spinner + token counter
  let streamOutputTokens = 0;
  let spinnerFrame = 0;
  const SPINNER = ['·', '.', 'o', 'O'];

  // Subagent phase tracking
  type SubagentPhase = 'sending' | 'streaming' | 'invoking' | 'executing' | 'done' | 'failed';
  const subagentPhase = new Map<string, SubagentPhase>();
  const PHASE_COLOR: Record<SubagentPhase, string> = {
    sending: YELLOW,
    streaming: CYAN,
    invoking: MAGENTA,
    executing: YELLOW,
    done: DIM_GRAY,
    failed: RED,
  };

  // ── Layout ────────────────────────────────────────────────────────────

  const rootBox = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });

  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: 'conversation',
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
  });

  const fleetBox = new BoxRenderable(renderer, {
    id: 'fleet',
    flexGrow: 1,
    flexDirection: 'column',
    paddingLeft: 1,
    paddingTop: 1,
  });
  let fleetLineCounter = 0;

  const statusLeft = new TextRenderable(renderer, {
    id: 'status-left',
    content: formatStatusLeft(state),
    fg: GRAY,
  });

  const statusRight = new TextRenderable(renderer, {
    id: 'status-right',
    content: formatTokens(state.tokens, false),
    fg: DIM_GRAY,
  });

  const statusBox = new BoxRenderable(renderer, {
    id: 'status-box',
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  });

  const input = new InputRenderable(renderer, {
    id: 'input',
    placeholder: 'Type a message or /help...',
  });

  // ── Paste handling (CC-style) ───────────────────────────────────────
  // Large pastes get stored out-of-band; a short placeholder appears in
  // the input field.  On submit the placeholders are expanded back.
  const pastedTexts: string[] = [];
  (input as any).handlePaste = (event: { text: string }) => {
    pastedTexts.push(event.text);
    const tag = `[pasted text #${pastedTexts.length}]`;
    (input as any).insertText(tag);
  };

  const inputBox = new BoxRenderable(renderer, {
    id: 'input-box',
    height: 1,
    paddingLeft: 1,
  });

  // Assembly — both views always present; fleet starts hidden
  statusBox.add(statusLeft);
  statusBox.add(statusRight);
  inputBox.add(input);
  rootBox.add(scrollBox);
  rootBox.add(fleetBox);
  fleetBox.visible = false;
  rootBox.add(statusBox);
  rootBox.add(inputBox);
  renderer.root.add(rootBox);

  input.focus();

  // ── Agent observability maps ──────────────────────────────────────

  /** Accumulated transcript per agent (text output + tool calls). */
  const agentTranscripts = new Map<string, string>();

  /** Parent tracking: child short name → parent full agent name. */
  const agentParent = new Map<string, string>();

  /** Last known input token count per agent (= context window size). */
  const agentContextTokens = new Map<string, number>();

  /** Synesthete summary per agent, keyed by full agent name. */
  const summaryCache = new Map<string, string>();
  const summarySnapshotLen = new Map<string, number>();
  const summaryPending = new Set<string>();

  const SUMMARY_DELTA = 2000;
  const SUMMARY_WINDOW = 10_000;

  function appendTranscript(agent: string, text: string) {
    const prev = agentTranscripts.get(agent) ?? '';
    agentTranscripts.set(agent, prev + text);
  }

  async function generateSummary(agentName: string) {
    if (summaryPending.has(agentName)) return;
    const transcript = agentTranscripts.get(agentName);
    if (!transcript || transcript.length < 50) return;

    const lastLen = summarySnapshotLen.get(agentName) ?? 0;
    if (transcript.length - lastLen < SUMMARY_DELTA && summaryCache.has(agentName)) return;

    summaryPending.add(agentName);
    try {
      const window = transcript.slice(-SUMMARY_WINDOW);
      const request: NormalizedRequest = {
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: `Agent activity stream:\n\n${window}\n\nWhat is this agent doing right now? Answer in 5-10 words.` }],
        }],
        system: 'You distill an agent\'s activity into a terse status phrase. 5-10 words max. No punctuation. Specific, not generic.',
        config: { model: 'claude-haiku-4-5-20251001', maxTokens: 40, temperature: 0.3 },
      };
      const response = await membrane.complete(request);
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('').trim();
      summaryCache.set(agentName, text.length > 60 ? text.slice(0, 57) + '...' : text);
      summarySnapshotLen.set(agentName, transcript.length);
      if (state.viewMode === 'fleet') updateFleetView();
    } catch {
      // best-effort
    } finally {
      summaryPending.delete(agentName);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  let messageCounter = 0;

  function addLine(text: string, color: string = WHITE) {
    scrollBox.add(new TextRenderable(renderer, {
      id: `msg-${++messageCounter}`,
      content: text,
      fg: color,
    }));
  }

  function updateStatus() {
    statusLeft.content = formatStatusLeft(state, SPINNER[spinnerFrame], streamOutputTokens);
    statusRight.content = formatTokens(state.tokens, verboseChat);
  }

  function beginStream() {
    currentStreamBuffer = '';
    currentStreamText = new TextRenderable(renderer, {
      id: `stream-${++messageCounter}`,
      content: '',
      fg: WHITE,
    });
    scrollBox.add(currentStreamText);
    streaming = true;
  }

  function streamToken(text: string) {
    if (currentStreamText) {
      currentStreamBuffer += text;
      currentStreamText.content = currentStreamBuffer;
    }
  }

  function endStream() {
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
  }

  function loadSessionHistory() {
    const agent = app.framework.getAgent('researcher');
    if (!agent) return;
    const cm = agent.getContextManager();
    const messages = cm.getAllMessages();
    if (messages.length === 0) return;

    addLine(`── session history (${messages.length} messages) ──`, DIM_GRAY);

    for (const msg of messages) {
      const toolNames: string[] = [];

      for (const block of msg.content) {
        if (block.type === 'text' && (block as { text: string }).text.trim()) {
          if (msg.participant === 'user') {
            addLine(`You: ${(block as { text: string }).text}`, GREEN);
          } else {
            addLine((block as { text: string }).text, WHITE);
          }
        } else if (block.type === 'tool_use') {
          toolNames.push((block as { name: string }).name);
        }
        // skip tool_result blocks
      }

      if (toolNames.length > 0) {
        addLine(`[tools] ${toolNames.join(', ')}`, YELLOW);
      }
    }

    addLine(`── end history ──`, DIM_GRAY);
  }

  /**
   * Rebuild the TUI display from Chronicle state after a branch switch.
   * Clears conversation, reloads messages, restores fleet tree from persisted subagent state.
   */
  function refreshFromStore() {
    // Clear conversation display
    const children = [...scrollBox.getChildren()];
    for (const child of children) {
      scrollBox.remove(child.id);
    }
    messageCounter = 0;

    // Reset streaming state
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
    state.status = 'idle';
    state.tool = null;

    // Reload conversation from Chronicle
    loadSessionHistory();

    // Restore fleet tree from persisted subagent module state
    if (subMod) {
      subMod.restoreFromStore();
      state.subagents = [...subMod.activeSubagents.values()];

      // Rebuild TUI-side parent map from persisted data
      agentParent.clear();
      for (const [child, parent] of subMod.parentMap) {
        agentParent.set(child, parent);
      }
    }

    updateStatus();
  }

  const fmtK = (n: number) => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  };

  // ── Fleet tree view ────────────────────────────────────────────────

  const expandedNodes = new Set<string>(['researcher']);
  let fleetCursor = 0;
  /** Ordered list of node IDs in current rendering (for cursor navigation). */
  let visibleNodeIds: string[] = [];

  function buildFleetTree(): FleetNode {
    const root: FleetNode = {
      name: 'researcher',
      fullName: 'researcher',
      isResearcher: true,
      children: [],
    };

    // Index subagents by short name for tree building
    const byName = new Map<string, FleetNode>();
    for (const sa of state.subagents) {
      const fullName = [...(subMod?.activeSubagents.keys() ?? [])].find(k => k.includes(sa.name)) ?? sa.name;
      const node: FleetNode = {
        name: sa.name,
        fullName,
        isResearcher: false,
        agent: sa,
        children: [],
      };
      byName.set(sa.name, node);
    }

    // Build parent-child links
    for (const sa of state.subagents) {
      const parentFullName = agentParent.get(sa.name);
      if (parentFullName && parentFullName !== 'researcher') {
        // Find the parent's short name
        const parentShort = [...byName.keys()].find(k => parentFullName.includes(k));
        if (parentShort && byName.has(parentShort)) {
          byName.get(parentShort)!.children.push(byName.get(sa.name)!);
          continue;
        }
      }
      // Default: child of researcher
      root.children.push(byName.get(sa.name)!);
    }

    // Sort children: running on top, then by startedAt ascending (stable reading order)
    const sortChildren = (children: FleetNode[]) => {
      children.sort((a, b) => {
        const aRunning = a.agent?.status === 'running' ? 0 : 1;
        const bRunning = b.agent?.status === 'running' ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        return (a.agent?.startedAt ?? 0) - (b.agent?.startedAt ?? 0);
      });
      for (const child of children) {
        if (child.children.length > 0) sortChildren(child.children);
      }
    };
    sortChildren(root.children);

    return root;
  }

  function renderNode(node: FleetNode, depth: number, lines: FleetLine[]): void {
    const indent = '  '.repeat(depth);
    const isExpanded = expandedNodes.has(node.name);
    const hasChildren = node.children.length > 0;

    // Determine node color based on status
    let nodeColor: string;
    if (node.isResearcher) {
      nodeColor = state.status === 'idle' ? GRAY : WHITE;
    } else {
      const sa = node.agent!;
      if (sa.status === 'running') {
        const phase = subagentPhase.get(sa.name) ?? 'sending';
        nodeColor = PHASE_COLOR[phase];
      } else {
        nodeColor = sa.status === 'failed' ? RED : DIM_GRAY;
      }
    }

    // Dimmer variant for detail/child lines
    const detailColor = node.isResearcher
      ? (state.status === 'idle' ? DIM_GRAY : GRAY)
      : (node.agent?.status === 'running' ? GRAY : DIM_GRAY);

    // Status tag
    let statusTag: string;
    if (node.isResearcher) {
      statusTag = state.status === 'idle' ? '✓ idle'
        : state.status === 'error' ? '✗ error'
        : `… ${state.status}`;
    } else {
      const sa = node.agent!;
      const endTime = sa.completedAt ?? Date.now();
      const elapsed = Math.floor((endTime - sa.startedAt) / 1000);
      if (sa.status !== 'running') {
        statusTag = sa.status === 'completed' ? `done ${elapsed}s` : `failed ${elapsed}s`;
      } else {
        const phase = subagentPhase.get(sa.name) ?? 'sending';
        statusTag = `${phase} ${elapsed}s`;
      }
    }

    // Context size (try fullName, then short name)
    const ctxTokens = agentContextTokens.get(node.fullName) ?? agentContextTokens.get(node.name);
    const ctxStr = ctxTokens ? ` ${fmtK(ctxTokens)}ctx` : '';

    // Compression stats (researcher only — we can access the strategy)
    let compStr = '';
    if (node.isResearcher) {
      try {
        const agent = app.framework.getAgent('researcher');
        const cm = agent?.getContextManager();
        const strategy = (cm as any)?.strategy as AutobiographicalStrategy | undefined;
        if (strategy?.getStats) {
          const stats = strategy.getStats();
          if (stats.compressionCount > 0) {
            compStr = ` ${stats.compressionCount}comp`;
          }
        }
      } catch { /* best-effort */ }
    }

    // Fold marker
    const marker = hasChildren ? (isExpanded ? '▼' : '►') : '─';

    // Header line (this is a navigable node)
    const isCursor = visibleNodeIds.length === fleetCursor;
    const cursor = isCursor ? '→' : ' ';
    visibleNodeIds.push(node.name);

    // Contextual key hints on the cursor line
    let hints = '';
    if (isCursor) {
      const canPeek = !node.isResearcher && node.agent?.status === 'running';
      hints = canPeek ? '  ⏎:fold p:peek Del:stop' : '  ⏎:fold';
    }

    lines.push({
      text: `${cursor} ${indent}${marker} ${node.name}  [${statusTag}]${ctxStr}${compStr}${hints}`,
      color: nodeColor,
    });

    if (!isExpanded) return;

    // Detail lines (indented further)
    const detail = indent + '    ';

    if (node.isResearcher && state.tool) {
      lines.push({ text: `  ${detail}tool: ${state.tool}`, color: detailColor });
    }
    if (!node.isResearcher && node.agent) {
      const sa = node.agent;
      // Truncate task to 60 chars
      const task = sa.task.length > 60 ? sa.task.slice(0, 57) + '...' : sa.task;
      lines.push({ text: `  ${detail}task: ${task}`, color: detailColor });
      if (sa.statusMessage) {
        lines.push({ text: `  ${detail}tool: ${sa.statusMessage} (${sa.toolCallsCount} calls)`, color: detailColor });
      }
    }

    // Synesthete summary
    const fullName = node.isResearcher ? 'researcher'
      : [...agentTranscripts.keys()].find(k => k.includes(node.name));
    if (fullName) {
      const summary = summaryCache.get(fullName);
      if (summary) {
        lines.push({ text: `  ${detail}┈ ${summary}`, color: DIM_GRAY });
      } else if (summaryPending.has(fullName)) {
        lines.push({ text: `  ${detail}┈ …`, color: DIM_GRAY });
      }
      generateSummary(fullName);
    }

    // Recurse into children
    for (const child of node.children) {
      renderNode(child, depth + 1, lines);
    }
  }

  function updateFleetView() {
    const tree = buildFleetTree();
    visibleNodeIds = [];

    const lines: FleetLine[] = [];
    lines.push({ text: '─── Agent Fleet ──────────────────── ↑↓:nav ───', color: GRAY });
    lines.push({ text: '', color: GRAY });

    renderNode(tree, 0, lines);

    // Clamp cursor
    if (fleetCursor >= visibleNodeIds.length) fleetCursor = visibleNodeIds.length - 1;
    if (fleetCursor < 0) fleetCursor = 0;

    lines.push({ text: '', color: GRAY });
    lines.push({ text: '                                    Tab: chat', color: DIM_GRAY });

    // Rebuild fleetBox children: clear old, add new per-line renderables
    for (const child of [...fleetBox.getChildren()]) {
      fleetBox.remove(child.id);
    }
    for (const line of lines) {
      fleetBox.add(new TextRenderable(renderer, {
        id: `fleet-ln-${++fleetLineCounter}`,
        content: line.text,
        fg: line.color,
      }));
    }
  }

  function switchView(mode: 'chat' | 'fleet') {
    state.viewMode = mode;
    scrollBox.visible = mode === 'chat';
    fleetBox.visible = mode === 'fleet';
    if (mode === 'fleet') {
      input.blur();
      updateFleetView();
    } else {
      input.focus();
    }
  }

  // ── Peek view ────────────────────────────────────────────────────────

  /** Accumulated event log per agent (keyed by display name). */
  const peekLogs = new Map<string, FleetLine[]>();
  /** Current in-progress tool per agent (for sticky display). */
  const peekCurrentTool = new Map<string, string | null>();
  let peekUnsubscribe: (() => void) | null = null;

  function appendPeekLog(name: string, text: string, color: string) {
    if (!peekLogs.has(name)) peekLogs.set(name, []);
    peekLogs.get(name)!.push({ text, color });
  }

  function cleanupPeek() {
    if (peekUnsubscribe) {
      peekUnsubscribe();
      peekUnsubscribe = null;
    }
    state.peekTarget = null;
  }

  function enterPeek(name: string) {
    // Only peek at running subagents
    const sa = state.subagents.find(s => s.name === name);
    if (!sa || sa.status !== 'running') return;

    state.viewMode = 'peek';
    state.peekTarget = name;

    // Ensure log exists (may already have entries from global subscriber)
    if (!peekLogs.has(name)) peekLogs.set(name, []);

    if (subMod) {
      // Get initial snapshot (async, best-effort) — seed the log if empty
      subMod.peek(name).then(snapshots => {
        if (snapshots.length > 0 && state.viewMode === 'peek' && state.peekTarget === name) {
          const snap = snapshots[0]!;
          const log = peekLogs.get(name);
          if (log && log.length === 0) {
            if (snap.currentStream) {
              // Show last few lines of existing stream as initial context
              const streamLines = snap.currentStream.split('\n').slice(-10);
              for (const l of streamLines) {
                if (l.trim()) appendPeekLog(name, l, WHITE);
              }
            }
            if (snap.pendingToolCalls.length > 0) {
              for (const tc of snap.pendingToolCalls) {
                appendPeekLog(name, `⟳ ${tc.name}`, YELLOW);
                peekCurrentTool.set(name, tc.name);
              }
            }
          }
          updatePeekView();
        }
      }).catch(() => {});
    }

    updatePeekView();
  }

  function updatePeekView() {
    const name = state.peekTarget;
    if (!name) return;

    const lines: FleetLine[] = [];
    lines.push({ text: `─── Peek: ${name} ──────────────── Esc:back ───`, color: GRAY });
    lines.push({ text: '', color: GRAY });

    const sa = state.subagents.find(s => s.name === name);
    if (sa) {
      const elapsed = Math.floor((Date.now() - sa.startedAt) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const timeStr = min > 0 ? `${min}m${sec}s` : `${sec}s`;
      const statusColor = sa.status === 'running' ? CYAN : sa.status === 'failed' ? RED : DIM_GRAY;
      lines.push({ text: `  ${sa.status}  ${timeStr}  ${sa.toolCallsCount} tool calls`, color: statusColor });

      const task = sa.task.length > 70 ? sa.task.slice(0, 67) + '...' : sa.task;
      lines.push({ text: `  task: ${task}`, color: GRAY });
    }

    // Sticky: current pending tool (if any)
    const log = peekLogs.get(name);
    if (peekCurrentTool.get(name)) {
      lines.push({ text: '', color: GRAY });
      lines.push({ text: `  ⟳ ${peekCurrentTool.get(name)}`, color: YELLOW });
    }

    lines.push({ text: '', color: GRAY });

    // Accumulated event log — show last N lines
    if (log && log.length > 0) {
      const maxLines = Math.max(10, (process.stdout.rows ?? 40) - 8);
      const tail = log.slice(-maxLines);
      if (log.length > maxLines) {
        lines.push({ text: `  ┈ (${log.length - maxLines} lines above)`, color: DIM_GRAY });
      }
      for (const entry of tail) {
        lines.push({ text: `  ${entry.text}`, color: entry.color });
      }
    } else {
      lines.push({ text: '  (waiting for output)', color: DIM_GRAY });
    }

    // Rebuild fleetBox children
    for (const child of [...fleetBox.getChildren()]) {
      fleetBox.remove(child.id);
    }
    for (const line of lines) {
      fleetBox.add(new TextRenderable(renderer, {
        id: `fleet-ln-${++fleetLineCounter}`,
        content: line.text,
        fg: line.color,
      }));
    }
  }

  // ── Trace listener ──────────────────────────────────────────────────

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;

    switch (event.type) {
      case 'inference:started': {
        if (agent === 'researcher') {
          if (backgrounded) {
            // Researcher is running in background — don't show stream UI
            state.status = 'background';
            streamOutputTokens = 0;
          } else {
            state.status = 'thinking';
            streamOutputTokens = 0;
            spinnerFrame = 0;
            beginStream();
          }
          updateStatus();
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        if (content) {
          if (agent === 'researcher' && backgrounded) {
            // Silently accumulate tokens while backgrounded
            backgroundBuffer += content;
            streamOutputTokens += Math.ceil(content.length / 4);
          } else if (agent === 'researcher' && streaming) {
            streamToken(content);
            streamOutputTokens += Math.ceil(content.length / 4);
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            updateStatus();
          }
          if (agent) {
            appendTranscript(agent, content);
            // Project context growth: output tokens will be in context next round
            const prev = agentContextTokens.get(agent);
            if (prev) {
              const delta = Math.ceil(content.length / 4);
              agentContextTokens.set(agent, prev + delta);
              const short = agent.replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '').replace(/-retry\d+$/, '');
              if (short !== agent) agentContextTokens.set(short, prev + delta);
            }
          }
        }
        break;
      }

      case 'inference:usage': {
        // Per-round usage updates during yielding streams
        const roundUsage = event.tokenUsage as { input?: number; output?: number } | undefined;
        if (agent && roundUsage?.input) {
          agentContextTokens.set(agent, roundUsage.input);
          const short = agent.replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '').replace(/-retry\d+$/, '');
          if (short !== agent) agentContextTokens.set(short, roundUsage.input);
          if (state.viewMode === 'fleet') updateFleetView();
        }
        break;
      }

      case 'inference:completed': {
        const usage = event.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
        if (usage) {
          state.tokens.input += usage.input ?? 0;
          state.tokens.output += usage.output ?? 0;
          state.tokens.cacheRead += usage.cacheRead ?? 0;
          state.tokens.cacheWrite += usage.cacheCreation ?? 0;
          // Track context size per agent (store by both full and short name)
          if (agent && usage.input) {
            agentContextTokens.set(agent, usage.input);
            const short = agent.replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '').replace(/-retry\d+$/, '');
            if (short !== agent) agentContextTokens.set(short, usage.input);
          }
        }

        if (agent === 'researcher') {
          state.status = 'idle';
          state.tool = null;
          if (backgrounded) {
            // Researcher returned from background — show accumulated output as a message
            if (backgroundBuffer.trim()) {
              addLine(backgroundBuffer, WHITE);
            }
            addLine('  (researcher returned from background)', CYAN);
            backgrounded = false;
            backgroundBuffer = '';
          }
          if (streaming) endStream();
        }
        updateStatus();
        break;
      }

      case 'inference:failed': {
        if (agent === 'researcher') {
          state.status = 'error';
          if (backgrounded) {
            backgrounded = false;
            backgroundBuffer = '';
          }
          if (streaming) endStream();
          addLine(`Error: ${event.error}`, RED);
          updateStatus();
        } else {
          if (agent) {
            const short = agent.replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '').replace(/-retry\d+$/, '');
            subagentPhase.set(short, 'failed');
          }
          addLine(`[${agent}] Error: ${event.error}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string; input?: unknown }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent) {
          const toolSnippet = calls.map(c => {
            const inp = c.input ? JSON.stringify(c.input) : '';
            return `[tool: ${c.name}${inp ? ' ' + inp.slice(0, 200) : ''}]`;
          }).join('\n');
          appendTranscript(agent, '\n' + toolSnippet + '\n');

          // Track parent-child for fleet tree
          for (const call of calls) {
            if (call.name === 'subagent--spawn' || call.name === 'subagent--fork') {
              const childName = (call.input as Record<string, unknown>)?.name as string | undefined;
              if (childName) {
                agentParent.set(childName, agent);
              }
            }
          }
        }

        if (agent === 'researcher') {
          state.status = backgrounded ? 'background' : 'tools';
          state.tool = names;
          if (streaming) endStream();
          if (!backgrounded) addLine(`[tools] ${names}`, YELLOW);
        } else {
          const short = (agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '');
          addLine(`  [${short}] ${names}`, DIM_GRAY);
          const sa = state.subagents.find(s => (agent ?? '').includes(s.name));
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split('--').pop();
          }
        }
        updateStatus();
        break;
      }

      case 'inference:stream_resumed': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          state.tool = null;
          beginStream();
          updateStatus();
        }
        break;
      }

      // Wake subscription trigger notice
      case 'process:received': {
        const pe = event.processEvent as { type: string; source?: string; metadata?: Record<string, unknown> } | undefined;
        if (pe?.source === 'wake:triggered' && pe.metadata) {
          const subs = (pe.metadata.subscriptions as string[]) ?? [];
          const summary = (pe.metadata.eventSummary as string) ?? '';
          const snippet = summary.length > 60 ? summary.slice(0, 57) + '...' : summary;
          const label = subs.join(', ');
          addLine(`\u2691 wake triggered: ${label} \u2014 "${snippet}"`, YELLOW);
        }
        break;
      }

      case 'tool:started': {
        const tool = event.tool as string;
        if (agent === 'researcher') {
          state.tool = tool;
          updateStatus();
        }
        // Show file operations in chat
        const toolInput = event.input as Record<string, unknown> | undefined;
        if (toolInput && (agent === 'researcher' || verboseChat)) {
          const short = agent === 'researcher' ? '' : `[${(agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '')}] `;
          if (tool === 'files:write' && toolInput.filePath) {
            const fp = String(toolInput.filePath);
            addLine(`  ${short}write ${fp}`, DIM_GRAY);
          } else if (tool === 'files:materialize' && toolInput.targetDir) {
            const dir = String(toolInput.targetDir);
            const files = toolInput.files as string[] | undefined;
            const fileList = files ? files.join(', ') : 'all';
            // OSC 8 hyperlink for the target directory
            const link = `\x1b]8;;file://${dir}\x07${dir}\x1b]8;;\x07`;
            addLine(`  ${short}materialize → ${link} (${fileList})`, DIM_GRAY);
          } else if (tool === 'lessons--create' && toolInput.content) {
            const content = String(toolInput.content);
            const tags = (toolInput.tags as string[] | undefined)?.join(', ') ?? '';
            const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
            addLine(`  ${short}+ lesson${tags ? ` [${tags}]` : ''}: ${preview}`, GREEN);
          }
        }
        break;
      }

      case 'tool:completed':
        break;

      case 'tool:failed': {
        const tool = event.tool as string;
        const error = event.error as string;
        if (agent === 'researcher') {
          addLine(`[tool error] ${tool}: ${error}`, RED);
        } else if (agent) {
          const short = agent.replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '').replace(/-retry\d+$/, '');
          addLine(`  [${short}] tool error: ${tool}: ${error}`, RED);
        }
        break;
      }
    }
  }

  // ── Subagent polling ────────────────────────────────────────────────

  let subMod = app.framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;

  // Subscribe to each subagent's stream for peek logs + done events.
  const subagentStreamUnsubs: Array<() => void> = [];
  const subscribedSubagents = new Set<string>();

  /** Tracks the last token line being built for each agent (to merge consecutive token events). */
  const peekTokenLine = new Map<string, string>();

  function subscribeSubagentStream(name: string) {
    if (subscribedSubagents.has(name) || !subMod) return;
    subscribedSubagents.add(name);

    if (!peekLogs.has(name)) peekLogs.set(name, []);

    const unsub = subMod.onPeekStream(name, (event) => {
      switch (event.type) {
        case 'inference:started':
          subagentPhase.set(name, 'sending');
          appendPeekLog(name, '── inference round ──', DIM_GRAY);
          peekCurrentTool.set(name, null);
          peekTokenLine.delete(name);
          break;

        case 'tokens': {
          if (subagentPhase.get(name) !== 'streaming') subagentPhase.set(name, 'streaming');
          // Merge consecutive token events into the last line
          const prev = peekTokenLine.get(name) ?? '';
          const merged = prev + event.content;
          // Split by newlines — only the last segment is "in progress"
          const parts = merged.split('\n');
          if (parts.length > 1) {
            // Flush completed lines
            for (let i = 0; i < parts.length - 1; i++) {
              if (parts[i]!.trim()) appendPeekLog(name, parts[i]!, WHITE);
            }
          }
          peekTokenLine.set(name, parts[parts.length - 1]!);
          break;
        }

        case 'tool_calls': {
          subagentPhase.set(name, 'invoking');
          // Flush any pending token line
          const pending = peekTokenLine.get(name);
          if (pending?.trim()) appendPeekLog(name, pending, WHITE);
          peekTokenLine.delete(name);
          const toolNames = event.calls.map(c => c.name).join(', ');
          appendPeekLog(name, `→ ${toolNames}`, YELLOW);
          break;
        }

        case 'tool:started':
          subagentPhase.set(name, 'executing');
          peekCurrentTool.set(name, event.tool);
          appendPeekLog(name, `  ⟳ ${event.tool}`, GRAY);
          break;

        case 'tool:completed':
          if (peekCurrentTool.get(name) === event.tool) peekCurrentTool.set(name, null);
          appendPeekLog(name, `  ✓ ${event.tool} (${event.durationMs}ms)`, DIM_GRAY);
          break;

        case 'tool:failed':
          if (peekCurrentTool.get(name) === event.tool) peekCurrentTool.set(name, null);
          appendPeekLog(name, `  ✗ ${event.tool}: ${event.error}`, RED);
          break;

        case 'stream_resumed':
          subagentPhase.set(name, 'sending');
          appendPeekLog(name, '── stream resumed ──', DIM_GRAY);
          peekCurrentTool.set(name, null);
          peekTokenLine.delete(name);
          break;

        case 'inference:completed':
          break;

        case 'done': {
          subagentPhase.set(name, 'done');
          // Flush any pending token line
          const pendingTok = peekTokenLine.get(name);
          if (pendingTok?.trim()) appendPeekLog(name, pendingTok, WHITE);
          peekTokenLine.delete(name);
          peekCurrentTool.set(name, null);

          const summary = event.summary;
          const truncated = summary.length > 100 ? summary.slice(0, 97) + '...' : summary;
          appendPeekLog(name, `── done: ${truncated} ──`, DIM_GRAY);

          // Update context tokens from done event
          if (event.lastInputTokens) {
            agentContextTokens.set(name, event.lastInputTokens);
          }

          // Verbose chat display
          if (verboseChat) {
            const chatTruncated = summary.length > 200 ? summary.slice(0, 197) + '...' : summary;
            addLine(`  ◀ [${name}] ${chatTruncated}`, CYAN);
          }
          break;
        }
      }

      if (state.viewMode === 'peek' && state.peekTarget === name) updatePeekView();
      if (state.viewMode === 'fleet') {
        state.subagents = [...subMod!.activeSubagents.values()];
        updateFleetView();
      }
    });
    subagentStreamUnsubs.push(unsub);
  }
  const pollTimer = setInterval(() => {
    // Animate spinner when researcher is active (not just on token events)
    if (state.status !== 'idle' && state.status !== 'error') {
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    }

    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      // Subscribe to stream events for any new subagents
      for (const sa of state.subagents) {
        subscribeSubagentStream(sa.name);
      }
      updateStatus();
      if (state.viewMode === 'fleet') updateFleetView();
      else if (state.viewMode === 'peek') updatePeekView();
    }
  }, 500);

  // ── Keyboard ───────────────────────────────────────────────────────

  renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'tab') {
      cleanupPeek();
      switchView(state.viewMode === 'chat' ? 'fleet' : 'chat');
      updateStatus();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      cleanup();
      return;
    }
    if (key.ctrl && key.name === 'v') {
      verboseChat = !verboseChat;
      addLine(verboseChat ? '(verbose: on — showing agent thoughts & subagent results)' : '(verbose: off)', DIM_GRAY);
      return;
    }
    // Ctrl+B: push to background — detach any blocking sync subagents and/or
    // background the researcher's current inference (stop displaying tokens,
    // re-enable input; result appears as message when done)
    if (key.ctrl && key.name === 'b' && state.viewMode === 'chat') {
      let acted = false;

      // 1. Detach any blocking sync subagents
      if (subMod?.hasDetachable()) {
        const detached = subMod.detachAll();
        if (detached > 0) {
          addLine(`  (${detached} sync subagent${detached > 1 ? 's' : ''} moved to background)`, CYAN);
          acted = true;
        }
      }

      // 2. Background the researcher's streaming output
      if (streaming && state.status !== 'idle') {
        endStream();
        backgrounded = true;
        addLine('  (researcher moved to background — result will appear when done)', CYAN);
        updateStatus();
        acted = true;
      }

      if (!acted) {
        addLine('  (nothing to background)', DIM_GRAY);
      }
      return;
    }

    // Chat view: Escape interrupts the active agent and all running subagents
    if (key.name === 'escape' && state.viewMode === 'chat') {
      if (state.status !== 'idle' && state.status !== 'error') {
        // Cancel all subagents first so their results propagate up
        const cancelled = subMod?.cancelAll() ?? 0;
        const agent = app.framework.getAgent('researcher');
        if (agent) {
          agent.cancelStream();
          if (streaming) endStream();
          if (backgrounded) {
            backgrounded = false;
            backgroundBuffer = '';
          }
          state.status = 'idle';
          state.tool = null;
          addLine(cancelled > 0
            ? `  (interrupted — ${cancelled} subagent${cancelled > 1 ? 's' : ''} stopped)`
            : '  (interrupted)', YELLOW);
          updateStatus();
        }
      }
      return;
    }

    // Peek view: Escape or p goes back to fleet
    if (state.viewMode === 'peek') {
      if (key.name === 'escape' || key.name === 'p') {
        cleanupPeek();
        switchView('fleet');
        updateStatus();
      }
      return;
    }

    // Fleet view navigation
    if (state.viewMode === 'fleet') {
      if (key.name === 'up') {
        fleetCursor = Math.max(0, fleetCursor - 1);
        updateFleetView();
      } else if (key.name === 'down') {
        fleetCursor = Math.min(visibleNodeIds.length - 1, fleetCursor + 1);
        updateFleetView();
      } else if (key.name === 'return' || key.name === 'right') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          if (expandedNodes.has(nodeId)) expandedNodes.delete(nodeId);
          else expandedNodes.add(nodeId);
          updateFleetView();
        }
      } else if (key.name === 'left') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          expandedNodes.delete(nodeId);
          updateFleetView();
        }
      } else if (key.name === 'p') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId && nodeId !== 'researcher') {
          enterPeek(nodeId);
        }
      } else if (key.name === 'delete' || key.name === 'backspace') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId && nodeId !== 'researcher') {
          const sa = state.subagents.find(s => s.name === nodeId);
          if (sa?.status === 'running' && subMod) {
            if (subMod.cancelSubagent(nodeId)) {
              addLine(`  ■ [${nodeId}] stopped by user`, YELLOW);
            }
          }
        }
      }
    }
  });

  // ── Input handling ─────────────────────────────────────────────────

  let resolveExit: (() => void) | null = null;

  input.on(InputRenderableEvents.ENTER, () => {
    const raw = input.value.trim();
    input.deleteLine();

    if (!raw) { pastedTexts.length = 0; return; }

    // Expand paste placeholders
    const text = pastedTexts.length > 0
      ? raw.replace(/\[pasted text #(\d+)\]/g, (m, n) => pastedTexts[parseInt(n, 10) - 1] ?? m)
      : raw;
    pastedTexts.length = 0;

    if (text.startsWith('/')) {
      const result = handleCommand(text, app);
      if (result.quit) {
        cleanup();
        return;
      }
      if (text === '/clear') {
        const children = [...scrollBox.getChildren()];
        for (const child of children) {
          scrollBox.remove(child.id);
        }
      } else {
        for (const l of result.lines) {
          addLine(l.text, GRAY);
        }
      }

      // Branch operation: refresh display from Chronicle state
      if (result.branchChanged) {
        refreshFromStore();
      }

      // Session switch: async teardown + rebuild
      if (result.switchToSessionId) {
        state.status = 'switching';
        updateStatus();
        app.framework.offTrace(onTrace as (e: unknown) => void);

        app.switchSession(result.switchToSessionId).then(() => {
          // Rebind to new framework
          subMod = app.framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
          app.framework.onTrace(onTrace as (e: unknown) => void);

          const session = app.sessionManager.getActiveSession();
          refreshFromStore();
          addLine(`Session: ${session?.name ?? 'unknown'}`, GRAY);
          state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          updateStatus();
        }).catch(err => {
          addLine(`Session switch failed: ${err}`, RED);
          state.status = 'error';
          updateStatus();
        });
      }
    } else {
      addLine(`You: ${raw}`, GREEN);
      state.status = 'thinking';
      updateStatus();
      app.framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: text, metadata: {}, triggerInference: true,
      });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  const session = app.sessionManager.getActiveSession();
  addLine('Forking Knowledge Miner. Type /help for commands.', GRAY);
  if (session) addLine(`Session: ${session.name}`, DIM_GRAY);
  addLine(`Error log: ${logPath}`, DIM_GRAY);
  app.framework.onTrace(onTrace as (e: unknown) => void);
  loadSessionHistory();

  // ── Cleanup ────────────────────────────────────────────────────────

  function cleanup() {
    cleanupPeek();
    for (const unsub of subagentStreamUnsubs) unsub();
    clearInterval(pollTimer);
    app.framework.offTrace(onTrace as (e: unknown) => void);
    renderer.destroy();
    process.stdout.write('\x1b]0;\x07');
    // Restore stderr
    process.stderr.write = origStderrWrite;
    logStream.end();
    app.framework.stop().then(() => {
      resolveExit?.();
    });
  }

  // ── Wait for exit ──────────────────────────────────────────────────

  await new Promise<void>(resolve => {
    resolveExit = resolve;
  });
}

// ---------------------------------------------------------------------------
// Status bar formatter
// ---------------------------------------------------------------------------

function formatStatusLeft(
  state: TuiState,
  spinnerChar?: string,
  outputTokens?: number,
): string {
  const sColor = state.status === 'idle' ? '✓' : state.status === 'error' ? '✗' : state.status === 'background' ? '↓' : '…';
  let bar = `[${sColor} ${state.status}`;
  if (spinnerChar !== undefined && state.status !== 'idle' && state.status !== 'error' && state.status !== 'background') {
    bar += ` ${spinnerChar}`;
    if (state.status === 'thinking' && outputTokens !== undefined && outputTokens > 0) {
      const tokStr = outputTokens >= 1000 ? (outputTokens / 1000).toFixed(1) + 'k' : String(outputTokens);
      bar += ` ${tokStr} tok`;
    }
  }
  if (state.tool) bar += ` | ${state.tool}`;
  const running = state.subagents.filter(s => s.status === 'running').length;
  if (running > 0) {
    bar += ` | ${running} sub`;
  }
  if (state.viewMode === 'fleet' || state.viewMode === 'peek') {
    bar += state.viewMode === 'peek' ? ` | peek: ${state.peekTarget}` : ' | fleet view';
  } else if (state.viewMode === 'chat') {
    if (state.status === 'background') bar += ' Esc:stop';
    else if (state.status !== 'idle' && state.status !== 'error') bar += ' Ctrl+B:bg Esc:stop';
    if (running > 0) bar += ' Tab:fleet';
  }
  bar += ']';
  return bar;
}

function formatTokens(tokens: TokenUsage, verbose: boolean): string {
  const parts: string[] = [];

  const total = tokens.input + tokens.output;
  if (total > 0) {
    const fmt = (n: number) => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
      return String(n);
    };
    let s = `${fmt(tokens.input)}in ${fmt(tokens.output)}out`;
    if (tokens.cacheRead > 0) s += ` ${fmt(tokens.cacheRead)}cache`;
    parts.push(s);
  }

  parts.push(verbose ? 'C-v:terse' : 'C-v:verbose');
  return parts.join('  ');
}

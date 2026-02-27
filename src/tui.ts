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
import type { AgentFramework } from '@connectome/agent-framework';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { handleCommand } from './commands.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface TuiState {
  status: string;
  tool: string | null;
  subagents: ActiveSubagent[];
  showSubagents: boolean;
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

export async function runTui(framework: AgentFramework): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  const state: TuiState = {
    status: 'idle',
    tool: null,
    subagents: [],
    showSubagents: false,
  };

  let streaming = false;
  let currentStreamText: TextRenderable | null = null;
  let currentStreamBuffer = '';  // Track accumulated text (TextRenderable.content is StyledText, not string)

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
  });

  const statusBar = new TextRenderable(renderer, {
    id: 'status',
    content: formatStatusBar(state),
    fg: GRAY,
  });

  const statusBox = new BoxRenderable(renderer, {
    id: 'status-box',
    height: 1,
    paddingLeft: 1,
  });

  const input = new InputRenderable(renderer, {
    id: 'input',
    placeholder: 'Type a message or /help...',
  });

  const inputBox = new BoxRenderable(renderer, {
    id: 'input-box',
    height: 1,
    paddingLeft: 1,
  });

  // Assembly
  statusBox.add(statusBar);
  inputBox.add(input);
  rootBox.add(scrollBox);
  rootBox.add(statusBox);
  rootBox.add(inputBox);
  renderer.root.add(rootBox);

  input.focus();

  // ── Helpers ───────────────────────────────────────────────────────────

  let messageCounter = 0;

  function addLine(text: string, color: string = WHITE) {
    const line = new TextRenderable(renderer, {
      id: `msg-${++messageCounter}`,
      content: text,
      fg: color,
    });
    scrollBox.add(line);
  }

  function updateStatus() {
    statusBar.content = formatStatusBar(state);
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

  // ── Trace listener ──────────────────────────────────────────────────

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;

    switch (event.type) {
      case 'inference:started': {
        if (agent === 'researcher') {
          state.status = 'thinking';
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        if (content && agent === 'researcher' && streaming) {
          streamToken(content);
        }
        break;
      }

      case 'inference:completed': {
        if (agent === 'researcher') {
          state.status = 'idle';
          state.tool = null;
          if (streaming) endStream();
          updateStatus();
        }
        break;
      }

      case 'inference:failed': {
        if (agent === 'researcher') {
          state.status = 'error';
          if (streaming) endStream();
          addLine(`Error: ${event.error}`, RED);
          updateStatus();
        } else {
          addLine(`[${agent}] Error: ${event.error}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent === 'researcher') {
          state.status = 'tools';
          state.tool = names;
          if (streaming) endStream();
          addLine(`[tools] ${names}`, YELLOW);
        } else {
          const short = (agent ?? '').replace(/^(spawn|fork)-/, '').replace(/-\d+$/, '');
          addLine(`  [${short}] ${names}`, DIM_GRAY);
          const sa = state.subagents.find(s => (agent ?? '').includes(s.name));
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split(':').pop();
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

      case 'tool:started': {
        if (agent === 'researcher') {
          state.tool = event.tool as string;
          updateStatus();
        }
        break;
      }
    }
  }

  // ── Subagent polling ────────────────────────────────────────────────

  const subMod = framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
  const pollTimer = setInterval(() => {
    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      updateStatus();
    }
  }, 500);

  // ── Keyboard ───────────────────────────────────────────────────────

  renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean }) => {
    if (key.name === 'tab') {
      state.showSubagents = !state.showSubagents;
      updateStatus();
    }
    if (key.ctrl && key.name === 'c') {
      cleanup();
    }
  });

  // ── Input handling ─────────────────────────────────────────────────

  let resolveExit: (() => void) | null = null;

  input.on(InputRenderableEvents.ENTER, () => {
    const text = input.value.trim();
    // Clear input
    input.deleteLine();

    if (!text) return;

    if (text.startsWith('/')) {
      const result = handleCommand(text, framework);
      if (result.quit) {
        cleanup();
        return;
      }
      if (text === '/clear') {
        // Remove all children from scroll box
        for (const child of scrollBox.getChildren()) {
          scrollBox.remove(child);
        }
      } else {
        for (const l of result.lines) {
          addLine(l.text, GRAY);
        }
      }
    } else {
      addLine(`You: ${text}`, GREEN);
      framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: text, metadata: {}, triggerInference: true,
      });
    }
  });

  // ── Init ───────────────────────────────────────────────────────────

  addLine('Zulip Knowledge App. Type /help for commands.', GRAY);
  framework.onTrace(onTrace as (e: unknown) => void);

  // ── Cleanup ────────────────────────────────────────────────────────

  function cleanup() {
    clearInterval(pollTimer);
    framework.offTrace(onTrace as (e: unknown) => void);
    renderer.destroy();
    framework.stop().then(() => {
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

function formatStatusBar(state: TuiState): string {
  const sColor = state.status === 'idle' ? '✓' : state.status === 'error' ? '✗' : '…';
  let bar = `[${sColor} ${state.status}`;
  if (state.tool) bar += ` | ${state.tool}`;
  const running = state.subagents.filter(s => s.status === 'running').length;
  if (running > 0) {
    bar += ` | ${running} sub`;
    if (state.showSubagents) {
      const details = state.subagents
        .filter(s => s.status === 'running')
        .map(s => {
          const t = Math.floor((Date.now() - s.startedAt) / 1000);
          const msg = s.statusMessage ? ` ${s.statusMessage}` : '';
          return `${s.name}(${t}s${msg})`;
        }).join(' ');
      bar += ' ' + details;
    } else {
      bar += ' Tab:details';
    }
  }
  bar += ']';
  return bar;
}

# Zulip Knowledge Miner

A TUI-driven application that points an LLM agent at Zulip conversations to extract, organize, and persist structured knowledge. Built on the Afcomech stack (Agent Framework + Context Manager + Membrane + Chronicle) as a dogfooding exercise.

## Goals

1. **Social knowledge extraction** — read Zulip streams, identify decisions, patterns, people, and processes, persist findings as structured lessons with confidence scores and provenance
2. **Parallel exploration** — spawn and fork subagents to analyze multiple streams/topics concurrently, synthesize their findings
3. **Semantic memory** — automatically surface relevant prior knowledge before each inference using a cheap LLM-as-retriever pipeline
4. **Reversibility** — Chronicle-backed undo/redo, named checkpoints, branch exploration via slash commands
5. **Dogfood the AF** — stress-test the agent framework's module system, MCPL integration, context strategies, and multi-agent capabilities

## Architecture

```
                         ┌──────────────┐
                         │   ANSI TUI   │  readline input, scroll region,
                         │   (tui.ts)   │  status bar, streaming tokens
                         └──────┬───────┘
                                │ pushEvent('external-message')
                         ┌──────┴───────┐
                         │  TuiModule   │  event bridge: TUI → context messages
                         └──────┬───────┘
                                │
                    ┌───────────┴───────────┐
                    │   Agent Framework     │
                    │  ┌─────────────────┐  │
                    │  │  researcher     │  │  main agent (Opus)
                    │  │  (event loop)   │  │
                    │  └────────┬────────┘  │
                    │           │            │
                    │  ┌────────┴────────┐  │
                    │  │   Modules       │  │
                    │  │  - subagent     │──┼── spawn/fork ephemeral agents
                    │  │  - lessons      │──┼── CRUD knowledge store (Chronicle)
                    │  │  - retrieval    │──┼── LLM-as-retriever (Haiku)
                    │  │  - tui          │  │
                    │  └────────┬────────┘  │
                    │           │            │
                    │  ┌────────┴────────┐  │
                    │  │  MCPL Server    │  │
                    │  │  (zulip-mcp)    │──┼── list_streams, get_messages, ...
                    │  └─────────────────┘  │
                    └───────────────────────┘
```

### Core data flow

1. User types a message in the TUI
2. `TuiModule` converts it to a context message + triggers inference
3. The researcher agent reads the conversation, calls tools (Zulip, subagent, lessons)
4. Before each inference, `RetrievalModule` and `LessonsModule` inject relevant knowledge via `gatherContext()`
5. Trace events (`inference:tokens`, `tool:started`, etc.) drive the TUI's streaming display

## Project Structure

```
zulip-app/
  src/
    index.ts                 Entry point, framework bootstrap, dual-mode (TUI / piped)
    tui.ts                   OpenTUI-based terminal interface (@opentui/core)
    commands.ts              Slash command handler (Chronicle reversibility)
    prompts/
      system.ts              Researcher agent system prompt
    modules/
      tui-module.ts          Event bridge: external-message → context + inference
      subagent-module.ts     Spawn, fork, launch, wait
      lessons-module.ts      Knowledge CRUD + gatherContext injection
      retrieval-module.ts    3-step LLM-as-retriever pipeline
```

## Components

### TUI (`tui.ts`)

Built on [OpenTUI](https://github.com/anomalyco/opentui) (`@opentui/core`) — the same terminal UI library that powers OpenCode. Requires the Bun runtime.

**Layout**: `ScrollBoxRenderable` (conversation, flexGrow, stickyScroll) + `BoxRenderable` (status bar, height=1) + `InputRenderable` (user input). OpenTUI handles all terminal rendering, cursor management, and input isolation.

**Status bar**: `[status | tool_name | N sub]` — shows agent state, current tool, active subagent count. Tab toggles inline subagent detail.

**Streaming**: Tokens arrive via `inference:tokens` trace events and are appended to a `TextRenderable.content` string. OpenTUI re-renders automatically.

**Dual mode**: If stdout is not a TTY (piped/CI), falls back to a plain readline loop with `waitForInference` promise gating (no OpenTUI dependency on this path).

### Subagent Module (`subagent-module.ts`)

Enables the researcher to delegate work to parallel ephemeral agents.

**Tools**:
| Tool | Behavior |
|------|----------|
| `subagent:spawn` | Fresh agent with system prompt + task. Blocks until complete. |
| `subagent:fork` | Agent inheriting parent's full message history. Blocks until complete. |
| `subagent:launch` | Non-blocking spawn or fork. Returns task ID immediately. |
| `subagent:wait` | Block until specific or all launched tasks complete. |

**Interaction model** (parallel-async-await): When the LLM emits multiple spawn/fork calls in a single turn, the AF dispatches them concurrently. The parent blocks on `waiting_for_tools` until all results arrive together — natural fan-out without explicit orchestration.

**Isolation**: Each ephemeral agent gets its own temporary Chronicle store (temp directory, cleaned up on completion). This prevents message leakage between parent and children.

**Depth limiting**: Constructor takes `maxDepth` (default 3). At the depth limit, subagent tools are stripped from the child's tool set.

**Terminology**: "Fork" and "branch" are distinct concepts:
- **Fork** = spawning a subagent that inherits the parent's compiled messages (agent-level, message copy)
- **Branch** = Chronicle state branch for undo/redo/checkpointing (storage-level, user-facing)

### Lessons Module (`lessons-module.ts`)

Persistent knowledge store backed by Chronicle state snapshots.

**Data model**:
```typescript
interface Lesson {
  id: string;           // Short UUID
  content: string;      // The knowledge itself
  confidence: number;   // 0.0–1.0
  tags: string[];       // people, process, decision, technical, ...
  evidence: string[];   // Source references (stream:topic:messageId)
  created: number;
  updated: number;
  deprecated: boolean;
  deprecationReason?: string;
}
```

**Tools**: `create`, `update`, `deprecate`, `query` (text + tags + confidence filter), `list`, `boost`, `demote`.

**Confidence dynamics**: `boost` applies diminishing-returns growth (`+0.1 * (1 - c)`); `demote` applies diminishing-returns decay (`-0.1 * c`). Lessons below 0.3 confidence are excluded from context injection.

**Context injection**: `gatherContext()` injects the top 10 active lessons (by confidence) as a `## Knowledge Library` block in the system position.

### Retrieval Module (`retrieval-module.ts`)

Semantic memory lookup using a three-step LLM-as-retriever pipeline. Runs in `gatherContext()` before each main-agent inference.

```
 Step 1: Flag concepts        Step 2: Keyword query      Step 3: Validate
 ┌──────────────────┐         ┌──────────────────┐       ┌──────────────────┐
 │ Recent messages   │──Haiku──│ Concept keywords │──DB──│ Candidate lessons │──Haiku──│ Relevant only │
 │ → "What concepts  │         │ ["RFC", "auth"]  │      │ (top 20 by conf.) │        │ (filtered IDs)│
 │   need background │         └──────────────────┘      └──────────────────┘        └───────────────┘
 │   knowledge?"     │
 └──────────────────┘
```

- Steps 1 and 3 use Haiku (~$0.001 each)
- Step 2 is mechanical keyword matching (no LLM call)
- Results cached by context hash — skips entirely if conversation hasn't changed
- Fails open: on error, returns empty (never blocks inference)
- Short-circuits: if only 3 or fewer candidates, skips validation step

### Slash Commands (`commands.ts`)

Chronicle-backed reversibility exposed through the TUI.

| Command | Effect |
|---------|--------|
| `/undo` | Branch at the message before the last agent turn, switch to it |
| `/redo` | Pop from redo stack, switch back |
| `/checkpoint <name>` | Save `(branchId, branchName)` as named point |
| `/restore <name>` | Switch to checkpoint's branch |
| `/branches` | List all Chronicle branches with head positions |
| `/checkout <name>` | Switch to named branch |
| `/history` | Show last 20 messages in summary form |
| `/lessons` | Show lesson library sorted by confidence |
| `/status` | Agent state, branch, queue depth |
| `/clear` | Clear scroll region |

## Framework Integration

The app runs on the `mcpl-first-class` branch of the Agent Framework, which embeds MCPL server management directly in the framework core.

**Key AF extensions made for this app**:
- `createEphemeralAgent()` — creates an agent + context manager with an isolated temp Chronicle store; returns a cleanup function
- `runEphemeralToCompletion()` — temporarily registers an ephemeral agent in the framework's agent map, triggers inference through the normal event loop (full trace events, logging, tool dispatch), resolves when the agent returns to idle
- `executeToolCall()` — routes tool calls to module registry or MCPL servers (used by subagents to access Zulip tools)

**Configuration** (from `index.ts`):
```typescript
const framework = await AgentFramework.create({
  storePath: './data/store',
  membrane,
  agents: [{
    name: 'researcher',
    model: 'claude-opus-4-20250514',
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 8192,
    strategy: new PassthroughStrategy(),
  }],
  modules: [tuiModule, subagentModule, lessonsModule, retrievalModule],
  mcplServers: [{
    id: 'zulip',
    command: 'node',
    args: ['../zulip-mcp/build/index.js'],
    env: { ZULIP_RC_PATH: '.zuliprc' },
  }],
});
```

## Environment

```
ANTHROPIC_API_KEY         Required. API key for Membrane.
MODEL                     Model for the researcher agent. Default: claude-opus-4-20250514
STORE_PATH                Chronicle store location. Default: ./data/store
ZULIP_MCP_CMD             Zulip MCP server command. Default: node
ZULIP_MCP_ARGS            Zulip MCP server args. Default: ../zulip-mcp/build/index.js
ZULIP_RC_PATH             Path to .zuliprc for Zulip bot credentials.
```

## Runtime

**Bun** (not Node.js). OpenTUI's native Zig core requires Bun. Chronicle's N-API bindings are validated under Bun (56 tests in `bun-compat/`).

## Running

```bash
# Interactive TUI (requires TTY)
bun src/index.ts

# Piped mode (CI / testing)
echo -e "/help\n/status\n/quit" | bun src/index.ts

# Dev mode with watch
bun --watch src/index.ts
```

## Dependencies

| Package | Source |
|---------|--------|
| `@connectome/agent-framework` | `../agent-framework` (mcpl-first-class branch) |
| `@connectome/context-manager` | `../context-manager` |
| `chronicle` | `../chronicle` (Rust + N-API bindings) |
| `membrane` | `../membrane` |
| `@opentui/core` | npm (native Zig terminal UI) |
| `zulip-mcp` | `../zulip-mcp` (cloned from `antra-tess/zulip_mcp`) |

## Status

| Feature | Status |
|---------|--------|
| Scaffold + bootstrap | Done |
| Zulip MCP integration | Done |
| OpenTUI TUI (streaming, status bar, input) | Done |
| Piped/CI mode | Done |
| Subagent spawn/fork/launch/wait | Done |
| Lessons CRUD + persistence | Done |
| Retrieval pipeline (LLM-as-retriever) | Done |
| Chronicle reversibility (undo/redo/checkpoint) | Done |
| Subagent TUI visibility (Tab toggle) | Done |
| Bun + Chronicle compatibility | Validated (56 tests) |
| End-to-end knowledge extraction session | Not yet tested |
| KnowledgeStrategy (context compression) | Not started |
| Tests | Not started |

## Commit History

```
595c10c Fix streaming token rendering + allow typing during inference
f4ff6e7 Replace Ink/React TUI with custom ANSI terminal
2a06353 Subagents now run through the framework event loop
3aea685 Fix TUI rendering interleave, add Tab-togglable subagent panel
295bc21 Fix agent not responding: add TuiModule for message routing
6927b6d Add --no-tui readline mode for piped/CI usage
44c42ea Initial scaffold: TUI knowledge extraction app for Zulip
```

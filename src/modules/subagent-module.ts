/**
 * SubagentModule — spawn and fork ephemeral subagents.
 *
 * Tools:
 *   subagent--spawn  — Fresh agent with system prompt + task, no inherited context
 *   subagent--fork   — Agent inheriting parent's compiled context
 *   subagent--hud    — Toggle fleet status HUD overlay
 *
 * By default, spawn/fork are async: they return immediately and deliver
 * results as user messages + inference-request events. Pass `sync: true`
 * to block until completion.
 *
 * Sync tasks are detachable: user can push them to background mid-flight
 * via Ctrl+B in TUI, or they auto-detach after `timeoutMs` if specified.
 * Both spawn and fork accept `timeoutMs` for per-task execution deadlines.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
  ContextManager,
} from '@connectome/agent-framework';
import type { AgentFramework } from '@connectome/agent-framework';
import { KnowledgeStrategy } from '@connectome/agent-framework';
import type { ContentBlock } from 'membrane';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentModuleConfig {
  /** Maximum fork/spawn depth (default: 3) */
  maxDepth?: number;
  /** Current depth (incremented for child subagent modules) */
  currentDepth?: number;
  /** Default model for subagents */
  defaultModel?: string;
  /** Default max tokens per subagent inference */
  defaultMaxTokens?: number;
  /** Which parent agent this module serves (for fork context access) */
  parentAgentName?: string;
  /** Max concurrent subagent executions (default: 3) */
  maxConcurrent?: number;
  /** Max prompt tokens before failing fast (default: 190000) */
  maxPromptTokens?: number;
  /** Max execution time per subagent in ms (default: 600000 = 10 min) */
  maxExecutionMs?: number;
  /** Max restart attempts on transient errors (default: 2) */
  maxRetries?: number;
}

export interface SubagentResult {
  summary: string;
  findings: string[];
  issues: string[];
  toolCallsCount: number;
}

interface SpawnInput {
  name: string;
  systemPrompt: string;
  task: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
  sync?: boolean;
  timeoutMs?: number;
}

interface ForkInput {
  name: string;
  task: string;
  systemPrompt?: string;
  model?: string;
  sync?: boolean;
  timeoutMs?: number;
}

/** Handle for an async (fire-and-forget) subagent. */
interface AsyncSubagentHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
}

/**
 * Handle for a sync subagent that can be detached mid-flight.
 * When detached, the blocking tool call resolves immediately and
 * the subagent continues running, delivering results async.
 */
interface DetachableHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
  detach: () => void;
}

/**
 * Non-retryable termination of a subagent. All abnormal-but-expected exits
 * (user cancel, zombie reclaim, depth limit, etc.) use this so the catch
 * path can distinguish "killed" from "transient network error".
 */
export class SubagentTerminated extends Error {
  constructor(
    public readonly reason: 'cancelled' | 'zombie' | 'killed',
    public readonly partialOutput: string,
    message?: string,
  ) {
    super(message ?? `Subagent terminated: ${reason}`);
    this.name = 'SubagentTerminated';
  }
}

/** Persisted subagent state (stored in Chronicle module state). */
interface PersistedSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  toolCallsCount: number;
  findingsCount: number;
  statusMessage?: string;
  parent?: string;
}

/** Observable state of an active subagent, for TUI display. */
export interface ActiveSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  statusMessage?: string;
  toolCallsCount: number;
  findingsCount: number;
}

/** Live state captured for peek observability. */
interface LiveSubagentState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: ContextManager;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  /** Track callIds from tool_calls_yielded so we can route tool:* events back. */
  activeCallIds: Set<string>;
}

/** Streaming event pushed to peek subscribers. */
export type SubagentStreamEvent =
  | { type: 'inference:started' }
  | { type: 'tokens'; content: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; input?: unknown }> }
  | { type: 'tool:started'; tool: string; input?: unknown }
  | { type: 'tool:completed'; tool: string; durationMs: number }
  | { type: 'tool:failed'; tool: string; error: string }
  | { type: 'inference:completed' }
  | { type: 'inference:failed'; error: string }
  | { type: 'stream_resumed' }
  | { type: 'done'; summary: string; lastInputTokens?: number };

export type SubagentStreamCallback = (event: SubagentStreamEvent) => void;

/** Snapshot returned by peek(). */
export interface SubagentPeekSnapshot {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  elapsedMs: number;
  messageCount: number;
  lastMessageSnippet: string;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  toolCallsCount: number;
  /** True if the subagent appears stalled: running status, no active stream, elapsed > threshold. */
  isZombie: boolean;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SubagentModule implements Module {
  readonly name = 'subagent';

  private ctx: ModuleContext | null = null;
  private config: SubagentModuleConfig;
  private framework: AgentFramework | null = null;
  private maxDepth: number;
  private currentDepth: number;
  private asyncHandles = new Map<string, AsyncSubagentHandle>();
  private detachableHandles = new Map<string, DetachableHandle>();

  // Concurrency control — adaptive rate-limit-aware semaphore
  private configuredMaxConcurrent: number;   // User's ceiling
  private effectiveConcurrent: number;       // Current effective limit (may be reduced)
  private activeConcurrent = 0;
  private waitQueue: Array<() => void> = [];
  private consecutiveSuccesses = 0;
  private lastRateLimitAt = 0;
  private rateLimitCooldownMs = 30_000;      // Delay after rate limit before releasing next slot

  // Prompt size guard
  private maxPromptTokens: number;

  // Per-subagent execution deadline
  private maxExecutionMs: number;

  // Retry on transient errors
  private maxRetries: number;

  /** Observable registry of active/recent subagents for TUI display. */
  readonly activeSubagents = new Map<string, ActiveSubagent>();

  /** Parent agent name for each subagent (for fleet tree reconstruction). */
  readonly parentMap = new Map<string, string>();

  // Stashed results from subagent--return tool calls, keyed by framework agent name
  private returnedResults = new Map<string, string>();

  // Live state for peek observability
  private liveSubagents = new Map<string, LiveSubagentState>();          // keyed by displayName
  private frameworkNameIndex = new Map<string, string>();                 // frameworkAgentName → displayName
  private callIdIndex = new Map<string, string>();                        // toolCallId → displayName
  private streamSubscribers = new Map<string, Set<SubagentStreamCallback>>();  // displayName → callbacks
  private lastInputTokens = new Map<string, number>();  // displayName → last known input token count
  private cancellationHandles = new Map<string, { reject: (err: Error) => void }>();  // displayName → cancel
  private agentDepths = new Map<string, number>();  // framework agent name → fork depth

  constructor(config: SubagentModuleConfig = {}) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? 3;
    this.currentDepth = config.currentDepth ?? 0;
    this.configuredMaxConcurrent = config.maxConcurrent ?? 5;
    this.effectiveConcurrent = this.configuredMaxConcurrent;
    this.maxPromptTokens = config.maxPromptTokens ?? 190_000;
    this.maxExecutionMs = config.maxExecutionMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /** Set the framework reference. Must be called after framework creation. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;

    // Subscribe to traces for peek observability + streaming fanout
    framework.onTrace((event: TraceEvent) => {
      // Events with agentName: inference lifecycle
      const agentName = 'agentName' in event ? (event as { agentName: string }).agentName : null;

      if (agentName) {
        const displayName = this.frameworkNameIndex.get(agentName);
        if (!displayName) return;
        const live = this.liveSubagents.get(displayName);
        if (!live) return;

        // inference:usage is emitted at runtime but not in the TraceEvent union — handle it first
        if ((event as { type: string }).type === 'inference:usage') {
          const roundUsage = (event as { tokenUsage?: { input?: number } }).tokenUsage;
          if (roundUsage?.input) this.lastInputTokens.set(displayName, roundUsage.input);
          return;
        }

        switch (event.type) {
          case 'inference:started':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.activeCallIds.clear();
            this.emit(displayName, { type: 'inference:started' });
            break;
          case 'inference:tokens': {
            const content = (event as { content?: string }).content ?? '';
            live.currentStream += content;
            this.emit(displayName, { type: 'tokens', content });
            break;
          }
          case 'inference:tool_calls_yielded': {
            const calls = (event as { calls?: Array<{ id: string; name: string; input?: unknown }> }).calls ?? [];
            live.pendingToolCalls = calls.map(c => ({ name: c.name, input: c.input }));
            live.currentStream = '';
            // Index callIds so we can route tool:* events back
            for (const c of calls) {
              live.activeCallIds.add(c.id);
              this.callIdIndex.set(c.id, displayName);
            }
            this.emit(displayName, { type: 'tool_calls', calls: calls.map(c => ({ name: c.name, input: c.input })) });
            break;
          }
          case 'inference:stream_resumed':
            live.currentStream = '';
            live.pendingToolCalls = [];
            this.emit(displayName, { type: 'stream_resumed' });
            break;
          case 'inference:completed': {
            const usage = (event as { tokenUsage?: { input?: number } }).tokenUsage;
            if (usage?.input) this.lastInputTokens.set(displayName, usage.input);
            this.emit(displayName, { type: 'inference:completed' });
            break;
          }
          case 'inference:failed': {
            const error = (event as { error?: string }).error ?? 'Unknown error';
            this.emit(displayName, { type: 'inference:failed', error });
            break;
          }
        }
        return;
      }

      // Events with callId: tool lifecycle (no agentName)
      const callId = 'callId' in event ? (event as { callId: string }).callId : null;
      if (callId) {
        const displayName = this.callIdIndex.get(callId);
        if (!displayName) return;

        switch (event.type) {
          case 'tool:started': {
            const e = event as { tool: string; input?: unknown };
            this.emit(displayName, { type: 'tool:started', tool: e.tool, input: e.input });
            break;
          }
          case 'tool:completed': {
            const e = event as { tool: string; durationMs: number };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:completed', tool: e.tool, durationMs: e.durationMs });
            break;
          }
          case 'tool:failed': {
            const e = event as { tool: string; error: string };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:failed', tool: e.tool, error: e.error });
            break;
          }
        }
      }
    });
  }

  private getFramework(): AgentFramework {
    if (!this.framework) throw new Error('SubagentModule: framework not set. Call setFramework() after creating the framework.');
    return this.framework;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    // Restore in-memory state from Chronicle (for session restore / branch switch)
    this.restoreFromStore();
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  /**
   * Persist subagent registry to Chronicle module state.
   * Called after each lifecycle transition so branch ops get correct fleet.
   */
  private persistState(): void {
    if (!this.ctx) return;
    const agents: Record<string, PersistedSubagent> = {};
    for (const [key, sa] of this.activeSubagents) {
      agents[key] = {
        name: sa.name,
        type: sa.type,
        task: sa.task,
        status: sa.status,
        startedAt: sa.startedAt,
        completedAt: sa.completedAt,
        toolCallsCount: sa.toolCallsCount,
        findingsCount: sa.findingsCount,
        statusMessage: sa.statusMessage,
        parent: this.parentMap.get(sa.name),
      };
    }
    this.ctx.setState({ agents });
  }

  /**
   * Restore activeSubagents + parentMap from Chronicle module state.
   * Marks any 'running' entries as 'interrupted' since the actual processes are gone.
   */
  restoreFromStore(): void {
    if (!this.ctx) return;
    const persisted = this.ctx.getState<{ agents?: Record<string, PersistedSubagent> }>();
    if (!persisted?.agents) return;

    this.activeSubagents.clear();
    this.parentMap.clear();

    for (const [key, pa] of Object.entries(persisted.agents)) {
      const sa: ActiveSubagent = {
        name: pa.name,
        type: pa.type,
        task: pa.task,
        status: pa.status === 'running' ? 'completed' : pa.status,
        startedAt: pa.startedAt,
        completedAt: pa.completedAt ?? (pa.status === 'running' ? Date.now() : undefined),
        toolCallsCount: pa.toolCallsCount,
        findingsCount: pa.findingsCount,
        statusMessage: pa.status === 'running' ? 'interrupted (branch/session switch)' : pa.statusMessage,
      };
      this.activeSubagents.set(key, sa);
      if (pa.parent) {
        this.parentMap.set(pa.name, pa.parent);
      }
    }
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'spawn',
        description: 'Spawn a fresh subagent with a system prompt and task. Async by default — returns immediately and delivers results as a message. Pass sync:true to block until completion.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the subagent' },
            systemPrompt: { type: 'string', description: 'System prompt for the subagent' },
            task: { type: 'string', description: 'The task for the subagent to perform' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max tokens per inference (optional)' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent can use (default: all). Note: subagent--return is always included automatically.',
            },
            sync: { type: 'boolean', description: 'If true, block until subagent completes (default: false)' },
            timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds. For async tasks, the subagent is cancelled after this duration. For sync tasks, auto-detaches to background after this duration (result delivered as message). Example: 600000 = 10 minutes.' },
          },
          required: ['name', 'systemPrompt', 'task'],
        },
      },
      {
        name: 'fork',
        description: 'Fork a subagent that inherits your current context. Async by default — returns immediately and delivers results as a message. Pass sync:true to block until completion.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the forked agent' },
            task: { type: 'string', description: 'Additional task for the fork to perform' },
            systemPrompt: { type: 'string', description: 'Override system prompt (optional, defaults to parent)' },
            model: { type: 'string', description: 'Model override (optional)' },
            sync: { type: 'boolean', description: 'If true, block until fork completes (default: false)' },
            timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds. For async tasks, the subagent is cancelled after this duration. For sync tasks, auto-detaches to background after this duration (result delivered as message). Example: 600000 = 10 minutes.' },
          },
          required: ['name', 'task'],
        },
      },
      {
        name: 'hud',
        description: 'Toggle the subagent fleet HUD overlay. When enabled, a compact fleet status summary is injected before each inference.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable or disable the fleet HUD' },
          },
          required: ['enabled'],
        },
      },
      {
        name: 'concurrency',
        description: 'View or adjust subagent concurrency. Omit maxConcurrent to just view status. Concurrency auto-adapts to rate limits (halves on 429, recovers after successes).',
        inputSchema: {
          type: 'object',
          properties: {
            maxConcurrent: { type: 'number', description: 'Set new concurrency ceiling (min 1)' },
          },
        },
      },
      {
        name: 'peek',
        description: 'Peek at a running subagent\'s live state: status, elapsed time, message count, last message snippet, current streaming output, and pending tool calls. Omit name to peek at all running subagents.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Subagent name to peek at (omit for all)' },
          },
        },
      },
      {
        name: 'return',
        description: 'Return results from a fork or spawn back to the parent agent. Call this when you have completed your task. Your result text will be delivered to the parent as the tool result of the fork/spawn call. This ends your execution.',
        inputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'Your findings, summary, or results to return to the parent' },
          },
          required: ['result'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const caller = call.callerAgentName;
    switch (call.name) {
      case 'spawn':
        return this.handleSpawn(call.input as SpawnInput, caller);
      case 'fork':
        return this.handleFork(call.input as ForkInput, caller);
      case 'hud':
        return this.handleHud(call.input as { enabled: boolean });
      case 'concurrency':
        return this.handleConcurrency(call.input as { maxConcurrent?: number });
      case 'peek':
        return this.handlePeek(call.input as { name?: string });
      case 'return': {
        // Stash the result keyed by the tool call ID. The completion path
        // in runSpawn/runFork will pick it up via the callIdIndex → displayName.
        const result = (call.input as { result: string }).result;
        // Find which subagent is calling this via the callIdIndex
        const callerName = this.callIdIndex.get(call.id);
        if (callerName) {
          this.returnedResults.set(callerName, result);
        }
        return { success: true, data: 'Result received.', endTurn: true };
      }
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  async gatherContext(_agentName: string): Promise<import('@connectome/context-manager').ContextInjection[]> {
    if (!this.ctx) return [];
    const persisted = this.ctx.getState<{ hudEnabled?: boolean }>() ?? {};
    if (!persisted.hudEnabled) return [];

    const lines: string[] = [];
    for (const [, sa] of this.activeSubagents) {
      const elapsed = sa.completedAt
        ? Math.floor((sa.completedAt - sa.startedAt) / 1000)
        : Math.floor((Date.now() - sa.startedAt) / 1000);
      const parent = this.parentMap.get(sa.name) ?? 'researcher';
      const parentShort = parent.replace(/^(spawn|fork)-/, '').replace(/-d\d+-\d+$/, '').replace(/-retry\d+$/, '');
      const task = sa.task.length > 50 ? sa.task.slice(0, 47) + '...' : sa.task;
      lines.push(`  ${sa.name} [${sa.type}] ${sa.status} ${elapsed}s ${sa.toolCallsCount}calls parent:${parentShort} "${task}"`);
    }

    // Also show async handles still running
    for (const [name] of this.asyncHandles) {
      if (!this.activeSubagents.has(name) && !this.activeSubagents.has(`spawn-${name}`)) {
        lines.push(`  ${name} [async] pending`);
      }
    }

    if (lines.length === 0) return [];

    return [{
      namespace: 'subagent-fleet',
      position: 'afterUser',
      content: [{ type: 'text', text: `[Fleet Status]\n${lines.join('\n')}` }],
    }];
  }

  // =========================================================================
  // Concurrency Control (adaptive, rate-limit-aware)
  // =========================================================================

  /**
   * Acquire a concurrency slot. Returns how long the caller waited (0 = immediate).
   * Throws if the slot is not acquired within `slotTimeoutMs`.
   */
  private async acquireSlot(slotTimeoutMs = 120_000): Promise<{ waitedMs: number }> {
    if (this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      return { waitedMs: 0 };
    }

    // Before queueing, try to reclaim slots from zombie subagents
    const reclaimedZombies = this.reclaimZombieSlots();
    if (reclaimedZombies > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      return { waitedMs: 0 };
    }

    const startWait = Date.now();
    return new Promise<{ waitedMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the wait queue
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx >= 0) this.waitQueue.splice(idx, 1);

        // Last-chance zombie reclamation before failing
        const reclaimed = this.reclaimZombieSlots();
        if (reclaimed > 0 && this.activeConcurrent < this.effectiveConcurrent) {
          this.activeConcurrent++;
          resolve({ waitedMs: Date.now() - startWait });
          return;
        }

        reject(new Error(
          `Timed out waiting for a concurrency slot after ${slotTimeoutMs}ms ` +
          `(${this.activeConcurrent}/${this.effectiveConcurrent} slots in use, ` +
          `${this.waitQueue.length} still queued). ` +
          `Limit parallel forks/spawns to ${this.effectiveConcurrent}.`
        ));
      }, slotTimeoutMs);

      const onSlot = () => {
        clearTimeout(timer);
        resolve({ waitedMs: Date.now() - startWait });
      };

      this.waitQueue.push(onSlot);
    });
  }

  /**
   * Scan for zombie subagents and force-release their concurrency slots.
   * A zombie is a subagent that's been "running" for >30s with no active
   * inference stream and no pending tool calls.
   * Returns the number of slots reclaimed.
   */
  private reclaimZombieSlots(): number {
    const ZOMBIE_THRESHOLD_MS = 30_000;
    let reclaimed = 0;

    for (const [displayName, live] of this.liveSubagents) {
      let entry: ActiveSubagent | undefined;
      for (const e of this.activeSubagents.values()) {
        if (e.name === displayName) { entry = e; break; }
      }
      if (!entry || entry.status !== 'running') continue;

      const elapsed = Date.now() - entry.startedAt;
      const isZombie = elapsed > ZOMBIE_THRESHOLD_MS
        && !live.currentStream
        && live.pendingToolCalls.length === 0;

      if (isZombie) {
        console.error(
          `[subagent] Reclaiming zombie slot: "${displayName}" ` +
          `(running for ${(elapsed / 1000).toFixed(0)}s with no active stream)`
        );

        // Cancel the zombie's framework agent
        try {
          const agent = this.getFramework().getAgent(live.frameworkAgentName);
          if (agent) agent.cancelStream();
        } catch { /* best-effort */ }

        // Cancel via cancellation handle (unblocks the Promise.race in runSpawn/runFork)
        const handle = this.cancellationHandles.get(displayName);
        if (handle) {
          const partial = live.currentStream ?? '';
          handle.reject(new SubagentTerminated(
            'zombie',
            partial,
            `Zombie detected: "${displayName}" ran for ${(elapsed / 1000).toFixed(0)}s ` +
            `without starting inference. Slot reclaimed.`,
          ));
          this.cancellationHandles.delete(displayName);
        }

        entry.status = 'failed';
        entry.completedAt = Date.now();
        entry.statusMessage = 'zombie — slot reclaimed';

        // Release the slot (the finally block in runSpawn/runFork will also
        // call releaseSlot, but that's safe — activeConcurrent just goes to
        // max(0, activeConcurrent-1) effectively)
        this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
        reclaimed++;
      }
    }

    return reclaimed;
  }

  private releaseSlot(): void {
    if (this.activeConcurrent <= 0) return; // Guard against double-release (e.g., zombie reclamation + finally)
    this.activeConcurrent--;
    if (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      this.waitQueue.shift()!();
    }
  }

  /** Format a concurrency notice for tool results (empty string if no wait). */
  private concurrencyNotice(waitedMs: number): string {
    if (waitedMs <= 0) return '';
    const secs = (waitedMs / 1000).toFixed(1);
    return `[Concurrency notice: this agent waited ${secs}s for a slot ` +
      `(${this.effectiveConcurrent} concurrent limit). ` +
      `To avoid delays, limit parallel forks/spawns to ${this.effectiveConcurrent}.]\n\n`;
  }

  /** Call on successful subagent completion — gradually recovers concurrency. */
  private onSubagentSuccess(): void {
    this.consecutiveSuccesses++;
    // After 3 consecutive successes, try increasing by 1
    if (this.consecutiveSuccesses >= 3 && this.effectiveConcurrent < this.configuredMaxConcurrent) {
      this.effectiveConcurrent++;
      this.consecutiveSuccesses = 0;
    }
  }

  /** Call on rate limit error — halves concurrency and applies cooldown. */
  private async onRateLimitHit(): Promise<void> {
    const prev = this.effectiveConcurrent;
    this.effectiveConcurrent = Math.max(1, Math.floor(this.effectiveConcurrent / 2));
    this.consecutiveSuccesses = 0;
    this.lastRateLimitAt = Date.now();
    console.error(
      `[subagent] Rate limit hit — concurrency ${prev} → ${this.effectiveConcurrent}, ` +
      `cooling down ${this.rateLimitCooldownMs}ms`
    );
    await new Promise(resolve => setTimeout(resolve, this.rateLimitCooldownMs));
  }

  private isRateLimitError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('rate') || msg.includes('429') || msg.includes('too many');
  }

  /** Transient = worth retrying the whole subagent from scratch. */
  private isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('idle') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('stream aborted') ||
      msg.includes('overloaded') ||
      msg.includes('529') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      this.isRateLimitError(err)
    );
  }

  /** Set concurrency ceiling at runtime. Also raises effective if below new ceiling. */
  setConcurrency(n: number): void {
    this.configuredMaxConcurrent = Math.max(1, n);
    if (this.effectiveConcurrent > this.configuredMaxConcurrent) {
      this.effectiveConcurrent = this.configuredMaxConcurrent;
    }
    // If we were throttled below the new ceiling, let waiters through
    while (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      this.waitQueue.shift()!();
    }
  }

  /** Get current concurrency status for observability. */
  getConcurrencyStatus(): { configured: number; effective: number; active: number; queued: number } {
    return {
      configured: this.configuredMaxConcurrent,
      effective: this.effectiveConcurrent,
      active: this.activeConcurrent,
      queued: this.waitQueue.length,
    };
  }

  // =========================================================================
  // Subagent Cancellation
  // =========================================================================

  /**
   * Force-stop a running subagent. Aborts the active HTTP stream and
   * causes runSpawn/runFork to return with a "[Stopped by user]" result.
   * Returns true if the subagent was found and cancelled.
   */
  cancelSubagent(displayName: string): boolean {
    // Cancel children first (bottom-up) so their results propagate before the parent dies
    this.cancelChildren(displayName);

    const handle = this.cancellationHandles.get(displayName);
    if (!handle) return false;

    // Abort the active inference stream (cancels the HTTP request)
    const live = this.liveSubagents.get(displayName);
    const partial = live?.currentStream ?? '';
    if (live) {
      try {
        const agent = this.getFramework().getAgent(live.frameworkAgentName);
        if (agent) agent.cancelStream();
      } catch { /* best-effort */ }
    }

    // Unblock the Promise.race in runSpawn/runFork
    handle.reject(new SubagentTerminated('cancelled', partial, `Subagent "${displayName}" cancelled by user`));
    return true;
  }

  /**
   * Cancel all running subagents (e.g. on user Esc).
   * Returns the number of subagents cancelled.
   */
  cancelAll(): number {
    // Collect all cancellable names first to avoid mutation during iteration
    const names = [...this.cancellationHandles.keys()];
    let count = 0;
    for (const name of names) {
      if (this.cancelSubagent(name)) count++;
    }
    return count;
  }

  /**
   * Cancel all children (direct + transitive) of the given display name.
   * Uses the parentMap to find descendants via framework agent names.
   */
  private cancelChildren(displayName: string): void {
    const live = this.liveSubagents.get(displayName);
    if (!live) return;

    // Find direct children: entries in parentMap whose parent is this agent's framework name
    const frameworkName = live.frameworkAgentName;
    const children: string[] = [];
    for (const [childName, parentFrameworkName] of this.parentMap) {
      if (parentFrameworkName === frameworkName) {
        children.push(childName);
      }
    }

    // Cancel each child (which recursively cancels its children)
    for (const child of children) {
      this.cancelSubagent(child);
    }
  }

  // =========================================================================
  // Peek Observability
  // =========================================================================

  private registerLive(
    displayName: string,
    frameworkAgentName: string,
    systemPrompt: string,
    contextManager: ContextManager,
  ): void {
    this.liveSubagents.set(displayName, {
      frameworkAgentName,
      displayName,
      systemPrompt,
      contextManager,
      currentStream: '',
      pendingToolCalls: [],
      activeCallIds: new Set(),
    });
    this.frameworkNameIndex.set(frameworkAgentName, displayName);
  }

  private unregisterLive(displayName: string, frameworkAgentName: string): void {
    // Clean up callId index entries for this subagent
    const live = this.liveSubagents.get(displayName);
    if (live) {
      for (const callId of live.activeCallIds) {
        this.callIdIndex.delete(callId);
      }
    }
    this.liveSubagents.delete(displayName);
    this.frameworkNameIndex.delete(frameworkAgentName);
  }

  /** Fan out a stream event to all subscribers for this subagent + wildcard. */
  private emit(displayName: string, event: SubagentStreamEvent): void {
    for (const key of [displayName, '*']) {
      const subs = this.streamSubscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb(event); } catch { /* subscriber error — don't break the loop */ }
      }
    }
  }

  /**
   * Subscribe to a running subagent's live stream. Receives all inference
   * and tool events as they happen. Returns an unsubscribe function.
   *
   * If name is '*', subscribes to events from ALL subagents (events are
   * the same type — use peek() to get the subagent name if needed).
   */
  onPeekStream(name: string, callback: SubagentStreamCallback): () => void {
    if (!this.streamSubscribers.has(name)) {
      this.streamSubscribers.set(name, new Set());
    }
    this.streamSubscribers.get(name)!.add(callback);

    return () => {
      const subs = this.streamSubscribers.get(name);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) this.streamSubscribers.delete(name);
      }
    };
  }

  /**
   * Peek at a running subagent's live state: full context, streaming output,
   * pending tool calls. Returns null if the subagent is not running.
   * If name is omitted, returns snapshots for all running subagents.
   */
  async peek(name?: string): Promise<SubagentPeekSnapshot[]> {
    if (name) {
      const snapshot = await this.peekOne(name);
      return snapshot ? [snapshot] : [];
    }
    const results: SubagentPeekSnapshot[] = [];
    for (const displayName of this.liveSubagents.keys()) {
      const snapshot = await this.peekOne(displayName);
      if (snapshot) results.push(snapshot);
    }
    return results;
  }

  private async peekOne(displayName: string): Promise<SubagentPeekSnapshot | null> {
    const live = this.liveSubagents.get(displayName);
    if (!live) return null;

    // Find the matching ActiveSubagent entry for status/metadata
    let entry: ActiveSubagent | undefined;
    for (const e of this.activeSubagents.values()) {
      if (e.name === displayName) { entry = e; break; }
    }

    let messageCount = 0;
    let lastMessageSnippet = '';
    try {
      const compiled = await live.contextManager.compile();
      messageCount = compiled.messages.length;
      // Extract a short snippet from the last message for observability
      // without dumping the entire context into the caller's window.
      if (compiled.messages.length > 0) {
        const last = compiled.messages[compiled.messages.length - 1];
        const textBlocks = last.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        const fullText = textBlocks.join(' ');
        lastMessageSnippet = fullText.length > 500 ? fullText.slice(-500) : fullText;
      }
    } catch {
      // Context manager may be mid-modification; return what we have
    }

    const elapsedMs = entry ? Date.now() - entry.startedAt : 0;

    // Zombie detection: running for >30s with no active stream and no pending tool calls
    const ZOMBIE_THRESHOLD_MS = 30_000;
    const isZombie = (entry?.status === 'running')
      && elapsedMs > ZOMBIE_THRESHOLD_MS
      && !live.currentStream
      && live.pendingToolCalls.length === 0;

    return {
      name: displayName,
      type: entry?.type ?? 'spawn',
      task: entry?.task ?? '',
      status: entry?.status ?? 'running',
      startedAt: entry?.startedAt ?? 0,
      elapsedMs,
      messageCount,
      lastMessageSnippet,
      currentStream: live.currentStream,
      pendingToolCalls: live.pendingToolCalls,
      toolCallsCount: entry?.toolCallsCount ?? 0,
      isZombie,
    };
  }

  // =========================================================================
  // Execution Timeout
  // =========================================================================

  private withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Subagent ${name} timed out after ${this.maxExecutionMs}ms`)),
          this.maxExecutionMs,
        )
      ),
    ]);
  }

  // =========================================================================
  // Prompt Size Estimation
  // =========================================================================

  private estimatePromptTokens(
    systemPrompt: string,
    messages: Array<{ content: ContentBlock[] }>,
    tools: ToolDefinition[],
  ): number {
    let tokens = Math.ceil(systemPrompt.length / 4) + 50; // system + overhead

    for (const msg of messages) {
      tokens += 50; // per-message overhead (role, formatting)
      for (const block of msg.content) {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }

    for (const tool of tools) {
      tokens += 100; // per-tool overhead
      tokens += Math.ceil(JSON.stringify(tool).length / 4);
    }

    return tokens;
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private async handleSpawn(input: SpawnInput, callerAgentName?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'researcher';

    // Apply per-task timeout override if provided
    const savedMaxExecution = this.maxExecutionMs;
    if (input.timeoutMs !== undefined) {
      this.maxExecutionMs = input.timeoutMs;
    }

    // Sync mode: block until completion, but detachable mid-flight
    if (input.sync) {
      const promise = this.runSpawn(input, callerAgentName, callerDepth);

      // Create a detachable wrapper: resolves either when the subagent completes
      // or when detach() is called (user Ctrl+B or auto-timeout)
      const result = await this.runDetachable(input.name, 'spawn', promise, parentAgentName, input.timeoutMs);
      this.maxExecutionMs = savedMaxExecution;
      return result;
    }

    // Async mode (default): fire-and-forget, deliver result as message
    const promise = this.runSpawn(input, callerAgentName, callerDepth);
    this.asyncHandles.set(input.name, { name: input.name, type: 'spawn', promise, parentAgentName });
    this.maxExecutionMs = savedMaxExecution;

    promise
      .then(result => this.deliverAsyncResult(input.name, result, parentAgentName))
      .catch(err => this.deliverAsyncError(input.name, err, parentAgentName));

    return { success: true, data: `Subagent '${input.name}' spawned. Running in background.` };
  }

  private async handleFork(input: ForkInput, callerAgentName?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'researcher';

    // Apply per-task timeout override if provided
    const savedMaxExecution = this.maxExecutionMs;
    if (input.timeoutMs !== undefined) {
      this.maxExecutionMs = input.timeoutMs;
    }

    // Sync mode: block until completion, but detachable mid-flight
    if (input.sync) {
      const promise = this.runFork(input, callerAgentName, callerDepth);

      const result = await this.runDetachable(input.name, 'fork', promise, parentAgentName, input.timeoutMs);
      this.maxExecutionMs = savedMaxExecution;
      return result;
    }

    // Async mode (default): fire-and-forget, deliver result as message
    const promise = this.runFork(input, callerAgentName, callerDepth);
    this.asyncHandles.set(input.name, { name: input.name, type: 'fork', promise, parentAgentName });
    this.maxExecutionMs = savedMaxExecution;

    promise
      .then(result => this.deliverAsyncResult(input.name, result, parentAgentName))
      .catch(err => this.deliverAsyncError(input.name, err, parentAgentName));

    return { success: true, data: `Subagent '${input.name}' forked. Running in background.` };
  }

  private deliverAsyncResult(name: string, result: SubagentResult, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' returned]\n\n${result.summary}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-completed:${name}`,
      source: 'subagent',
    });
  }

  private deliverAsyncError(name: string, err: unknown, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    const message = err instanceof Error ? err.message : String(err);
    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' failed]\n\nError: ${message}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-failed:${name}`,
      source: 'subagent',
    });
  }

  // =========================================================================
  // Detachable sync → async transition
  // =========================================================================

  /**
   * Run a sync subagent with the ability to detach mid-flight.
   * Returns a ToolResult — either the completed result (if it finishes in time)
   * or a "moved to background" acknowledgment (if detached by user or timeout).
   */
  private async runDetachable(
    name: string,
    type: 'spawn' | 'fork',
    promise: Promise<SubagentResult>,
    parentAgentName: string,
    autoDetachMs?: number,
  ): Promise<ToolResult> {
    let detachResolve: ((value: 'detached') => void) | null = null;
    const detachPromise = new Promise<'detached'>(resolve => { detachResolve = resolve; });

    const handle: DetachableHandle = {
      name,
      type,
      promise,
      parentAgentName,
      detach: () => detachResolve?.('detached'),
    };
    this.detachableHandles.set(name, handle);

    // Optional auto-detach timeout (sync → async after N ms)
    let autoTimer: ReturnType<typeof setTimeout> | null = null;
    if (autoDetachMs !== undefined) {
      autoTimer = setTimeout(() => {
        if (this.detachableHandles.has(name)) {
          handle.detach();
        }
      }, autoDetachMs);
    }

    type RaceResult =
      | { kind: 'completed'; result: SubagentResult }
      | { kind: 'error'; error: unknown }
      | { kind: 'detached' };

    try {
      const winner: RaceResult = await Promise.race([
        promise.then(
          (result): RaceResult => ({ kind: 'completed', result }),
          (err): RaceResult => ({ kind: 'error', error: err }),
        ),
        detachPromise.then((): RaceResult => ({ kind: 'detached' })),
      ]);

      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);

      if (winner.kind === 'completed') {
        return { success: true, data: winner.result };
      }

      if (winner.kind === 'error') {
        const err = winner.error;
        return {
          success: false,
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // Detached: transition to async — wire up result delivery
      this.asyncHandles.set(name, { name, type, promise, parentAgentName });
      promise
        .then(result => this.deliverAsyncResult(name, result, parentAgentName))
        .catch(err => this.deliverAsyncError(name, err, parentAgentName));

      return {
        success: true,
        data: `Subagent '${name}' moved to background. Results will be delivered as a message when complete.`,
      };
    } catch {
      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);
      return { success: false, isError: true, error: `Unexpected error in detachable handler for '${name}'` };
    }
  }

  /**
   * Detach a currently-blocking sync subagent, converting it to async.
   * Returns true if the subagent was found and detached.
   */
  detachSubagent(name: string): boolean {
    const handle = this.detachableHandles.get(name);
    if (!handle) return false;
    handle.detach();
    return true;
  }

  /**
   * Detach all currently-blocking sync subagents.
   * Returns the number of subagents detached.
   */
  detachAll(): number {
    let count = 0;
    for (const handle of this.detachableHandles.values()) {
      handle.detach();
      count++;
    }
    return count;
  }

  /**
   * Check if any sync subagents are currently blocking (and thus detachable).
   */
  hasDetachable(): boolean {
    return this.detachableHandles.size > 0;
  }

  private handleHud(input: { enabled: boolean }): ToolResult {
    if (!this.ctx) return { success: false, isError: true, error: 'Module not started' };
    const persisted = this.ctx.getState<{ agents?: unknown; hudEnabled?: boolean }>() ?? {};
    this.ctx.setState({ ...persisted, hudEnabled: input.enabled });
    return { success: true, data: { hudEnabled: input.enabled } };
  }

  private handleConcurrency(input: { maxConcurrent?: number }): ToolResult {
    if (input.maxConcurrent !== undefined) {
      this.setConcurrency(input.maxConcurrent);
    }
    return { success: true, data: this.getConcurrencyStatus() };
  }

  private async handlePeek(input: { name?: string }): Promise<ToolResult> {
    const snapshots = await this.peek(input.name);
    if (snapshots.length === 0) {
      return {
        success: true,
        data: { message: input.name ? `No running subagent named '${input.name}'` : 'No running subagents' },
      };
    }
    return { success: true, data: snapshots };
  }

  // =========================================================================
  // Subagent Execution
  // =========================================================================

  private async runSpawn(input: SpawnInput, _callerAgentName?: string, callerDepth = 0): Promise<SubagentResult> {
    const { waitedMs } = await this.acquireSlot();
    const childDepth = callerDepth + 1;

    const entry: ActiveSubagent = {
      name: input.name, type: 'spawn', task: input.task,
      status: 'running', startedAt: Date.now(), toolCallsCount: 0, findingsCount: 0,
    };
    const entryKey = `spawn-${input.name}`;
    this.activeSubagents.set(entryKey, entry);
    if (_callerAgentName) this.parentMap.set(input.name, _callerAgentName);
    this.persistState();

    try {
      const framework = this.getFramework();
      const model = input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001';
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const agentName = `spawn-${input.name}-${Date.now()}`;
        const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
          name: agentName,
          model,
          systemPrompt: input.systemPrompt,
          maxTokens: input.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
          maxStreamTokens: 200_000,
          strategy: new KnowledgeStrategy({
            headWindowTokens: 2_000,
            recentWindowTokens: 80_000,
            compressionModel: model,
            autoTickOnNewMessage: true,
            maxMessageTokens: 10_000,
          }),
          allowedTools: this.filterToolNames(input.tools, callerDepth),
        });

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, input.systemPrompt, contextManager);

        try {
          contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

          // Pre-validate prompt size
          const { messages } = await contextManager.compile();
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new Error(
              `Prompt too large for subagent ${input.name}: ~${est} tokens ` +
              `(limit: ${this.maxPromptTokens}). Reduce context or task size.`
            );
          }

          // Race execution against both timeout and user cancellation
          const cancelPromise = new Promise<never>((_, reject) => {
            this.cancellationHandles.set(input.name, { reject });
          });

          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager),
              input.name,
            ),
            cancelPromise,
          ]);

          this.cancellationHandles.delete(input.name);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.cancellationHandles.delete(input.name);

          // Non-retryable termination (user cancel, zombie reclaim, etc.)
          if (lastError instanceof SubagentTerminated) {
            entry.status = 'completed';
            entry.completedAt = Date.now();
            entry.statusMessage = lastError.reason;
            const notice = this.concurrencyNotice(waitedMs);
            const label = lastError.reason === 'cancelled' ? 'Stopped by user' : `Terminated: ${lastError.reason}`;
            const summary = notice + `[${label}] ` + (lastError.partialOutput || '(no output yet)');
            this.emit(input.name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(input.name) });
            return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
          }

          if (this.isRateLimitError(lastError)) await this.onRateLimitHit();
          if (!this.isTransientError(lastError) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } finally {
      this.persistState();
      this.releaseSlot();
    }
  }

  private async runFork(input: ForkInput, callerAgentName?: string, callerDepth = 0): Promise<SubagentResult> {
    const { waitedMs } = await this.acquireSlot();
    const childDepth = callerDepth + 1;

    const entry: ActiveSubagent = {
      name: input.name, type: 'fork', task: input.task,
      status: 'running', startedAt: Date.now(), toolCallsCount: 0, findingsCount: 0,
    };
    this.activeSubagents.set(input.name, entry);
    if (callerAgentName) this.parentMap.set(input.name, callerAgentName);
    this.persistState();

    try {
      const framework = this.getFramework();

      // Dynamic parent resolution: prefer the caller agent (enables recursive forks),
      // fall back to the configured parent agent for backward compat.
      const parentAgent = callerAgentName
        ? framework.getAgent(callerAgentName)
        : (this.config.parentAgentName ? framework.getAgent(this.config.parentAgentName) : null);

      const systemPrompt = input.systemPrompt
        ?? (parentAgent ? parentAgent.systemPrompt : 'You are a research assistant.');

      const model = input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001';
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        // Unique agent name: include depth + timestamp to prevent collisions when
        // a child fork uses the same display name as its parent (e.g. both called
        // "fork-level-2"). Without this, the child overwrites the parent in the
        // framework's agents Map, and the parent's completion promise never resolves.
        const suffix = attempt === 0 ? `d${childDepth}-${Date.now()}` : `d${childDepth}-retry${attempt}-${Date.now()}`;
        const agentName = `${input.name}-${suffix}`;

        const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
          name: agentName,
          model,
          systemPrompt,
          maxTokens: this.config.defaultMaxTokens ?? 4096,
          maxStreamTokens: 200_000,
          strategy: new KnowledgeStrategy({
            headWindowTokens: 2_000,
            recentWindowTokens: 80_000,
            compressionModel: model,
            autoTickOnNewMessage: true,
            maxMessageTokens: 10_000,
          }),
          allowedTools: this.filterToolNames(undefined, callerDepth),
        });

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, systemPrompt, contextManager);

        try {
          // Copy parent's compiled (already-compressed) context into the fork.
          // Deduplicate: after context compression, compile() can return both
          // original messages and their compressed summaries, causing duplication.
          if (parentAgent) {
            const parentCM = parentAgent.getContextManager();
            const { messages: compiled } = await parentCM.compile();
            const seen = new Set<string>();
            for (const msg of compiled) {
              // Hash by participant + content to detect exact duplicates
              const key = msg.participant + '\0' + JSON.stringify(msg.content);
              if (seen.has(key)) continue;
              seen.add(key);
              const participant = msg.participant === parentAgent.name ? agentName : msg.participant;
              contextManager.addMessage(participant, msg.content);
            }
          }

          // Fork identity: the fork is the same self that decided to fork.
          // Show it as a tool call it "made" with a result confirming it's inside.
          const forkCallId = `fork-${input.name}-${Date.now()}`;
          contextManager.addMessage(agentName, [{
            type: 'tool_use',
            id: forkCallId,
            name: 'subagent--fork',
            input: { name: input.name, task: input.task },
          }] as ContentBlock[]);
          contextManager.addMessage('user', [{
            type: 'tool_result',
            toolUseId: forkCallId,
            content: `Fork successful — you are now running inside the fork "${input.name}" ` +
              `(depth ${childDepth}/${this.maxDepth}). ` +
              `Complete your task, then call subagent--return with your findings to deliver ` +
              `them back to the parent agent.` +
              (childDepth < this.maxDepth
                ? ` You can sub-fork if needed (${this.maxDepth - childDepth} levels remaining).`
                : ` You are at max depth — you cannot sub-fork.`),
          }] as ContentBlock[]);

          // Pre-validate prompt size
          const { messages } = await contextManager.compile();
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new Error(
              `Prompt too large for subagent ${input.name}: ~${est} tokens ` +
              `(limit: ${this.maxPromptTokens}). Reduce context or task size.`
            );
          }

          // Race execution against both timeout and user cancellation
          const cancelPromise = new Promise<never>((_, reject) => {
            this.cancellationHandles.set(input.name, { reject });
          });

          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager),
              input.name,
            ),
            cancelPromise,
          ]);

          this.cancellationHandles.delete(input.name);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.cancellationHandles.delete(input.name);

          // Non-retryable termination (user cancel, zombie reclaim, etc.)
          if (lastError instanceof SubagentTerminated) {
            entry.status = 'completed';
            entry.completedAt = Date.now();
            entry.statusMessage = lastError.reason;
            const notice = this.concurrencyNotice(waitedMs);
            const label = lastError.reason === 'cancelled' ? 'Stopped by user' : `Terminated: ${lastError.reason}`;
            const summary = notice + `[${label}] ` + (lastError.partialOutput || '(no output yet)');
            this.emit(input.name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(input.name) });
            return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
          }

          if (this.isRateLimitError(lastError)) await this.onRateLimitHit();
          if (!this.isTransientError(lastError) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } finally {
      this.persistState();
      this.releaseSlot();
    }
  }

  /**
   * Extract the last assistant text from a context manager's messages.
   * Fallback when the streaming speech capture is empty (e.g., agent's
   * last action was a tool call, or speech was reset on stream_resumed).
   */
  private extractLastAssistantText(contextManager: ContextManager): string {
    try {
      const messages = contextManager.getAllMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.participant === 'user' || msg.participant === 'User') continue;
        const texts = msg.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        if (texts.length > 0) return texts.join('\n');
      }
    } catch {
      // best-effort
    }
    return '(no text output)';
  }

  /**
   * Build the allowedTools list for a subagent.
   * Removes subagent tools if at depth limit.
   *
   */
  private filterToolNames(allowedTools?: string[], callerDepth = 0): 'all' | string[] {
    // Always include subagent--return — subagents need it to deliver results
    const ensureReturn = (list: string[]) => {
      if (!list.includes('subagent--return')) list.push('subagent--return');
      return list;
    };

    // Use per-agent depth (from caller) rather than the module's static depth
    if (callerDepth + 1 >= this.maxDepth) {
      const allTools = this.getFramework().getAllTools();
      const filtered = allTools
        .filter(t => !t.name.startsWith('subagent--'))
        .map(t => t.name);
      if (allowedTools) {
        const allowed = new Set(allowedTools);
        return ensureReturn(filtered.filter(n => allowed.has(n)));
      }
      return ensureReturn(filtered);
    }
    return allowedTools ? ensureReturn(allowedTools) : 'all';
  }

}

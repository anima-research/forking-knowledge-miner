/**
 * WakeModule — selective MCPL event triggering via subscriptions.
 *
 * Tools:
 *   wake:subscribe   — Create a subscription with text/regex filter
 *   wake:unsubscribe — Remove a subscription by name
 *   wake:list        — List all active subscriptions
 *
 * Exposes `shouldTrigger` for wiring into McplServerConfig.shouldTriggerInference.
 * When no subscriptions exist, all events pass through (preserving default behavior).
 * When subscriptions exist, only matching events trigger inference.
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
} from '@connectome/agent-framework';
import type { AgentFramework } from '@connectome/agent-framework';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subscription {
  name: string;
  filter: { type: 'text' | 'regex'; pattern: string };
  subscriptionType: 'once' | 'permanent';
  scope: string[];
  createdAt: number;
  matchCount: number;
}

interface SubscribeInput {
  name: string;
  filter: { type: 'text' | 'regex'; pattern: string };
  type?: 'once' | 'permanent';
  scope?: string[];
}

interface UnsubscribeInput {
  name: string;
}

interface PendingEvent {
  subscription: string;
  content: string;
  eventType: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class WakeModule implements Module {
  readonly name = 'wake';

  private ctx: ModuleContext | null = null;
  private framework: AgentFramework | null = null;
  private subscriptions = new Map<string, Subscription>();
  private onceToRemove = new Set<string>();
  private pendingEvents: PendingEvent[] = [];
  private inferring = false;
  private agentName: string;
  private onWake?: (subs: string[], summary: string) => void;

  constructor(opts?: { agentName?: string; onWake?: (subs: string[], summary: string) => void }) {
    this.agentName = opts?.agentName ?? 'researcher';
    this.onWake = opts?.onWake;
  }

  setFramework(framework: AgentFramework): void {
    this.framework = framework;

    framework.onTrace((event: TraceEvent) => {
      const agent = 'agentName' in event ? (event as { agentName: string }).agentName : null;
      if (agent !== this.agentName) return;

      if (event.type === 'inference:started') {
        this.inferring = true;
      } else if (event.type === 'inference:completed' || event.type === 'inference:failed') {
        this.inferring = false;
        this.flushPendingEvents();
        this.cleanupOnce();
      }
    });
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    this.restoreFromStore();
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  private persistState(): void {
    if (!this.ctx) return;
    const subs: Record<string, Subscription> = {};
    for (const [key, sub] of this.subscriptions) {
      subs[key] = sub;
    }
    this.ctx.setState({ subscriptions: subs });
  }

  private restoreFromStore(): void {
    if (!this.ctx) return;
    const persisted = this.ctx.getState<{ subscriptions?: Record<string, Subscription> }>();
    if (!persisted?.subscriptions) return;

    this.subscriptions.clear();
    for (const [key, sub] of Object.entries(persisted.subscriptions)) {
      this.subscriptions.set(key, sub);
    }
  }

  // =========================================================================
  // shouldTrigger — arrow method for stable `this` binding
  // =========================================================================

  shouldTrigger = (content: string, metadata: Record<string, unknown>): boolean => {
    if (this.subscriptions.size === 0) return true;

    const eventType = (metadata.eventType as string) ?? 'unknown';
    const matches = this.matchSubscriptions(content, eventType);

    if (matches.length === 0) return false;

    // If currently inferring, stash for later delivery
    if (this.inferring) {
      for (const sub of matches) {
        this.pendingEvents.push({
          subscription: sub.name,
          content: content.length > 200 ? content.slice(0, 200) + '...' : content,
          eventType,
        });
      }
      return false;
    }

    // Fire onWake callback for TUI display
    if (this.onWake) {
      const snippet = content.length > 80 ? content.slice(0, 80) + '...' : content;
      this.onWake(matches.map(m => m.name), snippet);
    }

    return true;
  };

  // =========================================================================
  // Subscription matching
  // =========================================================================

  private matchSubscriptions(content: string, eventType: string): Subscription[] {
    const matched: Subscription[] = [];

    for (const sub of this.subscriptions.values()) {
      // Scope check
      if (sub.scope.length > 0 && !sub.scope.includes(eventType)) continue;

      // Filter check
      let isMatch = false;
      if (sub.filter.type === 'text') {
        isMatch = content.toLowerCase().includes(sub.filter.pattern.toLowerCase());
      } else {
        try {
          isMatch = new RegExp(sub.filter.pattern, 'i').test(content);
        } catch {
          // Invalid regex — skip
        }
      }

      if (isMatch) {
        sub.matchCount++;
        matched.push(sub);
        if (sub.subscriptionType === 'once') {
          this.onceToRemove.add(sub.name);
        }
      }
    }

    if (matched.length > 0) this.persistState();
    return matched;
  }

  // =========================================================================
  // Event bundling
  // =========================================================================

  private flushPendingEvents(): void {
    if (this.pendingEvents.length === 0 || !this.ctx) return;

    const events = this.pendingEvents.splice(0);
    const lines = events.map(e =>
      `- [${e.subscription}] (${e.eventType}): ${e.content}`
    ).join('\n');

    const text = `[Wake: ${events.length} event${events.length > 1 ? 's' : ''} matched during inference]\n\n${lines}`;

    this.ctx.addMessage('user', [{ type: 'text', text }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: this.agentName,
      reason: 'wake:pending-events',
      source: 'wake',
    });

    // Fire onWake for the bundled batch
    if (this.onWake) {
      const subNames = [...new Set(events.map(e => e.subscription))];
      this.onWake(subNames, `${events.length} events bundled`);
    }
  }

  private cleanupOnce(): void {
    if (this.onceToRemove.size === 0) return;
    for (const name of this.onceToRemove) {
      this.subscriptions.delete(name);
    }
    this.onceToRemove.clear();
    this.persistState();
  }

  // =========================================================================
  // onProcess — check subscriptions for non-MCPL events
  // =========================================================================

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    if ((event as { source?: string }).source === 'cli' || (event as { source?: string }).source === 'tui') return {};

    const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
    const eventType = (event as { source?: string }).source ?? 'external-message';

    if (this.subscriptions.size === 0) return {};

    const matches = this.matchSubscriptions(content, eventType);
    if (matches.length === 0) return {};

    if (this.onWake) {
      const snippet = content.length > 80 ? content.slice(0, 80) + '...' : content;
      this.onWake(matches.map(m => m.name), snippet);
    }

    return { requestInference: true };
  }

  // =========================================================================
  // Tools
  // =========================================================================

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'subscribe',
        description: 'Create a wake subscription. When matching events arrive, inference is triggered. With no subscriptions, all events pass through.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique name for this subscription' },
            filter: {
              type: 'object',
              description: 'Match filter',
              properties: {
                type: { type: 'string', enum: ['text', 'regex'], description: 'Filter type' },
                pattern: { type: 'string', description: 'Text to match or regex pattern' },
              },
              required: ['type', 'pattern'],
            },
            type: { type: 'string', enum: ['once', 'permanent'], description: 'once = auto-remove after first match (default: permanent)' },
            scope: {
              type: 'array',
              items: { type: 'string' },
              description: 'Event types to match (empty = all)',
            },
          },
          required: ['name', 'filter'],
        },
      },
      {
        name: 'unsubscribe',
        description: 'Remove a wake subscription by name.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Subscription name to remove' },
          },
          required: ['name'],
        },
      },
      {
        name: 'list',
        description: 'List all active wake subscriptions with match counts.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'subscribe': {
        const input = call.input as SubscribeInput;
        if (this.subscriptions.has(input.name)) {
          return { success: false, isError: true, error: `Subscription '${input.name}' already exists` };
        }
        if (input.filter.type === 'regex') {
          try { new RegExp(input.filter.pattern); } catch (e) {
            return { success: false, isError: true, error: `Invalid regex: ${e}` };
          }
        }
        const sub: Subscription = {
          name: input.name,
          filter: input.filter,
          subscriptionType: input.type ?? 'permanent',
          scope: input.scope ?? [],
          createdAt: Date.now(),
          matchCount: 0,
        };
        this.subscriptions.set(input.name, sub);
        this.persistState();
        return { success: true, data: { subscription: sub, total: this.subscriptions.size } };
      }

      case 'unsubscribe': {
        const { name } = call.input as UnsubscribeInput;
        if (!this.subscriptions.has(name)) {
          return { success: false, isError: true, error: `No subscription named '${name}'` };
        }
        this.subscriptions.delete(name);
        this.persistState();
        return { success: true, data: { removed: name, remaining: this.subscriptions.size } };
      }

      case 'list': {
        const subs = [...this.subscriptions.values()];
        return { success: true, data: { subscriptions: subs, total: subs.length } };
      }

      default:
        return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
    }
  }
}

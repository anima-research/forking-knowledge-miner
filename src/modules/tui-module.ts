/**
 * TuiModule — handles external-message events from the TUI/CLI.
 *
 * Converts them to context messages and triggers inference.
 * Follows the same pattern as ApiModule's handleMessage().
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
} from '@connectome/agent-framework';

export class TuiModule implements Module {
  readonly name = 'tui';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'TuiModule has no tools', isError: true };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};

    const source = (event as { source: string }).source;
    if (source !== 'tui' && source !== 'cli' && source !== 'system') return {};

    const content = (event as { content: unknown }).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const triggerInference = (event as { triggerInference?: boolean }).triggerInference;
    const targetAgents = (event as { targetAgents?: string[] }).targetAgents;

    const response: EventResponse = {
      addMessages: [
        {
          participant: 'user',
          content: [{ type: 'text', text }],
        },
      ],
    };

    if (triggerInference !== false) {
      response.requestInference = targetAgents ?? true;
    }

    return response;
  }
}

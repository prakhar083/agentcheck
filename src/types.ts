/**
 * Provider-neutral conversation model. Providers translate to and from their
 * own wire formats; everything else in agentcheck works with these types.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type Message =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /**
       * The provider's original content for this turn. Providers that need
       * exact replay (e.g. Anthropic thinking blocks) send this back verbatim.
       */
      raw?: unknown;
    }
  | { role: "tool"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  /** When set, the provider must return a single JSON object matching this schema as text. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
  raw?: unknown;
}

export interface Provider {
  readonly name: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

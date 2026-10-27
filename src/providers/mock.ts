import type { ModelRequest, ModelResponse, Provider, ToolCall, Usage } from "../types.js";

export type MockStep = Partial<Omit<ModelResponse, "toolCalls">> & {
  toolCalls?: (Omit<ToolCall, "id"> & { id?: string })[];
  /** Simulated latency for this step, in milliseconds. */
  delayMs?: number;
  /** Throw instead of responding (e.g. a ProviderError to exercise retries). */
  throws?: unknown;
};

export type MockHandler = (request: ModelRequest, callIndex: number) => MockStep | Promise<MockStep>;

/**
 * Deterministic provider for tests and offline examples. Give it either a
 * list of steps (consumed in order, per provider instance) or a handler that
 * computes each response from the request.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly requests: ModelRequest[] = [];
  private calls = 0;

  constructor(private readonly script: MockStep[] | MockHandler) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const index = this.calls++;
    this.requests.push(structuredClone(request));
    const step =
      typeof this.script === "function" ? await this.script(request, index) : this.script[index];
    if (!step) throw new Error(`MockProvider: no scripted response for call #${index + 1}`);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.throws !== undefined) throw step.throws;

    const toolCalls = (step.toolCalls ?? []).map((c, i) => ({ id: c.id ?? `call_${index}_${i}`, name: c.name, args: c.args }));
    const text = step.text ?? "";
    return {
      text,
      toolCalls,
      stopReason: step.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
      usage: step.usage ?? estimateUsage(request, text, toolCalls),
      raw: step.raw,
    };
  }
}

/** Rough 4-characters-per-token estimate so mock runs still produce plausible cost numbers. */
export function estimateUsage(request: ModelRequest, text: string, toolCalls: ToolCall[]): Usage {
  const promptChars = (request.system?.length ?? 0) + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  const outputChars = text.length + JSON.stringify(toolCalls).length;
  return {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: Math.ceil(outputChars / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

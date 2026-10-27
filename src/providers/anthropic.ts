import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig } from "../config/types.js";
import type { Message, ModelRequest, ModelResponse, Provider, StopReason, ToolCall } from "../types.js";
import { isRetryableStatus, parseRetryAfter, ProviderError } from "./retry.js";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    // agentcheck owns the retry policy so behaviour is identical across providers.
    maxRetries: 0,
  });

  return {
    name: "anthropic",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const outputConfig: Anthropic.OutputConfig = {};
      if (config.effort) outputConfig.effort = config.effort;
      if (request.responseSchema) outputConfig.format = { type: "json_schema", schema: request.responseSchema.schema };

      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system ? { system: request.system } : {}),
          messages: toAnthropicMessages(request.messages),
          ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
          ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        });
      } catch (err) {
        throw toProviderError(err);
      }
      return fromAnthropicMessage(message);
    },
  };
}

function toAnthropicTool(tool: ModelRequest["tools"][number]): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", ...tool.inputSchema },
  };
}

export function toAnthropicMessages(messages: readonly Message[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant": {
        // Replay the provider's own blocks verbatim when we have them: thinking
        // blocks must come back unchanged for multi-turn tool use to work.
        if (Array.isArray(m.raw)) return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text) content.push({ type: "text", text: m.text });
        for (const call of m.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
        }
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: m.results.map((r) => ({
            type: "tool_result" as const,
            tool_use_id: r.callId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

export function fromAnthropicMessage(message: Anthropic.Message): ModelResponse {
  const text: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> });
    }
  }
  return {
    text: text.join(""),
    toolCalls,
    stopReason: mapStopReason(message.stop_reason),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    raw: message.content,
  };
}

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function toProviderError(err: unknown): unknown {
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Anthropic connection error: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    return new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status),
      retryAfterMs: parseRetryAfter(err.headers?.get("retry-after")),
      cause: err,
    });
  }
  return err;
}

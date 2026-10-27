import OpenAI from "openai";
import type { ProviderConfig } from "../config/types.js";
import type { Message, ModelRequest, ModelResponse, Provider, StopReason, ToolCall } from "../types.js";
import { isRetryableStatus, parseRetryAfter, ProviderError } from "./retry.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Works with OpenAI and any server exposing the Chat Completions API
 * (vLLM, Ollama, LM Studio, OpenRouter, Together, ...) via `base_url`.
 */
export function createOpenAIProvider(config: ProviderConfig): Provider {
  const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const client = new OpenAI({
    // Local OpenAI-compatible servers usually ignore the key, but the SDK requires one.
    apiKey: process.env[apiKeyEnv] ?? (config.baseUrl ? "not-needed" : undefined),
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    maxRetries: 0,
  });
  // OpenAI's own API wants max_completion_tokens; most compatible servers only know max_tokens.
  const tokenParam = config.baseUrl ? "max_tokens" : "max_completion_tokens";

  return {
    name: "openai",
    async complete(request: ModelRequest): Promise<ModelResponse> {
      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await client.chat.completions.create({
          model: request.model,
          [tokenParam]: request.maxTokens,
          messages: toOpenAIMessages(request.system, request.messages),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((t) => ({
                  type: "function" as const,
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
          ...(request.responseSchema
            ? {
                response_format: {
                  type: "json_schema" as const,
                  json_schema: { name: request.responseSchema.name, schema: request.responseSchema.schema, strict: true },
                },
              }
            : {}),
        });
      } catch (err) {
        throw toProviderError(err);
      }
      return fromOpenAICompletion(completion);
    },
  };
}

export function toOpenAIMessages(system: string | undefined, messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : {}),
        });
        break;
      case "tool":
        for (const r of m.results) {
          out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
        }
        break;
    }
  }
  return out;
}

export function fromOpenAICompletion(completion: OpenAI.Chat.Completions.ChatCompletion): ModelResponse {
  const choice = completion.choices[0];
  if (!choice) throw new ProviderError("OpenAI response contained no choices", { retryable: false });
  const toolCalls: ToolCall[] = [];
  for (const call of choice.message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    toolCalls.push({ id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) });
  }
  const cached = completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: choice.message.content ?? "",
    toolCalls,
    stopReason: mapFinishReason(choice.finish_reason, choice.message.refusal),
    usage: {
      inputTokens: (completion.usage?.prompt_tokens ?? 0) - cached,
      outputTokens: completion.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    // Surface malformed arguments to assertions instead of crashing the run.
    return { __invalid_json__: raw };
  }
}

function mapFinishReason(reason: string, refusal: string | null | undefined): StopReason {
  if (refusal) return "refusal";
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function toProviderError(err: unknown): unknown {
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(`OpenAI connection error: ${err.message}`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIError && typeof err.status === "number") {
    return new ProviderError(`OpenAI API error ${err.status}: ${err.message}`, {
      status: err.status,
      retryable: isRetryableStatus(err.status),
      retryAfterMs: parseRetryAfter(err.headers?.get("retry-after")),
      cause: err,
    });
  }
  return err;
}

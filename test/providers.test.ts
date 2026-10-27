import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromAnthropicMessage, toAnthropicMessages } from "../src/providers/anthropic.js";
import { createProvider } from "../src/providers/index.js";
import { estimateUsage, MockProvider } from "../src/providers/mock.js";
import { fromOpenAICompletion, toOpenAIMessages } from "../src/providers/openai.js";
import type { Message } from "../src/types.js";

const conversation: Message[] = [
  { role: "user", content: "Where is order A1?" },
  { role: "assistant", text: "Let me check.", toolCalls: [{ id: "t1", name: "lookup_order", args: { order_id: "A1" } }] },
  { role: "tool", results: [{ callId: "t1", name: "lookup_order", content: '{"status":"shipped"}', isError: false }] },
];

describe("anthropic mapping", () => {
  it("maps tool calls and results to content blocks", () => {
    const out = toAnthropicMessages(conversation);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "t1", name: "lookup_order", input: { order_id: "A1" } },
      ],
    });
    expect(out[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: '{"status":"shipped"}' }] });
  });

  it("replays raw assistant content verbatim (thinking blocks must round-trip)", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "hi" }];
    const out = toAnthropicMessages([{ role: "user", content: "x" }, { role: "assistant", text: "hi", toolCalls: [], raw }]);
    expect(out[1]?.content).toBe(raw);
  });

  it("marks tool errors", () => {
    const out = toAnthropicMessages([{ role: "tool", results: [{ callId: "t", name: "x", content: "boom", isError: true }] }]);
    expect(out[0]?.content).toEqual([{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }]);
  });

  it("parses a response, ignoring thinking blocks", () => {
    const message = {
      id: "msg",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "tu", name: "lookup_order", input: { order_id: "A1" } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: null },
    } as unknown as Anthropic.Message;
    const res = fromAnthropicMessage(message);
    expect(res).toMatchObject({
      text: "Checking.",
      toolCalls: [{ id: "tu", name: "lookup_order", args: { order_id: "A1" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
    });
    expect(res.raw).toBe(message.content);
  });
});

describe("openai mapping", () => {
  it("maps the conversation to chat completion messages", () => {
    const out = toOpenAIMessages("be nice", conversation);
    expect(out).toEqual([
      { role: "system", content: "be nice" },
      { role: "user", content: "Where is order A1?" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "lookup_order", arguments: '{"order_id":"A1"}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: '{"status":"shipped"}' },
    ]);
  });

  it("parses tool calls, cached tokens and malformed arguments", () => {
    const completion = {
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "f", arguments: '{"x":1}' } },
              { id: "b", type: "function", function: { name: "g", arguments: "{oops" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 10, total_tokens: 130, prompt_tokens_details: { cached_tokens: 20 } },
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    const res = fromOpenAICompletion(completion);
    expect(res.toolCalls).toEqual([
      { id: "a", name: "f", args: { x: 1 } },
      { id: "b", name: "g", args: { __invalid_json__: "{oops" } },
    ]);
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 });
  });
});

describe("module provider", () => {
  it("loads a factory default export relative to the config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentcheck-mod-"));
    const file = path.join(dir, "agent.mjs");
    await writeFile(
      file,
      `export default (config) => ({ name: "custom", async complete() { return { text: "model=" + config.model, toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }; } });`,
    );
    const provider = await createProvider({ type: "module", module: file, model: "mock", maxTokens: 100 });
    const res = await provider.complete({ model: "mock", messages: [], tools: [], maxTokens: 100 });
    expect(provider.name).toBe("custom");
    expect(res.text).toBe("model=mock");
  });

  it("rejects modules that do not export a provider", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentcheck-mod-"));
    const file = path.join(dir, "bad.mjs");
    await writeFile(file, "export default 42;");
    await expect(createProvider({ type: "module", module: file, model: "mock", maxTokens: 1 })).rejects.toThrow(/default export must be a provider/);
  });
});

describe("MockProvider", () => {
  it("plays a script, assigns call ids and estimates usage", async () => {
    const p = new MockProvider([{ toolCalls: [{ name: "f", args: {} }] }, { text: "done" }]);
    const req = { model: "m", messages: [{ role: "user" as const, content: "hello" }], tools: [], maxTokens: 1 };
    const first = await p.complete(req);
    expect(first.toolCalls[0]?.id).toBe("call_0_0");
    expect(first.stopReason).toBe("tool_use");
    expect(first.usage.inputTokens).toBeGreaterThan(0);
    expect((await p.complete(req)).text).toBe("done");
    await expect(p.complete(req)).rejects.toThrow("no scripted response for call #3");
  });

  it("estimates roughly four characters per token", () => {
    const usage = estimateUsage({ model: "m", messages: [], tools: [], maxTokens: 1, system: "x".repeat(400) }, "y".repeat(40), []);
    expect(usage.inputTokens).toBe(101); // 400 system chars + "[]" + "[]"
    expect(usage.outputTokens).toBe(11); // 40 chars + "[]"
  });
});

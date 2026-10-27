import { describe, expect, it } from "vitest";
import type { ToolConfig } from "../src/config/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { runAgentLoop } from "../src/runner/agent-loop.js";
import { resolveToolCall } from "../src/runner/mock-tools.js";
import { fakeClock } from "./helpers.js";

const tools: ToolConfig[] = [
  {
    name: "lookup_order",
    description: "Look up an order",
    inputSchema: { type: "object", properties: { order_id: { type: "string" } } },
    rules: [
      { when: { order_id: "A1" }, response: { status: "delivered", total: 40 } },
      { when: { order_id: "LOST" }, error: "order service unavailable" },
      { response: { status: "not_found" } },
    ],
  },
  { name: "static", description: "", inputSchema: {}, rules: [{ response: "plain text" }] },
  { name: "unmocked", description: "", inputSchema: {}, rules: [{ when: { x: 1 }, response: "only x=1" }] },
];

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0 };

describe("resolveToolCall", () => {
  it("picks the first rule whose `when` matches, falling back to the default", () => {
    expect(resolveToolCall({ id: "1", name: "lookup_order", args: { order_id: "A1", extra: true } }, tools)).toEqual({
      callId: "1",
      name: "lookup_order",
      isError: false,
      content: '{"status":"delivered","total":40}',
    });
    expect(resolveToolCall({ id: "2", name: "lookup_order", args: { order_id: "Z9" } }, tools).content).toBe('{"status":"not_found"}');
  });

  it("returns errors for error rules, unknown tools and unmatched args", () => {
    expect(resolveToolCall({ id: "1", name: "lookup_order", args: { order_id: "LOST" } }, tools)).toMatchObject({
      isError: true,
      content: "order service unavailable",
    });
    expect(resolveToolCall({ id: "2", name: "nope", args: {} }, tools)).toMatchObject({ isError: true, content: 'Unknown tool "nope".' });
    expect(resolveToolCall({ id: "3", name: "unmocked", args: { x: 2 } }, tools)).toMatchObject({
      isError: true,
      content: 'No mocked response for unmocked with arguments {"x":2}.',
    });
  });

  it("passes string responses through unchanged", () => {
    expect(resolveToolCall({ id: "1", name: "static", args: {} }, tools).content).toBe("plain text");
  });
});

describe("runAgentLoop", () => {
  it("alternates model and mocked tools until the model answers", async () => {
    const provider = new MockProvider([
      { text: "Checking.", toolCalls: [{ name: "lookup_order", args: { order_id: "A1" } }], usage },
      { text: "Your order was delivered.", usage },
    ]);
    const trace = await runAgentLoop({
      provider,
      model: "m",
      maxTokens: 100,
      system: "sys",
      messages: [{ role: "user", content: "Where is A1?" }],
      tools,
      maxTurns: 5,
      now: fakeClock(25),
    });

    expect(trace.output).toBe("Your order was delivered.");
    expect(trace.turns).toBe(2);
    expect(trace.stopReason).toBe("end_turn");
    expect(trace.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0 });
    expect(trace.latencyMs).toBe(25);
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.toolCalls[0]).toMatchObject({ name: "lookup_order", turn: 1, result: { isError: false } });
    expect(trace.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    // The second request carries the tool result and the tool specs.
    const second = provider.requests[1];
    expect(second?.system).toBe("sys");
    expect(second?.tools.map((t) => t.name)).toEqual(["lookup_order", "static", "unmocked"]);
    expect(second?.messages.at(-1)).toMatchObject({ role: "tool", results: [{ name: "lookup_order", isError: false }] });
  });

  it("answers parallel tool calls in a single tool message", async () => {
    const provider = new MockProvider([
      {
        toolCalls: [
          { name: "lookup_order", args: { order_id: "A1" } },
          { name: "lookup_order", args: { order_id: "B2" } },
        ],
      },
      { text: "Both found." },
    ]);
    const trace = await runAgentLoop({ provider, model: "m", maxTokens: 1, messages: [{ role: "user", content: "x" }], tools, maxTurns: 3 });
    const toolMessage = trace.messages[2];
    expect(toolMessage?.role).toBe("tool");
    expect(toolMessage?.role === "tool" && toolMessage.results.length).toBe(2);
    expect(trace.toolCalls.map((c) => c.args.order_id)).toEqual(["A1", "B2"]);
  });

  it("stops at max turns", async () => {
    const provider = new MockProvider(() => ({ toolCalls: [{ name: "static", args: {} }] }));
    const trace = await runAgentLoop({ provider, model: "m", maxTokens: 1, messages: [{ role: "user", content: "x" }], tools, maxTurns: 3 });
    expect(trace.turns).toBe(3);
    expect(trace.stopReason).toBe("max_turns");
    expect(trace.toolCalls).toHaveLength(3);
  });

  it("records refusals and other stop reasons from the final turn", async () => {
    const provider = new MockProvider([{ text: "", stopReason: "refusal" }]);
    const trace = await runAgentLoop({ provider, model: "m", maxTokens: 1, messages: [{ role: "user", content: "x" }], tools, maxTurns: 3 });
    expect(trace.stopReason).toBe("refusal");
    expect(trace.turns).toBe(1);
  });

  it("propagates provider errors", async () => {
    const provider = new MockProvider([{ throws: new Error("boom") }]);
    await expect(
      runAgentLoop({ provider, model: "m", maxTokens: 1, messages: [{ role: "user", content: "x" }], tools, maxTurns: 3 }),
    ).rejects.toThrow("boom");
  });
});

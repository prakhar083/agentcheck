import { describe, expect, it } from "vitest";
import { type AssertionContext, describeAssertion, evaluateAssertion, parseJsonOutput } from "../src/assertions/index.js";
import type { Assertion } from "../src/config/types.js";
import type { Judge } from "../src/judge.js";
import { JudgeParseError } from "../src/judge.js";
import { matchesSubset } from "../src/match.js";
import { emptyUsage } from "../src/types.js";
import { call, trace } from "./helpers.js";

const ctx = (partial: Partial<AssertionContext> = {}): AssertionContext => ({
  trace: trace({ output: "Your refund of $40.00 for order A1 has been issued." }),
  costUsd: 0.002,
  model: "claude-sonnet-5-5",
  ...partial,
});

const check = (a: Assertion, c: AssertionContext = ctx()) => evaluateAssertion(a, c);

describe("text assertions", () => {
  it("contains: all values must be present", async () => {
    expect((await check({ type: "contains", value: "refund", ignore_case: false })).passed).toBe(true);
    expect((await check({ type: "contains", value: ["refund", "A1"], ignore_case: false })).passed).toBe(true);
    const r = await check({ type: "contains", value: ["refund", "store credit"], ignore_case: false });
    expect(r).toMatchObject({ passed: false, message: 'output is missing "store credit"' });
  });

  it("contains: case sensitivity is opt-out", async () => {
    expect((await check({ type: "contains", value: "REFUND", ignore_case: false })).passed).toBe(false);
    expect((await check({ type: "contains", value: "REFUND", ignore_case: true })).passed).toBe(true);
  });

  it("not_contains: none of the values may appear", async () => {
    expect((await check({ type: "not_contains", value: ["sorry", "cannot"], ignore_case: false })).passed).toBe(true);
    const r = await check({ type: "not_contains", value: ["ISSUED"], ignore_case: true });
    expect(r).toMatchObject({ passed: false, message: 'output contains "ISSUED"' });
  });

  it("regex: matches with flags, reports invalid patterns", async () => {
    expect((await check({ type: "regex", pattern: "\\$\\d+\\.\\d{2}" })).passed).toBe(true);
    expect((await check({ type: "regex", pattern: "^your", flags: "i" })).passed).toBe(true);
    expect((await check({ type: "regex", pattern: "^your" })).passed).toBe(false);
    // A global flag must not make the result depend on lastIndex.
    expect((await check({ type: "regex", pattern: "refund", flags: "g" })).passed).toBe(true);
    const bad = await check({ type: "regex", pattern: "(" });
    expect(bad.passed).toBe(false);
    expect(bad.message).toMatch(/^invalid regex/);
  });

  it("equals: compares trimmed output", async () => {
    const c = ctx({ trace: trace({ output: "  42\n" }) });
    expect((await check({ type: "equals", value: "42" }, c)).passed).toBe(true);
    expect((await check({ type: "equals", value: "43" }, c)).message).toBe('expected "43", got "42"');
  });
});

describe("json_schema", () => {
  const schema = {
    type: "object",
    properties: { order_id: { type: "string" }, refund: { type: "number", minimum: 0 } },
    required: ["order_id", "refund"],
    additionalProperties: false,
  };

  it("passes for valid JSON, including a fenced block", async () => {
    expect((await check({ type: "json_schema", schema }, ctx({ trace: trace({ output: '{"order_id":"A1","refund":40}' }) }))).passed).toBe(true);
    const fenced = '```json\n{"order_id":"A1","refund":0}\n```';
    expect((await check({ type: "json_schema", schema }, ctx({ trace: trace({ output: fenced }) }))).passed).toBe(true);
  });

  it("fails on unparseable output", async () => {
    const r = await check({ type: "json_schema", schema }, ctx({ trace: trace({ output: "Sure! Here it is" }) }));
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/^output is not valid JSON/);
  });

  it("lists every validation error", async () => {
    const r = await check({ type: "json_schema", schema }, ctx({ trace: trace({ output: '{"refund":-1,"extra":true}' }) }));
    expect(r.passed).toBe(false);
    expect(r.message).toContain("must have required property 'order_id'");
    expect(r.message).toContain("/refund must be >= 0");
    expect(r.message).toContain("must NOT have additional properties");
  });

  it("reports an invalid schema instead of throwing", async () => {
    const r = await check({ type: "json_schema", schema: { type: "not-a-type" } }, ctx({ trace: trace({ output: "{}" }) }));
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/^invalid JSON schema/);
  });

  it("parseJsonOutput", () => {
    expect(parseJsonOutput(" [1,2] ")).toEqual({ ok: true, value: [1, 2] });
    expect(parseJsonOutput("```\n{}\n```")).toEqual({ ok: true, value: {} });
    expect(parseJsonOutput("nope").ok).toBe(false);
  });
});

describe("tool assertions", () => {
  const calls = [
    call("lookup_order", { order_id: "A1" }, 1),
    call("lookup_order", { order_id: "B2" }, 1),
    call("issue_refund", { order_id: "A1", amount: 40, reason: "damaged" }, 2),
  ];
  const tctx = ctx({ trace: trace({ toolCalls: calls }) });

  it("tool_called: by name, args subset and exact count", async () => {
    expect((await check({ type: "tool_called", name: "lookup_order" }, tctx)).passed).toBe(true);
    expect((await check({ type: "tool_called", name: "issue_refund", args: { order_id: "A1", amount: 40 } }, tctx)).passed).toBe(true);
    expect((await check({ type: "tool_called", name: "issue_refund", args: { amount: 50 } }, tctx)).passed).toBe(false);
    expect((await check({ type: "tool_called", name: "lookup_order", count: 2 }, tctx)).passed).toBe(true);
    const r = await check({ type: "tool_called", name: "lookup_order", count: 1 }, tctx);
    expect(r.message).toMatch(/^expected 1 matching call\(s\), got 2/);
    expect((await check({ type: "tool_called", name: "escalate", count: 0 }, tctx)).passed).toBe(true);
  });

  it("tool_called: ordering with `after`", async () => {
    expect((await check({ type: "tool_called", name: "issue_refund", after: "lookup_order" }, tctx)).passed).toBe(true);
    const wrong = await check({ type: "tool_called", name: "lookup_order", after: "issue_refund" }, tctx);
    expect(wrong).toMatchObject({ passed: false });
    expect(wrong.message).toContain("was not called after issue_refund");
    expect((await check({ type: "tool_called", name: "issue_refund", after: "escalate" }, tctx)).message).toBe("escalate was never called");
  });

  it("tool_called: reports what was called when nothing matches", async () => {
    const r = await check({ type: "tool_called", name: "escalate" }, ctx());
    expect(r.message).toBe("no matching call (no tools were called)");
  });

  it("tool_not_called: by name or by args", async () => {
    expect((await check({ type: "tool_not_called", name: "escalate" }, tctx)).passed).toBe(true);
    expect((await check({ type: "tool_not_called", name: "issue_refund" }, tctx)).passed).toBe(false);
    expect((await check({ type: "tool_not_called", name: "issue_refund", args: { order_id: "B2" } }, tctx)).passed).toBe(true);
  });

  it("tool_sequence: ordered subsequence", async () => {
    expect((await check({ type: "tool_sequence", names: ["lookup_order", "issue_refund"] }, tctx)).passed).toBe(true);
    expect((await check({ type: "tool_sequence", names: ["lookup_order", "lookup_order", "issue_refund"] }, tctx)).passed).toBe(true);
    const r = await check({ type: "tool_sequence", names: ["issue_refund", "lookup_order"] }, tctx);
    expect(r.message).toBe("expected subsequence [issue_refund -> lookup_order], got [lookup_order -> lookup_order -> issue_refund]");
  });
});

describe("budget assertions", () => {
  it("max_turns", async () => {
    expect((await check({ type: "max_turns", value: 3 }, ctx({ trace: trace({ turns: 3 }) }))).passed).toBe(true);
    expect((await check({ type: "max_turns", value: 2 }, ctx({ trace: trace({ turns: 3 }) }))).passed).toBe(false);
  });

  it("max_cost_usd, including unknown pricing", async () => {
    expect((await check({ type: "max_cost_usd", value: 0.01 })).passed).toBe(true);
    expect((await check({ type: "max_cost_usd", value: 0.001 })).message).toBe("$0.002000, limit $0.001");
    const unknown = await check({ type: "max_cost_usd", value: 1 }, ctx({ costUsd: null, model: "llama" }));
    expect(unknown.passed).toBe(false);
    expect(unknown.message).toContain('no price known for model "llama"');
  });

  it("max_latency_ms", async () => {
    expect((await check({ type: "max_latency_ms", value: 100 })).passed).toBe(true);
    expect((await check({ type: "max_latency_ms", value: 99 })).passed).toBe(false);
  });
});

describe("llm_judge", () => {
  const usage = { ...emptyUsage(), inputTokens: 500, outputTokens: 40 };
  const judgeReturning = (score: number): Judge => ({ model: "j", grade: async () => ({ score, reasoning: "because", usage }) });

  it("passes at or above the threshold and keeps score, reasoning and usage", async () => {
    const r = await check({ type: "llm_judge", rubric: "Be polite", threshold: 4 }, ctx({ judge: judgeReturning(4) }));
    expect(r).toMatchObject({ passed: true, score: 4, reasoning: "because", judgeUsage: usage, message: "score 4/5, threshold 4" });
    expect((await check({ type: "llm_judge", rubric: "Be polite", threshold: 4 }, ctx({ judge: judgeReturning(3) }))).passed).toBe(false);
  });

  it("fails cleanly on unparseable judge output or judge errors", async () => {
    const parseFail: Judge = {
      model: "j",
      grade: async () => {
        const e = new JudgeParseError("judge output contained no JSON object", "I think it's fine");
        e.usage = usage;
        throw e;
      },
    };
    const r = await check({ type: "llm_judge", rubric: "x", threshold: 4 }, ctx({ judge: parseFail }));
    expect(r).toMatchObject({ passed: false, judgeUsage: usage });
    expect(r.message).toContain("I think it's fine");

    const down: Judge = { model: "j", grade: async () => Promise.reject(new Error("503")) };
    expect((await check({ type: "llm_judge", rubric: "x", threshold: 4 }, ctx({ judge: down }))).message).toBe("judge call failed: 503");
    expect((await check({ type: "llm_judge", rubric: "x", threshold: 4 })).message).toBe("no judge configured");
  });
});

describe("describeAssertion", () => {
  it("produces short labels", () => {
    expect(describeAssertion({ type: "contains", value: ["a", "b"], ignore_case: false })).toBe('contains "a", "b"');
    expect(describeAssertion({ type: "tool_called", name: "f", args: { x: 1 }, count: 2, after: "g" })).toBe('tool_called f {"x":1} x2 after g');
    expect(describeAssertion({ type: "llm_judge", rubric: "First line\nsecond", threshold: 3 })).toBe("llm_judge >= 3: First line");
  });
});

describe("matchesSubset", () => {
  it("matches nested objects and arrays structurally", () => {
    expect(matchesSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(matchesSubset({ a: [1, { x: 1, y: 2 }] }, { a: [1, { x: 1 }] })).toBe(true);
    expect(matchesSubset({ a: [1, 2] }, { a: [1] })).toBe(false);
    expect(matchesSubset({ a: "1" }, { a: 1 })).toBe(false);
    expect(matchesSubset({}, { a: undefined })).toBe(false);
    expect(matchesSubset(null, {})).toBe(false);
  });
});

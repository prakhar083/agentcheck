import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import { ProviderError } from "../src/providers/retry.js";
import { mapWithConcurrency } from "../src/runner/concurrency.js";
import { runSuites } from "../src/runner/run.js";
import type { ModelRequest } from "../src/types.js";
import { suite } from "./helpers.js";

const fastRetry = { retries: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} };
const lastUser = (req: ModelRequest) => {
  const m = req.messages.findLast((x) => x.role === "user");
  return m?.role === "user" ? m.content : "";
};

describe("runSuites", () => {
  it("runs cases, evaluates assertions and summarizes", async () => {
    const s = suite({
      name: "greet",
      cases: [
        { name: "pass", input: "hello", assert: [{ type: "contains", value: "HELLO" }] },
        { name: "fail", input: "bye", assert: [{ type: "contains", value: "HELLO" }] },
      ],
    });
    const provider = new MockProvider((req) => ({
      text: lastUser(req).toUpperCase(),
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const report = await runSuites([s], { providerFactory: () => provider, retry: fastRetry });

    expect(report.tool).toBe("agentcheck");
    expect(report.summary).toMatchObject({ cases: 2, passed: 1, failed: 1, flaky: 0, attempts: 2, attemptsPassed: 1 });
    const [pass, fail] = report.suites[0]?.cases ?? [];
    expect(pass).toMatchObject({ name: "pass", status: "pass", passRate: 1, judgeScore: null });
    expect(fail?.status).toBe("fail");
    expect(fail?.attempts[0]?.assertions[0]?.message).toContain('missing "HELLO"');
    // claude-sonnet-5-5: 1000 * $2/M + 100 * $10/M = $0.003 per attempt
    expect(pass?.costUsd).toBeCloseTo(0.003, 10);
    expect(report.summary.costUsd).toBeCloseTo(0.006, 10);
    expect(report.summary.usage.inputTokens).toBe(2000);
  });

  it("repeats cases, computes pass rate and flags flaky cases", async () => {
    let n = 0;
    const provider = new MockProvider(() => ({ text: n++ % 4 === 3 ? "wrong" : "right" }));
    const s = suite({
      cases: [
        { name: "strict", input: "x", repeat: 4, assert: [{ type: "equals", value: "right" }] },
        { name: "lenient", input: "x", repeat: 4, pass_threshold: 0.75, assert: [{ type: "equals", value: "right" }] },
      ],
    });
    const report = await runSuites([s], { providerFactory: () => provider, retry: fastRetry, concurrency: 1 });
    const [strict, lenient] = report.suites[0]?.cases ?? [];
    expect(strict).toMatchObject({ passCount: 3, passRate: 0.75, flaky: true, status: "fail" });
    expect(lenient).toMatchObject({ passCount: 3, passRate: 0.75, flaky: true, status: "pass" });
    expect(report.summary.flaky).toBe(2);
    expect(strict?.attempts.map((a) => a.index)).toEqual([0, 1, 2, 3]);
  });

  it("overrides repeat and filters cases", async () => {
    const provider = new MockProvider(() => ({ text: "ok" }));
    const s = suite({
      name: "s",
      cases: [
        { name: "refund flow", input: "x", repeat: 5 },
        { name: "greeting", input: "x" },
      ],
    });
    const report = await runSuites([s], { providerFactory: () => provider, retry: fastRetry, repeat: 2, filter: "refund" });
    expect(report.suites[0]?.cases.map((c) => c.name)).toEqual(["refund flow"]);
    expect(report.summary.attempts).toBe(2);
  });

  it("records provider failures as failed attempts after retrying", async () => {
    const provider = new MockProvider(() => ({ throws: new ProviderError("Anthropic API error 503: overloaded", { status: 503, retryable: true }) }));
    const s = suite({ cases: [{ name: "c", input: "x" }] });
    const report = await runSuites([s], { providerFactory: () => provider, retry: fastRetry });
    const attempt = report.suites[0]?.cases[0]?.attempts[0];
    expect(attempt).toMatchObject({ passed: false, stopReason: "error", error: "provider error: Anthropic API error 503: overloaded" });
    expect(provider.requests).toHaveLength(3);
  });

  it("fails attempts that hit the turn limit even without assertions", async () => {
    const provider = new MockProvider(() => ({ toolCalls: [{ name: "t", args: {} }] }));
    const s = suite({ cases: [{ name: "loops", input: "x", max_turns: 2, tools: [{ name: "t", response: "again" }] }] });
    const report = await runSuites([s], { providerFactory: () => provider, retry: fastRetry });
    expect(report.suites[0]?.cases[0]?.attempts[0]).toMatchObject({ passed: false, error: "agent did not finish within 2 turns" });
  });

  it("uses the judge provider for llm_judge and accounts for judge cost separately", async () => {
    const agent = new MockProvider(() => ({ text: "Refund issued.", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    const judge = new MockProvider(() => ({
      text: JSON.stringify({ reasoning: "Polite and correct.", score: 4 }),
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }));
    const s = suite({
      judge: { model: "claude-opus-5-5" },
      cases: [{ name: "c", input: "refund", repeat: 2, assert: [{ type: "llm_judge", rubric: "Issues a refund", threshold: 4 }] }],
    });
    const report = await runSuites([s], { providerFactory: (cfg) => (cfg.model === "claude-opus-5-5" ? judge : agent), retry: fastRetry });
    const c = report.suites[0]?.cases[0];
    expect(c).toMatchObject({ status: "pass", judgeScore: 4 });
    expect(judge.requests[0]?.responseSchema?.name).toBe("judge_verdict");
    expect(judge.requests[0]?.model).toBe("claude-opus-5-5");
    // 1000 * $4/M + 50 * $20/M = $0.005 per judge call, two attempts
    expect(c?.judgeCostUsd).toBeCloseTo(0.01, 10);
    expect(c?.attempts[0]?.assertions[0]?.reasoning).toBe("Polite and correct.");
  });

  it("does not create a judge when no case needs one", async () => {
    const created: string[] = [];
    const s = suite({ judge: { model: "judge-model" }, cases: [{ name: "c", input: "x" }] });
    await runSuites([s], {
      providerFactory: (cfg) => {
        created.push(cfg.model);
        return new MockProvider(() => ({ text: "ok" }));
      },
      retry: fastRetry,
    });
    expect(created).toEqual(["claude-sonnet-5-5"]);
  });

  it("strips provider raw content from transcripts", async () => {
    const provider = new MockProvider([{ text: "hi", raw: [{ type: "thinking", signature: "secret" }] }]);
    const report = await runSuites([suite({ cases: [{ name: "c", input: "x" }] })], { providerFactory: () => provider, retry: fastRetry });
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("handles empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

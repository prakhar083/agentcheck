import { beforeAll, describe, expect, it } from "vitest";
import { compareToBaseline } from "../src/baseline.js";
import { renderJson, renderJUnit, renderMarkdown, renderTerminal } from "../src/reporters/index.js";
import { formatCost, formatMs } from "../src/reporters/format.js";
import { MockProvider } from "../src/providers/mock.js";
import type { RunReport } from "../src/results.js";
import { runSuites } from "../src/runner/run.js";
import type { ModelRequest } from "../src/types.js";
import { fakeClock, report as fakeReport, suite } from "./helpers.js";

const usage = { inputTokens: 1200, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A small but realistic run: one pass, one failure with a judge, one flaky case. */
async function buildReport(): Promise<RunReport> {
  const s = suite(
    {
      name: "support",
      tools: [{ name: "lookup_order", response: { status: "delivered" } }],
      cases: [
        {
          name: "order status",
          input: "Where is order A1?",
          assert: [
            { type: "tool_called", name: "lookup_order" },
            { type: "contains", value: "delivered" },
          ],
        },
        {
          name: "refund <policy> & \"tone\"",
          input: "I want a refund | now",
          assert: [
            { type: "not_contains", value: "cannot" },
            { type: "llm_judge", rubric: "Offers a refund politely", threshold: 4 },
          ],
        },
        { name: "greeting", input: "hi", repeat: 4, pass_threshold: 0.5, assert: [{ type: "contains", value: "Hello" }] },
      ],
    },
    "/repo/evals/support.eval.yaml",
  );
  let greetings = 0;
  // Agent and judge share one provider config, so one mock serves both.
  const provider = new MockProvider((req: ModelRequest) => {
    if (req.responseSchema) {
      return { text: JSON.stringify({ reasoning: "The agent refused instead of offering a refund.", score: 2 }), usage };
    }
    const last = req.messages.at(-1);
    if (last?.role === "tool") return { text: "Your order was delivered.", usage };
    const text = last?.role === "user" ? last.content : "";
    if (text.includes("order A1")) return { toolCalls: [{ name: "lookup_order", args: { order_id: "A1" } }], usage };
    if (text.includes("refund")) return { text: "Sorry, I cannot help with refunds.", usage };
    return { text: greetings++ % 2 === 0 ? "Hello!" : "Hey.", usage };
  });
  const r = await runSuites([s], {
    providerFactory: () => provider,
    concurrency: 1,
    now: fakeClock(50),
    retry: { retries: 0, baseDelayMs: 1, maxDelayMs: 1 },
  });
  r.startedAt = "2026-03-01T12:00:00.000Z";
  return r;
}

let report: RunReport;
beforeAll(async () => {
  report = await buildReport();
});

describe("terminal reporter", () => {
  it("lists cases with status, failures and a summary", () => {
    const out = renderTerminal(report, { color: false, cwd: "/repo" });
    expect(out).toContain("support evals/support.eval.yaml · claude-sonnet-5-5");
    expect(out).toMatch(/✓ order status\s+1\/1\s+2\.0 turns/);
    expect(out).toMatch(/✗ refund <policy> & "tone"\s+0\/1/);
    expect(out).toContain('✗ not_contains "cannot" — output contains "cannot"');
    expect(out).toContain("✗ llm_judge >= 4: Offers a refund politely — score 2/5, threshold 4");
    expect(out).toContain("The agent refused instead of offering a refund.");
    expect(out).toMatch(/~ greeting \(flaky\)\s+2\/4/);
    expect(out).toContain("cases     2 passed, 1 failed, 1 flaky (3 total)");
    expect(out).toContain("attempts  3/6 passed");
    expect(out).not.toContain("\u001b[");
  });

  it("emits ANSI colors when enabled", () => {
    expect(renderTerminal(report, { color: true })).toContain("\u001b[");
  });

  it("prints baseline regressions", () => {
    const before = fakeReport([{ name: "refund <policy> & \"tone\"", status: "pass" }]);
    const withBaseline = { ...report, baseline: compareToBaseline(report, before, "/repo/baseline.json") };
    const out = renderTerminal(withBaseline, { color: false, cwd: "/repo" });
    expect(out).toContain("Baseline (baseline.json)");
    expect(out).toContain('regression   support › refund <policy> & "tone": passed → failed (pass rate 100% → 0%)');
    expect(out).toContain("new          support › order status");
  });
});

describe("markdown reporter", () => {
  it("renders a summary table with escaped cells and failure details", () => {
    const md = renderMarkdown(report);
    expect(md.startsWith("## agentcheck: failed (2/3 cases)")).toBe(true);
    expect(md).toContain("**2 passed** · **1 failed** · **1 flaky** · 3/6 attempts");
    expect(md).toContain("| pass | order status | 1/1 (100%) | – | 2.0 |");
    expect(md).toContain('| **FAIL** | refund &lt;policy&gt; &amp; "tone" | 0/1 (0%) | 2.0 |');
    expect(md).toContain("| flaky | greeting | 2/4 (50%) |");
    expect(md).toContain("<details><summary>Failure details (1)</summary>");
    expect(md).toContain("> The agent refused instead of offering a refund.");
    expect(md).toMatchSnapshot();
  });

  it("puts regressions first when comparing to a baseline", () => {
    const before = fakeReport([{ name: "refund <policy> & \"tone\"", status: "pass" }]);
    const md = renderMarkdown({ ...report, baseline: compareToBaseline(report, before, "b.json") });
    expect(md).toContain("### Regressions vs baseline (1)");
    expect(md.indexOf("Regressions")).toBeLessThan(md.indexOf("### support"));

    const clean = renderMarkdown({ ...report, baseline: compareToBaseline(report, report, "b.json") });
    expect(clean).toContain("No regressions against the baseline.");
  });

  it("escapes pipes in case names", () => {
    const md = renderMarkdown(fakeReport([{ name: "a | b" }]));
    expect(md).toContain("| a \\| b |");
    expect(md.startsWith("## agentcheck: passed (1/1 cases)")).toBe(true);
  });
});

describe("junit reporter", () => {
  it("emits one testcase per case with failures and escaped attributes", () => {
    const xml = renderJUnit(report);
    expect(xml).toContain('<testsuites name="agentcheck" tests="3" failures="1" errors="0"');
    expect(xml).toContain('<testsuite name="support" tests="3" failures="1" errors="0" skipped="0"');
    expect(xml).toContain('name="refund &lt;policy&gt; &amp; &quot;tone&quot;"');
    expect(xml.match(/<testcase /g)).toHaveLength(3);
    expect(xml.match(/<failure /g)).toHaveLength(1);
    expect(xml).toContain('<failure message="pass rate 0/1 (0%), threshold 100%, judge 2.00" type="AssertionFailure">');
    expect(xml).toContain("pass rate 2/4 (50%), threshold 50%, flaky");
    expect(xml).toMatchSnapshot();
  });

  it("strips characters that are illegal in XML", () => {
    const xml = renderJUnit(fakeReport([{ name: "bad\u0007name" }]));
    expect(xml).toContain('name="badname"');
  });
});

describe("json reporter", () => {
  it("round-trips the full report", () => {
    const parsed = JSON.parse(renderJson(report)) as RunReport;
    expect(parsed).toEqual(report);
    expect(parsed.suites[0]?.cases[0]?.attempts[0]?.toolCalls[0]).toMatchObject({ name: "lookup_order", result: '{"status":"delivered"}' });
  });
});

describe("format helpers", () => {
  it("formats cost and durations", () => {
    expect(formatCost(null)).toBe("n/a");
    expect(formatCost(0)).toBe("$0");
    expect(formatCost(0.00001)).toBe("<$0.0001");
    expect(formatCost(0.01234)).toBe("$0.0123");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatMs(250.4)).toBe("250ms");
    expect(formatMs(2500)).toBe("2.5s");
    expect(formatMs(125_000)).toBe("2m5s");
  });
});

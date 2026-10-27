import { parseSuite } from "../src/config/load.js";
import type { SuiteConfig } from "../src/config/types.js";
import { type CaseResult, REPORT_SCHEMA_VERSION, type RunReport, type SuiteResult } from "../src/results.js";
import type { AgentTrace, RecordedToolCall } from "../src/runner/agent-loop.js";
import { summarize } from "../src/runner/run.js";
import { emptyUsage } from "../src/types.js";

/** Build a validated suite from a plain object, as if it had been loaded from YAML. */
export function suite(doc: Record<string, unknown>, file = "/virtual/test.eval.yaml"): SuiteConfig {
  return parseSuite(doc, file);
}

export function trace(partial: Partial<AgentTrace> = {}): AgentTrace {
  return {
    messages: [{ role: "user", content: "hi" }],
    output: "",
    toolCalls: [],
    turns: 1,
    stopReason: "end_turn",
    usage: emptyUsage(),
    latencyMs: 100,
    ...partial,
  };
}

export function call(name: string, args: Record<string, unknown> = {}, turn = 1): RecordedToolCall {
  return { id: `${name}-${turn}`, name, args, turn, result: { callId: `${name}-${turn}`, name, content: "{}", isError: false } };
}

/** Deterministic clock: each read advances by `step` ms. */
export function fakeClock(step = 10): () => number {
  let t = 0;
  return () => (t += step);
}

/** Build a minimal report from case-level fields; enough for baseline diffing and reporters. */
export function report(cases: (Partial<CaseResult> & { name: string })[], suiteName = "support"): RunReport {
  const full: CaseResult[] = cases.map((c) => ({
    suite: suiteName,
    tags: [],
    status: "pass",
    flaky: false,
    passCount: 1,
    passRate: 1,
    passThreshold: 1,
    judgeScore: null,
    usage: emptyUsage(),
    costUsd: 0,
    judgeCostUsd: 0,
    latency: { p50: 100, p95: 100, mean: 100 },
    attempts: [],
    ...c,
  }));
  const suites: SuiteResult[] = [{ name: suiteName, file: "/x/support.eval.yaml", model: "claude-sonnet-5-5", judgeModel: "claude-sonnet-5-5", cases: full }];
  return {
    tool: "agentcheck",
    schemaVersion: REPORT_SCHEMA_VERSION,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1234,
    summary: summarize(suites),
    suites,
  };
}

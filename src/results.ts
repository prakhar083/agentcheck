import type { AssertionResult } from "./assertions/index.js";
import type { BaselineDiff } from "./baseline.js";
import type { LatencyStats } from "./stats.js";
import type { Message, StopReason, Usage } from "./types.js";

/** Bumped whenever the JSON report shape changes incompatibly. */
export const REPORT_SCHEMA_VERSION = 1;

export interface AttemptResult {
  index: number;
  passed: boolean;
  /** Set when the attempt could not complete (provider error, turn limit, refusal). */
  error?: string;
  output: string;
  turns: number;
  stopReason: StopReason | "max_turns" | "error";
  toolCalls: { name: string; args: Record<string, unknown>; turn: number; isError: boolean; result: string }[];
  usage: Usage;
  costUsd: number | null;
  judgeUsage: Usage;
  judgeCostUsd: number | null;
  latencyMs: number;
  assertions: AssertionResult[];
  transcript: Message[];
}

export interface CaseResult {
  suite: string;
  name: string;
  tags: string[];
  status: "pass" | "fail";
  /** Some attempts passed and some failed. */
  flaky: boolean;
  passCount: number;
  passRate: number;
  passThreshold: number;
  /** Mean llm_judge score across all attempts, or null when the case has no judge assertions. */
  judgeScore: number | null;
  usage: Usage;
  costUsd: number | null;
  judgeCostUsd: number | null;
  latency: LatencyStats;
  attempts: AttemptResult[];
}

export interface SuiteResult {
  name: string;
  file: string;
  model: string;
  judgeModel: string;
  cases: CaseResult[];
}

export interface RunSummary {
  cases: number;
  passed: number;
  failed: number;
  flaky: number;
  attempts: number;
  attemptsPassed: number;
  usage: Usage;
  costUsd: number | null;
  judgeCostUsd: number | null;
  latency: LatencyStats;
}

export interface RunReport {
  tool: "agentcheck";
  schemaVersion: number;
  startedAt: string;
  durationMs: number;
  summary: RunSummary;
  suites: SuiteResult[];
  baseline?: BaselineDiff;
}

export function caseKey(c: Pick<CaseResult, "suite" | "name">): string {
  return `${c.suite} › ${c.name}`;
}

import { readFile } from "node:fs/promises";
import { type CaseResult, caseKey, REPORT_SCHEMA_VERSION, type RunReport } from "./results.js";

export type ChangeKind = "pass_to_fail" | "score_drop" | "fail_to_pass" | "score_gain";

export interface CaseChange {
  key: string;
  kind: ChangeKind;
  before: { status: CaseResult["status"]; passRate: number; judgeScore: number | null };
  after: { status: CaseResult["status"]; passRate: number; judgeScore: number | null };
  message: string;
}

export interface BaselineDiff {
  file: string;
  regressions: CaseChange[];
  improvements: CaseChange[];
  /** Cases present now but not in the baseline. */
  added: string[];
  /** Cases in the baseline that no longer exist. */
  removed: string[];
}

export interface CompareOptions {
  /** Minimum drop in mean judge score (1-5 scale) that counts as a regression. */
  scoreTolerance: number;
}

export const DEFAULT_COMPARE: CompareOptions = { scoreTolerance: 0.5 };

export async function loadBaseline(file: string): Promise<RunReport> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read baseline ${file}: ${(err as Error).message}`);
  }
  const report = data as Partial<RunReport>;
  if (report.tool !== "agentcheck" || !Array.isArray(report.suites)) {
    throw new Error(`${file} is not an agentcheck JSON report`);
  }
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw new Error(`${file} uses report schema v${report.schemaVersion}; this version of agentcheck reads v${REPORT_SCHEMA_VERSION}`);
  }
  return report as RunReport;
}

export function compareToBaseline(
  current: RunReport,
  baseline: RunReport,
  file: string,
  opts: CompareOptions = DEFAULT_COMPARE,
): BaselineDiff {
  const before = indexCases(baseline);
  const after = indexCases(current);
  const diff: BaselineDiff = { file, regressions: [], improvements: [], added: [], removed: [] };

  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) {
      diff.added.push(key);
      continue;
    }
    const snapshot = (c: CaseResult) => ({ status: c.status, passRate: c.passRate, judgeScore: c.judgeScore });
    const change = (kind: ChangeKind, message: string): CaseChange => ({
      key,
      kind,
      before: snapshot(then),
      after: snapshot(now),
      message,
    });

    if (then.status === "pass" && now.status === "fail") {
      diff.regressions.push(change("pass_to_fail", `passed → failed (pass rate ${pct(then.passRate)} → ${pct(now.passRate)})`));
    } else if (then.status === "fail" && now.status === "pass") {
      diff.improvements.push(change("fail_to_pass", `failed → passed (pass rate ${pct(then.passRate)} → ${pct(now.passRate)})`));
    }

    if (then.judgeScore !== null && now.judgeScore !== null) {
      const delta = now.judgeScore - then.judgeScore;
      const msg = `judge score ${then.judgeScore.toFixed(2)} → ${now.judgeScore.toFixed(2)}`;
      if (delta <= -opts.scoreTolerance) diff.regressions.push(change("score_drop", msg));
      else if (delta >= opts.scoreTolerance) diff.improvements.push(change("score_gain", msg));
    }
  }
  for (const key of before.keys()) if (!after.has(key)) diff.removed.push(key);
  return diff;
}

function indexCases(report: RunReport): Map<string, CaseResult> {
  return new Map(report.suites.flatMap((s) => s.cases.map((c) => [caseKey(c), c] as const)));
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

import path from "node:path";
import { createColors } from "picocolors";
import type { CaseResult, RunReport } from "../results.js";
import { firstFailure, formatCost, formatInt, formatMs, meanTurns, truncate } from "./format.js";

export interface TerminalOptions {
  color: boolean;
  /** Show every failing attempt instead of only the first. */
  verbose?: boolean;
  cwd?: string;
}

export function renderTerminal(report: RunReport, opts: TerminalOptions): string {
  const c = createColors(opts.color);
  const cwd = opts.cwd ?? process.cwd();
  const lines: string[] = [];
  const nameWidth = Math.min(
    48,
    Math.max(20, ...report.suites.flatMap((s) => s.cases.map((cs) => cs.name.length + (cs.flaky ? 8 : 0)))),
  );

  for (const suite of report.suites) {
    lines.push("", `${c.bold(suite.name)} ${c.dim(`${path.relative(cwd, suite.file) || suite.file} · ${suite.model}`)}`);
    for (const cs of suite.cases) {
      lines.push(caseLine(cs));
      if (cs.status === "fail" || (opts.verbose && cs.flaky)) lines.push(...failureDetail(cs));
    }
  }

  const s = report.summary;
  const parts = [c.green(`${s.passed} passed`)];
  if (s.failed > 0) parts.push(c.red(`${s.failed} failed`));
  if (s.flaky > 0) parts.push(c.yellow(`${s.flaky} flaky`));
  lines.push(
    "",
    c.bold("Summary"),
    `  cases     ${parts.join(", ")} ${c.dim(`(${s.cases} total)`)}`,
    `  attempts  ${s.attemptsPassed}/${s.attempts} passed`,
    `  tokens    ${formatInt(s.usage.inputTokens + s.usage.cacheReadTokens + s.usage.cacheWriteTokens)} in · ${formatInt(s.usage.outputTokens)} out`,
    `  cost      ${formatCost(s.costUsd)} agent · ${formatCost(s.judgeCostUsd)} judge`,
    `  latency   p50 ${formatMs(s.latency.p50)} · p95 ${formatMs(s.latency.p95)}`,
    `  duration  ${formatMs(report.durationMs)}`,
  );

  if (report.baseline) {
    const b = report.baseline;
    lines.push("", c.bold(`Baseline ${c.dim(`(${path.relative(cwd, b.file) || b.file})`)}`));
    if (b.regressions.length === 0) lines.push(`  ${c.green("no regressions")}`);
    for (const r of b.regressions) lines.push(`  ${c.red("regression")}   ${r.key}: ${r.message}`);
    for (const r of b.improvements) lines.push(`  ${c.green("improvement")}  ${r.key}: ${r.message}`);
    for (const k of b.added) lines.push(`  ${c.dim("new")}          ${k}`);
    for (const k of b.removed) lines.push(`  ${c.dim("removed")}      ${k}`);
  }
  lines.push("");
  return lines.join("\n");

  function caseLine(cs: CaseResult): string {
    const icon = cs.status === "fail" ? c.red("✗") : cs.flaky ? c.yellow("~") : c.green("✓");
    const label = cs.flaky ? `${cs.name} ${c.yellow("(flaky)")}` : cs.name;
    const pad = " ".repeat(Math.max(1, nameWidth - cs.name.length - (cs.flaky ? 8 : 0) + 2));
    const stats = [
      `${cs.passCount}/${cs.attempts.length}`.padStart(5),
      `${meanTurns(cs).toFixed(1)} turns`.padStart(10),
      formatCost(cs.costUsd).padStart(9),
      (cs.attempts.length > 1 ? `p50 ${formatMs(cs.latency.p50)}` : formatMs(cs.latency.p50)).padStart(11),
    ];
    if (cs.judgeScore !== null) stats.push(`judge ${cs.judgeScore.toFixed(1)}`);
    return `  ${icon} ${label}${pad}${c.dim(stats.join("  "))}`;
  }

  function failureDetail(cs: CaseResult): string[] {
    const attempts = opts.verbose ? cs.attempts.filter((a) => !a.passed) : [firstFailure(cs)].filter((a) => a !== undefined);
    const out: string[] = [];
    for (const a of attempts) {
      if (cs.attempts.length > 1) out.push(c.dim(`      attempt ${a.index + 1}:`));
      if (a.error) out.push(`      ${c.red("✗")} ${a.error}`);
      for (const r of a.assertions.filter((x) => !x.passed)) {
        out.push(`      ${c.red("✗")} ${r.label} ${c.dim("—")} ${r.message}`);
        if (r.reasoning) out.push(c.dim(`          ${truncate(r.reasoning, 160)}`));
      }
      if (a.stopReason !== "error") out.push(c.dim(`        output: ${truncate(a.output, 160) || "(empty)"}`));
    }
    return out;
  }
}

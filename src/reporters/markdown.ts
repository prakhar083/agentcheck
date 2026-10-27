import type { CaseResult, RunReport } from "../results.js";
import { firstFailure, formatCost, formatMs, formatPct, meanTurns, truncate } from "./format.js";

/** GitHub-flavoured Markdown, sized for $GITHUB_STEP_SUMMARY or a PR comment. */
export function renderMarkdown(report: RunReport): string {
  const s = report.summary;
  const regressions = report.baseline?.regressions ?? [];
  const ok = s.failed === 0 && regressions.length === 0;
  const out: string[] = [];

  out.push(`## agentcheck: ${ok ? "passed" : "failed"} (${s.passed}/${s.cases} cases)`, "");
  const headline = [`**${s.passed} passed**`, `**${s.failed} failed**`];
  if (s.flaky > 0) headline.push(`**${s.flaky} flaky**`);
  out.push(
    `${headline.join(" · ")} · ${s.attemptsPassed}/${s.attempts} attempts · cost ${formatCost(s.costUsd)} (+${formatCost(s.judgeCostUsd)} judge) · latency p50 ${formatMs(s.latency.p50)} / p95 ${formatMs(s.latency.p95)} · ${formatMs(report.durationMs)}`,
    "",
  );

  if (report.baseline) {
    const b = report.baseline;
    if (regressions.length > 0) {
      out.push(`### Regressions vs baseline (${regressions.length})`, "", "| Case | Change |", "| --- | --- |");
      for (const r of regressions) out.push(`| ${cell(r.key)} | ${cell(r.message)} |`);
      out.push("");
    } else {
      out.push("No regressions against the baseline.", "");
    }
    const notes = [
      ...b.improvements.map((r) => `- Improved: ${cell(r.key)}: ${r.message}`),
      ...b.added.map((k) => `- New: ${cell(k)}`),
      ...b.removed.map((k) => `- Removed: ${cell(k)}`),
    ];
    if (notes.length > 0) out.push(...notes, "");
  }

  for (const suite of report.suites) {
    out.push(`### ${suite.name}`, "", `\`${suite.model}\``, "");
    out.push("| | Case | Pass rate | Judge | Turns | Cost | Latency p50 / p95 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const c of suite.cases) {
      out.push(
        `| ${status(c)} | ${cell(c.name)} | ${c.passCount}/${c.attempts.length} (${formatPct(c.passRate)}) | ${c.judgeScore === null ? "–" : c.judgeScore.toFixed(1)} | ${meanTurns(c).toFixed(1)} | ${formatCost(c.costUsd)} | ${formatMs(c.latency.p50)} / ${formatMs(c.latency.p95)} |`,
      );
    }
    out.push("");

    const failed = suite.cases.filter((c) => c.status === "fail");
    if (failed.length > 0) {
      out.push(`<details><summary>Failure details (${failed.length})</summary>`, "");
      for (const c of failed) out.push(...failureDetail(c));
      out.push("</details>", "");
    }
  }
  return out.join("\n");
}

function status(c: CaseResult): string {
  if (c.status === "fail") return "**FAIL**";
  return c.flaky ? "flaky" : "pass";
}

function failureDetail(c: CaseResult): string[] {
  const a = firstFailure(c);
  if (!a) return [];
  const lines = [`#### ${cell(c.name)}`, ""];
  if (c.attempts.length > 1) lines.push(`Attempt ${a.index + 1} of ${c.attempts.length}:`, "");
  if (a.error) lines.push(`- ${a.error}`);
  for (const r of a.assertions.filter((x) => !x.passed)) {
    lines.push(`- \`${r.label.replace(/`/g, "'")}\`: ${r.message}`);
    if (r.reasoning) lines.push(`  > ${truncate(r.reasoning, 400)}`);
  }
  if (a.output) lines.push("", "```text", truncate(a.output, 600).replace(/```/g, "'''"), "```");
  lines.push("");
  return lines;
}

/** Escape text for a table cell or heading: pipes break tables and raw `<` is parsed as HTML. */
function cell(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

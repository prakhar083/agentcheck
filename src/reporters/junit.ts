import type { CaseResult, RunReport } from "../results.js";
import { firstFailure, formatPct } from "./format.js";

/** JUnit XML: one <testsuite> per suite file, one <testcase> per case (attempts are aggregated). */
export function renderJUnit(report: RunReport): string {
  const s = report.summary;
  const out = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="agentcheck" tests="${s.cases}" failures="${s.failed}" errors="0" time="${seconds(report.durationMs)}">`,
  ];
  for (const suite of report.suites) {
    const failures = suite.cases.filter((c) => c.status === "fail").length;
    const time = suite.cases.reduce((t, c) => t + c.attempts.reduce((a, x) => a + x.latencyMs, 0), 0);
    out.push(
      `  <testsuite name="${attr(suite.name)}" tests="${suite.cases.length}" failures="${failures}" errors="0" skipped="0" time="${seconds(time)}" timestamp="${attr(report.startedAt)}" file="${attr(suite.file)}">`,
    );
    for (const c of suite.cases) out.push(...testcase(suite.name, c));
    out.push(`  </testsuite>`);
  }
  out.push(`</testsuites>`, "");
  return out.join("\n");
}

function testcase(suite: string, c: CaseResult): string[] {
  const time = c.attempts.reduce((t, a) => t + a.latencyMs, 0);
  const open = `    <testcase classname="${attr(suite)}" name="${attr(c.name)}" time="${seconds(time)}"`;
  const summary = `pass rate ${c.passCount}/${c.attempts.length} (${formatPct(c.passRate)}), threshold ${formatPct(c.passThreshold)}${c.flaky ? ", flaky" : ""}${c.judgeScore !== null ? `, judge ${c.judgeScore.toFixed(2)}` : ""}`;
  const lines = [`${open}>`];
  if (c.status === "fail") {
    const a = firstFailure(c);
    const details: string[] = [];
    if (a?.error) details.push(a.error);
    for (const r of a?.assertions.filter((x) => !x.passed) ?? []) {
      details.push(`${r.label}: ${r.message}`);
      if (r.reasoning) details.push(`  judge: ${r.reasoning}`);
    }
    if (a) details.push("", "output:", a.output);
    lines.push(`      <failure message="${attr(summary)}" type="AssertionFailure">${text(details.join("\n"))}</failure>`);
  }
  lines.push(`      <system-out>${text(summary)}</system-out>`, `    </testcase>`);
  return lines;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

// XML 1.0 forbids most control characters even when escaped.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function text(value: string): string {
  return value.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attr(value: string): string {
  return text(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

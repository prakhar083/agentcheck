import type { RunReport } from "../results.js";

export function renderJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

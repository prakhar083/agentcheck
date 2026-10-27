import type { AttemptResult, CaseResult } from "../results.js";
import { mean } from "../stats.js";

export function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function meanTurns(c: CaseResult): number {
  return mean(c.attempts.filter((a) => a.stopReason !== "error").map((a) => a.turns));
}

/** The first failing attempt, which reporters show as the representative failure. */
export function firstFailure(c: CaseResult): AttemptResult | undefined {
  return c.attempts.find((a) => !a.passed);
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

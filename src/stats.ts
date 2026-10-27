/** Nearest-rank percentile. Returns 0 for an empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export interface LatencyStats {
  p50: number;
  p95: number;
  mean: number;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  return { p50: percentile(values, 50), p95: percentile(values, 95), mean: mean(values) };
}

/** Sum that stays null if any element is null (an unpriced model makes the total unknown). */
export function sumNullable(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

import { describe, expect, it } from "vitest";
import { computeCost, lookupPrice, PRICING } from "../src/pricing.js";
import { latencyStats, mean, percentile, sumNullable } from "../src/stats.js";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("computeCost", () => {
  it("prices input and output per million tokens", () => {
    expect(computeCost(usage(1_000_000, 1_000_000), "claude-sonnet-5-5")).toBeCloseTo(12, 10);
    expect(computeCost(usage(12_345, 678), "claude-opus-5-5")).toBeCloseTo((12_345 * 4 + 678 * 20) / 1e6, 12);
  });

  it("uses explicit cache-read prices and the 0.1x / 1.25x defaults otherwise", () => {
    expect(computeCost(usage(0, 0, 1_000_000), "claude-sonnet-5-5")).toBeCloseTo(0.2, 10);
    expect(computeCost(usage(0, 0, 1_000_000), "claude-opus-4-8")).toBeCloseTo(0.5, 10);
    expect(computeCost(usage(0, 0, 0, 1_000_000), "claude-opus-4-8")).toBeCloseTo(6.25, 10);
  });

  it("returns null for unknown models and honours overrides", () => {
    expect(computeCost(usage(100, 100), "llama-3-70b")).toBeNull();
    expect(computeCost(usage(1_000_000, 0), "llama-3-70b", { "llama-3-70b": { input: 0.5, output: 1 } })).toBeCloseTo(0.5, 10);
    expect(lookupPrice("claude-sonnet-5-5", { "claude-sonnet-5-5": { input: 1, output: 1 } })).toEqual({ input: 1, output: 1 });
  });

  it("has a price for the default model", () => {
    expect(PRICING["claude-sonnet-5-5"]).toBeDefined();
  });
});

describe("stats", () => {
  it("computes nearest-rank percentiles", () => {
    const values = [120, 80, 100, 400, 90, 110, 95, 105, 85, 1000];
    expect(percentile(values, 50)).toBe(100);
    expect(percentile(values, 95)).toBe(1000);
    expect(percentile(values, 0)).toBe(80);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it("summarizes latency", () => {
    expect(latencyStats([100, 200, 300, 400])).toEqual({ p50: 200, p95: 400, mean: 250 });
    expect(mean([])).toBe(0);
  });

  it("sums nullable costs, propagating unknowns", () => {
    expect(sumNullable([0.1, 0.2])).toBeCloseTo(0.3, 10);
    expect(sumNullable([0.1, null])).toBeNull();
    expect(sumNullable([])).toBe(0);
  });
});

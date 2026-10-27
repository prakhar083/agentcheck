import type { Usage } from "./types.js";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Defaults to 10% of `input` when omitted. */
  cacheRead?: number;
  /** Defaults to 125% of `input` (5-minute cache writes) when omitted. */
  cacheWrite?: number;
}

/**
 * First-party Anthropic API list prices. This is the only place prices live;
 * suites can add or override entries with a top-level `pricing:` map, which is
 * how you price OpenAI-compatible or self-hosted models.
 *
 * Note: Claude Haiku 5.5 doubles its rate above 100K prompt tokens; the table
 * uses the base tier.
 */
export const PRICING: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export function lookupPrice(model: string, overrides: Readonly<Record<string, ModelPrice>> = {}): ModelPrice | undefined {
  return overrides[model] ?? PRICING[model];
}

/** Cost in USD, or `null` when the model has no known price. */
export function computeCost(
  usage: Usage,
  model: string,
  overrides: Readonly<Record<string, ModelPrice>> = {},
): number | null {
  const price = lookupPrice(model, overrides);
  if (!price) return null;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  const micro =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * cacheRead +
    usage.cacheWriteTokens * cacheWrite;
  return micro / 1_000_000;
}

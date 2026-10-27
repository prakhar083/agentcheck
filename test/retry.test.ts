import { describe, expect, it, vi } from "vitest";
import { backoffDelay, isRetryableStatus, parseRetryAfter, ProviderError, withRetries, withRetry } from "../src/providers/retry.js";
import { MockProvider } from "../src/providers/mock.js";

const noSleep = { retries: 3, baseDelayMs: 100, maxDelayMs: 1000, random: () => 1 };

describe("retry policy", () => {
  it("classifies retryable statuses", () => {
    expect([408, 409, 429, 500, 503, 529].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it("parses Retry-After in seconds and as an HTTP date", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("backs off exponentially with jitter and a cap", () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
    expect(backoffDelay(0, opts, () => 1)).toBe(100);
    expect(backoffDelay(2, opts, () => 1)).toBe(400);
    expect(backoffDelay(10, opts, () => 1)).toBe(1000);
    expect(backoffDelay(2, opts, () => 0)).toBe(200);
  });

  it("retries retryable ProviderErrors and then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderError("rate limited", { status: 429, retryable: true }))
      .mockRejectedValueOnce(new ProviderError("overloaded", { status: 529, retryable: true, retryAfterMs: 50 }))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { ...noSleep, sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // First delay from backoff, second honours Retry-After.
    expect(sleep.mock.calls).toEqual([[100], [50]]);
  });

  it("gives up after the configured number of retries", async () => {
    const err = new ProviderError("server error", { status: 500, retryable: true });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { ...noSleep, sleep: async () => {} })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-retryable or unknown errors", async () => {
    const bad = vi.fn(async () => {
      throw new ProviderError("bad request", { status: 400, retryable: false });
    });
    await expect(withRetry(bad, { ...noSleep, sleep: async () => {} })).rejects.toThrow("bad request");
    expect(bad).toHaveBeenCalledTimes(1);

    const plain = vi.fn(async () => {
      throw new TypeError("bug");
    });
    await expect(withRetry(plain, { ...noSleep, sleep: async () => {} })).rejects.toThrow("bug");
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("wraps a provider", async () => {
    const provider = new MockProvider([
      { throws: new ProviderError("429", { status: 429, retryable: true }) },
      { text: "done" },
    ]);
    const wrapped = withRetries(provider, { ...noSleep, sleep: async () => {} });
    const res = await wrapped.complete({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 10 });
    expect(res.text).toBe("done");
    expect(provider.requests).toHaveLength(2);
  });
});

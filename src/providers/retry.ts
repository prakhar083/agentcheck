import type { ModelRequest, ModelResponse, Provider } from "../types.js";

/** Error type providers throw so the retry policy can stay provider-agnostic. */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, opts: { status?: number; retryable: boolean; retryAfterMs?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "ProviderError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ProviderError }) => void;
}

export const DEFAULT_RETRY: RetryOptions = { retries: 4, baseDelayMs: 1000, maxDelayMs: 30_000 };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter: the delay is drawn from [50%, 100%] of the capped exponential step. */
export function backoffDelay(attempt: number, opts: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs">, random = Math.random): number {
  const step = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(step * (0.5 + random() * 0.5));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof ProviderError) || !err.retryable || attempt >= opts.retries) throw err;
      const delayMs =
        err.retryAfterMs !== undefined
          ? Math.min(err.retryAfterMs, opts.maxDelayMs)
          : backoffDelay(attempt, opts, opts.random);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}

export function withRetries(provider: Provider, opts: RetryOptions = DEFAULT_RETRY): Provider {
  return {
    name: provider.name,
    complete: (request: ModelRequest): Promise<ModelResponse> => withRetry(() => provider.complete(request), opts),
  };
}

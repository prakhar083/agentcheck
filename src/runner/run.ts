import { type AssertionResult, evaluateAssertions } from "../assertions/index.js";
import type { CaseConfig, ProviderConfig, SuiteConfig } from "../config/types.js";
import { createJudge, type Judge } from "../judge.js";
import { computeCost } from "../pricing.js";
import { createProvider } from "../providers/index.js";
import { DEFAULT_RETRY, type RetryOptions, withRetries } from "../providers/retry.js";
import {
  type AttemptResult,
  type CaseResult,
  REPORT_SCHEMA_VERSION,
  type RunReport,
  type RunSummary,
  type SuiteResult,
} from "../results.js";
import { latencyStats, mean, sumNullable } from "../stats.js";
import { addUsage, emptyUsage, type Message, type Provider, type Usage } from "../types.js";
import { type AgentTrace, runAgentLoop } from "./agent-loop.js";
import { mapWithConcurrency } from "./concurrency.js";

export interface RunOptions {
  /** Maximum attempts in flight across all suites. */
  concurrency: number;
  retry: RetryOptions;
  /** Override every case's `repeat`. */
  repeat?: number;
  /** Only run cases whose name (or `suite › name`) contains this substring, or matches it as a regex. */
  filter?: string;
  /** Inject providers (tests, programmatic use). Defaults to building one from config. */
  providerFactory?: (config: ProviderConfig) => Provider | Promise<Provider>;
  onAttemptComplete?: (event: { suite: string; case: string; attempt: AttemptResult; done: number; total: number }) => void;
  now?: () => number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = { concurrency: 4, retry: DEFAULT_RETRY };

interface Task {
  suite: SuiteConfig;
  testCase: CaseConfig;
  attempt: number;
  provider: Provider;
  judge?: Judge;
}

export async function runSuites(suites: readonly SuiteConfig[], options: Partial<RunOptions> = {}): Promise<RunReport> {
  const opts = { ...DEFAULT_RUN_OPTIONS, ...options };
  const startedAt = new Date();
  const clock = opts.now ?? (() => performance.now());
  const t0 = clock();
  const factory = opts.providerFactory ?? createProvider;
  const matches = buildFilter(opts.filter);

  // Providers are created once per distinct config and shared across cases.
  const providerCache = new Map<string, Promise<Provider>>();
  const getProvider = (config: ProviderConfig) => {
    const key = JSON.stringify(config);
    let p = providerCache.get(key);
    if (!p) {
      p = Promise.resolve(factory(config)).then((provider) => withRetries(provider, opts.retry));
      providerCache.set(key, p);
    }
    return p;
  };

  const selected = suites
    .map((suite) => ({ suite, cases: suite.cases.filter((c) => matches(suite.name, c.name)) }))
    .filter((s) => s.cases.length > 0);

  const tasks: Task[] = [];
  for (const { suite, cases } of selected) {
    const provider = await getProvider(suite.provider);
    const needsJudge = cases.some((c) => c.assertions.some((a) => a.type === "llm_judge"));
    const judge = needsJudge ? createJudge(await getProvider(suite.judge), suite.judge) : undefined;
    for (const testCase of cases) {
      const repeat = opts.repeat ?? testCase.repeat;
      for (let attempt = 0; attempt < repeat; attempt++) tasks.push({ suite, testCase, attempt, provider, judge });
    }
  }

  let done = 0;
  const attempts = await mapWithConcurrency(tasks, opts.concurrency, async (task) => {
    const result = await runAttempt(task, opts.now);
    done++;
    opts.onAttemptComplete?.({ suite: task.suite.name, case: task.testCase.name, attempt: result, done, total: tasks.length });
    return result;
  });

  const suiteResults: SuiteResult[] = selected.map(({ suite, cases }) => ({
    name: suite.name,
    file: suite.file,
    model: suite.provider.model,
    judgeModel: suite.judge.model,
    cases: cases.map((testCase) =>
      aggregateCase(
        suite.name,
        testCase,
        tasks.flatMap((t, i) => (t.testCase === testCase ? [attempts[i] as AttemptResult] : [])),
      ),
    ),
  }));

  return {
    tool: "agentcheck",
    schemaVersion: REPORT_SCHEMA_VERSION,
    startedAt: startedAt.toISOString(),
    durationMs: clock() - t0,
    summary: summarize(suiteResults),
    suites: suiteResults,
  };
}

async function runAttempt(task: Task, now?: () => number): Promise<AttemptResult> {
  const { suite, testCase } = task;
  let trace: AgentTrace;
  try {
    trace = await runAgentLoop({
      provider: task.provider,
      model: suite.provider.model,
      maxTokens: suite.provider.maxTokens,
      system: testCase.system,
      messages: testCase.messages,
      tools: testCase.tools,
      maxTurns: testCase.maxTurns,
      now,
    });
  } catch (err) {
    return {
      index: task.attempt,
      passed: false,
      error: `provider error: ${(err as Error).message}`,
      output: "",
      turns: 0,
      stopReason: "error",
      toolCalls: [],
      usage: emptyUsage(),
      costUsd: 0,
      judgeUsage: emptyUsage(),
      judgeCostUsd: 0,
      latencyMs: 0,
      assertions: [],
      transcript: stripRaw(testCase.messages),
    };
  }

  const costUsd = computeCost(trace.usage, suite.provider.model, suite.pricing);
  const assertions = await evaluateAssertions(testCase.assertions, {
    trace,
    costUsd,
    model: suite.provider.model,
    system: testCase.system,
    judge: task.judge,
  });
  const judgeUsage = assertions.reduce((acc, a) => (a.judgeUsage ? addUsage(acc, a.judgeUsage) : acc), emptyUsage());

  let error: string | undefined;
  if (trace.stopReason === "max_turns") error = `agent did not finish within ${testCase.maxTurns} turns`;
  else if (trace.stopReason === "refusal") error = "model refused to respond (stop_reason: refusal)";

  return {
    index: task.attempt,
    passed: error === undefined && assertions.every((a) => a.passed),
    ...(error ? { error } : {}),
    output: trace.output,
    turns: trace.turns,
    stopReason: trace.stopReason,
    toolCalls: trace.toolCalls.map((c) => ({
      name: c.name,
      args: c.args,
      turn: c.turn,
      isError: c.result.isError,
      result: c.result.content,
    })),
    usage: trace.usage,
    costUsd,
    judgeUsage,
    judgeCostUsd: isZero(judgeUsage) ? 0 : computeCost(judgeUsage, suite.judge.model, suite.pricing),
    latencyMs: trace.latencyMs,
    assertions,
    transcript: stripRaw(trace.messages),
  };
}

export function aggregateCase(suite: string, testCase: CaseConfig, attempts: AttemptResult[]): CaseResult {
  const passCount = attempts.filter((a) => a.passed).length;
  const passRate = attempts.length === 0 ? 0 : passCount / attempts.length;
  const scores = attempts.flatMap((a) => a.assertions.flatMap((r: AssertionResult) => (r.score !== undefined ? [r.score] : [])));
  return {
    suite,
    name: testCase.name,
    tags: testCase.tags,
    // Small epsilon so thresholds like 0.8 with 4/5 passes are not lost to float error.
    status: attempts.length > 0 && passRate + 1e-9 >= testCase.passThreshold ? "pass" : "fail",
    flaky: passCount > 0 && passCount < attempts.length,
    passCount,
    passRate,
    passThreshold: testCase.passThreshold,
    judgeScore: scores.length > 0 ? mean(scores) : null,
    usage: attempts.reduce((acc, a) => addUsage(acc, a.usage), emptyUsage()),
    costUsd: sumNullable(attempts.map((a) => a.costUsd)),
    judgeCostUsd: sumNullable(attempts.map((a) => a.judgeCostUsd)),
    latency: latencyStats(attempts.filter((a) => a.stopReason !== "error").map((a) => a.latencyMs)),
    attempts,
  };
}

export function summarize(suites: readonly SuiteResult[]): RunSummary {
  const cases = suites.flatMap((s) => s.cases);
  const attempts = cases.flatMap((c) => c.attempts);
  return {
    cases: cases.length,
    passed: cases.filter((c) => c.status === "pass").length,
    failed: cases.filter((c) => c.status === "fail").length,
    flaky: cases.filter((c) => c.flaky).length,
    attempts: attempts.length,
    attemptsPassed: attempts.filter((a) => a.passed).length,
    usage: cases.reduce((acc, c) => addUsage(acc, c.usage), emptyUsage()),
    costUsd: sumNullable(cases.map((c) => c.costUsd)),
    judgeCostUsd: sumNullable(cases.map((c) => c.judgeCostUsd)),
    latency: latencyStats(attempts.filter((a) => a.stopReason !== "error").map((a) => a.latencyMs)),
  };
}

function buildFilter(filter: string | undefined): (suite: string, name: string) => boolean {
  if (!filter) return () => true;
  let re: RegExp | undefined;
  try {
    re = new RegExp(filter, "i");
  } catch {
    re = undefined;
  }
  const needle = filter.toLowerCase();
  return (suite, name) => {
    const full = `${suite} › ${name}`;
    return re ? re.test(full) : full.toLowerCase().includes(needle);
  };
}

/** Provider-specific raw content (e.g. thinking signatures) is not useful in reports. */
function stripRaw(messages: readonly Message[]): Message[] {
  return messages.map((m) => (m.role === "assistant" ? { role: "assistant", text: m.text, toolCalls: m.toolCalls } : m));
}

function isZero(u: Usage): boolean {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens === 0;
}

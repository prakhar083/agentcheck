import { Ajv, type ValidateFunction } from "ajv";
import type { Assertion } from "../config/types.js";
import { JudgeParseError, type Judge } from "../judge.js";
import { matchesSubset } from "../match.js";
import type { AgentTrace, RecordedToolCall } from "../runner/agent-loop.js";
import type { Usage } from "../types.js";

export interface AssertionResult {
  type: Assertion["type"];
  /** Human-readable description of what was checked. */
  label: string;
  passed: boolean;
  /** Why it failed (or a short note on success). */
  message: string;
  /** llm_judge only. */
  score?: number;
  reasoning?: string;
  judgeUsage?: Usage;
}

export interface AssertionContext {
  trace: AgentTrace;
  /** Agent cost for this attempt; null when the model has no known price. */
  costUsd: number | null;
  model: string;
  system?: string;
  judge?: Judge;
}

export async function evaluateAssertions(assertions: readonly Assertion[], ctx: AssertionContext): Promise<AssertionResult[]> {
  // Judge calls are the slow part; run independent assertions concurrently.
  return Promise.all(assertions.map((a) => evaluateAssertion(a, ctx)));
}

export async function evaluateAssertion(a: Assertion, ctx: AssertionContext): Promise<AssertionResult> {
  const { trace } = ctx;
  const label = describeAssertion(a);
  const result = (passed: boolean, message: string): AssertionResult => ({ type: a.type, label, passed, message });

  switch (a.type) {
    case "contains":
    case "not_contains": {
      const values = Array.isArray(a.value) ? a.value : [a.value];
      const haystack = a.ignore_case ? trace.output.toLowerCase() : trace.output;
      const present = values.filter((v) => haystack.includes(a.ignore_case ? v.toLowerCase() : v));
      if (a.type === "contains") {
        const missing = values.filter((v) => !present.includes(v));
        return result(missing.length === 0, missing.length === 0 ? "found" : `output is missing ${quoteList(missing)}`);
      }
      return result(present.length === 0, present.length === 0 ? "not found" : `output contains ${quoteList(present)}`);
    }

    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(a.pattern, a.flags);
      } catch (err) {
        return result(false, `invalid regex: ${(err as Error).message}`);
      }
      const ok = re.test(trace.output);
      return result(ok, ok ? "matched" : `output does not match /${a.pattern}/${a.flags ?? ""}`);
    }

    case "equals": {
      const ok = trace.output.trim() === a.value.trim();
      return result(ok, ok ? "equal" : `expected ${JSON.stringify(a.value.trim())}, got ${JSON.stringify(truncate(trace.output.trim(), 200))}`);
    }

    case "json_schema": {
      const parsed = parseJsonOutput(trace.output);
      if (!parsed.ok) return result(false, `output is not valid JSON: ${parsed.error}`);
      let validate: ValidateFunction;
      try {
        validate = compileSchema(a.schema);
      } catch (err) {
        return result(false, `invalid JSON schema: ${(err as Error).message}`);
      }
      if (validate(parsed.value)) return result(true, "valid");
      const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
      return result(false, `schema validation failed: ${errors.join("; ")}`);
    }

    case "tool_called": {
      const matches = matchingCalls(trace.toolCalls, a.name, a.args);
      if (a.count !== undefined && matches.length !== a.count) {
        return result(false, `expected ${a.count} matching call(s), got ${matches.length}${describeCalls(trace.toolCalls)}`);
      }
      if (a.count === undefined && matches.length === 0) {
        return result(false, `no matching call${describeCalls(trace.toolCalls)}`);
      }
      if (a.after !== undefined) {
        const anchor = trace.toolCalls.findIndex((c) => c.name === a.after);
        if (anchor === -1) return result(false, `${a.after} was never called`);
        const ok = matches.some((m) => trace.toolCalls.indexOf(m) > anchor);
        if (!ok) return result(false, `${a.name} was not called after ${a.after}${describeCalls(trace.toolCalls)}`);
      }
      return result(true, `${matches.length} matching call(s)`);
    }

    case "tool_not_called": {
      const matches = matchingCalls(trace.toolCalls, a.name, a.args);
      return result(
        matches.length === 0,
        matches.length === 0 ? "not called" : `called ${matches.length} time(s): ${matches.map((m) => JSON.stringify(m.args)).join(", ")}`,
      );
    }

    case "tool_sequence": {
      const names = trace.toolCalls.map((c) => c.name);
      let i = 0;
      for (const name of names) if (name === a.names[i]) i++;
      const ok = i === a.names.length;
      return result(ok, ok ? "in order" : `expected subsequence [${a.names.join(" -> ")}], got [${names.join(" -> ")}]`);
    }

    case "max_turns":
      return result(trace.turns <= a.value, `${trace.turns} turn(s), limit ${a.value}`);

    case "max_cost_usd":
      if (ctx.costUsd === null) {
        return result(false, `no price known for model "${ctx.model}"; add it under \`pricing:\` in the suite`);
      }
      return result(ctx.costUsd <= a.value, `$${ctx.costUsd.toFixed(6)}, limit $${a.value}`);

    case "max_latency_ms":
      return result(trace.latencyMs <= a.value, `${Math.round(trace.latencyMs)}ms, limit ${a.value}ms`);

    case "llm_judge": {
      if (!ctx.judge) return result(false, "no judge configured");
      try {
        const verdict = await ctx.judge.grade(a.rubric, trace, ctx.system);
        return {
          ...result(verdict.score >= a.threshold, `score ${verdict.score}/5, threshold ${a.threshold}`),
          score: verdict.score,
          reasoning: verdict.reasoning,
          judgeUsage: verdict.usage,
        };
      } catch (err) {
        if (err instanceof JudgeParseError) {
          return { ...result(false, `${err.message}: ${truncate(err.rawOutput, 200)}`), judgeUsage: err.usage };
        }
        return result(false, `judge call failed: ${(err as Error).message}`);
      }
    }
  }
}

export function describeAssertion(a: Assertion): string {
  switch (a.type) {
    case "contains":
    case "not_contains":
      return `${a.type} ${quoteList(Array.isArray(a.value) ? a.value : [a.value])}`;
    case "regex":
      return `regex /${a.pattern}/${a.flags ?? ""}`;
    case "equals":
      return `equals ${JSON.stringify(truncate(a.value, 40))}`;
    case "json_schema":
      return "json_schema";
    case "tool_called": {
      const parts = [`tool_called ${a.name}`];
      if (a.args) parts.push(JSON.stringify(a.args));
      if (a.count !== undefined) parts.push(`x${a.count}`);
      if (a.after) parts.push(`after ${a.after}`);
      return parts.join(" ");
    }
    case "tool_not_called":
      return `tool_not_called ${a.name}${a.args ? ` ${JSON.stringify(a.args)}` : ""}`;
    case "tool_sequence":
      return `tool_sequence ${a.names.join(" -> ")}`;
    case "max_turns":
      return `max_turns ${a.value}`;
    case "max_cost_usd":
      return `max_cost_usd ${a.value}`;
    case "max_latency_ms":
      return `max_latency_ms ${a.value}`;
    case "llm_judge":
      return `llm_judge >= ${a.threshold}: ${truncate(a.rubric.trim().split("\n")[0] ?? "", 60)}`;
  }
}

function matchingCalls(calls: readonly RecordedToolCall[], name: string, args?: Record<string, unknown>): RecordedToolCall[] {
  return calls.filter((c) => c.name === name && (args === undefined || matchesSubset(c.args, args)));
}

function describeCalls(calls: readonly RecordedToolCall[]): string {
  if (calls.length === 0) return " (no tools were called)";
  return ` (calls: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")})`;
}

/** Accept bare JSON or a single fenced ```json block, which models often emit. */
export function parseJsonOutput(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return { ok: true, value: JSON.parse(fenced?.[1] ?? trimmed) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCache = new WeakMap<object, ValidateFunction>();

function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  let fn = schemaCache.get(schema);
  if (!fn) {
    fn = ajv.compile(schema);
    schemaCache.set(schema, fn);
  }
  return fn;
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => JSON.stringify(v)).join(", ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

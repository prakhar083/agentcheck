import { parseSuite } from "../src/config/load.js";
import type { SuiteConfig } from "../src/config/types.js";
import type { AgentTrace, RecordedToolCall } from "../src/runner/agent-loop.js";
import { emptyUsage } from "../src/types.js";

/** Build a validated suite from a plain object, as if it had been loaded from YAML. */
export function suite(doc: Record<string, unknown>, file = "/virtual/test.eval.yaml"): SuiteConfig {
  return parseSuite(doc, file);
}

export function trace(partial: Partial<AgentTrace> = {}): AgentTrace {
  return {
    messages: [{ role: "user", content: "hi" }],
    output: "",
    toolCalls: [],
    turns: 1,
    stopReason: "end_turn",
    usage: emptyUsage(),
    latencyMs: 100,
    ...partial,
  };
}

export function call(name: string, args: Record<string, unknown> = {}, turn = 1): RecordedToolCall {
  return { id: `${name}-${turn}`, name, args, turn, result: { callId: `${name}-${turn}`, name, content: "{}", isError: false } };
}

/** Deterministic clock: each read advances by `step` ms. */
export function fakeClock(step = 10): () => number {
  let t = 0;
  return () => (t += step);
}

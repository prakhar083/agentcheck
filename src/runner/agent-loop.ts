import type { ToolConfig } from "../config/types.js";
import { addUsage, emptyUsage, type Message, type Provider, type StopReason, type ToolCall, type ToolResult, type Usage } from "../types.js";
import { resolveToolCall } from "./mock-tools.js";

export interface RecordedToolCall extends ToolCall {
  /** 1-based model turn that issued the call. */
  turn: number;
  result: ToolResult;
}

export interface AgentTrace {
  /** Full transcript, including the case's starting messages. */
  messages: Message[];
  /** Text of the agent's final assistant turn. */
  output: string;
  toolCalls: RecordedToolCall[];
  /** Number of model calls made. */
  turns: number;
  stopReason: StopReason | "max_turns";
  usage: Usage;
  latencyMs: number;
}

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  maxTokens: number;
  system?: string;
  messages: readonly Message[];
  tools: readonly ToolConfig[];
  maxTurns: number;
  now?: () => number;
}

/**
 * Drive the model until it stops calling tools or the turn budget runs out.
 * Every tool call is answered from the case's mocks, so runs are hermetic.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentTrace> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const messages: Message[] = [...opts.messages];
  const toolSpecs = opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const toolCalls: RecordedToolCall[] = [];
  let usage = emptyUsage();
  let output = "";
  let stopReason: AgentTrace["stopReason"] = "max_turns";
  let turns = 0;

  while (turns < opts.maxTurns) {
    turns++;
    const response = await opts.provider.complete({
      model: opts.model,
      system: opts.system,
      messages,
      tools: toolSpecs,
      maxTokens: opts.maxTokens,
    });
    usage = addUsage(usage, response.usage);
    messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls, raw: response.raw });
    output = response.text;

    if (response.toolCalls.length === 0) {
      stopReason = response.stopReason;
      break;
    }

    const results = response.toolCalls.map((call) => resolveToolCall(call, opts.tools));
    response.toolCalls.forEach((call, i) => toolCalls.push({ ...call, turn: turns, result: results[i] as ToolResult }));
    messages.push({ role: "tool", results });
  }

  return { messages, output, toolCalls, turns, stopReason, usage, latencyMs: now() - started };
}

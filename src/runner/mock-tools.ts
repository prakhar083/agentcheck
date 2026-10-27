import type { ToolConfig } from "../config/types.js";
import { matchesSubset } from "../match.js";
import type { ToolCall, ToolResult } from "../types.js";

/**
 * Resolve a tool call against its mocked responses. Rules are tried in order;
 * the first whose `when` is a subset of the call arguments wins. A rule
 * without `when` matches anything, so put it last as the default.
 */
export function resolveToolCall(call: ToolCall, tools: readonly ToolConfig[]): ToolResult {
  const base = { callId: call.id, name: call.name };
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { ...base, isError: true, content: `Unknown tool "${call.name}".` };
  }
  const rule = tool.rules.find((r) => r.when === undefined || matchesSubset(call.args, r.when));
  if (!rule) {
    return {
      ...base,
      isError: true,
      content: `No mocked response for ${call.name} with arguments ${JSON.stringify(call.args)}.`,
    };
  }
  if (rule.error !== undefined) {
    return { ...base, isError: true, content: rule.error };
  }
  return { ...base, isError: false, content: serialize(rule.response) };
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

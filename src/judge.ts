import type { ProviderConfig } from "./config/types.js";
import type { AgentTrace } from "./runner/agent-loop.js";
import type { Message, Provider, Usage } from "./types.js";

export interface JudgeVerdict {
  score: number;
  reasoning: string;
}

/** Reasoning comes before the score so the judge commits to an argument first. */
export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    reasoning: { type: "string", description: "Short justification that cites specifics from the transcript." },
    score: { type: "integer", description: "1 (fails the rubric) to 5 (fully satisfies it)." },
  },
  required: ["reasoning", "score"],
  additionalProperties: false,
} as const;

export const JUDGE_SYSTEM = [
  "You are a strict evaluator grading the behaviour of an AI agent against a rubric.",
  "Judge only what the transcript shows. Do not reward intentions, only observable actions and the final answer.",
  "Score on a 1-5 scale:",
  "5 = fully satisfies every part of the rubric",
  "4 = satisfies the rubric with minor, harmless deviations",
  "3 = partially satisfies the rubric; a noticeable requirement is missed",
  "2 = mostly fails the rubric",
  "1 = fails the rubric entirely or does something the rubric forbids",
  'Respond with a single JSON object: {"reasoning": string, "score": integer}.',
].join("\n");

export class JudgeParseError extends Error {
  /** Tokens spent on the unparseable reply, so the cost is still accounted for. */
  usage: Usage | undefined;

  constructor(
    message: string,
    readonly rawOutput: string,
  ) {
    super(message);
    this.name = "JudgeParseError";
  }
}

export function buildJudgePrompt(rubric: string, trace: Pick<AgentTrace, "messages" | "output">, system?: string): string {
  const sections = [
    "<rubric>",
    rubric.trim(),
    "</rubric>",
    "",
    ...(system ? ["<agent_system_prompt>", system.trim(), "</agent_system_prompt>", ""] : []),
    "<transcript>",
    formatTranscript(trace.messages),
    "</transcript>",
    "",
    "<final_answer>",
    trace.output.trim() || "(the agent produced no final text)",
    "</final_answer>",
    "",
    "Grade the agent against the rubric.",
  ];
  return sections.join("\n");
}

export function formatTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") lines.push(`USER: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.text) lines.push(`AGENT: ${m.text}`);
      for (const call of m.toolCalls) lines.push(`AGENT CALLED ${call.name}(${JSON.stringify(call.args)})`);
    } else {
      for (const r of m.results) lines.push(`TOOL ${r.name}${r.isError ? " ERROR" : ""}: ${r.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse the judge's reply. Structured output makes this a plain JSON.parse
 * for providers that support it; the fallback extracts the first JSON object
 * from free text so OpenAI-compatible servers without json_schema still work.
 */
export function parseJudgeOutput(text: string): JudgeVerdict {
  const candidate = extractJsonObject(text);
  if (candidate === undefined) throw new JudgeParseError("judge output contained no JSON object", text);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new JudgeParseError("judge output was not valid JSON", text);
  }
  if (typeof value !== "object" || value === null) throw new JudgeParseError("judge output was not an object", text);
  const { score, reasoning } = value as Record<string, unknown>;
  const numeric = typeof score === "string" ? Number(score) : score;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric < 1 || numeric > 5) {
    throw new JudgeParseError(`judge score must be an integer from 1 to 5, got ${JSON.stringify(score)}`, text);
  }
  if (typeof reasoning !== "string") throw new JudgeParseError("judge output is missing `reasoning`", text);
  return { score: numeric, reasoning: reasoning.trim() };
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(trimmed);
  if (fenced?.[1]) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

export interface Judge {
  readonly model: string;
  grade(rubric: string, trace: Pick<AgentTrace, "messages" | "output">, system?: string): Promise<JudgeVerdict & { usage: Usage }>;
}

export function createJudge(provider: Provider, config: Pick<ProviderConfig, "model" | "maxTokens">): Judge {
  return {
    model: config.model,
    async grade(rubric, trace, system) {
      const response = await provider.complete({
        model: config.model,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: buildJudgePrompt(rubric, trace, system) }],
        tools: [],
        maxTokens: config.maxTokens,
        responseSchema: { name: "judge_verdict", schema: JUDGE_SCHEMA },
      });
      try {
        return { ...parseJudgeOutput(response.text), usage: response.usage };
      } catch (err) {
        if (err instanceof JudgeParseError) err.usage = response.usage;
        throw err;
      }
    },
  };
}

import { describe, expect, it } from "vitest";
import { buildJudgePrompt, createJudge, formatTranscript, JUDGE_SCHEMA, JudgeParseError, parseJudgeOutput } from "../src/judge.js";
import { MockProvider } from "../src/providers/mock.js";
import type { Message } from "../src/types.js";

describe("parseJudgeOutput", () => {
  it("parses structured output", () => {
    expect(parseJudgeOutput('{"reasoning":" Clear and correct. ","score":5}')).toEqual({ score: 5, reasoning: "Clear and correct." });
  });

  it("recovers JSON from fenced blocks and surrounding prose", () => {
    expect(parseJudgeOutput('Here you go:\n```json\n{"reasoning":"ok","score":3}\n```')).toEqual({ score: 3, reasoning: "ok" });
    expect(parseJudgeOutput('Verdict: {"reasoning":"meh","score":2} done')).toEqual({ score: 2, reasoning: "meh" });
  });

  it("accepts numeric strings for the score", () => {
    expect(parseJudgeOutput('{"reasoning":"r","score":"4"}').score).toBe(4);
  });

  it.each([
    ["no json here", "contained no JSON object"],
    ["{not json}", "not valid JSON"],
    ['{"reasoning":"r","score":6}', "integer from 1 to 5"],
    ['{"reasoning":"r","score":3.5}', "integer from 1 to 5"],
    ['{"reasoning":"r"}', "integer from 1 to 5"],
    ['{"score":3}', "missing `reasoning`"],
  ])("rejects %j", (text, message) => {
    expect(() => parseJudgeOutput(text)).toThrow(JudgeParseError);
    expect(() => parseJudgeOutput(text)).toThrow(message);
  });
});

describe("judge prompt", () => {
  const messages: Message[] = [
    { role: "user", content: "Refund order A1" },
    { role: "assistant", text: "Looking it up.", toolCalls: [{ id: "1", name: "lookup_order", args: { order_id: "A1" } }] },
    { role: "tool", results: [{ callId: "1", name: "lookup_order", content: '{"status":"delivered"}', isError: false }] },
    { role: "assistant", text: "", toolCalls: [{ id: "2", name: "issue_refund", args: { order_id: "A1" } }] },
    { role: "tool", results: [{ callId: "2", name: "issue_refund", content: "denied", isError: true }] },
  ];

  it("renders the transcript including tool calls and errors", () => {
    expect(formatTranscript(messages)).toBe(
      [
        "USER: Refund order A1",
        "AGENT: Looking it up.",
        'AGENT CALLED lookup_order({"order_id":"A1"})',
        'TOOL lookup_order: {"status":"delivered"}',
        'AGENT CALLED issue_refund({"order_id":"A1"})',
        "TOOL issue_refund ERROR: denied",
      ].join("\n"),
    );
  });

  it("includes rubric, system prompt and final answer", () => {
    const prompt = buildJudgePrompt("  Must apologise.  ", { messages, output: "" }, "You are support.");
    expect(prompt).toContain("<rubric>\nMust apologise.\n</rubric>");
    expect(prompt).toContain("<agent_system_prompt>\nYou are support.\n</agent_system_prompt>");
    expect(prompt).toContain("(the agent produced no final text)");
  });

  it("requests structured output and returns usage", async () => {
    const provider = new MockProvider([{ text: '{"reasoning":"good","score":4}' }]);
    const judge = createJudge(provider, { model: "claude-sonnet-5-5", maxTokens: 2048 });
    const verdict = await judge.grade("rubric", { messages, output: "done" });
    expect(verdict).toMatchObject({ score: 4, reasoning: "good" });
    expect(verdict.usage.inputTokens).toBeGreaterThan(0);
    const req = provider.requests[0];
    expect(req?.responseSchema).toEqual({ name: "judge_verdict", schema: JUDGE_SCHEMA });
    expect(req?.tools).toEqual([]);
    expect(req?.maxTokens).toBe(2048);
  });

  it("attaches usage to parse errors", async () => {
    const provider = new MockProvider([{ text: "looks fine to me" }]);
    const judge = createJudge(provider, { model: "m", maxTokens: 100 });
    const err = await judge.grade("rubric", { messages, output: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JudgeParseError);
    expect((err as JudgeParseError).usage?.inputTokens).toBeGreaterThan(0);
  });
});

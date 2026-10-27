import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findSuiteFiles, loadSuiteFile } from "../src/config/load.js";
import { suite } from "./helpers.js";

describe("parseSuite", () => {
  it("applies defaults and normalizes a minimal suite", () => {
    const s = suite({ cases: [{ name: "hello", input: "Say hi" }] });
    expect(s.name).toBe("test");
    expect(s.provider).toMatchObject({ type: "anthropic", model: "claude-sonnet-5-5", maxTokens: 16000 });
    expect(s.judge.model).toBe("claude-sonnet-5-5");
    expect(s.cases[0]).toMatchObject({
      name: "hello",
      messages: [{ role: "user", content: "Say hi" }],
      maxTurns: 10,
      repeat: 1,
      passThreshold: 1,
      assertions: [],
    });
  });

  it("inherits suite system prompt, tools and defaults, with case-level overrides", () => {
    const s = suite({
      system: "suite system",
      defaults: { max_turns: 4, repeat: 3, pass_threshold: 0.5 },
      tools: [
        { name: "a", response: "from suite" },
        { name: "b", response: "b" },
      ],
      cases: [
        { name: "inherits", input: "x" },
        { name: "overrides", input: "x", system: "own", repeat: 1, tools: [{ name: "a", response: "from case" }] },
      ],
    });
    const [inherits, overrides] = s.cases;
    expect(inherits).toMatchObject({ system: "suite system", maxTurns: 4, repeat: 3, passThreshold: 0.5 });
    expect(inherits?.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(overrides?.system).toBe("own");
    expect(overrides?.repeat).toBe(1);
    expect(overrides?.tools.find((t) => t.name === "a")?.rules).toEqual([{ response: "from case" }]);
  });

  it("converts prior assistant turns in `messages`", () => {
    const s = suite({
      cases: [
        {
          name: "multi",
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "refund please" },
          ],
        },
      ],
    });
    expect(s.cases[0]?.messages[1]).toEqual({ role: "assistant", text: "hello", toolCalls: [] });
  });

  it("lets the judge override the model and switch provider type without inheriting the agent's settings", () => {
    const s = suite({
      provider: { type: "openai", model: "gpt-x", base_url: "http://localhost:8000/v1" },
      judge: { type: "anthropic" },
      cases: [{ name: "c", input: "x" }],
    });
    expect(s.judge).toMatchObject({ type: "anthropic", model: "claude-sonnet-5-5", baseUrl: undefined });

    const same = suite({ provider: { type: "anthropic", effort: "low" }, judge: { model: "claude-opus-5-5" }, cases: [{ name: "c", input: "x" }] });
    expect(same.judge).toMatchObject({ type: "anthropic", model: "claude-opus-5-5", effort: "low" });
  });

  it("resolves module provider paths relative to the suite file", () => {
    const s = suite({ provider: { type: "module", module: "./agent.mjs" }, cases: [{ name: "c", input: "x" }] }, "/proj/evals/a.eval.yaml");
    expect(s.provider.module).toBe(path.resolve("/proj/evals/agent.mjs"));
    expect(s.provider.model).toBe("mock");
  });

  it("normalizes custom pricing", () => {
    const s = suite({ pricing: { "my-model": { input: 1, output: 2, cache_read: 0.5 } }, cases: [{ name: "c", input: "x" }] });
    expect(s.pricing["my-model"]).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: undefined });
  });

  it.each([
    [{ cases: [] }, "cases"],
    [{ cases: [{ name: "c" }] }, "exactly one of `input` or `messages`"],
    [{ cases: [{ name: "c", input: "x", messages: [{ role: "user", content: "y" }] }] }, "exactly one of"],
    [{ cases: [{ name: "c", messages: [{ role: "assistant", content: "y" }] }] }, "must end with a user message"],
    [{ cases: [{ name: "c", input: "x" }, { name: "c", input: "y" }] }, 'duplicate case name "c"'],
    [{ cases: [{ name: "c", input: "x", assert: [{ type: "nope" }] }] }, "type"],
    [{ cases: [{ name: "c", input: "x", assert: [{ type: "llm_judge", rubric: "r", threshold: 9 }] }] }, "threshold"],
    [{ cases: [{ name: "c", input: "x", tools: [{ name: "t", response: 1, responses: [] }] }] }, "not both"],
    [{ cases: [{ name: "c", input: "x", tools: [{ name: "t", responses: [{ when: {} }] }] }] }, "`response` or `error`"],
    [{ cases: [{ name: "c", input: "x", unknown_key: true }] }, "unknown_key"],
    [{ provider: { type: "module" }, cases: [{ name: "c", input: "x" }] }, "requires a `module` path"],
    [{ provider: { type: "openai" }, cases: [{ name: "c", input: "x" }] }, "requires a `model`"],
  ])("rejects invalid suite %#", (doc, fragment) => {
    expect(() => suite(doc)).toThrow(ConfigError);
    expect(() => suite(doc)).toThrow(fragment);
  });
});

describe("loading from disk", () => {
  it("finds suite files by glob and reports YAML errors with the file name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentcheck-"));
    await writeFile(path.join(dir, "good.eval.yaml"), "name: good\ncases:\n  - name: c\n    input: hi\n");
    await writeFile(path.join(dir, "bad.eval.yml"), "cases: [\n");
    await writeFile(path.join(dir, "ignored.yaml"), "x: 1\n");

    const files = await findSuiteFiles([], dir);
    expect(files.map((f) => path.basename(f))).toEqual(["bad.eval.yml", "good.eval.yaml"]);

    const good = await loadSuiteFile(path.join(dir, "good.eval.yaml"));
    expect(good.name).toBe("good");
    await expect(loadSuiteFile(path.join(dir, "bad.eval.yml"))).rejects.toThrow(/bad\.eval\.yml: invalid YAML/);
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, runCommand } from "../src/cli/main.js";
import type { RunReport } from "../src/results.js";

// Echoes the user's message back, so suites can control pass/fail from YAML.
const ECHO_PROVIDER = `export default {
  name: "echo",
  async complete(req) {
    const last = req.messages.at(-1);
    return { text: last.role === "user" ? last.content : "", toolCalls: [], stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  },
};`;

const suiteYaml = (expect: string) => `name: echo
provider: { type: module, module: ./echo.mjs }
cases:
  - name: says hello
    input: hello world
    assert: [{ type: contains, value: "${expect}" }]
`;

const flags = {
  concurrency: 2,
  reporter: "pretty" as const,
  scoreTolerance: 0.5,
  retries: 0,
  verbose: false,
  color: false,
};

describe("agentcheck run", () => {
  let dir: string;
  let stdout: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "agentcheck-cli-"));
    await writeFile(path.join(dir, "echo.mjs"), ECHO_PROVIDER);
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("exits 0 when every case passes and writes the requested reports", async () => {
    const file = path.join(dir, "echo.eval.yaml");
    await writeFile(file, suiteYaml("hello"));
    const out = (name: string) => path.join(dir, "out", name);
    const code = await runCommand([file], { ...flags, json: out("r.json"), markdown: out("r.md"), junit: out("r.xml") });

    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain("✓ says hello");
    const report = JSON.parse(await readFile(out("r.json"), "utf8")) as RunReport;
    expect(report.summary.passed).toBe(1);
    expect(await readFile(out("r.md"), "utf8")).toContain("## agentcheck: passed (1/1 cases)");
    expect(await readFile(out("r.xml"), "utf8")).toContain('<testcase classname="echo" name="says hello"');
  });

  it("exits 1 when a case fails", async () => {
    const file = path.join(dir, "echo.eval.yaml");
    await writeFile(file, suiteYaml("goodbye"));
    expect(await runCommand([file], flags)).toBe(EXIT.failed);
    expect(stdout).toContain('output is missing "goodbye"');
  });

  it("exits 1 on regressions against a baseline", async () => {
    const file = path.join(dir, "echo.eval.yaml");
    const baseline = path.join(dir, "baseline.json");
    await writeFile(file, suiteYaml("hello"));
    expect(await runCommand([file], { ...flags, json: baseline })).toBe(EXIT.ok);

    await writeFile(file, suiteYaml("goodbye"));
    stdout = "";
    expect(await runCommand([file], { ...flags, reporter: "markdown", baseline })).toBe(EXIT.failed);
    expect(stdout).toContain("### Regressions vs baseline (1)");
    expect(stdout).toContain("| echo › says hello | passed → failed (pass rate 100% → 0%) |");
  });

  it("prints machine-readable reports to stdout", async () => {
    const file = path.join(dir, "echo.eval.yaml");
    await writeFile(file, suiteYaml("hello"));
    await runCommand([file], { ...flags, reporter: "json" });
    expect((JSON.parse(stdout) as RunReport).tool).toBe("agentcheck");
  });

  it("exits 2 when nothing matches", async () => {
    expect(await runCommand([path.join(dir, "missing-*.eval.yaml")], flags)).toBe(EXIT.usage);
    const file = path.join(dir, "echo.eval.yaml");
    await writeFile(file, suiteYaml("hello"));
    expect(await runCommand([file], { ...flags, filter: "no such case" })).toBe(EXIT.usage);
  });
});

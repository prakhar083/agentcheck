import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareToBaseline, loadBaseline } from "../src/baseline.js";
import { report } from "./helpers.js";

describe("compareToBaseline", () => {
  const before = report([
    { name: "refund", status: "pass", passRate: 1 },
    { name: "tone", status: "pass", judgeScore: 4.5 },
    { name: "escalation", status: "fail", passRate: 0 },
    { name: "deleted", status: "pass" },
    { name: "stable", status: "pass", judgeScore: 4 },
  ]);
  const after = report([
    { name: "refund", status: "fail", passRate: 0.5 },
    { name: "tone", status: "pass", judgeScore: 3.5 },
    { name: "escalation", status: "pass", passRate: 1 },
    { name: "stable", status: "pass", judgeScore: 4.25 },
    { name: "brand new", status: "pass" },
  ]);
  const diff = compareToBaseline(after, before, "baseline.json");

  it("flags pass → fail and judge score drops as regressions", () => {
    expect(diff.regressions.map((r) => [r.key, r.kind])).toEqual([
      ["support › refund", "pass_to_fail"],
      ["support › tone", "score_drop"],
    ]);
    expect(diff.regressions[0]?.message).toBe("passed → failed (pass rate 100% → 50%)");
    expect(diff.regressions[1]?.message).toBe("judge score 4.50 → 3.50");
  });

  it("reports improvements, added and removed cases", () => {
    expect(diff.improvements.map((r) => r.kind)).toEqual(["fail_to_pass"]);
    expect(diff.added).toEqual(["support › brand new"]);
    expect(diff.removed).toEqual(["support › deleted"]);
  });

  it("ignores score changes within tolerance", () => {
    expect(diff.regressions.some((r) => r.key.endsWith("stable"))).toBe(false);
    const strict = compareToBaseline(after, before, "b.json", { scoreTolerance: 0.1 });
    expect(strict.improvements.some((r) => r.key.endsWith("stable") && r.kind === "score_gain")).toBe(true);
  });

  it("returns an empty diff for identical runs", () => {
    const same = compareToBaseline(before, before, "b.json");
    expect(same).toEqual({ file: "b.json", regressions: [], improvements: [], added: [], removed: [] });
  });
});

describe("loadBaseline", () => {
  it("reads a JSON report and rejects foreign or incompatible files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agentcheck-baseline-"));
    const good = path.join(dir, "good.json");
    await writeFile(good, JSON.stringify(report([{ name: "a" }])));
    expect((await loadBaseline(good)).suites[0]?.cases[0]?.name).toBe("a");

    const foreign = path.join(dir, "foreign.json");
    await writeFile(foreign, JSON.stringify({ hello: "world" }));
    await expect(loadBaseline(foreign)).rejects.toThrow("is not an agentcheck JSON report");

    const future = path.join(dir, "future.json");
    await writeFile(future, JSON.stringify({ ...report([{ name: "a" }]), schemaVersion: 99 }));
    await expect(loadBaseline(future)).rejects.toThrow("schema v99");

    await expect(loadBaseline(path.join(dir, "missing.json"))).rejects.toThrow("cannot read baseline");
  });
});

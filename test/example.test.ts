import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSuiteFile } from "../src/config/load.js";
import { runSuites } from "../src/runner/run.js";

// Keeps examples/ honest: the shipped suite must load and pass against its mock agent.
describe("examples/support-agent", () => {
  it("passes, with exactly one flaky case", async () => {
    const suite = await loadSuiteFile(path.resolve("examples/support-agent/support.eval.yaml"));
    const report = await runSuites([suite], { concurrency: 8 });
    expect(report.summary).toMatchObject({ cases: 7, failed: 0, flaky: 1 });
    expect(report.summary.costUsd).toBeGreaterThan(0);
    const refund = report.suites[0]?.cases.find((c) => c.name === "refunds a damaged item inside the window");
    expect(refund?.judgeScore).toBe(5);
  });
});

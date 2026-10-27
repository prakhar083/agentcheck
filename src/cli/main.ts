import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { compareToBaseline, loadBaseline } from "../baseline.js";
import { ConfigError, findSuiteFiles, loadSuiteFile } from "../config/load.js";
import type { SuiteConfig } from "../config/types.js";
import { DEFAULT_RETRY } from "../providers/retry.js";
import { renderJson, renderJUnit, renderMarkdown, renderTerminal } from "../reporters/index.js";
import type { RunReport } from "../results.js";
import { runSuites } from "../runner/run.js";

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

interface RunFlags {
  concurrency: number;
  repeat?: number;
  filter?: string;
  reporter: "pretty" | "json" | "markdown" | "junit";
  json?: string;
  markdown?: string;
  junit?: string;
  baseline?: string;
  scoreTolerance: number;
  retries: number;
  verbose: boolean;
  color: boolean;
}

const positiveInt = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
};
const nonNegativeInt = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
};
const nonNegativeNumber = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("must be a non-negative number");
  return n;
};

export async function runCommand(patterns: string[], flags: RunFlags): Promise<number> {
  const files = await findSuiteFiles(patterns);
  if (files.length === 0) {
    console.error(`No suite files matched ${patterns.length > 0 ? patterns.join(", ") : "**/*.eval.{yaml,yml}"}`);
    return EXIT.usage;
  }

  const suites: SuiteConfig[] = [];
  for (const file of files) suites.push(await loadSuiteFile(file));
  const baseline = flags.baseline ? await loadBaseline(flags.baseline) : undefined;

  const progress = flags.reporter === "pretty" && process.stderr.isTTY;
  const report: RunReport = await runSuites(suites, {
    concurrency: flags.concurrency,
    repeat: flags.repeat,
    filter: flags.filter,
    retry: {
      ...DEFAULT_RETRY,
      retries: flags.retries,
      onRetry: ({ attempt, delayMs, error }) => {
        if (flags.verbose) console.error(`retry ${attempt}/${flags.retries} in ${delayMs}ms: ${error.message}`);
      },
    },
    onAttemptComplete: progress
      ? ({ done, total }) => process.stderr.write(`\r\x1b[2Krunning ${done}/${total}`)
      : undefined,
  });
  if (progress) process.stderr.write("\r\x1b[2K");

  if (report.summary.cases === 0) {
    console.error(`No cases matched filter "${flags.filter ?? ""}"`);
    return EXIT.usage;
  }
  if (baseline && flags.baseline) {
    report.baseline = compareToBaseline(report, baseline, path.resolve(flags.baseline), {
      scoreTolerance: flags.scoreTolerance,
      reportRemoved: flags.filter === undefined,
    });
  }

  const stdout = {
    pretty: () => renderTerminal(report, { color: flags.color, verbose: flags.verbose }),
    json: () => renderJson(report),
    markdown: () => renderMarkdown(report),
    junit: () => renderJUnit(report),
  }[flags.reporter]();
  process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);

  const outputs: [string | undefined, () => string][] = [
    [flags.json, () => renderJson(report)],
    [flags.markdown, () => renderMarkdown(report)],
    [flags.junit, () => renderJUnit(report)],
  ];
  for (const [file, render] of outputs) {
    if (!file) continue;
    await mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await writeFile(file, render());
  }

  const regressions = report.baseline?.regressions.length ?? 0;
  return report.summary.failed > 0 || regressions > 0 ? EXIT.failed : EXIT.ok;
}

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export async function main(argv = process.argv): Promise<number> {
  const program = new Command()
    .name("agentcheck")
    .description("Test runner and eval harness for LLM agents.")
    .version(await readVersion())
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride();

  let exitCode: number = EXIT.ok;
  program
    .command("run")
    .description("Run eval suites (default: **/*.eval.{yaml,yml})")
    .argument("[patterns...]", "suite files or glob patterns")
    .option("-c, --concurrency <n>", "attempts to run in parallel", positiveInt, 4)
    .option("-r, --repeat <n>", "override every case's repeat count", positiveInt)
    .option("-f, --filter <pattern>", "only run cases whose 'suite › case' name matches (regex or substring)")
    .addOption(
      new Option("--reporter <name>", "what to print to stdout").choices(["pretty", "json", "markdown", "junit"]).default("pretty"),
    )
    .option("--json <file>", "write the JSON report (usable as a baseline)")
    .option("--markdown <file>", "write a Markdown summary")
    .option("--junit <file>", "write JUnit XML")
    .option("-b, --baseline <file>", "compare against a previous JSON report; regressions fail the run")
    .option("--score-tolerance <n>", "judge score drop that counts as a regression", nonNegativeNumber, 0.5)
    .option("--retries <n>", "retries per model call on 429/5xx/network errors", nonNegativeInt, DEFAULT_RETRY.retries)
    .option("-v, --verbose", "show every failing attempt and log retries", false)
    .option("--no-color", "disable ANSI colors")
    .action(async (patterns: string[], flags: RunFlags) => {
      exitCode = await runCommand(patterns, { ...flags, color: flags.color && !process.env.NO_COLOR && process.stdout.isTTY === true });
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // --help and --version surface as CommanderErrors with exit code 0.
    if (err instanceof CommanderError) return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    if (err instanceof ConfigError) {
      console.error(err.message);
      return EXIT.usage;
    }
    console.error(`agentcheck: ${(err as Error).message}`);
    return EXIT.usage;
  }
  return exitCode;
}

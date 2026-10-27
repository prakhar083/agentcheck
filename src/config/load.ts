import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ModelPrice } from "../pricing.js";
import { type RawProvider, type RawTool, suiteSchema } from "./schema.js";
import {
  type CaseConfig,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  type ProviderConfig,
  type SuiteConfig,
  type ToolConfig,
} from "./types.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_SUITE_GLOB = "**/*.eval.{yaml,yml}";

export async function findSuiteFiles(patterns: string[], cwd = process.cwd()): Promise<string[]> {
  const files = await glob(patterns.length > 0 ? patterns : [DEFAULT_SUITE_GLOB], {
    cwd,
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
  });
  return files.sort();
}

export async function loadSuiteFile(file: string): Promise<SuiteConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read file (${(err as Error).message})`, file);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`invalid YAML: ${(err as Error).message}`, file);
  }
  return parseSuite(data, file);
}

/** Validate and normalize an already-parsed suite document. */
export function parseSuite(data: unknown, file: string): SuiteConfig {
  const parsed = suiteSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(`invalid suite\n${z.prettifyError(parsed.error)}`, file);
  }
  const raw = parsed.data;
  const baseDir = path.dirname(path.resolve(file));

  const provider = normalizeProvider(raw.provider, baseDir, file);
  // The judge inherits the agent's provider settings unless it switches provider type.
  const judgeOverrides = stripUndefined(raw.judge ?? {});
  const judgeBase: RawProvider =
    judgeOverrides.type && judgeOverrides.type !== raw.provider.type ? { type: judgeOverrides.type } : raw.provider;
  const judge = normalizeProvider({ ...judgeBase, ...judgeOverrides }, baseDir, file);
  const suiteTools = raw.tools.map(normalizeTool);

  const pricing: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries(raw.pricing)) {
    pricing[model] = { input: p.input, output: p.output, cacheRead: p.cache_read, cacheWrite: p.cache_write };
  }

  const cases: CaseConfig[] = raw.cases.map((c) => ({
    name: c.name,
    description: c.description,
    tags: c.tags,
    system: c.system ?? raw.system,
    messages: (c.messages ?? [{ role: "user" as const, content: c.input ?? "" }]).map((m) =>
      m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, text: m.content, toolCalls: [] },
    ),
    tools: mergeTools(suiteTools, c.tools.map(normalizeTool)),
    assertions: c.assert,
    maxTurns: c.max_turns ?? raw.defaults.max_turns ?? DEFAULT_MAX_TURNS,
    repeat: c.repeat ?? raw.defaults.repeat ?? 1,
    passThreshold: c.pass_threshold ?? raw.defaults.pass_threshold ?? 1,
  }));

  return {
    name: raw.name ?? path.basename(file).replace(/(\.eval)?\.ya?ml$/, ""),
    file,
    description: raw.description,
    provider,
    judge,
    pricing,
    cases,
  };
}

function normalizeProvider(raw: RawProvider, baseDir: string, file: string): ProviderConfig {
  if (raw.type === "module" && !raw.module) {
    throw new ConfigError("provider type `module` requires a `module` path", file);
  }
  if (raw.type === "openai" && !raw.model) {
    throw new ConfigError("provider type `openai` requires a `model`", file);
  }
  return {
    type: raw.type,
    model: raw.model ?? (raw.type === "anthropic" ? DEFAULT_MODEL : "mock"),
    baseUrl: raw.base_url,
    apiKeyEnv: raw.api_key_env,
    module: raw.module ? path.resolve(baseDir, raw.module) : undefined,
    maxTokens: raw.max_tokens ?? DEFAULT_MAX_TOKENS,
    effort: raw.effort,
  };
}

function normalizeTool(raw: RawTool): ToolConfig {
  const rules = raw.responses ?? (raw.response !== undefined ? [{ response: raw.response }] : []);
  return { name: raw.name, description: raw.description, inputSchema: raw.input_schema, rules };
}

/** Case-level tools replace suite-level tools with the same name and append the rest. */
function mergeTools(suite: ToolConfig[], local: ToolConfig[]): ToolConfig[] {
  const byName = new Map(suite.map((t) => [t.name, t]));
  for (const t of local) byName.set(t.name, t);
  return [...byName.values()];
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

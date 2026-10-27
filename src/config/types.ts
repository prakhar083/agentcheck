import type { ModelPrice } from "../pricing.js";
import type { Message } from "../types.js";
import type { RawAssertion } from "./schema.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_TURNS = 10;
export const DEFAULT_MAX_TOKENS = 16_000;

export type Assertion = RawAssertion;
export type AssertionType = Assertion["type"];

export interface ProviderConfig {
  type: "anthropic" | "openai" | "module";
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Absolute path to an ES module whose default export creates a Provider. */
  module?: string;
  maxTokens: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface MockRule {
  /** Subset of tool arguments that must match for this rule to apply. Omitted = always matches. */
  when?: Record<string, unknown>;
  response?: unknown;
  error?: string;
}

export interface ToolConfig {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  rules: MockRule[];
}

export interface CaseConfig {
  name: string;
  description?: string;
  tags: string[];
  system?: string;
  /** Conversation the agent starts from; always ends with a user message. */
  messages: Extract<Message, { role: "user" | "assistant" }>[];
  tools: ToolConfig[];
  assertions: Assertion[];
  maxTurns: number;
  repeat: number;
  /** Fraction of attempts that must pass for the case to pass (1 = all). */
  passThreshold: number;
}

export interface SuiteConfig {
  name: string;
  file: string;
  description?: string;
  provider: ProviderConfig;
  judge: ProviderConfig;
  pricing: Record<string, ModelPrice>;
  cases: CaseConfig[];
}

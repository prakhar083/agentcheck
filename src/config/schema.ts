import { z } from "zod";

/**
 * Schema for suite files as written by users (snake_case YAML). The loader
 * validates against this and normalizes into the camelCase types in ./types.ts.
 */

const jsonObject = z.record(z.string(), z.unknown());

export const providerSchema = z.strictObject({
  type: z.enum(["anthropic", "openai", "module"]).default("anthropic"),
  model: z.string().min(1).optional(),
  base_url: z.url().optional(),
  api_key_env: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  max_tokens: z.int().positive().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

const mockRuleSchema = z
  .strictObject({
    when: jsonObject.optional(),
    response: z.unknown().optional(),
    error: z.string().optional(),
  })
  .refine((r) => r.response !== undefined || r.error !== undefined, {
    message: "a mock rule needs either `response` or `error`",
  });

export const toolSchema = z
  .strictObject({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, "tool names must match [a-zA-Z0-9_-]{1,64}"),
    description: z.string().default(""),
    input_schema: jsonObject.default({ type: "object", properties: {} }),
    response: z.unknown().optional(),
    responses: z.array(mockRuleSchema).optional(),
  })
  .refine((t) => !(t.response !== undefined && t.responses !== undefined), {
    message: "use either `response` or `responses`, not both",
  });

const stringOrList = z.union([z.string(), z.array(z.string()).min(1)]);

export const assertionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("contains"), value: stringOrList, ignore_case: z.boolean().default(false) }),
  z.strictObject({ type: z.literal("not_contains"), value: stringOrList, ignore_case: z.boolean().default(false) }),
  z.strictObject({ type: z.literal("regex"), pattern: z.string(), flags: z.string().optional() }),
  z.strictObject({ type: z.literal("equals"), value: z.string() }),
  z.strictObject({ type: z.literal("json_schema"), schema: jsonObject }),
  z.strictObject({
    type: z.literal("tool_called"),
    name: z.string(),
    args: jsonObject.optional(),
    count: z.int().nonnegative().optional(),
    after: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("tool_not_called"), name: z.string(), args: jsonObject.optional() }),
  z.strictObject({ type: z.literal("tool_sequence"), names: z.array(z.string()).min(1) }),
  z.strictObject({ type: z.literal("max_turns"), value: z.int().positive() }),
  z.strictObject({ type: z.literal("max_cost_usd"), value: z.number().nonnegative() }),
  z.strictObject({ type: z.literal("max_latency_ms"), value: z.number().positive() }),
  z.strictObject({
    type: z.literal("llm_judge"),
    rubric: z.string().min(1),
    threshold: z.int().min(1).max(5).default(4),
  }),
]);

const inputMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const runOptionsShape = {
  max_turns: z.int().positive().optional(),
  repeat: z.int().positive().optional(),
  pass_threshold: z.number().min(0).max(1).optional(),
};

export const caseSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    system: z.string().optional(),
    input: z.string().optional(),
    messages: z.array(inputMessageSchema).min(1).optional(),
    tools: z.array(toolSchema).default([]),
    assert: z.array(assertionSchema).default([]),
    ...runOptionsShape,
  })
  .refine((c) => (c.input === undefined) !== (c.messages === undefined), {
    message: "a case needs exactly one of `input` or `messages`",
  })
  .refine((c) => c.messages === undefined || c.messages.at(-1)?.role === "user", {
    message: "`messages` must end with a user message",
  });

const pricingSchema = z.record(
  z.string(),
  z.strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  }),
);

export const suiteSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    provider: providerSchema.default({ type: "anthropic" }),
    judge: providerSchema.partial().optional(),
    system: z.string().optional(),
    tools: z.array(toolSchema).default([]),
    defaults: z.strictObject(runOptionsShape).default({}),
    pricing: pricingSchema.default({}),
    cases: z.array(caseSchema).min(1),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.cases.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({ code: "custom", path: ["cases", i, "name"], message: `duplicate case name "${c.name}"` });
      }
      seen.add(c.name);
    });
  });

export type RawSuite = z.infer<typeof suiteSchema>;
export type RawProvider = z.infer<typeof providerSchema>;
export type RawTool = z.infer<typeof toolSchema>;
export type RawAssertion = z.infer<typeof assertionSchema>;

import { pathToFileURL } from "node:url";
import type { ProviderConfig } from "../config/types.js";
import type { Provider } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAIProvider } from "./openai.js";

export type ProviderFactory = (config: ProviderConfig) => Provider | Promise<Provider>;

/**
 * Build a provider from config. `module` providers point at an ES module whose
 * default export is either a Provider or a factory returning one; this is how
 * you plug in your own agent stack or an offline mock.
 */
export async function createProvider(config: ProviderConfig): Promise<Provider> {
  switch (config.type) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "openai":
      return createOpenAIProvider(config);
    case "module":
      return loadModuleProvider(config);
  }
}

async function loadModuleProvider(config: ProviderConfig): Promise<Provider> {
  if (!config.module) throw new Error("module provider requires a module path");
  const mod = (await import(pathToFileURL(config.module).href)) as { default?: unknown };
  const exported = mod.default;
  const provider = typeof exported === "function" ? await (exported as ProviderFactory)(config) : exported;
  if (!isProvider(provider)) {
    throw new Error(
      `${config.module}: default export must be a provider ({ name, complete(request) }) or a function returning one`,
    );
  }
  return provider;
}

function isProvider(value: unknown): value is Provider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Provider).complete === "function" &&
    typeof (value as Provider).name === "string"
  );
}

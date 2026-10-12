/** The registered workspace providers, by the name configuration uses. */
import type { Provider } from "../provider.ts";
import { conductorProvider } from "./conductor.ts";

// A Map, so a configured name can only ever find a registered provider, never
// something an object inherits (`constructor`, `toString`).
const PROVIDERS = new Map<string, () => Provider>([
  ["conductor", () => conductorProvider()],
]);

export function providerNames(): string[] {
  return [...PROVIDERS.keys()];
}

export function getProvider(name: string): Provider {
  const make = PROVIDERS.get(name);
  if (make === undefined)
    throw new Error(
      `unknown provider "${name}" (available: ${providerNames().join(", ")})`,
    );
  return make();
}

// Types for the vendored js-yaml ESM build: only the entry points the skills use.
export function load(text: string): unknown;
export function dump(
  value: unknown,
  options?: { sortKeys?: boolean; lineWidth?: number },
): string;

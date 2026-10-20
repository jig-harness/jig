import { readFileSync } from "node:fs";
import { join } from "node:path";

export function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * A file's text, or undefined when it does not exist in that tree: no such
 * file, or a path through a file rather than a directory.
 */
export function readable(tree: string, file: string): string | undefined {
  try {
    return readFileSync(join(tree, file), "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** JSON with every object's keys sorted, so key order does not matter. */
export function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

/** Canonical hashes of the ranker's inputs: equal values hash equal whatever their key order. */
import { createHash } from "node:crypto";

/** JSON with every object's keys sorted, so equal values serialize equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The first 16 hex digits of the SHA-256 of `value`'s canonical JSON. */
export function hashOf(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 16);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

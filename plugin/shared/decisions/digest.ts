/** A stored framing's identity, independent of object insertion order. */
import { createHash } from "node:crypto";
import type { ParkedDecision } from "./park.ts";
import { normalizeAnswerText } from "./answer-normalize.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Compute only when parking; readers compare the stored value across redaction. */
export function decisionDigest(decision: ParkedDecision): string {
  return createHash("sha256")
    .update(canonical(decision))
    .digest("hex")
    .slice(0, 12);
}

export function isDecisionDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
}

/** Strip a digest before option lookup, even when the whole answer is free. */
export function splitAnswerDigest(text: string): {
  text: string;
  digest?: string;
} {
  const normalized = normalizeAnswerText(text);
  // Only a terminal digest frames a structured answer. A digest in an option
  // name, or prose following a digest, must remain part of the answer text.
  const match = /(?:^|\s)\[([0-9a-f]{12})\]$/.exec(normalized);
  return match === null
    ? { text }
    : {
        text: normalized.slice(0, match.index).trimEnd(),
        digest: (match[1] ?? "").toLowerCase(),
      };
}

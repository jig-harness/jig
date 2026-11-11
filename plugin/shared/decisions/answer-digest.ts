/**
 * A decision digest as an answer line carries it: the readers take a
 * trailing `[<digest>]` off before they look up an option. No `node:` import,
 * so the dashboard's page reads an answer as the drive's readers do.
 */
import { normalizeAnswerText } from "./answer-normalize.ts";

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

/**
 * Every digest-shaped token a normalized answer states as its own, the
 * framing suffix included: what a reader counts as an identity claim.
 */
export function digestClaims(normalized: string): string[] {
  return [
    ...normalized.matchAll(/(?:^|\s)\[([0-9a-f]{12})\](?=\s|$|[.,;:!?])/g),
  ].map((match) => (match[1] ?? "").toLowerCase());
}

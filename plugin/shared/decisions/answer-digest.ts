/**
 * A decision digest as an answer line carries it: the readers take a
 * trailing `[<digest>]` off before they look up an option. No `node:` import,
 * so the dashboard's page reads an answer as the drive's readers do.
 */
import { normalizeAnswerText } from "./answer-normalize.ts";
import { DECISION_LIMITS } from "./decision-values.ts";

/** A digest's hexadecimal characters, as a pattern. */
const DIGEST = `[0-9a-f]{${DECISION_LIMITS.digest.value}}`;
const WHOLE_DIGEST = new RegExp(`^${DIGEST}$`);
const TRAILING_DIGEST = new RegExp(`(?:^|\\s)\\[(${DIGEST})\\]$`);
const DIGEST_CLAIM = new RegExp(
  `(?:^|\\s)\\[(${DIGEST})\\](?=\\s|$|[.,;:!?])`,
  "g",
);

export function isDecisionDigest(value: unknown): value is string {
  return typeof value === "string" && WHOLE_DIGEST.test(value);
}

/** Strip a digest before option lookup, even when the whole answer is free. */
export function splitAnswerDigest(text: string): {
  text: string;
  digest?: string;
} {
  const normalized = normalizeAnswerText(text);
  // Only a terminal digest frames a structured answer. A digest in an option
  // name, or prose following a digest, must remain part of the answer text.
  const match = TRAILING_DIGEST.exec(normalized);
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
  return [...normalized.matchAll(DIGEST_CLAIM)].map((match) =>
    (match[1] ?? "").toLowerCase(),
  );
}

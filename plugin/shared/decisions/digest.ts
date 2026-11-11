/** A stored framing's identity, independent of object insertion order. */
import { createHash } from "node:crypto";
import type { ParkedDecision } from "./park.ts";

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

export {
  digestClaims,
  isDecisionDigest,
  splitAnswerDigest,
} from "./answer-digest.ts";

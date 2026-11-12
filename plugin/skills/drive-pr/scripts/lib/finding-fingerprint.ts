/**
 * The key a summary-only finding is answered by, shared by the sticky's
 * bullets (`summary-findings.ts`) and a review object's body
 * (`review-body.ts`), so one marker grammar answers both.
 */
import { createHash } from "node:crypto";

/**
 * Stable key for a finding the reviewer did not fingerprint itself. Content-
 * derived on purpose: keying on the sticky comment id would be *too* stable
 * (the comment is upserted, so slot N stays "answered" after its finding
 * changed), and keying on the reviewed SHA would be too volatile (every push
 * would re-ask a standing wont-fix).
 *
 * Hashes the WHOLE text, never a prefix. The reviewer opens findings with
 * repeated severity/rationale boilerplate, so two distinct findings on one path
 * can share their first N characters; on a truncating hash they collide, `push()`
 * drops the second silently, and one answer marker then clears both — convergence
 * over live work. A prefix bounds nothing worth bounding here: the input is
 * already in memory and the digest is fixed-width either way.
 *
 * The LINE is in the key for the same reason, one axis over. Text alone is not
 * an identity: a finding class the reviewer emits per occurrence — a
 * hand-maintained tally, a missing guard, an unbounded call — reads identically
 * on every line it fires at. Two live occurrences would then collapse into one
 * item that `push()` dedupes, and answering it drives the count to zero while
 * the sibling stays live. `path` and `line` are separated by their own
 * delimiter so `a.ts|4` + `0|text` cannot hash as `a.ts|40` + `text`. A
 * finding in a review object's body names a line range (`31-35`) rather than
 * a line, and the range is its `line` here.
 */
export function fingerprintOf(
  path: string,
  line: number | string | null,
  text: string,
): string {
  return createHash("sha256")
    .update(`${path}|${line ?? ""}|${text}`)
    .digest("hex")
    .slice(0, 16);
}

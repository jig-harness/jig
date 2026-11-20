/**
 * The status evaluation's reads of the pull request itself: the opening
 * snapshot and the terminal recheck (`stillOnHead`), as one conditional REST
 * read of the pull document.
 *
 * One document carries every field the evaluation compares (state, draft,
 * head and base commit, head and base branch, mergeability and the merge
 * state), so a snapshot stays one observation of one (head, base) pair. The
 * recheck reads the same document, so the comparison it makes never spans two
 * sources. An unchanged pull request answers `304`: the kept reading is
 * reused, and GitHub's confirmation that it is current is what makes that
 * reading as fresh as a full one.
 *
 * The answer is mapped to the values the evaluation compares, in the GraphQL
 * spelling it has always used: `OPEN`/`CLOSED`/`MERGED`, `MERGEABLE`/
 * `CONFLICTING`/`UNKNOWN` (REST's `null` is mergeability GitHub has not
 * finished computing, so it reads `UNKNOWN`, never clean), and the merge
 * state upper-cased (`clean` → `CLEAN`). A field the document lacks maps to
 * empty or absent, and the evaluation's own validation turns that into
 * INDETERMINATE.
 *
 * FALLBACK: a conditional read that failed, or a kept reading that does not
 * read as a whole pull document, is followed by one full read (no validator
 * sent). A request the shared budget held is not: the budget said no. Neither
 * is ever taken for an unchanged pull request.
 */

import { type ConditionalGet, ghConditionalGet } from "../gh-conditional.ts";

/** The snapshot's fields, in the spelling `evaluate.ts` compares. */
export interface PrSnapshot {
  /** `OPEN`, `CLOSED`, `MERGED`, or `''` when the document carries no recognised state. */
  state: string;
  /** The document's `draft`, unvalidated: the evaluation refuses anything but a boolean. */
  isDraft: unknown;
  headRefOid: string;
  headRefName: string;
  baseRefOid: string;
  baseRefName: string;
  /** `MERGEABLE`, `CONFLICTING`, `UNKNOWN`, or `''` when absent or not a mergeability. */
  mergeable: string;
  mergeStateStatus: string;
}

export type PrSnapshotRead =
  | { ok: true; snapshot: PrSnapshot }
  | { ok: false; reason: string };

interface PullDocument {
  state?: unknown;
  merged?: unknown;
  draft?: unknown;
  head?: { sha?: unknown; ref?: unknown } | null;
  base?: { sha?: unknown; ref?: unknown } | null;
  mergeable?: unknown;
  mergeable_state?: unknown;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stateOf(doc: PullDocument): string {
  if (doc.state !== "open" && doc.state !== "closed") return "";
  if (doc.merged === true) return "MERGED";
  return doc.state === "open" ? "OPEN" : "CLOSED";
}

function mergeableOf(doc: PullDocument): string {
  if (!("mergeable" in doc)) return "";
  if (doc.mergeable === true) return "MERGEABLE";
  if (doc.mergeable === false) return "CONFLICTING";
  if (doc.mergeable === null) return "UNKNOWN";
  return "";
}

/** The pull document, or null when the body is not a JSON object. */
function parseDocument(body: string): PullDocument | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as PullDocument;
  } catch {
    return null;
  }
}

function snapshotOf(doc: PullDocument): PrSnapshot {
  return {
    state: stateOf(doc),
    isDraft: doc.draft,
    headRefOid: text(doc.head?.sha),
    headRefName: text(doc.head?.ref),
    baseRefOid: text(doc.base?.sha),
    baseRefName: text(doc.base?.ref),
    mergeable: mergeableOf(doc),
    mergeStateStatus: text(doc.mergeable_state).toUpperCase(),
  };
}

/** Whether a kept reading carries every field a verdict is decided from. */
function whole(s: PrSnapshot): boolean {
  return (
    s.state !== "" &&
    typeof s.isDraft === "boolean" &&
    s.headRefOid !== "" &&
    s.baseRefOid !== "" &&
    s.mergeable !== ""
  );
}

function held(r: ConditionalGet): boolean {
  return !r.ok && r.failure?.code === "rate-limited";
}

/**
 * Read pull request `pr` of `owner/repo`. `caller` labels the request in the
 * cost ledger and for the test double (`CallContext.caller`); `get` is the
 * conditional read, replaced by a test that counts its requests.
 */
export async function readPrSnapshot(
  owner: string,
  repo: string,
  pr: string,
  caller: string,
  get: typeof ghConditionalGet = ghConditionalGet,
): Promise<PrSnapshotRead> {
  if (!/^\d+$/.test(pr))
    return { ok: false, reason: `'${pr}' is not a pull request number` };
  const path = `repos/${owner}/${repo}/pulls/${pr}`;
  const first = await get(path, { caller });
  if (first.ok) {
    const doc = parseDocument(first.body);
    // A full answer is the full read: what it lacks, the evaluation refuses.
    if (first.changed)
      return doc === null
        ? { ok: false, reason: `${path}: the answer is not a pull document` }
        : { ok: true, snapshot: snapshotOf(doc) };
    if (doc !== null) {
      const kept = snapshotOf(doc);
      if (whole(kept)) return { ok: true, snapshot: kept };
    }
  } else if (held(first)) {
    return { ok: false, reason: first.reason };
  }
  const full = await get(path, { caller, unconditional: true });
  if (!full.ok) return { ok: false, reason: full.reason };
  const doc = parseDocument(full.body);
  return doc === null
    ? { ok: false, reason: `${path}: the answer is not a pull document` }
    : { ok: true, snapshot: snapshotOf(doc) };
}

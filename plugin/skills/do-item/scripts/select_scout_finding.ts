#!/usr/bin/env bun
/**
 * Select the newest `## Scout Findings` comment on a Linear issue and decide
 * whether to reuse it or re-run scouts — the freshness procedure Step 2 of
 * SKILL.md describes.
 *
 * Type: Decision
 * Input: JSON array of comments on stdin, each `{ body, created_at? |
 *   createdAt? }` — Linear's cache path supplies snake_case, `list_comments`
 *   supplies camelCase; either is accepted.
 * Output: JSON `ScoutFindingsDecision` on stdout.
 *
 * Usage:
 *     cat comments.json | bun select_scout_finding.ts --current-hash abc1234
 *
 * Exit codes: 0 decided, 2 usage, 1 unreadable stdin.
 *
 * Extracted so the freshness branches are unit-tested directly
 * (`selectScoutFinding`) instead of hand-run by whichever agent reads the prose
 * — the same shape as `determine_agent.ts`'s `determineAgents`. As prose-only
 * conditional logic, "Step 2" has no callsite to attach a test to, and a
 * field-name mismatch such as `created_at` against `createdAt` is exactly the
 * bug only a test catches.
 */

import { parseArgs, runEntry } from "./lib/cli.ts";

export interface ScoutFindingsComment {
  body: string;
  created_at?: string;
  createdAt?: string;
}

/** Runtime guard for one parsed-JSON array element — see the `main()` call site. */
export function isScoutFindingsCommentShape(
  value: unknown,
): value is ScoutFindingsComment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.body === "string" &&
    (v.created_at === undefined || typeof v.created_at === "string") &&
    (v.createdAt === undefined || typeof v.createdAt === "string")
  );
}

export type ScoutFindingsAction = "reuse" | "rerun" | "run";

export interface ScoutFindingsDecision {
  action: ScoutFindingsAction;
  /** Index into the input array of the comment the decision was made from, or null when there was none. */
  selectedIndex: number | null;
  /** The git hash extracted from the selected comment's heading, or null if absent/unparsable. */
  selectedHash: string | null;
  reason: string;
}

const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const HEADING_RE = /^##\s*scout findings\s*\(([0-9a-f]{4,40})\)/i;

function isScoutFindingsComment(body: string): boolean {
  return /^##\s*scout findings\b/i.test(body.trim());
}

/**
 * Parse the comment's raw timestamp, trying `created_at` then `createdAt`.
 *
 * Returns `null` only when there is genuinely no usable signal — missing or
 * unparsable — and otherwise the raw epoch, **including a future one**. This
 * is deliberately more permissive than `parseTimestampMs` below: it exists
 * solely to ORDER candidates by apparent post time, and a clock-skewed future
 * timestamp is still a larger (later) number than a real past one, so it must
 * not be discarded before ordering runs. Discarding it here — as an earlier
 * revision did, by sharing this function with freshness validation — let a
 * malformed/future timestamp on the actually-newest comment demote it to
 * "oldest" in the sort, resurrecting an older comment's (fresher-looking)
 * findings instead of failing closed on the newest one.
 */
function parseOrderingMs(c: ScoutFindingsComment): number | null {
  const raw = c.created_at ?? c.createdAt;
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Judge the FRESHNESS of an already-selected comment's timestamp.
 *
 * Returns `null` for missing, unparsable, or future timestamps — the three
 * "stale" causes SKILL.md's freshness rule treats identically. A future
 * timestamp is deliberately folded in here rather than surfaced as a valid-
 * but-negative age, since nothing downstream needs to distinguish "clock
 * skew" from "no signal at all": both fail closed to stale. Ordering must not
 * share this function — see `parseOrderingMs`.
 */
function parseTimestampMs(c: ScoutFindingsComment, now: number): number | null {
  const raw = c.created_at ?? c.createdAt;
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms) || ms > now) return null;
  return ms;
}

/**
 * Git's auto-computed `--short` length grows with repo size (measured in
 * this repo: 10 hex digits today, was fewer at some past commit), so the
 * stored heading's hash and a freshly-computed `currentHash` can legitimately
 * differ in length for the SAME commit — ruling out an exact-string compare.
 * `MIN_SAFE_HASH_LEN` bounds the collision risk that either-direction prefix
 * matching would otherwise accept at any length: 7 hex digits (git's
 * traditional fixed default before "auto" existed) caps an accidental match
 * between two unrelated commits at 16⁻⁷ ≈ 1 in 268 million, while still
 * tolerating the cross-time length drift a full `HEADING_RE` match (4–40
 * digits) would otherwise defeat.
 */
const MIN_SAFE_HASH_LEN = 7;

/** Case-insensitive, either-direction prefix match, gated by `MIN_SAFE_HASH_LEN` — see its comment. */
function hashesMatch(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= MIN_SAFE_HASH_LEN && longer.startsWith(shorter);
}

export function selectScoutFinding(
  comments: readonly ScoutFindingsComment[],
  currentHash: string,
  now: number = Date.now(),
): ScoutFindingsDecision {
  const candidates = comments
    .map((c, index) => ({ c, index, orderMs: parseOrderingMs(c) }))
    .filter((entry) => isScoutFindingsComment(entry.c.body));

  // Newest by raw (ordering) timestamp, future values included — see
  // `parseOrderingMs`. Missing/unparsable timestamps sort as oldest, so they
  // lose to any comment with a usable one. A stable sort preserves input
  // order among ties, including an all-null tie, so the result is
  // deterministic rather than input-order-dependent by accident. Freshness
  // is judged separately, below, once selection is settled — never as part
  // of this comparison.
  const [selected] = [...candidates].sort(
    (a, b) => (b.orderMs ?? -Infinity) - (a.orderMs ?? -Infinity),
  );

  if (selected === undefined) {
    return {
      action: "run",
      selectedIndex: null,
      selectedHash: null,
      reason: "No findings comment",
    };
  }

  const heading = selected.c.body.trim().split("\n", 1)[0] ?? "";
  const hashMatch = HEADING_RE.exec(heading);
  const selectedHash = hashMatch?.[1] ?? null;

  const freshnessMs = parseTimestampMs(selected.c, now);
  const hashSame =
    selectedHash !== null && hashesMatch(selectedHash, currentHash);
  const fresh = freshnessMs !== null && now - freshnessMs < FRESH_WINDOW_MS;

  // A candidate other than `selected` with no orderable timestamp could
  // legitimately be the newest comment — `parseOrderingMs` has no way to
  // rank it, so it lost the sort by construction, not by evidence. Reusing
  // `selected` purely on ITS OWN freshness in that situation risks
  // resurrecting an older comment's stale findings over a genuinely newer,
  // malformed-timestamp one.
  // `hashSame` is exempt: a hash match against the current commit is
  // evidence about content, not timing, and stands regardless of what any
  // other candidate's timestamp says.
  const hasUnorderableRival = candidates.some(
    (c) => c.orderMs === null && c.index !== selected.index,
  );

  if (hashSame || (fresh && !hasUnorderableRival)) {
    const why = hashSame
      ? `hash ${selectedHash} matches current ${currentHash}`
      : "timestamp is fresh (< 24h)";
    return {
      action: "reuse",
      selectedIndex: selected.index,
      selectedHash,
      reason: `Reuse: ${why}`,
    };
  }
  if (fresh && hasUnorderableRival) {
    return {
      action: "rerun",
      selectedIndex: selected.index,
      selectedHash,
      reason:
        "Re-run: selected comment looks fresh, but another comment has no " +
        "parsable timestamp and could actually be the newest",
    };
  }
  const why =
    freshnessMs === null
      ? selectedHash === null
        ? "no parsable timestamp and no readable hash heading"
        : "no parsable timestamp"
      : "timestamp is stale (>= 24h)";
  return {
    action: "rerun",
    selectedIndex: selected.index,
    selectedHash,
    reason: `Re-run: different hash (or none readable) and ${why}`,
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: [],
    values: ["current-hash"],
    // This script takes NO positional — every input is `--current-hash` plus
    // stdin. `noPositional` rejects any positional, including exactly one —
    // unlike faking this with `defaultPositional: ''`, which only rejects
    // TWO or more.
    noPositional: true,
    usage:
      "Usage: select_scout_finding.ts --current-hash <hash>  (comments JSON array on stdin)",
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const currentHash = parsed.args.values.get("current-hash");
  if (currentHash === undefined) {
    console.error(
      "--current-hash is required\nUsage: select_scout_finding.ts --current-hash <hash>",
    );
    return 2;
  }

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    console.error(
      `failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  let comments: unknown;
  try {
    comments = JSON.parse(raw);
  } catch (err) {
    console.error(
      `stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (!Array.isArray(comments)) {
    console.error("stdin must be a JSON array of comments");
    return 1;
  }
  const badIndex = comments.findIndex((c) => !isScoutFindingsCommentShape(c));
  if (badIndex !== -1) {
    console.error(
      `stdin[${badIndex}] is not a valid comment: expected an object with a ` +
        'string "body" and, if present, a string "created_at"/"createdAt"',
    );
    return 1;
  }

  const decision = selectScoutFinding(
    comments as ScoutFindingsComment[],
    currentHash,
  );
  console.log(JSON.stringify(decision));
  return 0;
}

if (import.meta.main) runEntry(main);

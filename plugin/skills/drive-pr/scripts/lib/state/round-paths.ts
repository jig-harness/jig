/**
 * Per-round finding anchors: the durable evidence `structuralEscalationDue`
 * and the structural-churn brake (`churn.ts`) are derived from, how one
 * round's anchors are normalized and folded into the stored window, and the
 * validator the stored state is held to. Re-exported by `schema.ts`, which
 * every reader imports these from.
 */
import { isRoundFacts, type RoundFacts, roundFactsFor } from "./churn-facts.ts";

/**
 * Which files this PR's reviewer findings anchored to, in one round — the
 * durable evidence `structuralEscalationDue` is derived from.
 *
 * A ROUND-KEYED RECORD rather than a running set, because the question the
 * signal asks is about CONSECUTIVENESS ("the same file two rounds running"),
 * which a flattened set cannot answer: a file found in rounds 1 and 7 with
 * five clean rounds between them is a different fact from a file found in
 * rounds 6 and 7, and only the second is evidence that the last round's own
 * fix drew the next finding.
 *
 * `paths` is a SET, stored sorted and de-duplicated — three findings on one
 * file in one round is one file, not three, and the comparison the predicate
 * makes is set intersection.
 */
export interface RoundPaths {
  round: number;
  paths: string[];
  /**
   * Whether the round's live findings included one of severity `high` or
   * `blocker` (`churn.ts`). Absent on a round recorded without the fact,
   * which the structural-churn brake never counts toward a same-file streak.
   */
  severe?: boolean;
  /**
   * For each recorded path that could be read, the git blob id of that file
   * at the head the round was evaluated on: what tells a file rewritten
   * between rounds from one left alone, and a return to an earlier content.
   */
  blobs?: Record<string, string>;
}

/**
 * How many rounds of finding anchors to keep, once every entry outside the
 * window is safely ACKNOWLEDGED (`foldRoundPaths` below). The predicate reads
 * exactly two adjacent entries, so anything ≥2 is behaviourally sufficient;
 * the surplus is for a human reading `drive-state.ts round-paths` (or the
 * stored state), who wants the shape of the whole drive rather than only its
 * last two rounds. This is a floor, not a hard cap — see `foldRoundPaths`.
 */
export const ROUND_PATHS_WINDOW = 12;

/** Cap on distinct anchor paths recorded per round. */
export const ROUND_PATHS_MAX_PER_ROUND = 200;

/** Cap on a single recorded path's length. */
export const ROUND_PATH_MAX_LENGTH = 512;

/**
 * Normalize one round's raw anchor paths into the stored form: trimmed,
 * newline-free, non-empty, length-capped, de-duplicated, sorted, count-capped.
 *
 * The newline ban is the same one `parked`/`held` keys carry, though for a
 * weaker reason than theirs: those keys travel on line-delimited channels
 * (`parked-keys`, `held-keys`), where a newline is read back as two tokens and
 * the phantom second one suppresses live work nobody parked. Nothing reads
 * `paths` line-delimited today — `round-paths` emits JSON, and the handoff
 * does not render them at all. It is banned anyway because the ONE consumer
 * that would want a line-delimited channel is the `--stdin` writer that
 * already exists, and a value it could not round-trip has no business being
 * stored by the flag-based one either.
 *
 * Shared by the writer (`record-paths`) and the validator, so a stored value
 * can never be one the writer would not have produced.
 */
export function normalizeRoundPaths(raw: readonly string[]): string[] {
  return normalizeRoundPathsUncapped(raw).slice(0, ROUND_PATHS_MAX_PER_ROUND);
}

/**
 * The same trim/empty/newline/length filtering and de-duplication as
 * `normalizeRoundPaths`, but WITHOUT the `ROUND_PATHS_MAX_PER_ROUND` cap —
 * so a caller that needs to know whether the cap actually dropped anything
 * can compare this length against the capped one, rather than re-deriving
 * the same filtering by hand and risking it drift from the writer's real
 * rule. `record-paths` uses this to warn when a round's real anchor count
 * exceeds what gets stored: sorting then slicing is silent by construction,
 * so without this comparison a truncated round drops real evidence with
 * nothing in state or the report recording that it happened.
 */
export function normalizeRoundPathsUncapped(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const p of raw) {
    // `.trim()` is used ONLY to test for a whitespace-only/oversized entry —
    // the ORIGINAL, untrimmed `p` is what gets stored. Two legitimate,
    // distinct repository paths can differ only by leading or trailing
    // whitespace (`a.ts` vs ` a.ts`); storing the trimmed form would alias
    // them to the same recurrence key, arming `structuralEscalationDue` on
    // findings from two different files — the same identity bug
    // `evaluate.ts`'s `openThreadPaths` had.
    if (p.trim() === "" || p.length > ROUND_PATH_MAX_LENGTH) continue;
    if (/[\n\r]/.test(p)) continue;
    seen.add(p);
  }
  return [...seen].sort();
}

/** A count as the stored state holds one: a non-negative integer. */
function isCount(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * One entry's stored paths, when they are exactly what the writer would
 * have stored: the validator restates the WRITER's invariant rather than a
 * weaker one it could drift from — the same rule `parked` follows. Comparing
 * against `normalizeRoundPaths` output is the strongest available form of
 * that: sorted, de-duplicated, newline-free, capped. A hand-edited file
 * carrying an unsorted or duplicated list is refused, because the
 * predicate's set intersection is only as trustworthy as the sets it reads.
 */
function storedPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string"))
    return null;
  const norm = normalizeRoundPaths(paths as string[]);
  return norm.length === paths.length && norm.every((p, i) => p === paths[i])
    ? norm
    : null;
}

/**
 * One entry's round, when it is a counted round no later than `rounds`, or
 * `null`. Round 0 is not a counted round (`freshState`'s own baseline,
 * before `bump-round`/`bump-attempt` ever runs) and `record-paths` refuses
 * to write one — so an entry naming it can only be a hand-edited or
 * pre-guard file, and admitting it would let round 1's real entry look
 * adjacent to a round that measured nothing.
 */
function entryRound(e: Record<string, unknown>, rounds: number): number | null {
  const round = e.round;
  return isCount(round) && (round as number) >= 1 && (round as number) <= rounds
    ? (round as number)
    : null;
}

/** One stored entry: its round, its paths and its optional facts. */
function usableEntry(rp: unknown, rounds: number): { round: number } | null {
  if (typeof rp !== "object" || rp === null || Array.isArray(rp)) return null;
  const e = rp as Record<string, unknown>;
  const round = entryRound(e, rounds);
  const paths = storedPaths(e.paths);
  if (round === null || paths === null) return null;
  return isRoundFacts(e.severe, e.blobs, paths) ? { round } : null;
}

/**
 * Whether a stored `roundPaths` value is one the writer could have produced
 * for a state at `rounds` with structural escalation acknowledged at
 * `lastEscalatedRound`.
 *
 * Collection-level invariants, restating `foldRoundPaths`'s own writer
 * contract rather than a weaker one the validator could drift from.
 * `foldRoundPaths` never produces a round beyond the state's own `rounds`,
 * and never two entries for one round — it replaces, sorted ascending. A
 * hand-edited file violating either of those changes what
 * `structuralEscalationArmed`'s adjacency check is even looking at:
 * duplicate or descending rounds can make two SNAPSHOTS of one round look
 * like consecutive ones, and a future round beyond `rounds` can pre-arm a
 * recurrence nothing has measured yet.
 *
 * The length itself is NOT capped at `ROUND_PATHS_WINDOW` outright:
 * `foldRoundPaths` only evicts an entry outside the window once it is
 * acknowledged (`round <= lastEscalatedRound`) — an unacknowledged entry
 * beyond the window is exactly what keeps `structuralEscalationArmed` honest
 * past round `ROUND_PATHS_WINDOW`. So the per-entry check restates THAT
 * invariant instead: an entry outside the window is refused only when it
 * could no longer have a legitimate reason to survive.
 */
export function isUsableRoundPaths(
  value: unknown,
  rounds: number,
  lastEscalatedRound: number,
): boolean {
  if (!Array.isArray(value)) return false;
  const windowCut = value.length - ROUND_PATHS_WINDOW;
  let lastRound = -1;
  for (const [i, rp] of value.entries()) {
    const entry = usableEntry(rp, rounds);
    if (entry === null || entry.round <= lastRound) return false;
    if (i < windowCut && entry.round <= lastEscalatedRound) return false;
    lastRound = entry.round;
  }
  return true;
}

/**
 * An INPUT contract, the same shape and for the same reason as
 * `ReflectCounters`: a caller legitimately holds a partial set (drive-status
 * reads it back out of `drive-state.ts get`'s stdout), and tolerating absence
 * at a FUNCTION boundary is not the accepts-both-stored-shapes tolerance
 * `DriveState` documents rejecting. Nothing here decides whether a stored STATE
 * is usable.
 */
export interface EscalationState {
  roundPaths?: RoundPaths[];
  lastEscalatedRound?: number;
  lastEscalatedInvariant?: string;
}

/**
 * Is a structural escalation owed — has a reviewer finding landed on the same
 * file in two CONSECUTIVE rounds since the last acknowledgment?
 *
 * Deliberately SHARPER than `reflectDue`'s round-depth trigger, and the
 * sharpness is the point. `reflectDue` fires on depth — "this drive has run
 * long" — which was measured arriving at round 4 when the signal had been
 * unambiguous since round 2. This one fires on RECURRENCE, so it arms while
 * there is one narrow fix to reconsider rather than three. The two do not
 * substitute for each other and neither is derived from the other.
 *
 * What it does NOT try to be: a claim that the recurrence is self-inflicted.
 * That question is answered per-finding, against the commits, by
 * `self-inflicted.ts` — a file drawing findings two rounds running is evidence
 * enough to stop and ask, whoever wrote the line.
 *
 * ARMED-UNTIL-DISCHARGED, mirroring `reflectDue`: once a qualifying pair
 * exists it keeps answering true until `set-escalated` (or a `/reflect`, which
 * subsumes it) stamps a round past it. A signal that un-armed itself on the
 * next round would be silent exactly when the pattern is worst — the round
 * after the one that should have stopped to generalize.
 *
 * The acknowledgment comparison is against the pair's LATER round, strictly:
 * an escalation acknowledged at round 3 is not re-armed by the (2,3) pair it
 * was raised on, but IS re-armed by (3,4), because round 4 is new evidence
 * that the acknowledgment did not settle the class.
 */
export function structuralEscalationArmed(s: EscalationState): boolean {
  const entries = [...(s.roundPaths ?? [])].sort((a, b) => a.round - b.round);
  const since = s.lastEscalatedRound ?? 0;
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.round !== prev.round + 1) continue;
    if (cur.round <= since) continue;
    const prevSet = new Set(prev.paths);
    if (cur.paths.some((p) => prevSet.has(p))) return true;
  }
  return false;
}

/**
 * The claim the last `set-escalated --invariant` recorded, echoed back ONLY
 * while {@link structuralEscalationArmed} is true — never while
 * the duty it was recorded against is discharged, which is what would happen
 * if this read `lastEscalatedInvariant` unconditionally: a drive that is
 * currently clean on every file would surface a sentence about a recurrence
 * that is no longer live, reading as active guidance for a round that owes
 * nothing.
 *
 * `null`, not `''`, both when nothing is armed and when it is armed but the
 * acknowledging round stated no invariant — the same "null is not the
 * positive claim of an empty measurement" convention `drive-status.ts`'s own
 * JSON payload documents for `drift`/`draft`. A consumer branching on this
 * field never needs to distinguish the two `null` causes: either way, there
 * is no prior claim for this round to check its own finding against.
 *
 * PR-GLOBAL, not per-file, for the reason `lastEscalatedInvariant`'s own doc
 * gives — a non-null result is "what the last acknowledgment believed it
 * closed," not a guarantee that it was about the specific file the CURRENT
 * arming's finding anchors to.
 */
export function structuralEscalationInvariant(
  s: EscalationState,
): string | null {
  if (!structuralEscalationArmed(s)) return null;
  const text = s.lastEscalatedInvariant ?? "";
  return text === "" ? null : text;
}

/**
 * Keep the newest `ROUND_PATHS_WINDOW` entries — PLUS any entry more recent
 * than `lastEscalatedRound`, whichever is more. `entries` must already be
 * sorted ascending by round, the shape both callers below maintain.
 *
 * That second clause is not an enlargement of the window for its own sake:
 * without it, a drive that runs past `ROUND_PATHS_WINDOW` rounds while an
 * escalation from its early rounds sits unacknowledged has that evidence
 * evicted out from under `structuralEscalationArmed` — the qualifying pair
 * simply falls off the stored history, and the ARMED-UNTIL-DISCHARGED duty
 * that function documents goes silent with no `set-escalated` or `/reflect`
 * ever having discharged it. An entry at
 * or before `lastEscalatedRound` carries no such risk — `set-escalated`
 * already silenced every pair ending at or before it — so ONLY those are
 * still safe to prune once the window is full; the acknowledgment is what
 * makes eviction sound, not the passage of rounds by itself. A drive that
 * never acknowledges therefore grows `roundPaths` without the window bound —
 * accepted, because the same drive is already bounded by the reviewer's own
 * round ceiling (SKILL.md § "When the reviewer will not answer") long before
 * this could matter in practice.
 *
 * Exported separately from `foldRoundPaths` (not just inlined there) because
 * `drive-state.ts`'s `set-reflected`/`set-escalated` need to re-apply this SAME
 * filter the instant they advance `lastEscalatedRound`, not only on the next
 * `record-paths` call. Advancing the acknowledgment without re-pruning left a
 * state `isUsableState` immediately rejected: a drive retaining more than the
 * window's worth of unacknowledged entries writes `lastEscalatedRound:
 * s.rounds`, and on the very next read `isUsableState`'s own invariant — an
 * entry outside the window with `round <= lastEscalatedRound` is refused — now
 * condemns the entries THIS update just newly acknowledged, because nothing
 * pruned them in the same write. Every acknowledging writer must therefore
 * prune in the same update that advances the acknowledgment, not rely on the
 * next fold.
 */
export function pruneRoundPaths(
  entries: readonly RoundPaths[],
  lastEscalatedRound: number,
): RoundPaths[] {
  const windowCut = entries.length - ROUND_PATHS_WINDOW;
  return entries.filter(
    (e, i) => i >= windowCut || e.round > lastEscalatedRound,
  );
}

/**
 * Fold one round's anchor paths into the stored window: replace the entry for
 * that round if it already exists (a second pass on an unmoved head re-reads
 * the same threads and must not create a second entry for one round), append
 * otherwise, then prune via {@link pruneRoundPaths}.
 *
 * `facts` are the round's severity and blob ids (`churn-facts.ts`), kept
 * only for the paths the entry stores.
 *
 * Lives here rather than in the CLI command for the reason
 * `reflectDepthPastLast` does: the writer and the validator have to agree
 * about what a stored entry looks like, and two copies of that would drift.
 */
export function foldRoundPaths(
  existing: readonly RoundPaths[],
  round: number,
  paths: readonly string[],
  lastEscalatedRound = 0,
  facts: RoundFacts = {},
): RoundPaths[] {
  const stored = normalizeRoundPaths(paths);
  const entry: RoundPaths = {
    round,
    paths: stored,
    ...roundFactsFor(stored, facts),
  };
  const kept = existing.filter((e) => e.round !== round);
  const merged = [...kept, entry].sort((a, b) => a.round - b.round);
  return pruneRoundPaths(merged, lastEscalatedRound);
}

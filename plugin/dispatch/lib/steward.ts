/** The owner-local steward's closed records, digest and durable once-only decisions. */
import { createHash } from "node:crypto";
import { isMapping } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { matches } from "../../shared/shapes.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { stateRoot } from "../receipts.ts";
import { stateDb } from "./state.ts";
import type { Action, DrivenPr } from "./types.ts";
import type { FailureRow } from "./failures.ts";
import type { LineLoad } from "./dashboard-contract.ts";
import type { StewardTargetEvidence } from "./steward-evidence.ts";
import type { UnreportedRun } from "./steward-causes.ts";
import { currentIso, currentMs } from "../../shared/time.ts";
import { inTransaction } from "../../shared/records/db.ts";
import {
  STEWARD_LIST_SHAPE,
  STEWARD_REASONED_SHAPE,
  STEWARD_RECORD_SHAPE,
  type StewardRecord,
} from "./steward-record-shapes.ts";
import {
  STEWARD_COMMON_FIELDS,
  STEWARD_RECORD_KINDS,
} from "./steward-record-values.ts";

export type { StewardRecord };

export const STEWARD_DEADLINE_SEC = 900;
export const STEWARD_RESUME =
  "Take the option you recommended and record it as a decision taken unattended";
/** What kind of judgment a member of the judgment backlog waits on. */
export type BacklogKind =
  | "stalled"
  | "followup-failed"
  | "rearm"
  | "resume"
  | "facet"
  | "need"
  | "cause";

/** One item of the judgment backlog: its kind, its target and the facts that make it this occurrence. */
export interface BacklogMember {
  kind: BacklogKind;
  /** `PR #7`, an item key, or for a resume or a cause the ended launch's id. */
  target: string;
  facts: string;
}

/** A need that already arrives framed, and who framed it: context for the steward, never a target for its `need` record. */
export interface FramedNeed {
  target: string;
  cause: string;
  framedBy: "park" | "session" | "dispatcher";
  /** The framed question, when its framing states one. */
  question: string | null;
}

export interface StewardDigest {
  version: 1;
  repo: string;
  /** The judgment backlog the pass was started on; absent from a digest kept before the trigger read it. */
  backlog?: BacklogMember[];
  drives: DrivenPr[];
  /** The needs with no framing: the only targets a `need` record may name. */
  needs: Action[];
  /** The needs that arrive framed, with their framing: never reframed. */
  framed?: FramedNeed[];
  queue: PoolIssue[];
  passes: Array<{
    record: string;
    action: "pickup" | "followup";
    target: string;
    question: string | null;
    said: string | null;
  }>;
  failures: FailureRow[];
  load: LineLoad | null;
  history?: unknown[];
  /** The runs that ended with no report and no explanation, with their transcript excerpts: the only records a `cause` record may name. */
  unreported?: UnreportedRun[];
  /** Facts read for this digest, never authority for applying a record. */
  targets?: StewardTargetEvidence[];
  /** Current targets are always first; only this many additional historical targets are read. */
  targetHistoryLimit?: number;
  /** The earlier order records the tick refused whose targets still read as they did then: proposing one again is not kept. */
  refused?: RefusedOrder[];
}
/** An order record the tick refused, while the facts it was refused on still hold. */
export interface RefusedOrder {
  record: number;
  kind: "order";
  targets: string[];
  refusal: string;
}
/** Why the tick refused a record, and the facts it read when it did. */
export interface StewardRefusal {
  reason: string;
  facts: string;
}
export interface StewardRun {
  id: string;
  hash: string;
  at: number;
}
export interface KeptStewardRecord {
  id: number;
  run: string;
  value: StewardRecord;
  applied: boolean;
  effect: string | null;
  /** Why the tick refused the record, where it kept a reason. */
  refusal: StewardRefusal | null;
}
export type SubmitStewardResult =
  | "submitted"
  | "already-submitted"
  | "missing-run";

/** A steward can act only on evidence included in its own signed-off digest. */
export function recordBelongsToDigest(
  record: StewardRecord,
  digest: StewardDigest,
): boolean {
  switch (record.kind) {
    case "rearm":
      return digest.drives.some(
        (drive) => `PR #${drive.number}` === record.target,
      );
    case "need":
      return digest.needs.some((need) => need.target === record.target);
    case "resume":
      return digest.passes.some((pass) => pass.record === record.record);
    case "facet":
      return digest.queue.some((issue) => issue.identifier === record.target);
    case "order":
      return record.targets.every((target) =>
        digest.queue.some((issue) => issue.identifier === target),
      );
    case "cause":
      return (digest.unreported ?? []).some(
        (run) => run.record === record.record,
      );
  }
}

/** The steward passes the host starts in a rolling hour, across its repositories. */
const STEWARD_HOURLY_BUDGET = 3;

/** Whether the host's passes in the rolling hour before `now` spent its budget. */
export function stewardBudgetSpent(
  runs: readonly { at: number }[],
  now: number,
): boolean {
  return (
    runs.filter((r) => r.at > now - 3_600_000).length >= STEWARD_HOURLY_BUDGET
  );
}

export function memberKey(member: BacklogMember): string {
  return JSON.stringify([member.kind, member.target, member.facts]);
}

/** The trigger's hash: the judgment backlog's members alone, whatever else the line did. */
export function backlogHash(members: readonly BacklogMember[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        members.map(memberKey).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    )
    .digest("hex");
}

/** The fields a record of `kind` may carry, or none for a kind the steward has not. */
function fieldsOf(kind: string): readonly string[] | undefined {
  if (!Object.hasOwn(STEWARD_RECORD_KINDS, kind)) return undefined;
  const own = STEWARD_RECORD_KINDS[kind as keyof typeof STEWARD_RECORD_KINDS];
  return [...Object.keys(STEWARD_COMMON_FIELDS), ...Object.keys(own.fields)];
}

/**
 * The records of a submission, or why it is refused: the first record that
 * does not read refuses the whole submission. Each record is checked for its
 * reason, then for its kind and the names of its fields, then against its
 * kind's shape (`steward-record-shapes.ts`).
 */
export function checkedRecords(
  value: unknown,
): Outcome<StewardRecord[], "invalid"> {
  if (!matches(STEWARD_LIST_SHAPE, value))
    return failed(
      "invalid",
      "the steward submits at most 100 records as a JSON array",
    );
  for (const r of value) {
    if (!matches(STEWARD_REASONED_SHAPE, r))
      return failed("invalid", "each steward record needs a reason");
    const kind = (r as { kind?: unknown }).kind;
    const keys = typeof kind === "string" ? fieldsOf(kind) : undefined;
    if (!keys || Object.keys(r).some((k) => !keys.includes(k)))
      return failed(
        "invalid",
        "the steward record kind or fields are not allowed",
      );
    if (!matches(STEWARD_RECORD_SHAPE, r))
      return failed("invalid", "a steward record has invalid values");
  }
  return ok(value as StewardRecord[]);
}

/** A drive reserved for a person or parked by the registry never becomes a steward retry. */
export function rearmableBySteward(pr: DrivenPr, held: boolean): boolean {
  return (
    !held &&
    ["needs-person", "stopped-unknown"].includes(pr.class) &&
    typeof pr.evidence.exit === "number" &&
    pr.evidence.exit !== 0 &&
    pr.evidence.stopped !== true &&
    pr.evidence.manualStop !== true &&
    pr.evidence.trustedDriveManual !== true &&
    pr.evidence.parked !== true &&
    !pr.waiting?.length
  );
}

export function stewardRuns(
  repo: string | null,
  root = stateRoot(),
): StewardRun[] {
  return stateDb(root)
    .query(
      "SELECT id, hash, at_ms AS at FROM steward_runs WHERE (? IS NULL OR repo = ?) ORDER BY at_ms DESC LIMIT 20",
    )
    .all(repo, repo) as StewardRun[];
}
export function keepStewardRun(
  id: string,
  digest: StewardDigest,
  at: number,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      "INSERT INTO steward_runs (id, repo, hash, at_ms, digest) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      id,
      digest.repo,
      backlogHash(digest.backlog ?? []),
      at,
      JSON.stringify(digest),
    );
}
/** Take back a run whose pass never started, so its backlog members stay unjudged. */
export function forgetStewardRun(id: string, root = stateRoot()): void {
  stateDb(root).query("DELETE FROM steward_runs WHERE id = ?").run(id);
}
/**
 * Erase the output-bearing fields (each target's last-pass tail, each
 * pass's quoted question context, and each unreported run's transcript
 * excerpt and output tail) from digests older than the retention,
 * in step with launch pruning. The rest of the digest stays.
 */
export function eraseStewardOutput(
  nowMs: number,
  days: number,
  root = stateRoot(),
): number {
  const db = stateDb(root);
  const rows = db
    .query(
      "SELECT id, digest FROM steward_runs WHERE erased = 0 AND at_ms <= ? ORDER BY at_ms LIMIT 200",
    )
    .all(nowMs - days * 86_400_000) as Array<{ id: string; digest: string }>;
  let erased = 0;
  for (const row of rows) {
    const next = erasedOutput(row.digest);
    db.query("UPDATE steward_runs SET digest = ?, erased = 1 WHERE id = ?").run(
      next ?? row.digest,
      row.id,
    );
    if (next !== null) erased++;
  }
  return erased;
}

/** Empty each target's last-pass tail; whether any held one. */
function erasedTails(targets: unknown): boolean {
  let changed = false;
  for (const t of Array.isArray(targets) ? targets : []) {
    const out =
      isMapping(t) && isMapping(t.lastPass) ? t.lastPass.output : null;
    if (!isMapping(out) || out.tail === "") continue;
    out.tail = "";
    out.unavailable = "erased after the retention period";
    changed = true;
  }
  return changed;
}

/** Null each pass's `said` and `question`; whether any held one. */
function erasedPassFields(passes: unknown): boolean {
  let changed = false;
  for (const p of Array.isArray(passes) ? passes : [])
    for (const field of ["said", "question"])
      if (isMapping(p) && p[field] !== null && p[field] !== undefined) {
        p[field] = null;
        changed = true;
      }
  return changed;
}

/** Empty each run's transcript excerpt and output tail; whether any held one. */
function erasedExcerpts(unreported: unknown): boolean {
  let changed = false;
  for (const run of Array.isArray(unreported) ? unreported : []) {
    if (!isMapping(run)) continue;
    if (isMapping(run.excerpt) && run.excerpt.unavailable === undefined) {
      run.excerpt = {
        untrusted: true,
        unavailable: "erased after the retention period",
      };
      changed = true;
    }
    if (run.output !== null && run.output !== undefined) {
      run.output = null;
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether every structure that can hold output has the shape the erasers
 * walk, so a malformed one is tombstoned rather than left with its text.
 */
function outputFieldsReadable(digest: unknown): boolean {
  if (!isMapping(digest)) return false;
  const { targets, passes, unreported } = digest;
  if (targets !== undefined && !Array.isArray(targets)) return false;
  if (
    unreported !== undefined &&
    !(Array.isArray(unreported) && unreported.every(isMapping))
  )
    return false;
  if (!Array.isArray(passes) || !passes.every(isMapping)) return false;
  return (targets ?? []).every((t: unknown) => {
    if (!isMapping(t)) return false;
    const last = t.lastPass;
    if (last === undefined || last === null) return true;
    return (
      isMapping(last) &&
      (last.output === undefined ||
        last.output === null ||
        isMapping(last.output))
    );
  });
}

/** What an expired digest that does not parse is replaced with: its text is unclassified, so none of it stays. */
const UNREADABLE_TOMBSTONE = JSON.stringify({
  erased: "unreadable digest removed after the retention period",
});

/**
 * The digest text without its output, the tombstone when it does not parse
 * as a digest, or `null` when it holds no output.
 */
function erasedOutput(text: string): string | null {
  const parsed = attempt("unreadable", "the steward digest does not read", () =>
    JSON.parse(text),
  );
  if (!parsed.ok) return UNREADABLE_TOMBSTONE;
  const digest: unknown = parsed.value;
  if (!isStewardDigest(digest) || !outputFieldsReadable(digest))
    return UNREADABLE_TOMBSTONE;
  const erasedTargets = erasedTails(digest.targets);
  const erasedPasses = erasedPassFields(digest.passes);
  const erasedRuns = erasedExcerpts(digest.unreported);
  const changed = erasedTargets || erasedPasses || erasedRuns;
  return changed ? JSON.stringify(digest) : null;
}
export function readStewardDigest(
  id: string,
  root = stateRoot(),
): Outcome<StewardDigest, "unreadable"> {
  const got = attempt("unreadable", "the steward digest does not read", () => {
    const row = stateDb(root)
      .query("SELECT digest FROM steward_runs WHERE id = ?")
      .get(id) as { digest: string } | null;
    return row === null ? null : JSON.parse(row.digest);
  });
  if (!got.ok) return got;
  return isStewardDigest(got.value)
    ? ok(got.value)
    : failed("unreadable", "the steward run has no valid digest");
}

function isStewardDigest(value: unknown): value is StewardDigest {
  return (
    isMapping(value) &&
    value.version === 1 &&
    typeof value.repo === "string" &&
    [
      value.drives,
      value.needs,
      value.queue,
      value.passes,
      value.failures,
    ].every(Array.isArray) &&
    (value.history === undefined || Array.isArray(value.history)) &&
    (value.refused === undefined || Array.isArray(value.refused)) &&
    (value.unreported === undefined || Array.isArray(value.unreported))
  );
}
export function submitStewardRecords(
  run: string,
  value: unknown,
  root = stateRoot(),
): Outcome<SubmitStewardResult, "invalid" | "unreadable"> {
  const checked = checkedRecords(value);
  if (!checked.ok) return checked;
  return attempt("unreadable", "the steward records could not be kept", () => {
    const db = stateDb(root);
    return inTransaction(db, () => {
      const row = db
        .query("SELECT submitted, digest FROM steward_runs WHERE id = ?")
        .get(run) as { submitted: number; digest: string } | null;
      if (row === null) return "missing-run" as const;
      if (row.submitted) return "already-submitted" as const;
      const refused = refusedIn(row.digest);
      for (const record of checked.value.filter(
        (r) => !refusedAgain(r, refused),
      ))
        db.query(
          "INSERT INTO steward_records (run, repo, value) SELECT id, repo, ? FROM steward_runs WHERE id = ?",
        ).run(JSON.stringify(record), run);
      db.query("UPDATE steward_runs SET submitted = 1 WHERE id = ?").run(run);
      db.query(
        "UPDATE launches SET result = 'done', result_at = ? WHERE id = ? AND result IS NULL",
      ).run(currentIso(), run);
      return "submitted" as const;
    });
  });
}
/** The refused orders a kept digest lists; none when it lists none or does not read. */
function refusedIn(digest: string): RefusedOrder[] {
  const got = attempt("unreadable", "the steward digest does not read", () =>
    JSON.parse(digest),
  );
  return got.ok && isStewardDigest(got.value) ? (got.value.refused ?? []) : [];
}

/** An order naming the same targets, in the same order, as one its digest lists refused on facts that still hold. */
function refusedAgain(
  record: StewardRecord,
  refused: readonly RefusedOrder[],
): boolean {
  if (record.kind !== "order") return false;
  const same = JSON.stringify(record.targets);
  return refused.some((r) => JSON.stringify(r.targets) === same);
}

export function stewardRecords(
  repo: string,
  root = stateRoot(),
): KeptStewardRecord[] {
  return (
    stateDb(root)
      .query(
        "SELECT id, run, value, applied, effect, refusal FROM steward_records WHERE repo = ? ORDER BY id",
      )
      .all(repo) as Array<{
      id: number;
      run: string;
      value: string;
      applied: number;
      effect: string | null;
      refusal: string | null;
    }>
  ).flatMap((r) => {
    const value: unknown = JSON.parse(r.value);
    const checked = checkedRecords([value]);
    const record = checked.ok ? checked.value[0] : undefined;
    return record === undefined
      ? []
      : [
          {
            ...r,
            value: record,
            applied: r.applied === 1,
            refusal: refusalOf(r.refusal),
          },
        ];
  });
}

function refusalOf(text: string | null): StewardRefusal | null {
  if (text === null) return null;
  const got = attempt("unreadable", "the refusal does not read", () =>
    JSON.parse(text),
  );
  return got.ok &&
    isMapping(got.value) &&
    typeof got.value.reason === "string" &&
    typeof got.value.facts === "string"
    ? { reason: got.value.reason, facts: got.value.facts }
    : null;
}
/** A resume refused for a fact its ended pass fixes: the pass is settled. */
export const STEWARD_REFUSED = "refused";
/** A resume refused for a fact that can change (policy, an unvalidated name): the pass stays offered. */
export const STEWARD_REFUSED_OPEN = "refused-open";

/** The passes a resume record already settled, launched or refused for good: the digest offers them no more. */
export function judgedResumes(
  repo: string,
  root = stateRoot(),
): ReadonlySet<string> {
  const digests = new Map<string, ReturnType<typeof readStewardDigest>>();
  return new Set(
    stewardRecords(repo, root).flatMap((r) =>
      r.applied &&
      r.effect !== null &&
      r.effect !== STEWARD_REFUSED_OPEN &&
      r.value.kind === "resume" &&
      !namedOutsideDigest(r, root, digests)
        ? [r.value.record]
        : [],
    ),
  );
}

/** An earlier steward settled a resume naming a pass outside its own digest as refused: that pass stays offered. */
function namedOutsideDigest(
  r: KeptStewardRecord,
  root: string,
  digests: Map<string, ReturnType<typeof readStewardDigest>>,
): boolean {
  if (r.effect !== STEWARD_REFUSED) return false;
  // One run's refusals share one digest: read and parse it once per call.
  let digest = digests.get(r.run);
  if (digest === undefined) {
    digest = readStewardDigest(r.run, root);
    digests.set(r.run, digest);
  }
  return digest.ok && !recordBelongsToDigest(r.value, digest.value);
}

/** The claim precedes any action; an interrupted application is never attempted twice. */
export function claimStewardRecord(id: number, root = stateRoot()): boolean {
  return (
    stateDb(root)
      .query(
        "UPDATE steward_records SET applied = 1 WHERE id = ? AND applied = 0",
      )
      .run(id).changes === 1
  );
}

export function markStewardEffect(
  id: number,
  effect: string,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      "UPDATE steward_records SET effect = ?, effect_at_ms = ? WHERE id = ? AND effect IS NULL",
    )
    .run(effect, currentMs(), id);
}

/** Refuse an unjudged record for good, keeping why and the facts it was refused on. */
export function refuseStewardRecord(
  id: number,
  refusal: StewardRefusal,
  root = stateRoot(),
): void {
  stateDb(root)
    .query(
      "UPDATE steward_records SET applied = 1, effect = ?, effect_at_ms = ?, refusal = ? WHERE id = ? AND effect IS NULL",
    )
    .run(STEWARD_REFUSED, currentMs(), JSON.stringify(refusal), id);
}

export function releaseStewardRecord(id: number, root = stateRoot()): void {
  stateDb(root)
    .query(
      "UPDATE steward_records SET applied = 0 WHERE id = ? AND effect IS NULL",
    )
    .run(id);
}

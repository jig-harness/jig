/** The owner-local steward's closed records, digest and durable once-only decisions. */
import { createHash } from "node:crypto";
import { isMapping } from "../../shared/config-layers.ts";
import { NEED_ACTS, type NeedAct } from "../../shared/acts.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { stateRoot } from "../receipts.ts";
import { stateDb } from "./state.ts";
import type { Action, DrivenPr } from "./types.ts";
import type { FailureRow } from "./failures.ts";
import type { LineLoad } from "./dashboard-contract.ts";
import type { StewardTargetEvidence } from "./steward-evidence.ts";

export const STEWARD_DEADLINE_SEC = 900;
export const STEWARD_RESUME =
  "Take the option you recommended and record it as a decision taken unattended";
export type StewardRecord =
  | {
      kind: "rearm";
      target: string;
      facts: string;
      class: string;
      reason: string;
    }
  | { kind: "resume"; record: string; reason: string }
  | { kind: "need"; target: string; act: NeedAct; ask: string; reason: string }
  | {
      kind: "facet";
      target: string;
      facet: "priority" | "type" | "size";
      value: string | number;
      reason: string;
    }
  | { kind: "order"; targets: string[]; reason: string };
export interface StewardDigest {
  version: 1;
  repo: string;
  drives: DrivenPr[];
  needs: Action[];
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
  /** Facts read for this digest, never authority for applying a record. */
  targets?: StewardTargetEvidence[];
  /** Current targets are always first; only this many additional historical targets are read. */
  targetHistoryLimit?: number;
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
  }
}

/** The cadence or the rolling hourly cap rules a run out whatever the input: checked before the digest is read. */
export function stewardWaits(
  runs: readonly { at: number }[],
  now: number,
  every: number,
): boolean {
  const latest = [...runs].sort((a, b) => b.at - a.at)[0];
  return (
    (latest !== undefined && (now - latest.at < every || latest.at > now)) ||
    runs.filter((r) => r.at > now - 3_600_000).length >= 3
  );
}

/** A changed input, the cadence and a rolling hourly cap must all permit a run. */
export function stewardDue(
  hash: string,
  runs: readonly { hash: string; at: number }[],
  now: number,
  every: number,
): boolean {
  const latest = [...runs].sort((a, b) => b.at - a.at)[0];
  return !stewardWaits(runs, now, every) && latest?.hash !== hash;
}

/** Times in receipts and measured gauges do not turn unchanged work into a new digest. */
export function digestHash(digest: StewardDigest): string {
  const { load: _load, ...stable } = digest;
  const ordered = {
    ...stable,
    drives: [...stable.drives]
      .sort((a, b) => a.number - b.number)
      .map(({ why: _why, ...p }) => p),
    needs: stable.needs
      .map((a) => ({
        stage: a.stage,
        target: a.target,
        cause: a.cause,
        evidence: a.evidence,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    queue: [...stable.queue].sort((a, b) =>
      a.identifier.localeCompare(b.identifier),
    ),
    passes: [...stable.passes].sort((a, b) => a.record.localeCompare(b.record)),
    targets: stable.targets?.toSorted((a, b) =>
      a.target.localeCompare(b.target),
    ),
    failures: [...stable.failures].sort((a, b) => a.key.localeCompare(b.key)),
    history: [...(stable.history ?? [])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  };
  return createHash("sha256")
    .update(
      JSON.stringify(ordered, (key, value) =>
        ["heartbeatAgeMinutes", "stewardAct", "stewardAsk"].includes(key)
          ? undefined
          : value,
      ),
    )
    .digest("hex");
}

function nonempty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && v.length <= 4000;
}
export function checkedRecords(
  value: unknown,
): Outcome<StewardRecord[], "invalid"> {
  if (!Array.isArray(value) || value.length > 100)
    return failed(
      "invalid",
      "the steward submits at most 100 records as a JSON array",
    );
  for (const r of value) {
    if (!isMapping(r) || !nonempty(r.reason))
      return failed("invalid", "each steward record needs a reason");
    const shapes: Record<string, string[]> = {
      rearm: ["kind", "target", "facts", "class", "reason"],
      resume: ["kind", "record", "reason"],
      need: ["kind", "target", "act", "ask", "reason"],
      facet: ["kind", "target", "facet", "value", "reason"],
      order: ["kind", "targets", "reason"],
    };
    const keys = Object.hasOwn(shapes, String(r.kind))
      ? shapes[String(r.kind)]
      : undefined;
    if (!keys || Object.keys(r).some((k) => !keys.includes(k)))
      return failed(
        "invalid",
        "the steward record kind or fields are not allowed",
      );
    const valid = recordValues(r);
    if (!valid) return failed("invalid", "a steward record has invalid values");
  }
  return ok(value as StewardRecord[]);
}

function recordValues(r: Record<string, unknown>): boolean {
  switch (r.kind) {
    case "rearm":
      return rearmValues(r);
    case "resume":
      return nonempty(r.record);
    case "need":
      return needValues(r);
    case "facet":
      return facetValues(r);
    case "order":
      return orderValues(r);
    default:
      return false;
  }
}
function rearmValues(r: Record<string, unknown>): boolean {
  return (
    nonempty(r.target) &&
    /^PR #[1-9]\d*$/.test(r.target) &&
    nonempty(r.facts) &&
    nonempty(r.class)
  );
}
function needValues(r: Record<string, unknown>): boolean {
  return (
    nonempty(r.target) &&
    nonempty(r.ask) &&
    (NEED_ACTS as readonly unknown[]).includes(r.act)
  );
}
function facetValues(r: Record<string, unknown>): boolean {
  if (!nonempty(r.target)) return false;
  if (r.facet === "priority")
    return (
      Number.isInteger(r.value) && Number(r.value) >= 1 && Number(r.value) <= 4
    );
  return (
    ["size", "type"].includes(String(r.facet)) &&
    nonempty(r.value) &&
    r.value.length <= 100
  );
}
function orderValues(r: Record<string, unknown>): boolean {
  return (
    Array.isArray(r.targets) &&
    r.targets.length <= 100 &&
    r.targets.every(nonempty) &&
    new Set(r.targets).size === r.targets.length
  );
}

/** A human stop or a registry park never becomes a steward retry. */
export function rearmableBySteward(pr: DrivenPr, held: boolean): boolean {
  return (
    !held &&
    ["needs-person", "stopped-unknown"].includes(pr.class) &&
    typeof pr.evidence.exit === "number" &&
    pr.evidence.exit !== 0 &&
    pr.evidence.stopped !== true &&
    pr.evidence.manualStop !== true &&
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
    .run(id, digest.repo, digestHash(digest), at, JSON.stringify(digest));
}
/**
 * Erase the output-bearing fields (each target's last-pass tail and each
 * pass's quoted question context) from digests older than the retention,
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
  if (!isStewardDigest(digest)) return UNREADABLE_TOMBSTONE;
  const erasedTargets = erasedTails(digest.targets);
  const erasedPasses = erasedPassFields(digest.passes);
  const changed = erasedTargets || erasedPasses;
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
    (value.history === undefined || Array.isArray(value.history))
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
    return db.transaction(() => {
      const row = db
        .query("SELECT submitted FROM steward_runs WHERE id = ?")
        .get(run) as { submitted: number } | null;
      if (row === null) return "missing-run" as const;
      if (row.submitted) return "already-submitted" as const;
      for (const record of checked.value)
        db.query(
          "INSERT INTO steward_records (run, repo, value) SELECT id, repo, ? FROM steward_runs WHERE id = ?",
        ).run(JSON.stringify(record), run);
      db.query("UPDATE steward_runs SET submitted = 1 WHERE id = ?").run(run);
      db.query(
        "UPDATE launches SET result = 'done', result_at = ? WHERE id = ? AND result IS NULL",
      ).run(new Date().toISOString(), run);
      return "submitted" as const;
    })();
  });
}
export function stewardRecords(
  repo: string,
  root = stateRoot(),
): KeptStewardRecord[] {
  return (
    stateDb(root)
      .query(
        "SELECT id, run, value, applied, effect FROM steward_records WHERE repo = ? ORDER BY id",
      )
      .all(repo) as Array<{
      id: number;
      run: string;
      value: string;
      applied: number;
      effect: string | null;
    }>
  ).flatMap((r) => {
    const value: unknown = JSON.parse(r.value);
    const checked = checkedRecords([value]);
    const record = checked.ok ? checked.value[0] : undefined;
    return record === undefined
      ? []
      : [{ ...r, value: record, applied: r.applied === 1 }];
  });
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
    .run(effect, Date.now(), id);
}

export function releaseStewardRecord(id: number, root = stateRoot()): void {
  stateDb(root)
    .query(
      "UPDATE steward_records SET applied = 0 WHERE id = ? AND effect IS NULL",
    )
    .run(id);
}

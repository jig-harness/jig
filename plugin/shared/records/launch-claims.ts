/**
 * The two kinds of claim the shared records publish on the forge, as kinds of
 * the forge-claims module (`forge-claims.ts`), and what each says as a shared
 * record (`shared.ts`).
 *
 * **The follow-up marker** (`dispatch-followup`) claims a merged pull
 * request's follow-up. A dispatcher posts one naming its launch record and
 * its host before it starts the follow-up's session, and writes the
 * follow-up's answer onto it (`outcome: done|failed`) once the launch record
 * ends; a follow-up a person runs posts one saying so (`run: manual`) and
 * marks it `outcome: done` once its last act succeeded.
 *
 *   <!-- jig-dispatch-followup -->
 *   <!-- jig-dispatch-followup-data
 *   {"kind":"dispatch-followup","v":2,"key":"followup",…,"pr":<PR>,"run":"tick","record":"<id>","host":"<host>"}
 *   -->
 *   jig dispatch follow-up · record: <id>
 *
 * A marker in an earlier form still reads: version 1, whose key was the pull
 * request's number, and the line form written before the envelope, whose
 * second line is `jig dispatch follow-up · record: <id>` or
 * `jig dispatch follow-up · run: manual · outcome: running|done`. A pull
 * request has one follow-up, so a trusted marker whose record does not read
 * still claims it and holds against every later one, until a person settles
 * it.
 *
 * **The launch claim** (`dispatch-launch-claim`) claims one launch of a pull
 * request's drive: a re-arm, a re-drive, an arm or a takeover. Its key is
 * `drive`, its generation the attempt it claims, and its record names the
 * action, the claiming host's launch record, the host, whether that host owns
 * the repository, the ledger facts the launch acts on and, for a re-drive,
 * the change it re-drives. Its host writes the launch's end onto it (`end`).
 *
 *   <!-- jig-dispatch-launch-claim -->
 *   <!-- jig-dispatch-launch-claim-data
 *   {"kind":"dispatch-launch-claim","v":1,"key":"drive","generation":<n>,…,"pr":<PR>,"action":"rearm","record":"<id>","host":"<host>","facts":"…"}
 *   -->
 *   jig dispatch launch · rearm · record: <id> · host: <host>
 *
 * The host a claim names is a digest of the claiming dispatcher's database
 * instance (`dispatch/lib/shared-launches.ts`): a public comment names no
 * machine, and the host that made a claim recognises it as its own.
 */
import { isRecord } from "../guards.ts";
import { decodeMarker } from "./envelope.ts";
import type { ClaimDraft, ClaimKind, ClaimRecord } from "./forge-claims.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import type {
  ClaimSays,
  LaunchDraft,
  LaunchEnd,
  SharedStage,
} from "./shared.ts";
import { parseMs } from "../time.ts";

/** The shape of a dispatcher's launch record id (`dispatch/lib/launches.ts`). */
export const LAUNCH_RECORD_ID = /^\d{8}T\d{6}Z-[a-f\d]{8}$/;

export const FOLLOWUP_MARKER = "<!-- jig-dispatch-followup -->";
/** The follow-up marker's kind in the records registry. */
export const FOLLOWUP_KIND = "dispatch-followup";
/** The version of the follow-up marker's record this version writes. */
export const FOLLOWUP_VERSION = 2;
/** What a follow-up marker claims: the one follow-up of the pull request it is on. */
export const FOLLOWUP_KEY = "followup";
const FOLLOWUP_DATA = "jig-dispatch-followup-data";

export const LAUNCH_MARKER = "<!-- jig-dispatch-launch-claim -->";
/** The launch claim's kind in the records registry. */
const LAUNCH_KIND = "dispatch-launch-claim";
/** What a launch claim claims: a launch of the drive of the pull request it is on. */
export const DRIVE_KEY = "drive";
const LAUNCH_DATA = "jig-dispatch-launch-claim-data";

const isText = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is string =>
  isText(v) && Number.isFinite(parseMs(v));
const isRecordId = (v: unknown): v is string =>
  isText(v) && LAUNCH_RECORD_ID.test(v);
const textOrNull = (v: unknown): string | null =>
  isText(v) && v !== "" ? v : null;
const flagOrNull = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** The answers a launch that ended may carry: none, or a follow-up's. */
const OUTCOMES: ReadonlySet<unknown> = new Set([
  undefined,
  null,
  "done",
  "failed",
]);

/** Why a launch's end as written is not one, or `null` when it is. */
function endFault(end: unknown): string | null {
  if (end === undefined) return null;
  if (!isRecord(end) || !isText(end.at)) return "its end has no time";
  if (end.state === "died")
    return isText(end.reason) &&
      (end.executed === undefined || end.executed === false)
      ? null
      : "its end reason or execution evidence does not read";
  return end.state === "ended"
    ? endedFault(end)
    : "its end is neither ended nor died";
}

/** Why a launch's end as ended is not one, or `null` when it is. */
function endedFault(end: Record<string, unknown>): string | null {
  const exitOk = end.exit === null || Number.isSafeInteger(end.exit);
  return exitOk && OUTCOMES.has(end.outcome)
    ? null
    : "its end's exit or outcome does not read";
}

/** A launch's end as written; `null` when it has none. */
function endOf(end: unknown): LaunchEnd | null {
  if (endFault(end) !== null || end === undefined) return null;
  const e = end as Record<string, unknown>;
  if (e.state === "died")
    return {
      state: "died",
      at: String(e.at),
      reason: String(e.reason),
      ...(e.executed === false ? { executed: false as const } : {}),
    };
  return {
    state: "ended",
    at: String(e.at),
    exit: (e.exit as number | null) ?? null,
    outcome: (e.outcome as "done" | "failed" | null | undefined) ?? null,
  };
}

/** A launch's end as a claim's payload holds it. */
function writtenEnd(end: LaunchEnd): Record<string, unknown> {
  return end.state === "died"
    ? {
        state: "died",
        at: end.at,
        reason: end.reason,
        ...(end.executed === false ? { executed: false } : {}),
      }
    : { state: "ended", at: end.at, exit: end.exit, outcome: end.outcome };
}

/** The end a person reads on the claim's last line. */
function endLine(end: LaunchEnd | null): string {
  if (end === null) return "";
  if (end.state === "died") return ` · died: ${end.reason}`;
  if (end.outcome !== null) return ` · outcome: ${end.outcome}`;
  return ` · ended ${end.exit === null ? "on a signal" : `exit ${end.exit}`}`;
}

// ---------------------------------------------------------------- follow-up

const NOT_A_RUN = "its record is neither a tick's nor a manual run's";
/** A tick's marker carries no answer, or the follow-up's; a manual run's its own outcome. */
const TICK_OUTCOMES: ReadonlySet<unknown> = new Set([
  undefined,
  "done",
  "failed",
]);
const MANUAL_OUTCOMES: ReadonlySet<unknown> = new Set(["running", "done"]);

/** Why a record's run is not a tick's or a manual run's, or `null`. */
function runFault(payload: Record<string, unknown>): string | null {
  const { run, record, outcome } = payload;
  if (run === "manual") return MANUAL_OUTCOMES.has(outcome) ? null : NOT_A_RUN;
  if (run !== "tick" || !isRecordId(record)) return NOT_A_RUN;
  return TICK_OUTCOMES.has(outcome)
    ? null
    : "its tick's outcome is neither done nor failed";
}

/** Why a read record is not a follow-up claim on `target`, or `null` when it is one. */
function followupFault(
  r: ClaimRecord,
  target: { number: number } | null,
): string | null {
  if (!r.legacy && r.key !== FOLLOWUP_KEY)
    return `its record claims ${JSON.stringify(r.key)}, not the follow-up`;
  if (!r.legacy && target !== null && r.payload.pr !== target.number)
    return `its record names pull request #${String(r.payload.pr)}`;
  return runFault(r.payload);
}

function legacyRecord(
  payload: Record<string, unknown>,
  at = "",
): Outcome<ClaimRecord, "unreadable"> {
  return ok({ key: FOLLOWUP_KEY, at, payload, legacy: true });
}

/** A marker of version 1, whose key was its pull request's number. */
function versionOne(
  body: string,
  target: { number: number } | null,
): Outcome<ClaimRecord, "unreadable"> {
  const read = decodeMarker(body, FOLLOWUP_DATA, FOLLOWUP_KIND);
  if (!read.ok)
    return failed(
      "unreadable",
      `its record does not read: ${read.failure.reason}`,
    );
  const { envelope, payload } = read.value;
  if (target !== null && envelope.key !== String(target.number))
    return failed(
      "unreadable",
      `its record names pull request #${envelope.key}`,
    );
  return legacyRecord(payload, envelope.at);
}

/** A marker in a form written before this version's: version 1, or the line form. */
function legacyMarker(
  body: string,
  target: { number: number } | null,
): Outcome<ClaimRecord, "unreadable"> {
  const line = body.split("\n")[1]?.trim() ?? "";
  if (line === `<!-- ${FOLLOWUP_DATA}`) return versionOne(body, target);
  const tick = /^jig dispatch follow-up · record: (\S+)$/.exec(line);
  if (tick !== null) return legacyRecord({ run: "tick", record: tick[1] });
  const manual =
    /^jig dispatch follow-up · run: manual · outcome: (running|done)$/.exec(
      line,
    );
  if (manual !== null)
    return legacyRecord({ run: "manual", outcome: manual[1] });
  return failed(
    "unreadable",
    `its body does not read as a marker: ${JSON.stringify(line.slice(0, 80))}`,
  );
}

/** The follow-up marker as a kind of forge claim. */
export const FOLLOWUP_CLAIM: ClaimKind = {
  name: FOLLOWUP_KIND,
  opens: FOLLOWUP_MARKER,
  data: `<!-- ${FOLLOWUP_DATA}`,
  onlyKey: FOLLOWUP_KEY,
  shape: followupFault,
  legacy: legacyMarker,
};

/** Who posts a marker, on which pull request, and when; a tick's names its host. */
export interface MarkerPost {
  pr: number;
  writer: ClaimDraft["writer"];
  at?: string;
  host?: string;
  owner?: boolean;
}

function markerClaim(
  post: MarkerPost,
  run: Record<string, unknown>,
  line: string,
): ClaimDraft {
  return {
    key: FOLLOWUP_KEY,
    writer: post.writer,
    ...(post.at === undefined ? {} : { at: post.at }),
    payload: { pr: post.pr, ...run },
    text: `jig dispatch follow-up · ${line}`,
  };
}

/** A tick's claim, naming the launch record it starts the follow-up under, its host, and the follow-up's answer once it ended. */
export function tickClaim(
  record: string,
  post: MarkerPost,
  outcome: "done" | "failed" | null = null,
): ClaimDraft {
  return markerClaim(
    post,
    {
      run: "tick",
      record,
      ...(post.host === undefined ? {} : { host: post.host }),
      ...(post.owner === undefined ? {} : { owner: post.owner }),
      ...(outcome === null ? {} : { outcome }),
    },
    `record: ${record}${outcome === null ? "" : ` · outcome: ${outcome}`}`,
  );
}

/** A manual run's claim, carrying its own outcome. */
export function manualClaim(done: boolean, post: MarkerPost): ClaimDraft {
  const outcome = done ? "done" : "running";
  return markerClaim(
    post,
    { run: "manual", outcome },
    `run: manual · outcome: ${outcome}`,
  );
}

/** A follow-up's answer as its marker carries it: a manual run's `done`, or the answer a tick's host wrote. */
function followupEnd(p: Record<string, unknown>): LaunchEnd | null {
  if (p.outcome !== "done" && p.outcome !== "failed") return null;
  const at = isTime(p.endedAt) ? p.endedAt : "";
  return { state: "ended", at, exit: null, outcome: p.outcome };
}

/** What a follow-up marker's record says as a shared record. */
function followupSays(r: ClaimRecord, pr: number): ClaimSays {
  const p = r.payload;
  const manual = p.run === "manual";
  return {
    pr,
    attempt: 1,
    at: r.at,
    run: manual ? "manual" : "tick",
    action: "followup",
    record: manual ? null : String(p.record),
    host: textOrNull(p.host),
    owner: flagOrNull(p.owner),
    facts: null,
    change: null,
    conflictStop: false,
    end: followupEnd(p),
    legacy: r.legacy,
  };
}

// ------------------------------------------------------------------- launch

/** What a launch claim's payload holds, each field with what it says when it does not. */
const LAUNCH_FIELDS: ReadonlyArray<
  readonly [(p: Record<string, unknown>) => boolean, string]
> = [
  [
    (p) => p.action === "rearm" || p.action === "takeover",
    "its action is neither a re-arm nor a takeover",
  ],
  [(p) => isRecordId(p.record), "it names no launch record"],
  [(p) => textOrNull(p.host) !== null, "it names no host"],
  [(p) => isText(p.facts), "it names no ledger facts"],
  [(p) => p.change === undefined || isText(p.change), "its change is not text"],
  [
    (p) =>
      p.earlier === undefined ||
      (Array.isArray(p.earlier) && p.earlier.every(isText)),
    "its earlier changes are not a list of text",
  ],
  [
    (p) => p.owner === undefined || flagOrNull(p.owner) !== null,
    "its owner is neither true nor false",
  ],
];

/** Why a read record is not a launch claim on `target`, or `null` when it is one. */
function launchFault(
  r: ClaimRecord,
  target: { number: number } | null,
): string | null {
  if (r.key !== DRIVE_KEY)
    return `its record claims ${JSON.stringify(r.key)}, not a drive's launch`;
  if ((r.generation ?? 0) < 1) return "its record names no attempt";
  if (target !== null && r.payload.pr !== target.number)
    return `its record names pull request #${String(r.payload.pr)}`;
  const fault = LAUNCH_FIELDS.find(([holds]) => !holds(r.payload));
  return fault === undefined ? endFault(r.payload.end) : fault[1];
}

/** The launch claim as a kind of forge claim. A trusted one that does not read is reported, and holds nothing it could not name. */
export const LAUNCH_CLAIM: ClaimKind = {
  name: LAUNCH_KIND,
  opens: LAUNCH_MARKER,
  data: `<!-- ${LAUNCH_DATA}`,
  shape: launchFault,
};

/** A launch claim's payload, from the draft. */
function launchPayload(draft: LaunchDraft): Record<string, unknown> {
  return {
    pr: draft.pr,
    action: draft.action,
    record: draft.record,
    host: draft.host,
    ...(draft.owner === null ? {} : { owner: draft.owner }),
    facts: draft.facts ?? "",
    ...(draft.change == null ? {} : { change: draft.change }),
    ...(draft.earlier === undefined || draft.earlier.length === 0
      ? {}
      : { earlier: draft.earlier }),
    ...(draft.conflictStop === true ? { conflictStop: true } : {}),
  };
}

/** The claim a drive's launch posts for attempt `attempt`. */
export function launchClaim(
  draft: LaunchDraft,
  attempt: number,
  at?: string,
): ClaimDraft {
  return {
    key: DRIVE_KEY,
    generation: attempt,
    writer: draft.writer,
    ...(at === undefined ? {} : { at }),
    payload: launchPayload(draft),
    text: `jig dispatch launch · ${draft.action} · record: ${String(draft.record)} · host: ${String(draft.host)}`,
  };
}

/** What a launch claim's record says as a shared record. */
function launchSays(r: ClaimRecord, pr: number): ClaimSays {
  const p = r.payload;
  return {
    pr,
    attempt: r.generation ?? 0,
    at: r.at,
    run: "tick",
    action: p.action as "rearm" | "takeover",
    record: String(p.record),
    host: String(p.host),
    owner: flagOrNull(p.owner),
    facts: String(p.facts),
    change: textOrNull(p.change),
    ...(Array.isArray(p.earlier) ? { earlier: p.earlier.filter(isText) } : {}),
    conflictStop: p.conflictStop === true,
    end: endOf(p.end),
    legacy: r.legacy,
  };
}

// ------------------------------------------------------------------- both

/** The claim kind a stage publishes. */
export function kindOf(stage: SharedStage): ClaimKind {
  return stage === "drive" ? LAUNCH_CLAIM : FOLLOWUP_CLAIM;
}

/** What a claim record of `stage` on pull request `pr` says as a shared record. */
export function saysOf(
  stage: SharedStage,
  r: ClaimRecord,
  pr: number,
): ClaimSays {
  return stage === "drive" ? launchSays(r, pr) : followupSays(r, pr);
}

/** A draft as the claim the stage posts. */
export function draftClaim(draft: LaunchDraft, attempt: number): ClaimDraft {
  if (draft.stage === "drive") return launchClaim(draft, attempt);
  const post: MarkerPost = {
    pr: draft.pr,
    writer: draft.writer,
    ...(draft.host === null ? {} : { host: draft.host }),
    ...(draft.owner === null ? {} : { owner: draft.owner }),
  };
  return draft.run === "manual"
    ? manualClaim(false, post)
    : tickClaim(String(draft.record), post);
}

/**
 * The claim `r` on pull request `pr` rewritten with the launch's end, keeping
 * its key, attempt, time and payload, and its writer where it named one
 * (`writer` otherwise). A follow-up marker that names no host (posted before
 * markers named theirs) takes `host`, the host ending it.
 */
export function endedClaim(
  stage: SharedStage,
  r: ClaimRecord,
  pr: number,
  end: LaunchEnd,
  writer: ClaimDraft["writer"],
  host?: string,
): ClaimDraft {
  const keep = {
    key: stage === "drive" ? DRIVE_KEY : FOLLOWUP_KEY,
    ...(stage === "drive" && r.generation !== undefined
      ? { generation: r.generation }
      : {}),
    writer: r.writer ?? writer,
    ...(r.at === "" ? {} : { at: r.at }),
  };
  const p: Record<string, unknown> = { ...r.payload, pr };
  if (stage === "drive")
    return {
      ...keep,
      payload: { ...p, end: writtenEnd(end) },
      text: `jig dispatch launch · ${String(p.action)} · record: ${String(p.record)} · host: ${String(p.host)}${endLine(end)}`,
    };
  if (p.run === "manual")
    return {
      ...keep,
      payload: { pr, run: "manual", outcome: "done" },
      text: "jig dispatch follow-up · run: manual · outcome: done",
    };
  const outcome =
    end.state === "ended" && end.outcome !== null ? end.outcome : "failed";
  return {
    ...keep,
    payload: {
      ...p,
      ...(p.host === undefined && host !== undefined ? { host } : {}),
      outcome,
      endedAt: end.at,
    },
    text: `jig dispatch follow-up · record: ${String(p.record)} · outcome: ${outcome}`,
  };
}

/**
 * The follow-up marker: a claim comment on a merged pull request that claims
 * its follow-up, a claim of the shared forge-claims module
 * (`shared/records/forge-claims.ts`), which posts it, reads it back and
 * decides it. The tick posts one naming its launch record before it starts
 * the follow-up's session; a follow-up a person runs by hand posts one
 * saying so (`run: manual`) and edits it to `outcome: done` once its last act
 * succeeded.
 *
 * From its second line the marker holds its record in the records codec's
 * marker form (`shared/records/envelope.ts`): the envelope (kind
 * `dispatch-followup`, `followup` as the key it claims, the writer and the
 * time) beside the pull request and the run, then one line a person reads.
 *
 *   <!-- jig-dispatch-followup -->
 *   <!-- jig-dispatch-followup-data
 *   {"kind":"dispatch-followup","v":2,"key":"followup",…,"pr":<PR>,"run":"tick","record":"<launch record id>"}
 *   -->
 *   jig dispatch follow-up · record: <launch record id>
 *
 * A manual run's record carries `"run":"manual"` and its `outcome`,
 * `running` or `done`. A marker in an earlier form still reads: version 1,
 * whose key was the pull request's number, and the line form written before
 * the envelope, whose second line is `jig dispatch follow-up · record: <id>`
 * or `jig dispatch follow-up · run: manual · outcome: running|done`.
 *
 * A marker counts only when written by the dispatcher's own login or by an
 * owner, member or collaborator, as the drive trusts a ledger; of two
 * trusted markers the earlier comment (the lower id) wins, by the
 * forge-claims rule. A pull request has one follow-up, so a trusted marker
 * whose record does not read still claims it and holds against every later
 * one, until a person settles it. Every forge call goes through `ghCall`,
 * under its deadline, and either answers or says why it could not.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { decodeMarker } from "../../shared/records/envelope.ts";
import {
  type ClaimDraft,
  type ClaimKind,
  type ClaimRecord,
  type ClaimTarget,
  claimBody,
  type ListedClaim,
  list,
  readClaim,
  type Standing,
} from "../../shared/records/forge-claims.ts";
import type { Writer } from "../../shared/records/writer.ts";
import { forge } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { isRecordId } from "./launches.ts";
import type { FollowupMarker } from "./types.ts";

export const MARKER = "<!-- jig-dispatch-followup -->";

/** The marker's kind in the records registry (`shared/records/registry.ts`). */
export const FOLLOWUP_KIND = "dispatch-followup";

/** The version of the marker's record this version writes. */
export const FOLLOWUP_VERSION = 2;

/** What a marker claims: the one follow-up of the pull request it is on. */
export const FOLLOWUP_KEY = "followup";

/** The hidden marker its record is written in. */
const DATA = "jig-dispatch-followup-data";

/** Who posts a marker, on which pull request, and when. */
export interface MarkerPost {
  pr: number;
  writer: Writer;
  at?: string;
}

/** The pull request `pr` of repository `slug`, as a claim's target. */
export function followupTarget(slug: string, pr: number): ClaimTarget {
  return { repo: slug, number: pr };
}

const isText = (v: unknown): v is string => typeof v === "string";

/** Why a record's run is not a tick's or a manual run's, or `null`. */
function runFault(payload: Record<string, unknown>): string | null {
  const { run, record, outcome } = payload;
  if (run === "tick" && isText(record) && isRecordId(record)) return null;
  if (run === "manual" && (outcome === "running" || outcome === "done"))
    return null;
  return "its record is neither a tick's nor a manual run's";
}

/** Why a read record is not a follow-up claim on `target`, or `null` when it is one. */
function followupFault(
  r: ClaimRecord,
  target: ClaimTarget | null,
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
  target: ClaimTarget | null,
): Outcome<ClaimRecord, "unreadable"> {
  const read = decodeMarker(body, DATA, FOLLOWUP_KIND);
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
  target: ClaimTarget | null,
): Outcome<ClaimRecord, "unreadable"> {
  const line = body.split("\n")[1]?.trim() ?? "";
  if (line === `<!-- ${DATA}`) return versionOne(body, target);
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
  opens: MARKER,
  data: `<!-- ${DATA}`,
  onlyKey: FOLLOWUP_KEY,
  shape: followupFault,
  legacy: legacyMarker,
};

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

/** A tick's claim, naming the launch record it starts the follow-up under. */
export function tickClaim(record: string, post: MarkerPost): ClaimDraft {
  return markerClaim(post, { run: "tick", record }, `record: ${record}`);
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

/** A tick's marker body. */
export function tickMarker(record: string, post: MarkerPost): string {
  return claimBody(FOLLOWUP_CLAIM, tickClaim(record, post));
}

/** A manual run's marker body. */
export function manualMarker(done: boolean, post: MarkerPost): string {
  return claimBody(FOLLOWUP_CLAIM, manualClaim(done, post));
}

/** What a marker's record says about its run, or why it does not read. */
function runOf(
  record: Outcome<ClaimRecord, "unreadable">,
): FollowupMarker["run"] {
  if (!record.ok) return { kind: "unreadable", reason: record.failure.reason };
  const { payload } = record.value;
  return payload.run === "tick"
    ? { kind: "tick", record: String(payload.record) }
    : { kind: "manual", done: payload.outcome === "done" };
}

/** What a marker on pull request `pr` says, or why it does not read. */
export function markerRun(body: string, pr: number): FollowupMarker["run"] {
  return runOf(
    readClaim(FOLLOWUP_CLAIM, body, followupTarget("", pr)) ??
      failed("unreadable", "its body does not open with the marker"),
  );
}

/** A listed claim comment as the dispatcher reads a marker. */
function markerOf(c: ListedClaim): FollowupMarker {
  return {
    id: c.id,
    login: c.login,
    trusted: c.trusted,
    createdAt: c.createdAt,
    run: runOf(c.record),
  };
}

/** Every follow-up marker on the pull request, earliest first, or why they could not be read. */
export async function readMarkers(
  slug: string,
  pr: number,
  self: string | null,
): Promise<FollowupMarker[] | { unreadable: string }> {
  const listing = await list(followupTarget(slug, pr), FOLLOWUP_CLAIM, self);
  return listing.ok
    ? listing.value.map(markerOf)
    : { unreadable: listing.failure.reason };
}

/** Rewrite a marker's body; `""` when it was written, else why not. */
export async function editMarker(
  slug: string,
  id: number,
  body: string,
): Promise<string> {
  const r = await forge(
    [
      "api",
      "-X",
      "PATCH",
      `repos/${slug}/issues/comments/${id}`,
      "--input",
      "-",
    ],
    JSON.stringify({ body }),
  );
  return r.ok ? "" : r.why;
}

/** The trusted markers, earliest first. */
export function trustedMarkers(
  markers: readonly FollowupMarker[],
): FollowupMarker[] {
  return markers.filter((m) => m.trusted);
}

/** The run a posted marker must still read as: the tick's own record, or a manual run. */
export type ExpectedRun = { kind: "tick"; record: string } | { kind: "manual" };

/** Whether a marker's body still says what its poster wrote. */
function readsAs(run: FollowupMarker["run"], expected: ExpectedRun) {
  if (expected.kind === "manual") return run.kind === "manual" && !run.done;
  return run.kind === "tick" && run.record === expected.record;
}

/** What the read-back after posting marker `own` shows: it stands, or why not. `done` is a manual claim already marked done, which is kept. */
export type ReadBack =
  | { kind: "stands" }
  | { kind: "unreadable"; reason: string }
  | { kind: "missing" }
  | { kind: "altered" }
  | { kind: "done" }
  | { kind: "earlier"; marker: FollowupMarker };

/**
 * The marker's standing after a read (`forge-claims.ts`'s `post` or
 * `check`), as the follow-up's callers act on it. An earlier trusted marker
 * wins; a marker the read never listed is `missing`; one whose body no
 * longer says what its poster wrote is `altered`.
 */
export function markerStanding(
  seen: Outcome<Standing, "unreadable">,
  expected: ExpectedRun,
): ReadBack {
  if (!seen.ok) return { kind: "unreadable", reason: seen.failure.reason };
  const { verdict, winner, own, listing } = seen.value;
  const earlier = listing.find((c) => c.id === winner?.id);
  if (verdict === "lost-to" && earlier !== undefined)
    return { kind: "earlier", marker: markerOf(earlier) };
  if (own === null || !own.trusted) return { kind: "missing" };
  const run = runOf(own.record);
  if (verdict === "holds" && readsAs(run, expected)) return { kind: "stands" };
  // A person finished the manual run between the post and the read-back: the
  // completion stands, so the claimant stops without deleting it.
  if (expected.kind === "manual" && run.kind === "manual" && run.done)
    return { kind: "done" };
  return { kind: "altered" };
}

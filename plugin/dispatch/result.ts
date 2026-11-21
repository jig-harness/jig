/**
 * `jig dispatch result <record> <token> done|failed`: a pickup's session or
 * a follow-up's pass records its own answer in the launch record the tick
 * wrote for it, which its prompt names with the record's token. A pickup
 * whose claim the repository's start rules refused records
 * `failed --refused <updated-at> --reason <reason>`, the item's `updatedAt` and the
 * reason its claim printed: the tick holds the item, showing the reason,
 * until its `updatedAt` moves past that time. A batch pickup names each
 * refused member with `--key <item>` beside its `--refused`, repeated per
 * member, so only those members are held. It refuses
 * a token that is not the record's own, a drive's record (whose exit is its
 * answer), and a record that already has a result, so a session settles
 * its own launch and no other, once.
 *
 * `waits --until <time>` is a pickup the tracker's rate limit stopped, or a
 * follow-up the forge's or the tracker's rate limit stopped: the tick starts
 * it again once `time` (ISO 8601, at most a day ahead) has passed, and asks
 * no person (a follow-up's third rate-limit wait in a row is a person's:
 * `lib/followup-waits.ts`). `--reason` says what it waits for:
 * `rate-limit`, the default, or `pending`, a follow-up one of whose arms is
 * still pending (a release run still going, a deploy not started), which
 * `--arm <name>` names; a follow-up that finds its arm still pending once
 * `dispatch.followup_within` has passed since it first did is a person's.
 *
 * `waits --reason test-lock [--until <time>]` is a claimed pickup whose
 * committed work the repository's pre-push hook refused only because its
 * wait for the host's test lock ran out, and whose retries in the pass did
 * not get through. It asks no person: the tick relaunches the pickup in its
 * tree to push and go on once the host's validation capacity admits it
 * (`lib/pickup-lock-wait.ts`), not before `time` when one is given. Without
 * `--until` the recording time stands in its place, so no time holds it. It
 * is a pickup's only, as `pending` is a follow-up's only, and not a batch's,
 * whose stop stays a person's.
 *
 * `failed --decision <file>` (`-` for standard input) is a pass that stopped
 * for a person and framed what it asks: a `parked-decision/v1` record, the
 * decision a drive's park holds, checked by the same checker and kept with
 * the result and its digest (`lib/framed-result.ts`). Every reader takes the
 * result as `parked`, not a failure, and its handoff names the person who
 * answers the decision and the act its class asks for. The need the tick
 * shows for it carries that decision, answered as a park is. A decision
 * that does not pass the check records nothing, so the pass can fix it and
 * run the command again.
 *
 * When the state database refuses the read or the write (a schema out of
 * step with its version, a broken or locked file), the command keeps the
 * evidence of the attempt outside the database (`lib/unwritten-result.ts`)
 * and tells the pass to stop and ask no person about the dispatcher: the
 * fault is the host's, its health check reports it, and the tick settles
 * the stage itself once the database reads again.
 *
 * Exit codes: 0 recorded; 2 usage, no such record, a token that is not the
 * record's, a drive's record, or a decision the check refuses; 3 the record
 * already has a result; 4 the host could not write it.
 */
import { derivedNext, type NextOwner, parkedNext } from "./lib/next-owner.ts";
import { stateDbFailure } from "./lib/state.ts";
import { writeUnwritten } from "./lib/unwritten-result.ts";
import { stateRoot } from "./receipts.ts";
import { recordConditionalResult } from "./lib/launch-conditional-result.ts";
import { framedResultOf } from "./lib/framed-result.ts";
import { timingSafeEqual } from "node:crypto";
import {
  type LaunchRecord,
  type PickupRefusal,
  type RefusedMember,
  isRecordId,
  readRecord,
  readResult,
  recordResult,
  type SessionResult,
} from "./lib/launches.ts";
import { currentIso, currentMs, isoFromMs, parseMs } from "../shared/time.ts";
import {
  ARM_MAX,
  armWords,
  WAIT_REASONS,
  type WaitFor,
  type WaitReason,
} from "./lib/wait-for.ts";

import {
  parsePickupPr,
  pickupConditionWords,
  readPickupCondition,
  type PickupCondition,
} from "./lib/pickup-condition.ts";

const USAGE =
  "usage: jig dispatch result <record> <token> done|failed [--pr <number> | --none <reason>] | failed --decision <file|-> | failed (--refused <updated-at> [--key <item>])... --reason <reason>... | waits --until <time> [--reason rate-limit|pending] [--arm <name>] | waits --until-merged <pr> | waits --until-closed <item> | waits --reason test-lock [--until <time>]";
/** The host could not write the result: the evidence is kept, and the dispatcher settles the stage. */
const UNWRITTEN = 4;
/** The longest a pass may wait on a rate limit: a tracker's or the forge's window is an hour or less. */
const MAX_WAIT_MS = 24 * 60 * 60_000;
/** The record already has a result, which stands. */
const ALREADY = 3;

/** The record `id` names when `token` is its own and it is a pickup's or a follow-up's; `null`, printed, otherwise. */
function ownRecord(
  id: string,
  token: string,
  root: string | undefined,
): LaunchRecord | null {
  const record = isRecordId(id) ? readRecord(id, root) : null;
  if (record === null || !sameToken(record.token, token)) {
    console.error(
      `jig dispatch result: ${id} is not a launch record with that token`,
    );
    return null;
  }
  if (record.action !== "pickup" && record.action !== "followup") {
    console.error(
      `jig dispatch result: ${id} is a drive's record; its exit is its answer`,
    );
    return null;
  }
  return record;
}

function already(id: string, root: string | undefined): number {
  console.error(
    `jig dispatch result: ${id} already has a result (${readResult(id, root) ?? "unreadable"}); it stands`,
  );
  return ALREADY;
}

/** What a refused pickup's result says: its `--refused` times, `--key` items and `--reason`s, each in the order given. */
export interface RefusedArgs {
  refused: readonly string[];
  keys: readonly string[];
  reasons: readonly string[];
}

/** `<record> <token> failed --refused <updated-at> [--key <item>] --reason <reason>`, each repeatable. */
export function refusedResultMain(
  id: string,
  token: string,
  result: string,
  args: RefusedArgs,
  root?: string,
): number {
  const record = ownRecord(id, token, root);
  if (record === null) return 2;
  const refusal = refusalFor(record, result, args);
  if (refusal === null) return 2;
  const next = derivedNext(record.action, "gates failed", "result failed");
  if (!recordResult(id, "failed", root, next, refusal))
    return already(id, root);
  console.log(
    JSON.stringify({
      record: id,
      item: record.item,
      result: "failed",
      refused: refusal,
    }),
  );
  return 0;
}

/** Whether two tokens are the same, compared in constant time. */
export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Validate the handoff a session may state; line-fixed handoffs are derived. */
function nextForResult(
  record: LaunchRecord,
  result: string,
  flag?: string,
  value?: string,
): NextOwner | null {
  if (flag !== undefined) {
    if (
      record.action !== "pickup" ||
      result !== "done" ||
      value === undefined ||
      (flag !== "--pr" && flag !== "--none") ||
      !value.trim() ||
      (flag === "--pr" &&
        (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))
    ) {
      console.error(USAGE);
      return null;
    }
    return flag === "--pr"
      ? { address: `drive@${record.repo}#${value}` }
      : { none: value.trim() };
  } else if (record.action === "pickup" && result === "done") {
    console.error(
      "jig dispatch result: a completed pickup must name what follows: pass --pr <number>, or --none <reason> when no pull request was needed",
    );
    return null;
  } else {
    return derivedNext(
      record.action,
      result === "done" ? "converged" : "gates failed",
      `result ${result}`,
    );
  }
}

/** The items a pickup's record covers: its batch's members, else its one item. */
function itemsOf(record: LaunchRecord): string[] {
  return (
    record.batchItems?.map((i) => i.key) ??
    (record.item === null ? [] : [record.item])
  );
}

function oneLine(reason: string): string {
  return reason.replace(/\s+/g, " ").trim();
}

/**
 * The refused members `--key` names, each with the `--refused` time and the
 * `--reason` in its place (one `--reason` stands for every member); `null`
 * after printing why when a key is not the record's, is named twice, or the
 * counts do not pair.
 */
function membersFor(
  record: LaunchRecord,
  args: RefusedArgs,
): RefusedMember[] | null {
  const { refused, keys, reasons } = args;
  if (
    refused.length !== keys.length ||
    (reasons.length !== 1 && reasons.length !== keys.length)
  ) {
    console.error(
      "jig dispatch result: pass one --refused per --key, and one --reason, or one per --key",
    );
    return null;
  }
  const items = itemsOf(record);
  const members: RefusedMember[] = [];
  for (const [i, key] of keys.entries()) {
    if (!items.includes(key) || members.some((m) => m.key === key)) {
      console.error(
        `jig dispatch result: --key ${key} is not an item of this pickup named once (${items.join(", ")})`,
      );
      return null;
    }
    members.push({
      key,
      updatedAt: refused[i] ?? "",
      reason: oneLine(reasons[reasons.length === 1 ? 0 : i] ?? ""),
    });
  }
  return members;
}

/**
 * `--refused <updated-at> [--key <item>] --reason <reason>`: valid only on a
 * pickup's `failed`, with a time and a nonempty reason for each refused
 * member; `null` after printing the usage otherwise. Without `--key`, one
 * time and one reason stand for the whole pickup.
 */
function refusalFor(
  record: LaunchRecord,
  result: string,
  args: RefusedArgs,
): PickupRefusal | null {
  if (
    record.action !== "pickup" ||
    result !== "failed" ||
    args.refused.length === 0 ||
    args.reasons.length === 0 ||
    args.refused.some((t) => !Number.isFinite(parseMs(t))) ||
    args.reasons.some((r) => !r.trim()) ||
    (args.keys.length === 0 &&
      (args.refused.length !== 1 || args.reasons.length !== 1))
  ) {
    console.error(USAGE);
    return null;
  }
  if (args.keys.length === 0)
    return {
      reason: oneLine(args.reasons[0] ?? ""),
      updatedAt: args.refused[0] ?? "",
    };
  const members = membersFor(record, args);
  const first = members?.[0];
  if (members === null || first === undefined) return null;
  return { reason: first.reason, updatedAt: first.updatedAt, members };
}

/** The time a `waits` result names, in the column's form; `null` when it is not one. */
function waitsUntil(value?: string): string | null {
  if (value === undefined) return null;
  const at = parseMs(value);
  if (!Number.isFinite(at) || at > currentMs() + MAX_WAIT_MS) return null;
  return isoFromMs(at);
}

/** What a `waits` result says: the time it waits until, and what for. */
interface WaitsArgs {
  until: string;
  wait: WaitFor;
}

const WAITS_FLAGS = ["--until", "--reason", "--arm"];

/**
 * `--until <time> [--reason rate-limit|pending|test-lock] [--arm <name>]`,
 * each at most once and in any order: `--reason` absent is a rate limit's,
 * `--arm`, one line of at most `ARM_MAX` characters, goes only with
 * `pending`, and `--until` may be left out only with `test-lock`, whose
 * wait then stands at the recording time; `null` when they do not read.
 */
function waitsArgs(rest: readonly string[]): WaitsArgs | null {
  const named = waitsFlags(rest);
  if (named === null) return null;
  const wait = waitFor(named.get("--reason"), named.get("--arm"));
  const given = named.get("--until");
  const until =
    given === undefined && wait?.reason === "test-lock"
      ? currentIso()
      : waitsUntil(given);
  return until === null || wait === null ? null : { until, wait };
}

/** The `waits` options by flag, each named once; `null` for an unknown, repeated or valueless one. */
function waitsFlags(rest: readonly string[]): Map<string, string> | null {
  const named = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === undefined || value === undefined) return null;
    if (!WAITS_FLAGS.includes(flag) || named.has(flag)) return null;
    named.set(flag, value);
  }
  return named;
}

/** What `--reason` and `--arm` say a wait waits for; `null` when they do not read. */
function waitFor(reason = "rate-limit", raw?: string): WaitFor | null {
  if (!(WAIT_REASONS as readonly string[]).includes(reason)) return null;
  if (raw === undefined)
    return reason === "pending" ? null : { reason: reason as WaitReason };
  const arm = oneLine(raw);
  if (reason !== "pending" || arm === "" || arm.length > ARM_MAX) return null;
  return { reason: "pending", arm };
}

function conditionArgs(rest: readonly string[]): PickupCondition | null {
  const [flag, value] = rest;
  if (rest.length !== 2 || value === undefined) return null;
  if (flag === "--until-closed")
    return readPickupCondition({ kind: "item-closed", item: value });
  if (flag !== "--until-merged") return null;
  const pr = parsePickupPr(value);
  return pr === null ? null : { kind: "pr-merged", pr };
}

/** Why `record` cannot wait on `condition`, or `null` when it can: only a single-item pickup waits, on another item in its tracker's key format or on a pull request. */
function conditionalWaitRefusal(
  record: LaunchRecord,
  condition: PickupCondition,
): string | null {
  const item = record.item;
  if (
    record.action !== "pickup" ||
    record.batchItems !== undefined ||
    item === null ||
    (condition.kind === "item-closed" && condition.item === item.toUpperCase())
  )
    return "a single-item pickup can wait on another item or on a pull request";
  if (
    condition.kind === "item-closed" &&
    item.startsWith("#") !== condition.item.startsWith("#")
  )
    return "the dependency must use the pickup's tracker key format";
  return null;
}

function recordConditionalWait(
  record: LaunchRecord,
  condition: PickupCondition,
  root?: string,
): number {
  const refusal = conditionalWaitRefusal(record, condition);
  if (refusal !== null) {
    console.error(`jig dispatch result: ${refusal}`);
    return 2;
  }
  const item = record.item as string;
  const next = { none: `waiting for ${pickupConditionWords(condition)}` };
  const written = recordConditionalResult(
    record,
    item,
    {
      by: "pickup",
      title: item,
      url: null,
      condition,
      resumeRecord: record.id,
    },
    next,
    root,
  );
  if (!written.ok) {
    console.error(`jig dispatch result: ${written.failure.reason}`);
    return 2;
  }
  if (!written.value) return already(record.id, root);
  console.log(
    JSON.stringify({
      record: record.id,
      item,
      result: "waits",
      condition,
      next,
    }),
  );
  return 0;
}

/** A command line this command takes: `done|failed` with their options, or `waits` with its own. */
function wellFormed(argv: string[]): boolean {
  const [id, token, result] = argv;
  if (id === undefined || token === undefined) return false;
  if (result === "waits")
    return (
      waitsArgs(argv.slice(3)) !== null || conditionArgs(argv.slice(3)) !== null
    );
  if (argv.length !== 3 && argv.length !== 5) return false;
  return result === "done" || result === "failed";
}

/** The handoff a `waits` result records: nobody's, until the time it names. */
function waitsNext(waited: WaitsArgs): NextOwner {
  if (waited.wait.reason === "test-lock")
    return {
      none: "waits for the host's test lock: the dispatcher relaunches the pickup in its tree to push once the host's validation capacity admits it",
    };
  return waited.wait.reason === "pending"
    ? {
        none: `waits for ${armWords(waited.wait)} still pending until ${waited.until}`,
      }
    : { none: `waits for a rate limit until ${waited.until}` };
}

/** The record this session may answer for, or why not. */
function answerable(
  id: string,
  token: string,
  root?: string,
): LaunchRecord | string {
  const record = isRecordId(id) ? readRecord(id, root) : null;
  if (record === null || !sameToken(record.token, token))
    return `${id} is not a launch record with that token`;
  if (record.action !== "pickup" && record.action !== "followup")
    return `${id} is a drive's record; its exit is its answer`;
  return record;
}

/** Why `record` cannot wait as `waited` says, or `null` when it can: `pending` is a follow-up's, `test-lock` a single-item pickup's. */
function waitRefusal(
  waited: WaitsArgs | null,
  record: LaunchRecord,
): string | null {
  const reason = waited?.wait.reason;
  if (reason === "pending" && record.action !== "followup")
    return "--reason pending is a follow-up's; a pickup waits on a rate limit or the host's test lock";
  if (reason !== "test-lock") return null;
  if (record.action !== "pickup")
    return "--reason test-lock is a claimed pickup's; a follow-up waits on a rate limit or an arm still pending";
  if (record.batchItems !== undefined)
    return "--reason test-lock is a pickup's of one item; a batch's pass is never relaunched, so it records failed";
  return null;
}

/** Record `result` on `record` with its handoff `next`, and print what was recorded. */
function recordAndPrint(
  id: string,
  record: LaunchRecord,
  result: string,
  next: NextOwner,
  waited: WaitsArgs | null,
  root?: string,
): number {
  if (
    !recordResult(
      id,
      result as SessionResult,
      root,
      next,
      null,
      waited?.until,
      undefined,
      waited?.wait,
    )
  ) {
    return already(id, root);
  }
  console.log(
    JSON.stringify({
      record: id,
      ...(record.item === null ? { pr: record.pr } : { item: record.item }),
      result,
      ...(waited === null ? {} : { until: waited.until, ...waited.wait }),
      next,
    }),
  );
  return 0;
}

export function resultMain(argv: string[], root?: string): number {
  if (!wellFormed(argv)) {
    console.error(USAGE);
    return 2;
  }
  const [id, token, result, flag, value] = argv as [
    string,
    string,
    string,
    string?,
    string?,
  ];
  const record = answerable(id, token, root);
  if (typeof record === "string") {
    console.error(`jig dispatch result: ${record}`);
    return 2;
  }
  const waits = result === "waits";
  const condition = waits ? conditionArgs(argv.slice(3)) : null;
  if (condition !== null) return recordConditionalWait(record, condition, root);
  const waited = waits ? waitsArgs(argv.slice(3)) : null;
  const refusal = waitRefusal(waited, record);
  if (refusal !== null) {
    console.error(`jig dispatch result: ${refusal}`);
    return 2;
  }
  const next =
    waited === null
      ? nextForResult(record, result, flag, value)
      : waitsNext(waited);
  if (next === null) return 2;
  return recordAndPrint(id, record, result, next, waited, root);
}

/**
 * `<record> <token> failed --decision <file>`: a pass that stopped for a
 * person records `failed` with the decision it framed, `text` being the
 * decision's JSON. A decision the check refuses records nothing (exit 2,
 * every problem named), so the pass can fix it and send it again.
 */
export function framedResultMain(
  id: string,
  token: string,
  result: string,
  text: string,
  root?: string,
): number {
  const record = ownRecord(id, token, root);
  if (record === null) return 2;
  if (result !== "failed") {
    console.error(
      "jig dispatch result: --decision is a stop for a person's: record it with failed",
    );
    return 2;
  }
  const framed = framedResultOf(text, currentIso());
  if (!framed.ok) {
    console.error(
      `jig dispatch result: the decision was not recorded: ${framed.failure.reason}`,
    );
    return 2;
  }
  const next = parkedNext(framed.value);
  if (!recordResult(id, "parked", root, next, null, undefined, framed.value))
    return already(id, root);
  console.log(
    JSON.stringify({
      record: id,
      ...(record.item === null ? { pr: record.pr } : { item: record.item }),
      result: "failed",
      decision: framed.value.digest,
      next,
    }),
  );
  return 0;
}

/**
 * Run one of the result commands for record `id`, keeping the evidence of
 * the attempt outside the state database when the database fails it (exit
 * `UNWRITTEN`), so the tick that reads it again knows the pass tried. Any
 * other throw, a defect among them, goes on to the command's own boundary.
 */
export async function guardedResult(
  id: string,
  token: string,
  record: () => number | Promise<number>,
  root = stateRoot(),
): Promise<number> {
  try {
    return await record();
  } catch (error) {
    // Only the database's own failure is the host's; anything else, a defect among them, is reported as what it is.
    const why = stateDbFailure(error);
    if (why === null) throw error;
    const kept = writeUnwritten(root, id, token, "result", why);
    console.error(
      `jig dispatch result: this host could not write the result (${why}). ${kept ? "The dispatcher keeps evidence of this attempt and settles the stage itself" : "Its evidence could not be kept either; the dispatcher reads the stage as ended without a result"}: stop now, and ask no person about the dispatcher's database or host, whose health check (jig doctor dispatch) reports the cause.`,
    );
    return UNWRITTEN;
  }
}

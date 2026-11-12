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
 * `waits --until <time>` is a pickup the tracker's rate limit stopped: the
 * tick starts the item again once `time` (ISO 8601, at most a day ahead)
 * has passed, and asks no person.
 *
 * `failed --decision <file>` (`-` for standard input) is a pass that stopped
 * for a person and framed what it asks: a `parked-decision/v1` record, the
 * decision a drive's park holds, checked by the same checker and kept with
 * the result and its digest (`lib/framed-result.ts`). The need the tick
 * shows for it carries that decision, answered as a park is. A decision
 * that does not pass the check records nothing, so the pass can fix it and
 * run the command again.
 *
 * Exit codes: 0 recorded; 2 usage, no such record, a token that is not the
 * record's, a drive's record, or a decision the check refuses; 3 the record
 * already has a result.
 */
import { derivedNext, type NextOwner } from "./lib/next-owner.ts";
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

const USAGE =
  "usage: jig dispatch result <record> <token> done|failed [--pr <number> | --none <reason>] | failed --decision <file|-> | failed (--refused <updated-at> [--key <item>])... --reason <reason>... | waits --until <time>";
/** The longest a pickup may wait on a rate limit: a tracker's window is an hour or less. */
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

function sameToken(a: string, b: string): boolean {
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
    args.refused.some((t) => !Number.isFinite(Date.parse(t))) ||
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
function waitsUntil(flag?: string, value?: string): string | null {
  if (flag !== "--until" || value === undefined) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at > Date.now() + MAX_WAIT_MS) return null;
  return new Date(at).toISOString();
}

/** A command line this command takes: `done|failed` with their options, or `waits --until <time>`. */
function wellFormed(argv: string[]): boolean {
  const [id, token, result, flag, value] = argv;
  if (argv.length !== 3 && argv.length !== 5) return false;
  if (id === undefined || token === undefined) return false;
  if (result === "waits") return waitsUntil(flag, value) !== null;
  return result === "done" || result === "failed";
}

/** The record this session may answer for, or why not. */
function answerable(
  id: string,
  token: string,
  result: string,
  root?: string,
): LaunchRecord | string {
  const record = isRecordId(id) ? readRecord(id, root) : null;
  if (record === null || !sameToken(record.token, token))
    return `${id} is not a launch record with that token`;
  if (record.action !== "pickup" && record.action !== "followup")
    return `${id} is a drive's record; its exit is its answer`;
  if (result === "waits" && record.action !== "pickup")
    return `${id} is a follow-up's record; only a pickup waits for a tracker's rate limit`;
  return record;
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
  const record = answerable(id, token, result, root);
  if (typeof record === "string") {
    console.error(`jig dispatch result: ${record}`);
    return 2;
  }
  const until = result === "waits" ? waitsUntil(flag, value) : null;
  const next =
    until === null
      ? nextForResult(record, result, flag, value)
      : { none: `waits for the tracker's rate limit until ${until}` };
  if (next === null) return 2;
  if (
    !recordResult(
      id,
      result as SessionResult,
      root,
      next,
      null,
      until ?? undefined,
    )
  ) {
    return already(id, root);
  }
  console.log(
    JSON.stringify({
      record: id,
      ...(record.item === null ? { pr: record.pr } : { item: record.item }),
      result,
      ...(until === null ? {} : { until }),
      next,
    }),
  );
  return 0;
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
  const framed = framedResultOf(text, new Date().toISOString());
  if (!framed.ok) {
    console.error(
      `jig dispatch result: the decision was not recorded: ${framed.failure.reason}`,
    );
    return 2;
  }
  const next = derivedNext(record.action, "gates failed", "result failed");
  if (!recordResult(id, "failed", root, next, null, undefined, framed.value))
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

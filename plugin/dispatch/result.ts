/**
 * `jig dispatch result <record> <token> done|failed`: a pickup's session or
 * a follow-up's pass records its own answer in the launch record the tick
 * wrote for it, which its prompt names with the record's token. It refuses
 * a token that is not the record's own, a drive's record (whose exit is its
 * answer), and a record that already has a result, so a session settles
 * its own launch and no other, once.
 *
 * `waits --until <time>` is a pickup the tracker's rate limit stopped: the
 * tick starts the item again once `time` (ISO 8601, at most a day ahead)
 * has passed, and asks no person.
 *
 * Exit codes: 0 recorded; 2 usage, no such record, a token that is not the
 * record's, or a drive's record; 3 the record already has a result.
 */
import { derivedNext, type NextOwner } from "./lib/next-owner.ts";
import { timingSafeEqual } from "node:crypto";
import {
  type LaunchRecord,
  isRecordId,
  readRecord,
  readResult,
  recordResult,
  type SessionResult,
} from "./lib/launches.ts";

const USAGE =
  "usage: jig dispatch result <record> <token> done|failed [--pr <number> | --none <reason>] | waits --until <time>";
/** The longest a pickup may wait on a rate limit: a tracker's window is an hour or less. */
const MAX_WAIT_MS = 24 * 60 * 60_000;
/** The record already has a result, which stands. */
const ALREADY = 3;

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
    !recordResult(id, result as SessionResult, root, next, until ?? undefined)
  ) {
    console.error(
      `jig dispatch result: ${id} already has a result (${readResult(id, root) ?? "unreadable"}); it stands`,
    );
    return ALREADY;
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

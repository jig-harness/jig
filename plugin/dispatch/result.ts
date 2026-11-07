/**
 * `jig dispatch result <record> <token> done|failed`: a pickup's session or
 * a follow-up's pass records its own answer in the launch record the tick
 * wrote for it, which its prompt names with the record's token. It refuses
 * a token that is not the record's own, a drive's record (whose exit is its
 * answer), and a record that already has a result, so a session settles
 * its own launch and no other, once.
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
  "usage: jig dispatch result <record> <token> done|failed [--pr <number> | --none <reason>]";
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

export function resultMain(argv: string[], root?: string): number {
  const [id, token, result, flag, value] = argv;
  if (
    (argv.length !== 3 && argv.length !== 5) ||
    id === undefined ||
    token === undefined ||
    (result !== "done" && result !== "failed")
  ) {
    console.error(USAGE);
    return 2;
  }
  const record = isRecordId(id) ? readRecord(id, root) : null;
  if (record === null || !sameToken(record.token, token)) {
    console.error(
      `jig dispatch result: ${id} is not a launch record with that token`,
    );
    return 2;
  }
  if (record.action !== "pickup" && record.action !== "followup") {
    console.error(
      `jig dispatch result: ${id} is a drive's record; its exit is its answer`,
    );
    return 2;
  }
  const next = nextForResult(record, result, flag, value);
  if (next === null) return 2;
  if (!recordResult(id, result as SessionResult, root, next)) {
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
      next,
    }),
  );
  return 0;
}

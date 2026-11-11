/**
 * `jig dispatch result <record> <token> done|failed`: a pickup's session or
 * a follow-up's pass records its own answer in the launch record the tick
 * wrote for it, which its prompt names with the record's token. A pickup
 * whose claim the repository's start rules refused records
 * `failed --refused <updated-at> --reason <reason>`, the item's `updatedAt` and the
 * reason its claim printed: the tick holds the item, showing the reason,
 * until its `updatedAt` moves past that time. It refuses
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
  type PickupRefusal,
  isRecordId,
  readRecord,
  readResult,
  recordResult,
  type SessionResult,
} from "./lib/launches.ts";

const USAGE =
  "usage: jig dispatch result <record> <token> done|failed [--pr <number> | --none <reason>] | failed --refused <updated-at> --reason <reason>";
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

/** `<record> <token> failed --refused <updated-at> <reason>`, as the command line hands it on. */
function refusedMain(argv: string[], root?: string): number {
  const [id, token, result, , updatedAt, reason] = argv;
  if (argv.length !== 6 || id === undefined || token === undefined) {
    console.error(USAGE);
    return 2;
  }
  const record = ownRecord(id, token, root);
  if (record === null) return 2;
  const refusal = refusalFor(record, result ?? "", updatedAt, reason);
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

/**
 * `--refused <updated-at> --reason <reason>`: valid only on a pickup's `failed`, with
 * a time and a nonempty reason; `null` after printing the usage otherwise.
 */
function refusalFor(
  record: LaunchRecord,
  result: string,
  updatedAt: string | undefined,
  reason: string | undefined,
): PickupRefusal | null {
  if (
    record.action !== "pickup" ||
    result !== "failed" ||
    updatedAt === undefined ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    reason === undefined ||
    !reason.trim()
  ) {
    console.error(USAGE);
    return null;
  }
  return { reason: reason.replace(/\s+/g, " ").trim(), updatedAt };
}

export function resultMain(argv: string[], root?: string): number {
  if (argv[3] === "--refused") return refusedMain(argv, root);
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
  const record = ownRecord(id, token, root);
  if (record === null) return 2;
  const next = nextForResult(record, result, flag, value);
  if (next === null) return 2;
  if (!recordResult(id, result as SessionResult, root, next))
    return already(id, root);
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

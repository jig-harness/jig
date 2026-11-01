/**
 * `jig dispatch result <record> <token> done|failed`: an interactive
 * session records its own answer in the launch record the tick wrote for
 * it, which its prompt names with the record's token. It refuses a token
 * that is not the record's own, a record of a headless pass (whose exit is
 * its answer), and a record that already has a result, so a session settles
 * its own launch and no other, once.
 *
 * Exit codes: 0 recorded; 2 usage, no such record, a token that is not the
 * record's, or a headless pass's record; 3 the record already has a result.
 */
import { timingSafeEqual } from "node:crypto";
import {
  isRecordId,
  readRecordFile,
  readResult,
  recordResult,
  type SessionResult,
} from "./lib/launches.ts";

const USAGE = "usage: jig dispatch result <record> <token> done|failed";
/** The record already has a result, which stands. */
const ALREADY = 3;

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function resultMain(argv: string[], root?: string): number {
  const [id, token, result] = argv;
  if (
    argv.length !== 3 ||
    id === undefined ||
    token === undefined ||
    (result !== "done" && result !== "failed")
  ) {
    console.error(USAGE);
    return 2;
  }
  const record = isRecordId(id) ? readRecordFile(id, root) : null;
  if (record === null || !sameToken(record.token, token)) {
    console.error(
      `jig dispatch result: ${id} is not a launch record with that token`,
    );
    return 2;
  }
  if (record.action !== "pickup" && record.action !== "followup") {
    console.error(
      `jig dispatch result: ${id} is a headless pass's record; its exit is its answer`,
    );
    return 2;
  }
  if (!recordResult(id, result as SessionResult, root)) {
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
    }),
  );
  return 0;
}

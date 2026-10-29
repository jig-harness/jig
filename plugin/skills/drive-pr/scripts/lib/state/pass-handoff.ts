/**
 * What the driver hands a review pass that must outlive one driver process,
 * kept as files in the drive's state directory beside `drive-pr-<PR>.json`:
 *
 *   - `drive-pr-<PR>.answers.json`: the human verdicts a re-arm read for the
 *     parked items it unparked. Written before the unpark, so a stop between
 *     the unpark and a pass (a crash, a mailbox stop, a spent round budget)
 *     cannot lose them once their parks are gone; every later arm hands them
 *     on, and they are removed only when a pass exits 0 with them.
 *   - `drive-pr-<PR>.notice.md`: a pass notice too long for one environment
 *     variable. The variable then carries its head and this file's path, so
 *     a long notice cannot make the pass fail to spawn.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";

import { atomicWrite } from "./fsutil.ts";

/** The most bytes `$DRIVE_PR_PASS_NOTICE` carries; a longer notice goes to a file. */
export const PASS_NOTICE_ENV_MAX = 16_384;

/** One answer a person gave to a parked item. */
export interface PendingAnswer {
  author: string;
  at: string;
  url: string;
  body: string;
}

/** A parked item a re-arm unparked, with the answers that admitted it. */
export interface PendingVerdict {
  kind: "thread" | "finding";
  key: string;
  reason: string;
  answers: PendingAnswer[];
}

export function answersFile(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.answers.json`);
}

export function noticeFile(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.notice.md`);
}

const str = (v: unknown): v is string => typeof v === "string";

function isAnswer(v: unknown): v is PendingAnswer {
  return isRecord(v) && [v.author, v.at, v.url, v.body].every(str);
}

function isVerdict(v: unknown): v is PendingVerdict {
  return (
    isRecord(v) &&
    (v.kind === "thread" || v.kind === "finding") &&
    str(v.key) &&
    str(v.reason) &&
    Array.isArray(v.answers) &&
    v.answers.every(isAnswer)
  );
}

/**
 * The kept verdicts; `[]` when there are none, `null` when the file cannot
 * be read as them. The caller must not treat `null` as none: that would drop
 * answers whose parks are gone.
 */
export function readPendingVerdicts(
  stateDir: string,
  pr: string,
): PendingVerdict[] | null {
  const file = answersFile(stateDir, pr);
  if (!existsSync(file)) return [];
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    swallow(err, "the kept answers are unreadable");
    return null;
  }
  return Array.isArray(value) && value.every(isVerdict) ? value : null;
}

export function writePendingVerdicts(
  stateDir: string,
  pr: string,
  verdicts: readonly PendingVerdict[],
): void {
  atomicWrite(
    answersFile(stateDir, pr),
    `${JSON.stringify(verdicts, null, 2)}\n`,
  );
}

/** A pass exited 0 with the verdicts: nothing is owed any more. */
export function clearPendingVerdicts(stateDir: string, pr: string): void {
  try {
    rmSync(answersFile(stateDir, pr), { force: true });
  } catch (err) {
    swallow(err, "the kept answers could not be removed");
  }
}

/**
 * `notice` as it may go into `$DRIVE_PR_PASS_NOTICE`: unchanged when it fits
 * `PASS_NOTICE_ENV_MAX`, otherwise written whole to `noticeFile` and cut to a
 * head (whose first line still names the case) plus the file's path.
 */
export function boundPassNotice(
  stateDir: string,
  pr: string,
  notice: string,
): string {
  const file = noticeFile(stateDir, pr);
  if (Buffer.byteLength(notice) <= PASS_NOTICE_ENV_MAX) {
    try {
      rmSync(file, { force: true });
    } catch (err) {
      swallow(err, "a stale pass notice file could not be removed");
    }
    return notice;
  }
  let where = `read all of it in ${file} before acting`;
  try {
    atomicWrite(file, notice);
  } catch (err) {
    where = `writing it to ${file} failed (${String(err)}), so the rest is lost`;
  }
  const tail = `\n… (cut: this notice is longer than one environment variable may hold; ${where})`;
  const room = PASS_NOTICE_ENV_MAX - Buffer.byteLength(tail) - 4;
  const head = Buffer.from(notice).subarray(0, room).toString("utf8");
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return `${head.replace(/�+$/, "")}${tail}`;
}

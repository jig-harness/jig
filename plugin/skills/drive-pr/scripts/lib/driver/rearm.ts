/**
 * Picking a stopped drive up again: the re-arm checks `drive.ts` runs once it
 * holds the drive's locks and before its first round.
 *
 * A drive that stopped holds no lock, so picking it up is a re-arm from its
 * durable state, admitted on two mechanical states rather than on anyone's
 * judgement:
 *
 *   - QUOTA_PARKED. While the wall is still in effect (its reset unknown or
 *     still ahead), the re-arm is admitted only for a pass that bills a
 *     DIFFERENT account from the one the wall belongs to: the park records
 *     that account hashed (`accountHash`), and this driver resolves its own
 *     from the pass command it will spawn. Either side unknown, or both
 *     equal, refuses with the wall's account named, because a successor on
 *     the same subscription is behind the same wall. A reset already past,
 *     or a person's `--window-reopened`, admits any account.
 *   - HITL_PARKED. Once EVERY parked item has an answer — a comment by an
 *     author GitHub vouches for as an owner, member or collaborator
 *     (`TRUSTED_ASSOCIATIONS`, the summary-finding guard's rule), later than
 *     the park, on the item's thread or as a pull-request comment with a line
 *     `answer <key>: …` — the re-arm keeps the answers in the state directory,
 *     unparks every item in one state mutation, and hands the answers to
 *     every pass until one completes, across later arms too, as human
 *     verdicts. With any item unanswered nothing is
 *     unparked, and the drive stops `HITL_PARKED` at its first gate as
 *     before. A comment the drive itself writes (one opening with an outcome
 *     token, or carrying a hidden marker other than the record of an answer
 *     `jig send` wrote, `answer-comment.ts`) is never read as an answer, and a
 *     pull-request comment counts only in the stated `answer <key>:` form:
 *     the drive posts with the operator's own credentials, so a comment that
 *     merely mentions a parked key must not unpark it.
 */
import { fail, shellQuote } from "./../cli.ts";

import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import {
  accountHash,
  formatAccountIdentity,
  resolveAccountIdentity,
} from "./../identity.ts";

import { type DriveState, isUsableState } from "./../state/schema.ts";

import {
  answersFile,
  type PendingVerdict,
  readPendingVerdicts,
  writePendingVerdicts,
} from "./../state/pass-handoff.ts";

import { resolveStateDir } from "./../state/store.ts";
import type { ConsumedVerdict } from "./../state/resolution-receipt.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { parkAnswers } from "./park-answers.ts";
import { laggingAnswerPublication } from "./answer-publication.ts";

import { pinsEmptyPassArgs } from "./../pass-args.ts";

import { driveState, driveTs } from "./paths.ts";

import { QUOTA_PARKED_EXIT } from "./settings.ts";

import { provisionalDuties, provisionalNotice } from "./rearm-provisional.ts";
import { humanVerdictNotice } from "./human-answer-notice.ts";
import { parseMs } from "../../../../../shared/time.ts";
export { humanVerdictNotice, NOTICE_MAX } from "./human-answer-notice.ts";

/**
 * The arm command, in the drive's own mode, for a person to copy: with the
 * drive's own pass command when `agent` holds it (the driver passes the
 * command it runs, whose `--model` names the pass model), else the documented
 * Claude Code one, to which `drive.ts` adds the configured model.
 */
export function armCommand(
  driveTs: string,
  pr: string,
  botsOnly: boolean,
  extra = "",
  agent: readonly string[] = [],
): string {
  const mode = botsOnly ? " --bots-only" : "";
  const pinned = pinsEmptyPassArgs(agent) ? " --pass-args ''" : "";
  const pass =
    agent.length > 0
      ? agent.map(shellQuote).join(" ")
      : `claude -p "/jig:drive-pr${mode} ${pr}"`;
  return `bun ${shellQuote(driveTs)} ${pr}${extra}${pinned}${mode} -- ${pass}`;
}

/** Whether a pass command is scoped to bot threads, as `drive.ts` checks it. */
export function passBotsOnly(agent: readonly string[]): boolean {
  return agent.some((word) => word.includes("--bots-only"));
}

/** `admitQuotaRearm` for a state that may be unreadable (the gate refuses it). */
export function quotaRefusal(
  state: DriveState | null,
  agent: string[],
  windowReopened: boolean,
): number | undefined {
  if (state === null) return undefined;
  return (
    admitQuotaRearm(state, agent, windowReopened, Temporal.Now.instant()) ??
    undefined
  );
}

/** The drive state, or `null` when it cannot be read (the gate then refuses). */
export async function readDriveState(pr: string): Promise<DriveState | null> {
  const res = await run(tsArgv(driveState, ["get", pr]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code !== 0) return null;
  const state = parseJson(res.stdout, "drive-state.ts get");
  return isUsableState(state, Number.parseInt(pr, 10)) ? state : null;
}

/** `text` as JSON, or `null` when it is not JSON. */
export function parseJson(text: string, what: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch (err) {
    swallow(err, `${what} printed no JSON`);
    return null;
  }
}

/**
 * Admit or refuse a re-arm of a quota-parked drive; `null` admits. See the
 * module header for the rule.
 */
export function admitQuotaRearm(
  state: DriveState,
  agent: string[],
  windowReopened: boolean,
  now: Temporal.Instant,
): number | null {
  const park = state.quotaPark;
  if (park === null) return null;
  const pr = String(state.pr);
  if (park.resetAt !== null && parseMs(park.resetAt) <= now.epochMilliseconds) {
    console.error(
      `re-arm: PR #${pr} was quota-parked, and its window reset at ${park.resetAt}; driving on.`,
    );
    return null;
  }
  if (windowReopened) {
    console.error(
      `re-arm: PR #${pr} was quota-parked (reset ${park.resetAt ?? "unresolved"}); --window-reopened says the window is open again.`,
    );
    return null;
  }
  const identity = resolveAccountIdentity(agent);
  const mine = accountHash(identity);
  const wall = park.account ?? null;
  if (mine !== null && wall !== null && mine !== wall) {
    console.error(
      `re-arm: PR #${pr} was quota-parked on account ${wall}; this pass bills ${mine} (${formatAccountIdentity(identity)}), a different account — driving on.`,
    );
    return null;
  }
  const why =
    mine === null
      ? `the account this pass bills is unknown (${formatAccountIdentity(identity)})`
      : wall === null
        ? "the park did not record the account the wall belongs to"
        : `this pass bills the same account the wall belongs to (${wall})`;
  for (const line of [
    `refusing to re-arm PR #${pr}: it is quota-parked on a ${park.vendor} ${park.window}-window wall (reset ${park.resetAt ?? "unresolved"}), and ${why}.`,
    "A successor on the same subscription is behind the same wall. Re-arm from a session",
    "whose pass bills another account, or after the reset. --window-reopened only if a person",
    "knows the window has reopened: an agent never passes it.",
    `The wall belongs to account ${wall ?? "unrecorded"}. From a session whose pass bills another account:`,
    `  ${armCommand(driveTs, pr, passBotsOnly(agent), "", agent)}`,
  ])
    console.error(line);
  return QUOTA_PARKED_EXIT;
}

export {
  type CommentLike,
  answersKey,
  isAnswer,
  isAnswerLine,
  linesOutsideFences,
} from "../answer-forms.ts";
export {
  conversationOf,
  parkAnswers,
  prComments,
  threadComments,
  type ParkAnswersResult,
} from "./park-answers.ts";

/**
 * Every parked item with its answers once all of them are answered; `null`
 * when one is unanswered or a read failed (each logged).
 */
async function answeredParks(
  state: DriveState,
): Promise<PendingVerdict[] | null> {
  const found = await parkAnswers(state.pr, state.parked);
  if ("unreadable" in found) {
    console.error(
      `re-arm: could not read the comments that would answer parked ${found.unreadable}; leaving every item parked.`,
    );
    return null;
  }
  const { answered, waiting, unread, responded } = found;
  const lagging = await laggingAnswerPublication(
    state.pr,
    state.parked,
    (key) => [
      ...(answered.find((v) => v.key === key)?.answers ?? []),
      ...(found.stale.find((v) => v.item.key === key)?.answers ?? []),
      ...(found.disputed.find((v) => v.item.key === key)?.answers ?? []),
      ...(found.partial.find((v) => v.key === key)?.answers ?? []),
    ],
  );
  if (lagging.length > 0) {
    console.error(
      `re-arm: the ledger has not yet caught up with the local decision framing for ${lagging.join(", ")}; every item stays parked until the driver's next write publishes it again.`,
    );
    return null;
  }
  if (found.stale.length > 0)
    console.error(
      `re-arm: stale answers name an earlier decision framing for ${found.stale.map((v) => v.item.key).join(", ")}; copy a current answer line with its digest. Every item stays parked.`,
    );
  if (waiting.length === 0 && unread.length === 0) return answered;
  // At the wide level, the unanswered items a provisional decision may take:
  // only once every place a person's answer could be was read, since an
  // answer in an unread one must never be decided over.
  if (unread.length > 0) {
    console.error(
      `re-arm: could not read every place an answer to ${unread.map((p) => `${p.kind} ${p.key}`).join(", ")} could be; nothing is unparked, and nothing is decided provisionally.`,
    );
    return null;
  }
  // A dispute or any other answer remains a person's to settle, at every level.
  if (waiting.some((p) => responded.some((a) => a.key === p.key))) {
    console.error(
      "re-arm: a parked item has answers that do not settle it; leaving every item parked for the people answering it.",
    );
    return null;
  }
  const duties = provisionalDuties(waiting);
  if (duties !== null) return [...answered, ...duties];
  console.error(
    `re-arm: ${answered.length} of ${state.parked.length} parked item(s) answered; still waiting on ${waiting.map((p) => `${p.kind} ${p.key}`).join(", ")}. Nothing is unparked until every one is.`,
  );
  return null;
}

/**
 * Unpark every parked item once all of them are answered, and return the
 * notice that hands the answers, with any an earlier arm unparked and no pass
 * has yet completed with, to the first round; `''` when there are none.
 *
 * The answers are written to the state directory (`pass-handoff.ts`) before
 * the one `unpark` that removes every answered park or none, so no stop
 * after it can lose them: they stay there until a pass exits 0. An entry
 * whose item is still parked (an unpark that failed) is kept and not handed:
 * the item's thread still holds the answer for the next arm to read.
 */
export async function admitAnsweredParks(
  state: DriveState,
  dryRun: boolean,
): Promise<string> {
  const pr = String(state.pr);
  const stateDir = await resolveStateDir();
  const file = answersFile(stateDir, pr);
  const kept = readPendingVerdicts(stateDir, pr);
  // Driving on would let the next completed pass remove the only copy of
  // answers whose parks may already be gone, unread.
  if (kept === null)
    return fail(
      1,
      `re-arm: cannot read the answers kept for PR #${pr} in ${file}; stopping with the file left in place. Repair it, or act on it by hand and remove it, then re-arm.`,
    );
  const isParked = (key: string) => state.parked.some((p) => p.key === key);
  const carried = kept.filter((v) => !isParked(v.key));
  if (carried.length > 0)
    console.error(
      `re-arm: ${carried.length} answered item(s) an earlier arm unparked are still owed to a pass (${file}).`,
    );
  const fresh = state.parked.length === 0 ? [] : await answeredParks(state);
  if (fresh === null || fresh.length === 0)
    return dryRun ? "" : rearmNotice(carried, file);
  if (dryRun) {
    console.error(
      `(dry-run) re-arm would unpark ${fresh.length} answered item(s) and hand the answers to the first round.`,
    );
    return "";
  }
  const keys = new Set(fresh.map((v) => v.key));
  try {
    writePendingVerdicts(stateDir, pr, [
      ...kept.filter((v) => !keys.has(v.key)),
      ...fresh,
    ]);
  } catch (err) {
    console.error(
      `re-arm: cannot keep the answers in ${file} (${String(err)}); every item stays parked.`,
    );
    return rearmNotice(carried, file);
  }
  // Bound to the parks whose answers were read: a park replaced under the
  // same key, or added, while the comments were read refuses the whole set.
  // The consumed verdicts on stdin become each park's resolution receipt.
  const parkedAt = new Map(state.parked.map((p) => [p.key, p.at ?? ""]));
  const res = await run(
    tsArgv(driveState, [
      "unpark",
      pr,
      "--every",
      "--stdin",
      ...fresh.flatMap((v) => [
        "--key",
        v.key,
        "--parked-at",
        parkedAt.get(v.key) ?? "",
      ]),
    ]),
    {
      stdin: JSON.stringify(fresh.map(consumedOf)),
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (res.code !== 0)
    return recoverFailedUnpark(pr, res.code, carried, fresh, file);
  await announceUnparked(pr, fresh, file);
  return rearmNotice([...carried, ...fresh], file);
}

/** What `unpark --stdin` keeps of a verdict for its receipt. */
function consumedOf(v: PendingVerdict): ConsumedVerdict {
  return {
    key: v.key,
    answers: v.answers,
    ...(v.provisional === true ? { provisional: true as const } : {}),
  };
}

/**
 * After an `unpark` that exited non-zero: a deadline can end the call after
 * its write landed, so read the state to tell, hand on the answers of items
 * that are unparked, and record that re-arm.
 */
async function recoverFailedUnpark(
  pr: string,
  code: number | null,
  carried: readonly PendingVerdict[],
  fresh: readonly PendingVerdict[],
  file: string,
) {
  const gone = unparkedAfterFailure(await readDriveState(pr), fresh);
  if (gone === null)
    return fail(
      1,
      `re-arm: drive-state.ts unpark exited ${code}, and the drive state cannot be read to tell whether the answered items were unparked; stopping with the answers kept in ${file}. Re-arm once the state reads.`,
    );
  console.error(
    gone.length > 0
      ? `re-arm: drive-state.ts unpark exited ${code}, but the answered items are unparked; handing their answers on.`
      : `re-arm: could not unpark the answered items (drive-state.ts exited ${code}); every one stays parked, and the next arm reads their answers again.`,
  );
  if (gone.length > 0) await announceUnparked(pr, gone, file);
  return rearmNotice([...carried, ...gone], file);
}

/** Say what the re-arm unparked, and record it (`events.ts`). */
async function announceUnparked(
  pr: string,
  fresh: readonly PendingVerdict[],
  file: string,
): Promise<void> {
  const duties = fresh.filter((v) => v.provisional === true).length;
  console.error(
    duties === 0
      ? `re-arm: every parked item on PR #${pr} is answered — unparked ${fresh.length} and handing the answers to the first round as human verdicts (kept in ${file} until a pass completes).`
      : `re-arm: PR #${pr} re-armed at the wide level — unparked ${fresh.length}: ${fresh.length - duties} answered, handed on as human verdicts, and ${duties} to decide provisionally (kept in ${file} until a pass completes).`,
  );
  await recordDriveEvent(
    pr,
    "rearm",
    duties === 0 ? "answered" : "provisional",
  );
}

/**
 * Record a self-restart or a re-arm in the drive state (`events.ts`), for
 * the morning report and `loop-metrics.ts`; best-effort, logged. Returns
 * whether the event was recorded, for a caller whose next write depends on it.
 */
export async function recordDriveEvent(
  pr: string,
  kind: "restart" | "rearm" | "stop",
  cause: string,
  measured: { leftWork: boolean; tree: string } | null = null,
): Promise<boolean> {
  const res = await run(tsArgv(driveState, ["record-event", pr]), {
    stdin: JSON.stringify({ kind, cause, ...measured }),
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code === 0) return true;
  console.error(
    `drive.ts: could not record the ${kind} (${cause}) in the drive state (exit ${res.code}); driving on.`,
  );
  return false;
}

/** The cause of a re-arm past a quota park (`events.ts`); `null` when there was none. */
export function quotaRearmCause(
  state: DriveState,
  windowReopened: boolean,
  now: Temporal.Instant,
): string | null {
  const park = state.quotaPark;
  if (park === null) return null;
  if (park.resetAt !== null && parseMs(park.resetAt) <= now.epochMilliseconds)
    return "quota-reset";
  return windowReopened ? "window-reopened" : "quota-account";
}

/** The notice for the answered items, then for those to decide provisionally. */
function rearmNotice(
  verdicts: readonly PendingVerdict[],
  file: string,
): string {
  return [
    humanVerdictNotice(
      verdicts.filter((v) => v.provisional !== true),
      file,
    ),
    provisionalNotice(verdicts),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * After an `unpark` that exited non-zero, the answered items the state
 * `now` no longer parks (all of them or none), to hand on. `null` when the
 * state could not be read: whether they were unparked is then unknown, and
 * driving on could let a completed pass remove the only copy of answers
 * whose parks are gone, so the arm stops.
 */
export function unparkedAfterFailure(
  now: DriveState | null,
  fresh: readonly PendingVerdict[],
): PendingVerdict[] | null {
  if (now === null) return null;
  return fresh.filter((v) => !now.parked.some((p) => p.key === v.key));
}

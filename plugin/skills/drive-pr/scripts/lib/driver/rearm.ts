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
 *     token, or carrying a hidden marker) is never read as an answer, and a
 *     pull-request comment counts only in the stated `answer <key>:` form:
 *     the drive posts with the operator's own credentials, so a comment that
 *     merely mentions a parked key must not unpark it.
 */
import { fail, shellQuote } from "./../cli.ts";

import {
  ghCall,
  ghRepoEnv,
  helperTimeoutSeconds,
  run,
  tsArgv,
} from "./../proc.ts";

import {
  accountHash,
  formatAccountIdentity,
  resolveAccountIdentity,
} from "./../identity.ts";

import {
  type DriveState,
  isUsableState,
  type ParkedItem,
} from "./../state/schema.ts";

import {
  answersFile,
  type PendingAnswer,
  type PendingVerdict,
  readPendingVerdicts,
  writePendingVerdicts,
} from "./../state/pass-handoff.ts";

import { resolveStateDir } from "./../state/store.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";

import { pinsEmptyPassArgs } from "./../pass-args.ts";

import { driveState, driveTs } from "./paths.ts";

import { QUOTA_PARKED_EXIT } from "./settings.ts";

import { provisionalDuties, provisionalNotice } from "./rearm-provisional.ts";

/** The longest answer body in the notice; the url and the kept file carry the rest. */
const ANSWER_BODY_MAX = 1500;

/** The longest park reason in an item's entry. */
const REASON_MAX = 300;

/** The length the answer bodies are cut to fit, beside every item's entry. */
export const NOTICE_MAX = 15_000;

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
  return admitQuotaRearm(state, agent, windowReopened, new Date()) ?? undefined;
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

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Admit or refuse a re-arm of a quota-parked drive; `null` admits. See the
 * module header for the rule.
 */
export function admitQuotaRearm(
  state: DriveState,
  agent: string[],
  windowReopened: boolean,
  now: Date,
): number | null {
  const park = state.quotaPark;
  if (park === null) return null;
  const pr = String(state.pr);
  if (park.resetAt !== null && Date.parse(park.resetAt) <= now.getTime()) {
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

export interface CommentLike {
  author: string;
  association: string;
  at: string;
  url: string;
  body: string;
}

/** A pull-request comment answers a parked key only with a line `answer <key>:`. */
export function answersKey(body: string, key: string): boolean {
  const prefix = `answer ${key}:`.toLowerCase();
  // The open fence's marker run (```` ```` ````, `~~~`, …); `''` outside one.
  let fence = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    // A fenced block is an example or a quote, never the answer itself.
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1] ?? "";
    if (fence === "") {
      if (marker !== "") fence = marker;
      else if (isAnswerLine(raw, line, prefix)) return true;
    } else if (closesFence(line, marker, fence)) fence = "";
  }
  return false;
}

/**
 * Whether one line outside a fence is the answer: the prefix with a decision
 * after it, indented less than an indented code block (four spaces or a tab),
 * which is an example too.
 */
function isAnswerLine(raw: string, line: string, prefix: string): boolean {
  return (
    !/^( {4}|\t)/.test(raw.replace(/^ {0,3}(?=\t)/, "")) &&
    line.toLowerCase().startsWith(prefix) &&
    line.slice(prefix.length).trim() !== ""
  );
}

/**
 * Whether `line` closes the fence `open` opened: a run of the same character
 * at least as long, with nothing after it (CommonMark's closing fence).
 */
function closesFence(line: string, marker: string, open: string): boolean {
  return (
    marker !== "" &&
    marker[0] === open[0] &&
    marker.length >= open.length &&
    line.slice(marker.length).trim() === ""
  );
}

/** A comment a person wrote after the park, not one the drive wrote. */
function isAnswer(c: CommentLike, after: number): boolean {
  return (
    TRUSTED_ASSOCIATIONS.has(c.association) &&
    Date.parse(c.at) > after &&
    !/^\*\*(accepted|rejected|wont-fix|deferred|moot)\*\*/.test(c.body) &&
    !c.body.includes("<!--")
  );
}

const THREAD_QUERY =
  "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved comments(first:100){pageInfo{hasNextPage} nodes{url author{login} authorAssociation createdAt body}}}}}";

/**
 * One thread's comments, in order; `null` when they could not be read, or
 * when the thread holds more than one page of them: a partial history is
 * never read as the whole, since the comment it leaves out may be the one
 * the caller looks for.
 */
export async function threadComments(
  key: string,
): Promise<CommentLike[] | null> {
  const res = await ghCall(
    ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${key}`],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (res.code !== 0) return null;
  let comments: unknown = parseJson(res.stdout, "the thread query");
  for (const key of ["data", "node", "comments"])
    comments = isRecord(comments) ? comments[key] : undefined;
  if (!isRecord(comments)) return null;
  const page = comments.pageInfo;
  if (!isRecord(page) || page.hasNextPage !== false) return null;
  const at = comments.nodes;
  if (!Array.isArray(at)) return null;
  return at.filter(isRecord).map((n) => ({
    author: isRecord(n.author) ? text(n.author.login) : "",
    association: text(n.authorAssociation),
    at: text(n.createdAt),
    url: text(n.url),
    body: text(n.body),
  }));
}

export async function prComments(
  pr: string,
  repo = "{owner}/{repo}",
): Promise<CommentLike[] | null> {
  const res = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/issues/${pr}/comments?per_page=100`,
    ],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (res.code !== 0) return null;
  const pages = parseJson(res.stdout, "the pull request's comments");
  if (!Array.isArray(pages)) return null;
  return pages
    .flat()
    .filter(isRecord)
    .map((c) => ({
      author: isRecord(c.user) ? text(c.user.login) : "",
      association: text(c.author_association),
      at: text(c.created_at),
      url: text(c.html_url),
      body: text(c.body),
    }));
}

/**
 * The answers to one parked item, and whether every place an answer could be
 * (its thread, and the pull request's conversation) was read; `null` when
 * none could be.
 */
async function answersTo(
  item: ParkedItem,
  conversation: CommentLike[] | null,
): Promise<{ answers: PendingAnswer[]; complete: boolean } | null> {
  // No park time means no baseline to measure an answer against: nothing was
  // read, so the item is waiting on evidence, not on a person.
  if (item.at === undefined) return { answers: [], complete: false };
  const after = Date.parse(item.at);
  const thread = item.kind === "thread" ? await threadComments(item.key) : [];
  if (thread === null && conversation === null) return null;
  const candidates = [
    ...(thread ?? []),
    ...(conversation ?? []).filter((c) => answersKey(c.body, item.key)),
  ];
  return {
    answers: candidates
      .filter((c) => isAnswer(c, after))
      .map(({ author, at, url, body }) => ({ author, at, url, body })),
    complete: thread !== null && conversation !== null,
  };
}

/**
 * The answers to each parked item of pull request `pr`, the items still
 * waiting, and of those the ones not every place an answer could be was read
 * for (`unread`); `unreadable` names the item none of whose comments could be
 * read. `repo` (`owner/name`) names the repository; without it, the current
 * directory's.
 */
export async function parkAnswers(
  pr: number,
  parked: readonly ParkedItem[],
  repo?: string,
): Promise<
  | { answered: PendingVerdict[]; waiting: ParkedItem[]; unread: ParkedItem[] }
  | { unreadable: string }
> {
  const conversation = await prComments(String(pr), repo);
  const answered: PendingVerdict[] = [];
  const waiting: ParkedItem[] = [];
  const unread: ParkedItem[] = [];
  for (const item of parked) {
    const read = await answersTo(item, conversation);
    if (read === null) return { unreadable: `${item.kind} ${item.key}` };
    if (read.answers.length > 0)
      answered.push({
        kind: item.kind,
        key: item.key,
        reason: item.reason,
        answers: read.answers,
      });
    else {
      waiting.push(item);
      if (!read.complete) unread.push(item);
    }
  }
  return { answered, waiting, unread };
}

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
  const { answered, waiting, unread } = found;
  if (waiting.length === 0) return answered;
  // At the wide level, the unanswered items a provisional decision may take:
  // only once every place a person's answer could be was read, since an
  // answer in an unread one must never be decided over.
  if (unread.length > 0) {
    console.error(
      `re-arm: could not read every place an answer to ${unread.map((p) => `${p.kind} ${p.key}`).join(", ")} could be; nothing is unparked, and nothing is decided provisionally.`,
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
  const parkedAt = new Map(state.parked.map((p) => [p.key, p.at ?? ""]));
  const res = await run(
    tsArgv(driveState, [
      "unpark",
      pr,
      "--every",
      ...fresh.flatMap((v) => [
        "--key",
        v.key,
        "--parked-at",
        parkedAt.get(v.key) ?? "",
      ]),
    ]),
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  if (res.code !== 0)
    return recoverFailedUnpark(pr, res.code, carried, fresh, file);
  await announceUnparked(pr, fresh, file);
  return rearmNotice([...carried, ...fresh], file);
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
): Promise<boolean> {
  const res = await run(tsArgv(driveState, ["record-event", pr]), {
    stdin: JSON.stringify({ kind, cause }),
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
  now: Date,
): string | null {
  const park = state.quotaPark;
  if (park === null) return null;
  if (park.resetAt !== null && Date.parse(park.resetAt) <= now.getTime())
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

function clip(text: string, max: number, why: string): string {
  return text.length > max ? `${text.slice(0, max)}… (cut; ${why})` : text;
}

/**
 * The notice for `verdicts`; `''` for none. Every item keeps a one-line
 * `[kind] key — url` entry whatever the count; only answer bodies are cut to
 * fit `NOTICE_MAX`, and `file` holds every answer in full.
 */
export function humanVerdictNotice(
  verdicts: readonly PendingVerdict[],
  file: string,
): string {
  if (verdicts.length === 0) return "";
  const head = [
    "RE-ARMED WITH HUMAN ANSWERS: every parked item was answered by an owner, member or collaborator after it was parked, and is unparked.",
    "Treat each answer as a person's verdict on its item: act on it this round, reply with the outcome it leads to, and resolve or hold as usual.",
    `Every answer in full: ${file}`,
  ];
  const entries = verdicts.map((v) => ({
    entry: `- [${v.kind}] ${v.key} — ${v.answers[0]?.url ?? "(no url)"} — parked: ${clip(v.reason, REASON_MAX, "see the thread")}`,
    answers: v.answers.map((a) => ({
      line: `  answered by ${a.author} at ${a.at} (${a.url}):`,
      body: a.body,
    })),
  }));
  // Each answer's body is at least the cut note; what is left is shared out
  // in order.
  const floor = indent(CUT).length + 1;
  const skeleton = [
    ...head,
    ...entries.flatMap((e) => [e.entry, ...e.answers.map((a) => a.line)]),
  ].join("\n").length;
  let room = NOTICE_MAX - skeleton - floor * answerCount(entries);
  const lines = [...head];
  for (const e of entries) {
    lines.push(e.entry);
    for (const a of e.answers) {
      const body = fitBody(a.body, floor + Math.max(0, room));
      room -= body.length + 1 - floor;
      lines.push(a.line, body);
    }
  }
  return lines.join("\n");
}

const CUT = "… (cut; read the rest at the url or in the file named above)";

function indent(body: string): string {
  return body
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function answerCount(entries: ReadonlyArray<{ answers: unknown[] }>): number {
  return entries.reduce((n, e) => n + e.answers.length, 0);
}

/** `body` indented, cut to at most `ANSWER_BODY_MAX` characters and `max` in all. */
function fitBody(body: string, max: number): string {
  if (body.length <= ANSWER_BODY_MAX && indent(body).length + 1 <= max)
    return indent(body);
  let n = Math.min(ANSWER_BODY_MAX, body.length);
  let out = indent(`${body.slice(0, n)}${CUT}`);
  while (n > 0 && out.length + 1 > max) {
    n = Math.max(0, n - (out.length + 1 - max));
    out = indent(`${body.slice(0, n)}${CUT}`);
  }
  return out;
}

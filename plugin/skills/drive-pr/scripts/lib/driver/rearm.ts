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
 *     `answer <key>: …` — the re-arm unparks them all and hands the answers to
 *     the first round as human verdicts. With any item unanswered nothing is
 *     unparked, and the drive stops `HITL_PARKED` at its first gate as
 *     before. A comment the drive itself writes (one opening with an outcome
 *     token, or carrying a hidden marker) is never read as an answer, and a
 *     pull-request comment counts only in the stated `answer <key>:` form:
 *     the drive posts with the operator's own credentials, so a comment that
 *     merely mentions a parked key must not unpark it.
 */
import { shellQuote } from "./../cli.ts";

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

import { swallow } from "../../../../../shared/errors.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";

import { driveState } from "./paths.ts";

import { QUOTA_PARKED_EXIT } from "./settings.ts";

/** The longest answer body handed to the first pass; the url carries the rest. */
const ANSWER_BODY_MAX = 1500;

/** The longest notice the first pass is handed, whatever the number of answers. */
const NOTICE_MAX = 16_000;

/** The canonical arm command, in the drive's own mode, for a person to copy. */
export function armCommand(
  driveTs: string,
  pr: string,
  botsOnly: boolean,
  extra = "",
): string {
  const mode = botsOnly ? " --bots-only" : "";
  return `bun ${shellQuote(driveTs)} ${pr}${extra}${mode} -- claude -p "/jig:drive-pr${mode} ${pr}"`;
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
  ])
    console.error(line);
  return QUOTA_PARKED_EXIT;
}

interface Answer {
  author: string;
  at: string;
  url: string;
  body: string;
}

interface CommentLike {
  author: string;
  association: string;
  at: string;
  url: string;
  body: string;
}

/** A pull-request comment answers a parked key only with a line `answer <key>:`. */
export function answersKey(body: string, key: string): boolean {
  const prefix = `answer ${key}:`.toLowerCase();
  return body
    .split("\n")
    .some((line) => line.trim().toLowerCase().startsWith(prefix));
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
  "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved comments(last:100){nodes{url author{login} authorAssociation createdAt body}}}}}";

async function threadComments(key: string): Promise<CommentLike[] | null> {
  const res = await ghCall(
    ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${key}`],
    { stderr: "pipe", env: ghRepoEnv() },
  );
  if (res.code !== 0) return null;
  let at: unknown = parseJson(res.stdout, "the thread query");
  for (const key of ["data", "node", "comments", "nodes"])
    at = isRecord(at) ? at[key] : undefined;
  if (!Array.isArray(at)) return null;
  return at.filter(isRecord).map((n) => ({
    author: isRecord(n.author) ? text(n.author.login) : "",
    association: text(n.authorAssociation),
    at: text(n.createdAt),
    url: text(n.url),
    body: text(n.body),
  }));
}

async function prComments(pr: string): Promise<CommentLike[] | null> {
  const res = await ghCall(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`,
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

/** The answers to one parked item; `null` when its comments could not be read. */
async function answersTo(
  item: ParkedItem,
  conversation: CommentLike[] | null,
): Promise<Answer[] | null> {
  if (item.at === undefined) return [];
  const after = Date.parse(item.at);
  const thread = item.kind === "thread" ? await threadComments(item.key) : [];
  if (thread === null && conversation === null) return null;
  const candidates = [
    ...(thread ?? []),
    ...(conversation ?? []).filter((c) => answersKey(c.body, item.key)),
  ];
  return candidates
    .filter((c) => isAnswer(c, after))
    .map(({ author, at, url, body }) => ({ author, at, url, body }));
}

/**
 * Unpark every parked item once all of them are answered, and return the
 * notice that hands the answers to the first round; `''` when nothing was
 * unparked (no parks, an unanswered item, or a read that failed).
 */
export async function admitAnsweredParks(
  state: DriveState,
  dryRun: boolean,
): Promise<string> {
  if (state.parked.length === 0) return "";
  const pr = String(state.pr);
  const conversation = await prComments(pr);
  const answered: Array<{ item: ParkedItem; answers: Answer[] }> = [];
  const waiting: string[] = [];
  for (const item of state.parked) {
    const answers = await answersTo(item, conversation);
    if (answers === null) {
      console.error(
        `re-arm: could not read the comments that would answer parked ${item.kind} ${item.key}; leaving every item parked.`,
      );
      return "";
    }
    if (answers.length === 0) waiting.push(`${item.kind} ${item.key}`);
    else answered.push({ item, answers });
  }
  if (waiting.length > 0) {
    console.error(
      `re-arm: ${answered.length} of ${state.parked.length} parked item(s) answered; still waiting on ${waiting.join(", ")}. Nothing is unparked until every one is.`,
    );
    return "";
  }
  if (dryRun) {
    console.error(
      `(dry-run) re-arm would unpark ${answered.length} answered item(s) and hand the answers to the first round.`,
    );
    return "";
  }
  for (const { item } of answered) {
    const res = await run(
      tsArgv(driveState, ["unpark", pr, "--key", item.key]),
      {
        stderr: "inherit",
        timeoutSec: helperTimeoutSeconds(),
      },
    );
    if (res.code !== 0) {
      console.error(
        `re-arm: could not unpark ${item.key} (drive-state.ts exited ${res.code}); the drive keeps its parks.`,
      );
      return "";
    }
  }
  console.error(
    `re-arm: every parked item on PR #${pr} is answered — unparked ${answered.length} and handing the answers to the first round as human verdicts.`,
  );
  return humanVerdictNotice(answered);
}

function humanVerdictNotice(
  answered: Array<{ item: ParkedItem; answers: Answer[] }>,
): string {
  const lines = [
    "RE-ARMED WITH HUMAN ANSWERS: every parked item was answered by an owner, member or collaborator after it was parked, and is unparked.",
    "Treat each answer as a person's verdict on its item: act on it this round, reply with the outcome it leads to, and resolve or hold as usual.",
  ];
  for (const { item, answers } of answered) {
    lines.push(`- [${item.kind}] ${item.key} — parked: ${item.reason}`);
    for (const a of answers) {
      const body =
        a.body.length > ANSWER_BODY_MAX
          ? `${a.body.slice(0, ANSWER_BODY_MAX)}… (cut; read the rest at the url)`
          : a.body;
      lines.push(`  answered by ${a.author} at ${a.at} (${a.url}):`);
      for (const line of body.split("\n")) lines.push(`    ${line}`);
    }
  }
  const notice = lines.join("\n");
  return notice.length > NOTICE_MAX
    ? `${notice.slice(0, NOTICE_MAX)}\n… (cut; read the remaining answers on the pull request)`
    : notice;
}

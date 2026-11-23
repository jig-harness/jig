/** Read every place an answer can be, then classify it through one parser. */
import { ghCall, ghRepoEnv } from "../proc.ts";
import { ghRepoEnvFor } from "../../../../../shared/gh-repo-env.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { currentMs, parseMs } from "../../../../../shared/time.ts";
import type { OutboundFailure } from "../../../../../shared/outbound/failure.ts";
import { ghRunFailure } from "../../../../../shared/outbound/github.ts";
import type { ParkedItem } from "../state/schema.ts";
import type { PendingAnswer, PendingVerdict } from "../state/pass-handoff.ts";
import {
  type CommentLike,
  disputedAnswers,
  latestAnswers,
  parseAnswerComment,
  noteWithoutAnswer,
  answerTime,
  answerDecision,
} from "../answer-forms.ts";

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    swallow(err, "the answer comment query returned no JSON");
    return null;
  }
}
const THREAD_QUERY =
  "query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved comments(first:100){pageInfo{hasNextPage} nodes{url author{login} authorAssociation createdAt lastEditedAt body}}}}}";

/** A complete review-thread read, including its current resolution state. */
export interface ThreadComments {
  comments: CommentLike[];
  isResolved: boolean | null;
}

/** Decode a complete thread response without silently losing evidence. */
export function parseThreadComments(value: unknown): ThreadComments | null {
  let node = value;
  for (const key of ["data", "node"])
    node = isRecord(node) ? node[key] : undefined;
  const comments = isRecord(node) ? node.comments : undefined;
  if (
    !isRecord(node) ||
    !isRecord(comments) ||
    !isRecord(comments.pageInfo) ||
    comments.pageInfo.hasNextPage !== false ||
    !Array.isArray(comments.nodes)
  )
    return null;
  const parsed: CommentLike[] = [];
  for (const comment of comments.nodes) {
    if (
      !isRecord(comment) ||
      typeof comment.url !== "string" ||
      !isRecord(comment.author) ||
      typeof comment.author.login !== "string" ||
      typeof comment.authorAssociation !== "string" ||
      typeof comment.createdAt !== "string" ||
      typeof comment.body !== "string" ||
      Number.isNaN(parseMs(comment.createdAt)) ||
      (comment.lastEditedAt !== null &&
        (typeof comment.lastEditedAt !== "string" ||
          Number.isNaN(parseMs(comment.lastEditedAt))))
    )
      return null;
    parsed.push({
      author: comment.author.login,
      association: comment.authorAssociation,
      at: comment.createdAt,
      editedAt: comment.lastEditedAt,
      url: comment.url,
      body: comment.body,
    });
  }
  return {
    isResolved: typeof node.isResolved === "boolean" ? node.isResolved : null,
    comments: parsed,
  };
}

/**
 * A review thread's comments; `null` when they did not read, the failed
 * call's class told to `failed`. An incomplete thread can hide a dispute,
 * so never certify its answers.
 *
 * A node-id query names no repository, so a caller that runs outside the
 * pull request's checkout passes `repo` (`owner/name`): it goes to the forge
 * client as `GH_REPO`, where the account-routing wrapper and the governed
 * quota find which owner the call is for. Without it the call runs as the
 * default login, which cannot see another owner's private repository.
 */
export async function threadComments(
  key: string,
  timeoutSec?: number,
  failed?: (failure: OutboundFailure) => void,
  repo?: string,
): Promise<ThreadComments | null> {
  const began = currentMs();
  const res = await ghCall(
    ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${key}`],
    {
      stderr: "pipe",
      env: repo === undefined ? ghRepoEnv() : ghRepoEnvFor(repo),
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    },
  );
  if (res.code !== 0) {
    const failure = ghRunFailure(res, currentMs() - began);
    if (failure !== null) failed?.(failure);
    return null;
  }
  return parseThreadComments(json(res.stdout));
}

/**
 * The pull request's conversation, read fresh (`paged-read.ts`): what it
 * says re-arms a drive on a person's answer or reverses a provisional ruling.
 */
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
  const pages = json(res.stdout);
  return Array.isArray(pages) ? conversationOf(pages.flat()) : null;
}

export function conversationOf(listing: readonly unknown[]): CommentLike[] {
  return listing.filter(isRecord).map((c) => ({
    author: isRecord(c.user) ? text(c.user.login) : "",
    association: text(c.author_association),
    at: text(c.created_at),
    editedAt: typeof c.updated_at === "string" ? c.updated_at : null,
    url: text(c.html_url),
    body: text(c.body),
  }));
}

export interface ParkDispute {
  item: ParkedItem;
  answers: PendingAnswer[];
}
export interface ParkNote {
  item: ParkedItem;
  author: string;
  at: string;
  url: string;
  note: string;
}
export type ParkAnswersResult =
  | {
      answered: PendingVerdict[];
      partial: PendingVerdict[];
      waiting: ParkedItem[];
      unread: ParkedItem[];
      disputed: ParkDispute[];
      stale: ParkDispute[];
      responded: ParkedItem[];
      /** Each item with any answer, with every person's latest answer to it, stale ones included. */
      responses: ParkDispute[];
      notes: ParkNote[];
      /** Thread parks a person already resolved without leaving an answer. */
      resolved: ParkedItem[];
    }
  | { unreadable: string };

type ReadParkAnswers = Exclude<ParkAnswersResult, { unreadable: string }>;

/** The same parser serves each source, without dropping a person's whole comment. */
function sourceAnswers(
  item: ParkedItem,
  comments: readonly CommentLike[],
  place: "thread" | "conversation",
): PendingAnswer[] {
  return comments.flatMap((c) => {
    const answer = parseAnswerComment(item, c, place);
    return answer === null ? [] : [answer];
  });
}

function sourceNotes(
  item: ParkedItem,
  comments: readonly CommentLike[],
): ParkNote[] {
  return comments.flatMap((c) => {
    const note = noteWithoutAnswer(item, c);
    return note === null
      ? []
      : [{ item, author: c.author, at: answerTime(c), url: c.url, note }];
  });
}

function verdictOf(item: ParkedItem, answers: PendingAnswer[]): PendingVerdict {
  const decision = answerDecision(item);
  return {
    kind: item.kind,
    key: item.key,
    reason: item.reason,
    answers,
    ...(decision === undefined ? {} : { decision }),
    ...(item.digest === undefined ? {} : { digest: item.digest }),
  };
}

/** Classify one complete or partial history, preserving evidence that blocks provisional work. */
function classifyPark(
  result: ReadParkAnswers,
  item: ParkedItem,
  answers: PendingAnswer[],
  incomplete: boolean,
  resolved: boolean,
  hasNotes: boolean,
): void {
  if (answers.length > 0) {
    result.responded.push(item);
    result.responses.push({ item, answers });
  }
  const verdict = verdictOf(item, answers);
  const stale = answers.filter((a) => a.stale === true);
  if (stale.length > 0) result.stale.push({ item, answers: stale });
  const disputed = disputedAnswers(answers);
  if (disputed) result.disputed.push({ item, answers });
  // Resolution is sufficient only where it does not erase an answer, dispute
  // or condition note. Those still need the ordinary answer safeguards.
  if (resolved && answers.length === 0 && !incomplete && !hasNotes) {
    result.resolved.push(item);
    return;
  }
  if (incomplete) {
    result.unread.push(item);
    if (answers.length > 0) result.partial.push(verdict);
  }
  // A condition note from someone who did not answer is not in the verdict
  // handed on, so the item keeps waiting rather than losing it.
  if (
    answers.length > 0 &&
    stale.length === 0 &&
    !disputed &&
    !incomplete &&
    !hasNotes
  )
    result.answered.push(verdict);
  else result.waiting.push(item);
}

type ThreadLoader = (
  key: string,
) => Promise<ThreadComments | CommentLike[] | null>;

async function loadParkThread(
  item: ParkedItem,
  loader: ThreadLoader,
): Promise<ThreadComments | null> {
  if (item.kind !== "thread") return { comments: [], isResolved: false };
  const loaded = await loader(item.key);
  return Array.isArray(loaded)
    ? { comments: loaded, isResolved: false }
    : loaded;
}

/** The optional loader lets read-only commands keep their deadline/cache policy. */
export async function parkAnswers(
  pr: number,
  parked: readonly ParkedItem[],
  repo?: string,
  listing?: readonly unknown[],
  loaders: {
    acceptResolvedThreads?: boolean;
    /** Arrays are accepted for callers from before resolution state was read; they never certify resolution. */
    threadComments?: ThreadLoader;
  } = {},
): Promise<ParkAnswersResult> {
  const conversation =
    listing === undefined
      ? await prComments(String(pr), repo)
      : conversationOf(listing);
  const result: ReadParkAnswers = {
    answered: [],
    partial: [],
    waiting: [],
    unread: [],
    disputed: [],
    stale: [],
    responded: [],
    responses: [],
    notes: [],
    resolved: [],
  };
  const loadThread =
    loaders.threadComments ??
    ((key) => threadComments(key, undefined, undefined, repo));
  const pullComments = conversation ?? [];
  for (const item of parked) {
    const thread = await loadParkThread(item, loadThread);
    if (thread === null && conversation === null)
      return { unreadable: `${item.kind} ${item.key}` };
    const threadHistory = thread?.comments ?? [];
    const answers = latestAnswers([
      ...sourceAnswers(item, threadHistory, "thread"),
      ...sourceAnswers(item, pullComments, "conversation"),
    ]);
    if (
      loaders.acceptResolvedThreads &&
      thread?.isResolved === null &&
      answers.length === 0
    )
      return {
        unreadable: `thread ${item.key} (GitHub did not report its resolution status)`,
      };
    const notes = sourceNotes(item, [...threadHistory, ...pullComments]);
    result.notes.push(...notes);
    classifyPark(
      result,
      item,
      answers,
      item.at === undefined || thread === null || conversation === null,
      loaders.acceptResolvedThreads === true && thread?.isResolved === true,
      notes.length > 0,
    );
  }
  return result;
}

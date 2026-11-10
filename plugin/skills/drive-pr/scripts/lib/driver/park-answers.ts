/** Read every place an answer can be, then classify it through one parser. */
import { ghCall, ghRepoEnv } from "../proc.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { swallow } from "../../../../../shared/errors.ts";
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

/** An incomplete thread can hide a dispute, so never certify its answers. */
export async function threadComments(
  key: string,
  timeoutSec?: number,
): Promise<CommentLike[] | null> {
  const res = await ghCall(
    ["api", "graphql", "-f", `query=${THREAD_QUERY}`, "-f", `id=${key}`],
    {
      stderr: "pipe",
      env: ghRepoEnv(),
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    },
  );
  if (res.code !== 0) return null;
  let comments = json(res.stdout);
  for (const key of ["data", "node", "comments"])
    comments = isRecord(comments) ? comments[key] : undefined;
  if (
    !isRecord(comments) ||
    !isRecord(comments.pageInfo) ||
    comments.pageInfo.hasNextPage !== false ||
    !Array.isArray(comments.nodes)
  )
    return null;
  return comments.nodes.filter(isRecord).map((n) => ({
    author: isRecord(n.author) ? text(n.author.login) : "",
    association: text(n.authorAssociation),
    at: text(n.createdAt),
    editedAt: typeof n.lastEditedAt === "string" ? n.lastEditedAt : null,
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
      waiting: ParkedItem[];
      unread: ParkedItem[];
      disputed: ParkDispute[];
      responded: ParkedItem[];
      notes: ParkNote[];
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

/** Classify one complete or partial history, preserving evidence that blocks provisional work. */
function classifyPark(
  result: ReadParkAnswers,
  item: ParkedItem,
  answers: PendingAnswer[],
  incomplete: boolean,
): void {
  if (answers.length > 0) result.responded.push(item);
  const disputed = disputedAnswers(answers);
  if (disputed) result.disputed.push({ item, answers });
  if (incomplete) result.unread.push(item);
  const decision = answerDecision(item);
  if (answers.length > 0 && !disputed && !incomplete)
    result.answered.push({
      kind: item.kind,
      key: item.key,
      reason: item.reason,
      answers,
      ...(decision === undefined ? {} : { decision }),
    });
  else result.waiting.push(item);
}

/** The optional loader lets read-only commands keep their deadline/cache policy. */
export async function parkAnswers(
  pr: number,
  parked: readonly ParkedItem[],
  repo?: string,
  listing?: readonly unknown[],
  loaders: {
    threadComments?: (key: string) => Promise<CommentLike[] | null>;
  } = {},
): Promise<ParkAnswersResult> {
  const conversation =
    listing === undefined
      ? await prComments(String(pr), repo)
      : conversationOf(listing);
  const result: ReadParkAnswers = {
    answered: [],
    waiting: [],
    unread: [],
    disputed: [],
    responded: [],
    notes: [],
  };
  for (const item of parked) {
    const thread =
      item.kind === "thread"
        ? await (loaders.threadComments ?? threadComments)(item.key)
        : [];
    if (thread === null && conversation === null)
      return { unreadable: `${item.kind} ${item.key}` };
    const answers = latestAnswers([
      ...sourceAnswers(item, thread ?? [], "thread"),
      ...sourceAnswers(item, conversation ?? [], "conversation"),
    ]);
    result.notes.push(
      ...sourceNotes(item, [...(thread ?? []), ...(conversation ?? [])]),
    );
    classifyPark(
      result,
      item,
      answers,
      item.at === undefined || thread === null || conversation === null,
    );
  }
  return result;
}

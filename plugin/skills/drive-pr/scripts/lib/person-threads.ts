/**
 * A person's review thread binds the drive. A fix for a bot's finding may not
 * undo, narrow or contradict what a person asked for or settled in another
 * thread of the same pull request, open or resolved (the triage rubric's
 * guardrails). A pass triages only the unresolved threads it lists, and a
 * person's thread that was answered and resolved carries no outcome token for
 * the reversal check to find. So `triage-thread.ts` refuses a fresh `accepted`
 * reply to a bot's thread whose file carries a person's thread, until the
 * review arbiter's `fix-now` ruling on that bot thread is recorded
 * (`drive-state.ts rule`).
 *
 * A person's thread is one a person started or commented on. A person's
 * comment comes from an owner, member or collaborator and carries no hidden
 * marker (`isPersonsComment`). After a thread's opening comment, one that
 * opens with an outcome token and comes from the login the drive posts as
 * (the query's `viewer`) is the drive's own reply, not a person's word; the
 * same token from another login is a person's verdict. A person who shares
 * the drive's login is indistinguishable from it, a limit of the forge's
 * identity. The arbiter's `fix-now` ruling lifts the refusal only while no
 * person has spoken on the file since it was recorded. Every read goes
 * through `ghCall` under its deadline, and a read that fails or does not
 * parse whole refuses, since the absence of a person's thread is
 * established, never assumed.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { attempt } from "../../../../shared/outcome.ts";
import { fail } from "./cli.ts";
import { readDriveState } from "./driver/rearm.ts";
import { qualifyingOutcome } from "./outcome.ts";
import { ghCall } from "./proc.ts";
import { isPersonsComment } from "./provisional.ts";

/** The refusal's exit code, listed in `triage-thread.ts`'s header. */
export const PERSON_THREAD_EXIT = 5;

/** Pages read before the check gives up and refuses: 1,000 threads. */
const MAX_PAGES = 20;

const PAGE_QUERY = `query($id:ID!, $after:String){
  viewer{ login }
  node(id:$id){
    ... on PullRequestReviewThread{
      path
      pullRequest{
        reviewThreads(first:50, after:$after){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id path line isResolved
            comments(first:100){ pageInfo{ hasNextPage } nodes{ url createdAt author{ login __typename } authorAssociation body } }
          }
        }
      }
    }
  }
}`;

export interface ThreadComment {
  login: string;
  type: string;
  association: string;
  body: string;
  /** When it was posted, ISO 8601. */
  at: string;
  /** Its permalink. */
  url: string;
}

/** A review thread of the pull request, as the page query reads it. */
export interface ReviewThread {
  id: string;
  path: string | null;
  line: number | null;
  isResolved: boolean;
  /** More than 100 comments: a person's later word may be past the window. */
  truncated: boolean;
  comments: ThreadComment[];
}

/** What a person said on one thread, for the arbiter to weigh. */
export interface PersonThread {
  id: string;
  /** The permalink of the thread's opening comment. */
  url: string;
  line: number | null;
  isResolved: boolean;
  truncated: boolean;
  words: ThreadComment[];
}

/**
 * A person's comments on `t`, in order. `viewer` is the login the drive posts
 * as: its outcome replies are not a person's words.
 */
export function personsWords(t: ReviewThread, viewer: string): ThreadComment[] {
  return t.comments.filter(
    (c, i) =>
      c.type === "User" &&
      isPersonsComment(c.association, c.body) &&
      (i === 0 || c.login !== viewer || qualifyingOutcome(c.body) === null),
  );
}

/** Whether `c` was posted after `since`; a time that does not parse is after. */
function postedAfter(c: ThreadComment, since: string): boolean {
  const at = Date.parse(c.at);
  const bound = Date.parse(since);
  return Number.isNaN(at) || Number.isNaN(bound) || at > bound;
}

/**
 * The threads on `path`, other than `self`, that a person spoke on, or whose
 * comments could not all be read. `self`'s own comments are already in front
 * of the pass that triages it, a person's answer to its park included. With
 * `since`, only words posted after that time count, so a ruling recorded
 * then has weighed everything older.
 */
export function personThreadsOn(
  threads: readonly ReviewThread[],
  self: string,
  path: string,
  viewer: string,
  since?: string,
): PersonThread[] {
  return threads
    .filter((t) => t.id !== self && t.path === path)
    .map((t) => ({
      id: t.id,
      url: t.comments[0]?.url ?? "",
      line: t.line,
      isResolved: t.isResolved,
      truncated: t.truncated,
      words: personsWords(t, viewer).filter(
        (c) => since === undefined || postedAfter(c, since),
      ),
    }))
    .filter((p) => p.truncated || p.words.length > 0);
}

/** One comment, or `null` when any field the check reads is missing. */
function commentFrom(raw: unknown): ThreadComment | null {
  if (!isRecord(raw)) return null;
  const { author, authorAssociation, body, createdAt, url } = raw;
  if (
    typeof authorAssociation !== "string" ||
    typeof body !== "string" ||
    typeof createdAt !== "string" ||
    typeof url !== "string"
  )
    return null;
  // A deleted account has no author; it is no person.
  const who = isRecord(author) ? author : {};
  return {
    login: typeof who.login === "string" ? who.login : "",
    type: typeof who.__typename === "string" ? who.__typename : "",
    association: authorAssociation,
    body,
    at: createdAt,
    url,
  };
}

/** One thread, or `null` when it does not read whole. */
function threadFrom(raw: unknown): ReviewThread | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  if (typeof raw.path !== "string") return null;
  if (typeof raw.isResolved !== "boolean" || !isRecord(raw.comments))
    return null;
  const { nodes, pageInfo } = raw.comments;
  if (!Array.isArray(nodes)) return null;
  const comments = nodes.map(commentFrom);
  if (comments.some((c) => c === null)) return null;
  return {
    id: raw.id,
    path: raw.path,
    line: typeof raw.line === "number" ? raw.line : null,
    isResolved: raw.isResolved,
    truncated: !isRecord(pageInfo) || pageInfo.hasNextPage !== false,
    comments: comments as ThreadComment[],
  };
}

interface Page {
  path: string | null;
  viewer: string;
  threads: ReviewThread[];
  endCursor: string | null;
}

/** One page of the query's answer, or `null` when any part does not read. */
export function pageFrom(stdout: string): Page | null {
  const read = attempt("unreadable", "the review threads", (): unknown =>
    JSON.parse(stdout),
  );
  if (!read.ok) return null;
  const parsed = read.value;
  const data = isRecord(parsed) ? parsed.data : undefined;
  const node = isRecord(data) ? data.node : undefined;
  const viewer =
    isRecord(data) && isRecord(data.viewer) ? data.viewer.login : "";
  if (typeof viewer !== "string" || viewer === "") return null;
  if (!isRecord(node) || !isRecord(node.pullRequest)) return null;
  const conn = node.pullRequest.reviewThreads;
  if (!isRecord(conn) || !isRecord(conn.pageInfo) || !Array.isArray(conn.nodes))
    return null;
  const threads = conn.nodes.map(threadFrom);
  if (threads.some((t) => t === null)) return null;
  const more = conn.pageInfo.hasNextPage;
  const cursor = conn.pageInfo.endCursor;
  if (more === true && (typeof cursor !== "string" || cursor === ""))
    return null;
  if (more !== true && more !== false) return null;
  return {
    path: typeof node.path === "string" ? node.path : null,
    viewer,
    threads: threads as ReviewThread[],
    endCursor: more ? (cursor as string) : null,
  };
}

/**
 * `threadId`'s file and every review thread of its pull request, or `null`
 * when a read fails. Each page is one `ghCall` under its own deadline.
 */
async function readThreads(threadId: string): Promise<{
  path: string | null;
  viewer: string;
  threads: ReviewThread[];
} | null> {
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ["api", "graphql", "-f", `query=${PAGE_QUERY}`];
    args.push("-f", `id=${threadId}`);
    if (after !== null) args.push("-f", `after=${after}`);
    const r = await ghCall(args, { stderr: "inherit" });
    if (r.code !== 0) return null;
    const read = pageFrom(r.stdout);
    if (read === null) return null;
    threads.push(...read.threads);
    if (read.endCursor === null)
      return { path: read.path, viewer: read.viewer, threads };
    after = read.endCursor;
  }
  return null;
}

/** A comment's whole text on one line: the arbiter weighs the qualifications at its end. */
const whole = (body: string): string =>
  JSON.stringify(body.replace(/\s+/g, " ").trim());

/** The refusal, naming each person's thread and what the pass does next. */
export function refusalLines(
  threadId: string,
  path: string,
  persons: readonly PersonThread[],
): string[] {
  return [
    `triage-thread.ts: ${threadId} is a bot's finding on ${path}, where a person spoke in another review thread:`,
    ...persons.map((p) => {
      const at = `${p.isResolved ? "resolved" : "open"} thread ${p.id}${p.url === "" ? "" : ` (${p.url})`} at ${path}${p.line === null ? "" : `:${p.line}`}`;
      const said = p.words.map((w) => `${w.login}: ${whole(w.body)}`);
      if (p.truncated)
        said.push("more than 100 comments, read it on the pull request");
      return `  - ${at}: ${said.join("; ")}`;
    }),
    "A fix never overrules a person's thread, open or resolved (the triage rubric's guardrails).",
    "Hand this finding and the threads above, with their ids, links and full text, to the review arbiter, record its ruling with drive-state.ts rule (SKILL.md § 4), and act on it:",
    "fix-now lets this accepted reply post; rejected is answered **rejected**, citing the person's thread; escalate parks the thread under its class.",
  ];
}

/**
 * `triage-thread.ts`, before a fresh reply with `outcome` on `thread`:
 * refuse an `accepted` one to a bot's thread while another thread on its
 * file is a person's, unless the arbiter's ruling recorded for it is
 * `fix-now` and no person has spoken on the file since it was recorded. A thread a person started is never checked: the pass carries
 * out their request.
 */
export async function refuseOverrulingPersonThread(
  threadId: string,
  pr: string,
  outcome: string,
  thread: { confirmedHumanStarted: boolean },
): Promise<void> {
  if (outcome !== "accepted" || thread.confirmedHumanStarted) return;
  const state = await readDriveState(pr);
  const ruledAt = (state?.rulings ?? []).find(
    (r) => r.key === threadId && r.verdict === "fix-now",
  )?.at;
  const read = await readThreads(threadId);
  if (read === null || read.path === null)
    fail(
      1,
      `triage-thread.ts: could not read the review threads of ${threadId}'s pull request, so whether a person's thread shares its file is unknown; refusing to post an accepted reply without that check.`,
    );
  const persons = personThreadsOn(
    read.threads,
    threadId,
    read.path,
    read.viewer,
    ruledAt,
  );
  if (persons.length > 0)
    fail(PERSON_THREAD_EXIT, ...refusalLines(threadId, read.path, persons));
}

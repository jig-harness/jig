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
 * comment comes from an owner, member or collaborator, carries no hidden
 * marker (`isPersonsComment`), and, after a thread's opening comment, opens
 * with no outcome token: the drive's own replies always open with one. Every
 * read goes through `ghCall` under its deadline, and a read that fails
 * refuses, since the absence of a person's thread is established, never
 * assumed.
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
  node(id:$id){
    ... on PullRequestReviewThread{
      path
      pullRequest{
        reviewThreads(first:50, after:$after){
          pageInfo{ hasNextPage endCursor }
          nodes{
            id path line isResolved
            comments(first:100){ pageInfo{ hasNextPage } nodes{ author{ login __typename } authorAssociation body } }
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
  line: number | null;
  isResolved: boolean;
  truncated: boolean;
  words: ThreadComment[];
}

/** A person's comments on `t`, in order. */
export function personsWords(t: ReviewThread): ThreadComment[] {
  return t.comments.filter(
    (c, i) =>
      c.type === "User" &&
      isPersonsComment(c.association, c.body) &&
      (i === 0 || qualifyingOutcome(c.body) === null),
  );
}

/**
 * The threads on `path`, other than `self`, that a person spoke on, or whose
 * comments could not all be read. `self`'s own comments are already in front
 * of the pass that triages it, a person's answer to its park included.
 */
export function personThreadsOn(
  threads: readonly ReviewThread[],
  self: string,
  path: string,
): PersonThread[] {
  return threads
    .filter((t) => t.id !== self && t.path === path)
    .map((t) => ({
      line: t.line,
      isResolved: t.isResolved,
      truncated: t.truncated,
      words: personsWords(t),
    }))
    .filter((p) => p.truncated || p.words.length > 0);
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function threadFrom(raw: unknown): ReviewThread | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  if (typeof raw.isResolved !== "boolean" || !isRecord(raw.comments))
    return null;
  const { nodes, pageInfo } = raw.comments;
  if (!Array.isArray(nodes)) return null;
  return {
    id: raw.id,
    path: typeof raw.path === "string" ? raw.path : null,
    line: typeof raw.line === "number" ? raw.line : null,
    isResolved: raw.isResolved,
    truncated: !isRecord(pageInfo) || pageInfo.hasNextPage !== false,
    comments: nodes.map((c) => {
      const node = isRecord(c) ? c : {};
      const author = isRecord(node.author) ? node.author : {};
      return {
        login: text(author.login),
        type: text(author.__typename),
        association: text(node.authorAssociation),
        body: text(node.body),
      };
    }),
  };
}

interface Page {
  path: string | null;
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
    threads: threads as ReviewThread[],
    endCursor: more ? (cursor as string) : null,
  };
}

/**
 * `threadId`'s file and every review thread of its pull request, or `null`
 * when a read fails. Each page is one `ghCall` under its own deadline.
 */
async function readThreads(
  threadId: string,
): Promise<{ path: string | null; threads: ReviewThread[] } | null> {
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
    if (read.endCursor === null) return { path: read.path, threads };
    after = read.endCursor;
  }
  return null;
}

const excerpt = (body: string): string => {
  const line = body.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 300 ? `${line.slice(0, 299)}…` : line);
};

/** The refusal, naming each person's thread and what the pass does next. */
export function refusalLines(
  threadId: string,
  path: string,
  persons: readonly PersonThread[],
): string[] {
  return [
    `triage-thread.ts: ${threadId} is a bot's finding on ${path}, where a person spoke in another review thread:`,
    ...persons.map((p) => {
      const at = `${p.isResolved ? "resolved" : "open"} thread at ${path}${p.line === null ? "" : `:${p.line}`}`;
      const said = p.words.map((w) => `${w.login}: ${excerpt(w.body)}`);
      if (p.truncated)
        said.push("more than 100 comments, read it on the pull request");
      return `  - ${at}: ${said.join("; ")}`;
    }),
    "A fix never overrules a person's thread, open or resolved (the triage rubric's guardrails).",
    "Hand this finding and the threads above to the review arbiter, record its ruling with drive-state.ts rule (SKILL.md § 4), and act on it:",
    "fix-now lets this accepted reply post; rejected is answered **rejected**, citing the person's thread; escalate parks the thread under its class.",
  ];
}

/**
 * `triage-thread.ts`, before a fresh reply with `outcome` on `thread`:
 * refuse an `accepted` one to a bot's thread while another thread on its
 * file is a person's, unless the arbiter's ruling recorded for it is
 * `fix-now`. A thread a person started is never checked: the pass carries
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
  const ruled = (state?.rulings ?? []).some(
    (r) => r.key === threadId && r.verdict === "fix-now",
  );
  if (ruled) return;
  const read = await readThreads(threadId);
  if (read === null || read.path === null)
    fail(
      1,
      `triage-thread.ts: could not read the review threads of ${threadId}'s pull request, so whether a person's thread shares its file is unknown; refusing to post an accepted reply without that check.`,
    );
  const persons = personThreadsOn(read.threads, threadId, read.path);
  if (persons.length > 0)
    fail(PERSON_THREAD_EXIT, ...refusalLines(threadId, read.path, persons));
}

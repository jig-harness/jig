/**
 * Reading and rewriting a pull request's body by read-modify-write against
 * its `updated_at`, so a person's edit to the body is not silently
 * overwritten.
 *
 * The forge has no compare-and-set on a body. The change is built from one
 * read, the body is read again just before the write, and a body that moved
 * in between is rebuilt from the newer read, up to `WRITE_ATTEMPTS` times.
 * That leaves a person's edit at risk only inside one request's latency,
 * not inside a round. After the write the body is read back and the change
 * confirmed in it. Every forge call carries the plugin's `gh` deadline.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { ghCall } from "../../../../shared/proc.ts";
import { TRUSTED_ASSOCIATIONS } from "../../../../shared/trusted-authors.ts";
import { SECTION_ANCHOR } from "./deferred-section.ts";

const WRITE_ATTEMPTS = 3;

/** The forge could not read or write the body, or it kept moving. */
export class PrBodyError extends Error {
  override name = "PrBodyError";
}

export interface PrBody {
  body: string;
  updatedAt: string;
  /** The pull request's web url. */
  url: string;
}

/**
 * A `**deferred**` answer that links the section, so its entry must be there:
 * a resolved review thread's reply, keyed on the thread's first comment, or a
 * summary finding's answer, keyed on the fingerprint its marker carries.
 */
export type DeferredReply =
  | {
      /** The thread's first comment: the source its deferred entry is keyed on. */
      thread: string;
      /** The `**deferred**` reply itself. */
      reply: string;
    }
  | {
      /** The summary finding's fingerprint, from its answer's marker. */
      fingerprint: string;
      /** The `**deferred**` answer comment itself. */
      reply: string;
    };

/**
 * A comment that may answer a finding, as the forge returns it: a reply on a
 * resolved review thread (with the thread's first comment), or a top-level
 * comment on the pull request.
 */
export interface AnswerComment {
  /** The thread's first comment; absent on a top-level comment. */
  thread?: string;
  url: string;
  body: string;
  /** The forge's `author_association` for the comment's author. */
  association: string;
}

/**
 * What the scripts need of the forge: a pull request's body, read and
 * written, and every comment that may answer one of its findings, complete
 * or refused.
 */
export interface PrBodyForge {
  read(pr: string): Promise<PrBody>;
  write(pr: string, body: string): Promise<void>;
  answers(pr: string): Promise<AnswerComment[]>;
}

/** A fingerprint as `answer-summary-finding.ts` writes it into its marker. */
const ADDRESSED_MARKER =
  /<!-- drive-pr-addressed: ([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** A character that continues a url, so a link ending before it is another. */
const URL_CHAR = /[\w/%#?&=+~-]/;

/**
 * Whether `body` links the `## Deferred` section of the pull request at
 * `prUrl`: the exact url and anchor, not part of a longer url on either side.
 */
export function linksSection(body: string, prUrl: string): boolean {
  const link = `${prUrl}#${SECTION_ANCHOR}`;
  for (let i = body.indexOf(link); i !== -1; i = body.indexOf(link, i + 1)) {
    const before = body[i - 1] ?? "";
    const after = body[i + link.length] ?? "";
    if (
      !/[\w/.:]/.test(before) &&
      !URL_CHAR.test(before) &&
      !URL_CHAR.test(after)
    )
      return true;
  }
  return false;
}

/**
 * The answers that defer a finding into the section of the pull request at
 * `prUrl`: a trusted author's comment that opens with `**deferred**` and
 * links that section. A thread reply is keyed on its thread; a top-level
 * answer on each fingerprint its `drive-pr-addressed` markers name. The same
 * shape from anyone else, or linking another section, defers nothing here.
 */
export function deferredReplies(
  answers: AnswerComment[],
  prUrl: string,
): DeferredReply[] {
  return answers
    .filter(
      (a) =>
        TRUSTED_ASSOCIATIONS.has(a.association) &&
        a.body.startsWith("**deferred**") &&
        linksSection(a.body, prUrl),
    )
    .flatMap((a): DeferredReply[] =>
      a.thread !== undefined
        ? [{ thread: a.thread, reply: a.url }]
        : [...a.body.matchAll(ADDRESSED_MARKER)].map((m) => ({
            fingerprint: m[1] ?? "",
            reply: a.url,
          })),
    );
}

/** The review threads, each with its comments' urls, bodies and authors. */
const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) { pageInfo { hasNextPage } nodes { url body authorAssociation } }
        }
      }
    }
  }
}`;

/**
 * Each resolved thread's first comment, whether its comments were cut at the
 * page, and its replies, one JSON object per line. A cut thread is refused
 * whatever its visible replies say: a reply past the page is one the census
 * cannot see.
 */
const THREAD_REPLIES_JQ = `.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved) | {thread: .comments.nodes[0].url, truncated: .comments.pageInfo.hasNextPage, replies: [.comments.nodes[1:][] | {url, body, association: .authorAssociation}]} | @json`;

/** Each top-level comment, one JSON object per line. */
const COMMENTS_JQ = `.[] | {url: .html_url, body: (.body // ""), association: .author_association} | @json`;

/** The JSON lines `gh … --jq` printed, each checked by `ok`. */
function jsonLines<T>(
  raw: string,
  ok: (v: unknown) => v is T,
  why: string,
): T[] {
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const v: unknown = JSON.parse(l);
      if (!ok(v)) throw new PrBodyError(why);
      return v;
    });
}

type Comment = Omit<AnswerComment, "thread">;

const isComment = (v: unknown): v is Comment =>
  isRecord(v) &&
  typeof v.url === "string" &&
  typeof v.body === "string" &&
  typeof v.association === "string";

interface ThreadLine {
  thread: string;
  truncated: boolean;
  replies: Comment[];
}

const isThreadLine = (v: unknown): v is ThreadLine =>
  isRecord(v) &&
  typeof v.thread === "string" &&
  typeof v.truncated === "boolean" &&
  Array.isArray(v.replies) &&
  v.replies.every(isComment);

async function gh(args: string[], stdin?: string): Promise<string> {
  const r = await ghCall(args, {
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (r.timedOut)
    throw new PrBodyError(`gh ${args[0] ?? ""} ran past its deadline`);
  if (r.code !== 0)
    throw new PrBodyError(
      `gh exited ${r.code}: ${r.stderr.trim().split("\n").at(-1) ?? ""}`,
    );
  return r.stdout;
}

/** The forge through the signed-in `gh` client. */
export function ghPrBodyForge(): PrBodyForge {
  return {
    async read(pr) {
      const raw = await gh([
        "api",
        `repos/{owner}/{repo}/pulls/${pr}`,
        "--jq",
        '{body: (.body // ""), updatedAt: .updated_at, url: .html_url}',
      ]);
      const v: unknown = JSON.parse(raw);
      if (
        !isRecord(v) ||
        typeof v.body !== "string" ||
        typeof v.updatedAt !== "string" ||
        typeof v.url !== "string"
      )
        throw new PrBodyError(`pull request #${pr} could not be read`);
      return { body: v.body, updatedAt: v.updatedAt, url: v.url };
    },
    async write(pr, body) {
      await gh(
        [
          "api",
          "--method",
          "PATCH",
          `repos/{owner}/{repo}/pulls/${pr}`,
          "--input",
          "-",
        ],
        JSON.stringify({ body }),
      );
    },
    async answers(pr) {
      const threads = jsonLines(
        await gh([
          "api",
          "graphql",
          "--paginate",
          "-f",
          `query=${THREADS_QUERY}`,
          "-F",
          "owner={owner}",
          "-F",
          "name={repo}",
          "-F",
          `pr=${pr}`,
          "--jq",
          THREAD_REPLIES_JQ,
        ]),
        isThreadLine,
        `pull request #${pr}'s review threads could not be read`,
      );
      const cut = threads.find((t) => t.truncated);
      if (cut !== undefined)
        throw new PrBodyError(
          `${cut.thread} has more than 100 comments, so its **deferred** replies cannot all be read; check that thread's entry by hand`,
        );
      const comments = jsonLines(
        await gh([
          "api",
          "--paginate",
          `repos/{owner}/{repo}/issues/${pr}/comments`,
          "--jq",
          COMMENTS_JQ,
        ]),
        isComment,
        `pull request #${pr}'s comments could not be read`,
      );
      return [
        ...threads.flatMap((t) =>
          t.replies.map((r) => ({ ...r, thread: t.thread })),
        ),
        ...comments,
      ];
    },
  };
}

/**
 * Apply `change` to the pull request's body. `change` returns the new body,
 * or `null` when the body already holds what it would add. `holds` confirms
 * the change in the body read back after the write.
 */
export async function updatePrBody(
  forge: PrBodyForge,
  pr: string,
  change: (body: string) => string | null,
  holds: (body: string) => boolean,
): Promise<{ url: string; changed: boolean }> {
  for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
    const first = await forge.read(pr);
    const next = change(first.body);
    if (next === null) return { url: first.url, changed: false };
    const again = await forge.read(pr);
    if (again.updatedAt !== first.updatedAt || again.body !== first.body)
      continue;
    await forge.write(pr, next);
    const after = await forge.read(pr);
    if (holds(after.body)) return { url: after.url, changed: true };
  }
  throw new PrBodyError(
    `pull request #${pr}'s body kept changing under ${WRITE_ATTEMPTS} attempts to write it; nothing was lost, run again`,
  );
}

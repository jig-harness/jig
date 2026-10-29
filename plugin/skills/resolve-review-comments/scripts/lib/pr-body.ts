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
 * What the scripts need of the forge: a pull request's body, read and
 * written, and every `**deferred**` answer that links the body's
 * `## Deferred` section, complete or refused.
 */
export interface PrBodyForge {
  read(pr: string): Promise<PrBody>;
  write(pr: string, body: string): Promise<void>;
  deferredReplies(pr: string): Promise<DeferredReply[]>;
}

/** The review threads, each with its comments' urls and bodies. */
const THREADS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) { pageInfo { hasNextPage } nodes { url body } }
        }
      }
    }
  }
}`;

/**
 * Each resolved thread's first comment, whether its comments were cut at the
 * page, and its `**deferred**` replies that link `#deferred`, one JSON object
 * per line. A cut thread is emitted whatever its visible replies say: a reply
 * past the page is one the census cannot see.
 */
const DEFERRED_REPLIES_JQ = `.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved) | {thread: .comments.nodes[0].url, truncated: .comments.pageInfo.hasNextPage, replies: [.comments.nodes[1:][] | select(.body | startswith("**deferred**")) | select(.body | contains("#deferred")) | .url]} | select(.truncated or (.replies | length > 0)) | @json`;

/**
 * Each top-level `**deferred**` answer that links `#deferred`, with the
 * fingerprints its `drive-pr-addressed` markers name, one JSON object per
 * line (`answer-summary-finding.ts` writes them).
 */
const SUMMARY_DEFERRED_JQ = `.[] | select(.body | startswith("**deferred**")) | select(.body | contains("#deferred")) | {reply: .html_url, fingerprints: [.body | scan("<!-- drive-pr-addressed: ([^\\\\s>@#]+)") | .[0]]} | @json`;

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

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

interface ThreadLine {
  thread: string;
  truncated: boolean;
  replies: string[];
}

const isThreadLine = (v: unknown): v is ThreadLine =>
  isRecord(v) &&
  typeof v.thread === "string" &&
  typeof v.truncated === "boolean" &&
  isStrings(v.replies);

const isSummaryLine = (
  v: unknown,
): v is { reply: string; fingerprints: string[] } =>
  isRecord(v) && typeof v.reply === "string" && isStrings(v.fingerprints);

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
    async deferredReplies(pr) {
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
          DEFERRED_REPLIES_JQ,
        ]),
        isThreadLine,
        `pull request #${pr}'s review threads could not be read`,
      );
      const cut = threads.find((t) => t.truncated);
      if (cut !== undefined)
        throw new PrBodyError(
          `${cut.thread} has more than 100 comments, so its **deferred** replies cannot all be read; check that thread's entry by hand`,
        );
      const summaries = jsonLines(
        await gh([
          "api",
          "--paginate",
          `repos/{owner}/{repo}/issues/${pr}/comments`,
          "--jq",
          SUMMARY_DEFERRED_JQ,
        ]),
        isSummaryLine,
        `pull request #${pr}'s comments could not be read`,
      );
      return [
        ...threads.flatMap((t) =>
          t.replies.map((reply) => ({ thread: t.thread, reply })),
        ),
        ...summaries.flatMap((s) =>
          s.fingerprints.map((fingerprint) => ({
            fingerprint,
            reply: s.reply,
          })),
        ),
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

/** A resolution needs the resolving login's reply after the last reviewer post. */
import { fail, failFrom } from "../../../../shared/cli.ts";
import { decodeJson, isRecord } from "../../../../shared/guards.ts";
import { ghOrExit } from "./gh.ts";
import {
  resolutionFollowUp,
  type ResolutionComment,
  type TransparentResolutionFollowUp,
} from "./resolution-follow-up.ts";

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value === "")
    fail(1, "resolve-thread: incomplete reply evidence; refusing resolution");
  return value;
}

function commentEvidence(comment: unknown): ResolutionComment {
  const author = text(field(field(comment, "author"), "login"));
  const at = Date.parse(text(field(comment, "createdAt")));
  if (!Number.isFinite(at))
    fail(1, "resolve-thread: invalid comment timestamp");
  const body = field(comment, "body");
  return { author, at, body: typeof body === "string" ? body : null };
}

async function readPage(threadId: string, cursor: string | null) {
  const args = [
    "api",
    "graphql",
    "-f",
    "query=query($threadId:ID!,$cursor:String){ viewer { login } node(id:$threadId){ ... on PullRequestReviewThread { id comments(first:100,after:$cursor){ nodes { author { login __typename } authorAssociation body createdAt } pageInfo { hasNextPage endCursor } } } } }",
    "-f",
    `threadId=${threadId}`,
  ];
  if (cursor !== null) args.push("-f", `cursor=${cursor}`);
  let value: unknown;
  try {
    value = decodeJson(
      await ghOrExit("resolve-thread", args),
      isRecord,
      `reply evidence for thread ${threadId}`,
    );
  } catch (error) {
    failFrom(
      error,
      1,
      "resolve-thread: cannot read reply evidence; refusing resolution",
    );
  }
  const data = field(value, "data");
  const viewer = text(field(field(data, "viewer"), "login"));
  const node = field(data, "node");
  const comments = field(node, "comments");
  const page = field(comments, "pageInfo");
  const nodes = field(comments, "nodes");
  const more = field(page, "hasNextPage");
  if (
    field(value, "errors") !== undefined ||
    field(node, "id") !== threadId ||
    !Array.isArray(nodes) ||
    typeof more !== "boolean"
  ) {
    fail(1, "resolve-thread: invalid reply evidence; refusing resolution");
  }
  return {
    viewer,
    comments: nodes.map(commentEvidence),
    cursor: more ? text(field(page, "endCursor")) : null,
  };
}

interface Latest {
  at: number;
  position: number;
}

interface LatestComments {
  reply: Latest;
  other: Latest;
  next: number;
}

/** Later by timestamp; equal timestamps fall back to connection order. */
function isLater(a: Latest, b: Latest): boolean {
  return a.at > b.at || (a.at === b.at && a.position > b.position);
}

function latestCommentTimes(
  comments: ResolutionComment[],
  viewer: string,
  latest: LatestComments,
  transparent: TransparentResolutionFollowUp,
) {
  for (const comment of comments) {
    const { author, at } = comment;
    const here = { at, position: latest.next++ };
    if (
      latest.reply.position >= 0 &&
      at > latest.reply.at &&
      transparent(comment)
    )
      continue;
    const key =
      author.toLowerCase() === viewer.toLowerCase() ? "reply" : "other";
    if (isLater(here, latest[key])) latest[key] = here;
  }
  return latest;
}

export async function assertResolutionReply(threadId: string): Promise<void> {
  const transparent = await resolutionFollowUp();
  let cursor: string | null = null;
  const seen = new Set<string>();
  let latest: LatestComments = {
    reply: { at: -1, position: -1 },
    other: { at: -1, position: -1 },
    next: 0,
  };
  let viewer = "";
  for (;;) {
    const page = await readPage(threadId, cursor);
    if (viewer && viewer !== page.viewer)
      fail(1, "resolve-thread: resolving identity changed during pagination");
    viewer = page.viewer;
    latest = latestCommentTimes(page.comments, viewer, latest, transparent);
    cursor = page.cursor;
    if (cursor === null) break;
    if (seen.has(cursor))
      fail(1, "resolve-thread: repeated comment cursor; refusing resolution");
    seen.add(cursor);
  }
  if (latest.other.position < 0 || !isLater(latest.reply, latest.other)) {
    fail(
      6,
      "resolve-thread: REPLY_REQUIRED — post a reply from the resolving login after the last reviewer comment before resolving",
    );
  }
}

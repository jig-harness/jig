/**
 * The legacy form of a GitHub `related` link, and its migration to GitHub's
 * own related links.
 *
 * Earlier versions of the adapter recorded a related link as a comment on
 * each issue, `<!-- jig:related <owner>/<repo>#<n> -->`, because GitHub had
 * no such link. GitHub's `addRelatesTo` is the link now; the adapter still
 * reads a trusted comment as a link until `migrateRelations` has converted
 * it, and that conversion marks the comment superseded, so it is read no
 * more.
 */

import type { RelationMigration } from "../port.ts";
import type { Client } from "./client.ts";
import { PAGE, onePage, record, str } from "./read.ts";
import { type IssueRef, type Repo, keyOf, repoOf } from "./refs.ts";
import { pageAll } from "./transport.ts";

/** Authors whose comments are trusted: they can write to the repository. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The marker of a legacy `related` comment; the other issue is always qualified. */
const LEGACY_MARKER =
  /<!-- jig:related ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9]\d*) -->/g;

export interface LegacyComment {
  id: string;
  body: string;
  trusted: boolean;
}

/** The issues a comment body relates its issue to, as qualified keys. */
export function legacyTargets(body: string): string[] {
  return [...body.matchAll(LEGACY_MARKER)].map((m) => m[1] as string);
}

/**
 * A comment's body once the links to `converted` are native: each of their
 * markers becomes a superseded one, which is no longer read, and everything
 * else in the comment (another link's marker, a person's words) stays.
 */
export function supersededBody(body: string, converted: string[]): string {
  return body.replace(LEGACY_MARKER, (marker, target: string) =>
    converted.includes(target)
      ? `<!-- jig:related-superseded ${target} -->`
      : marker,
  );
}

const SCAN = `
query TrackerLegacyRelated($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 25, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number
        relatesTo(first: ${PAGE}) { pageInfo { hasNextPage } nodes { number repository { nameWithOwner } } }
        comments(first: ${PAGE}) {
          pageInfo { hasNextPage }
          nodes { id body authorAssociation viewerDidAuthor }
        }
      }
    }
  }
}`;

export const ADD_RELATES_TO = `mutation TrackerAddRelatesTo($issueId: ID!, $relatedIssueId: ID!) {
  addRelatesTo(input: { issueId: $issueId, relatedIssueId: $relatedIssueId }) { issue { id } }
}`;

const UPDATE_COMMENT = `mutation TrackerUpdateComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } }
}`;

/** Every comment of the issue, as the scan could not hold them in one page. */
const COMMENTS = `
query TrackerComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      comments(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body authorAssociation viewerDidAuthor }
      }
    }
  }
}`;

function commentOf(v: unknown, where: string): LegacyComment {
  const n = record(v, where);
  return {
    id: str(n.id, `${where}.id`),
    body: str(n.body, `${where}.body`),
    trusted:
      TRUSTED.has(String(n.authorAssociation)) || n.viewerDidAuthor === true,
  };
}

/** The comments of one scanned issue; the scan holds a page, so a longer list is read in full. */
async function commentsOf(
  client: Client,
  issue: Record<string, unknown>,
  ref: IssueRef,
  signal?: AbortSignal,
): Promise<LegacyComment[]> {
  const key = keyOf(ref, client.home);
  const held = record(issue.comments, `${key}.comments`);
  const more =
    record(held.pageInfo, `${key}.comments.pageInfo`).hasNextPage === true;
  const nodes = more
    ? await pageAll(
        client.transport,
        COMMENTS,
        { owner: ref.owner, name: ref.name, number: ref.number },
        (d) =>
          record(record(d.repository, "repository").issue, `issue ${key}`)
            .comments,
        `comments of ${key}`,
        signal,
      )
    : onePage(held, `${key}.comments`);
  return nodes.map((c, n) => commentOf(c, `comments of ${key}[${n}]`));
}

/** The keys an issue already has a native related link to. */
function nativeLinks(
  issue: Record<string, unknown>,
  key: string,
  home: Repo,
): string[] {
  return onePage(issue.relatesTo, `${key}.relatesTo`).map((n) => {
    const r = record(n, `${key}.relatesTo`);
    const repo = record(r.repository, `${key}.relatesTo.repository`);
    return keyOf(
      {
        ...repoOf(str(repo.nameWithOwner, `${key}.relatesTo`)),
        number: Number(r.number),
      },
      home,
    );
  });
}

/**
 * Convert every trusted legacy `related` comment of the repository into a
 * native related link, then mark the comment superseded. Safe to run again:
 * a comment already marked is no longer found, a link already native is not
 * written twice, and a run that stopped between the link and the comment
 * finds the link native and only marks the comment.
 */
export async function migrateRelations(
  client: Client,
  opts: { dryRun?: boolean } = {},
  signal?: AbortSignal,
): Promise<RelationMigration> {
  const { home } = client;
  const dryRun = opts.dryRun === true;
  const report: RelationMigration = {
    dryRun,
    scanned: 0,
    links: [],
    converted: [],
    unresolved: [],
    unmarked: [],
  };
  const nodes = await pageAll(
    client.transport,
    SCAN,
    { owner: home.owner, name: home.name },
    (d) => record(record(d.repository, "repository").issues, "issues"),
    "the issues of the repository",
    signal,
  );
  /** The pairs whose native link is there: written in this run or found. */
  const linked = new Set<string>();

  /** Make sure the pair has a native link; `null` when it is there, else why it cannot be. */
  async function link(
    issue: Record<string, unknown>,
    key: string,
    otherKey: string,
    native: string[],
  ): Promise<string | null> {
    const pair = [key, otherKey].sort().join(" ");
    if (linked.has(pair) || native.includes(otherKey)) {
      linked.add(pair);
      return null;
    }
    if (otherKey === key) return "the comment names its own issue";
    try {
      const found = await client.issue(client.ref(otherKey), "", signal);
      if (found === null) return "the issue does not exist or is not visible";
      if (!dryRun)
        await client.mutate(
          ADD_RELATES_TO,
          {
            issueId: str(issue.id, `${key}.id`),
            relatedIssueId: found.issue.id,
          },
          signal,
        );
    } catch (err) {
      // One pair GitHub refuses must not stop the rest; the next run meets it again.
      if (signal?.aborted === true) throw err;
      return err instanceof Error ? err.message : String(err);
    }
    report.links.push({ issue: key, related: otherKey });
    linked.add(pair);
    return null;
  }

  /** Rewrite the comment once, for the links that are native now; an edit it refuses is reported. */
  async function supersede(
    c: LegacyComment,
    key: string,
    done: Array<{ target: string; related: string }>,
  ): Promise<void> {
    if (done.length === 0) return;
    const entries = done.map((d) => ({
      issue: key,
      related: d.related,
      comment: c.id,
    }));
    if (dryRun) {
      report.converted.push(...entries);
      return;
    }
    try {
      await client.mutate(
        UPDATE_COMMENT,
        {
          id: c.id,
          body: supersededBody(
            c.body,
            done.map((d) => d.target),
          ),
        },
        signal,
      );
      report.converted.push(...entries);
    } catch (err) {
      // A comment someone else wrote may not be editable. The links are
      // native by now and the comment is still read as the same links, so a
      // later run marks it.
      if (signal?.aborted === true) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      for (const e of entries) report.unmarked.push({ ...e, reason });
    }
  }

  for (const node of nodes) {
    const issue = record(node, "issue");
    const ref: IssueRef = { ...home, number: Number(issue.number) };
    const key = keyOf(ref, home);
    report.scanned++;
    const comments = (await commentsOf(client, issue, ref, signal)).filter(
      (c) => c.trusted,
    );
    if (!comments.some((c) => legacyTargets(c.body).length > 0)) continue;
    const native = nativeLinks(issue, key, home);
    for (const c of comments) {
      const done: Array<{ target: string; related: string }> = [];
      for (const target of legacyTargets(c.body)) {
        const otherKey = keyOf(client.ref(target), home);
        const why = await link(issue, key, otherKey, native);
        if (why === null) done.push({ target, related: otherKey });
        else report.unresolved.push({ issue: key, related: otherKey, why });
      }
      await supersede(c, key, done);
    }
  }
  return report;
}

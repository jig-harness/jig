/**
 * dispatch: the repository's query read as the listings it replaces. Its
 * comments read as the forge's comment listing gives them, field by field
 * that a reader reads, compared on a pair taken from one pull request's real
 * listing and the query's answer for it (in both, each body a fixture's
 * and each author's login a neutral one); its pull requests read as the pull
 * request listing gives them. The tick's comment listings hold what the
 * query read without listing it again, and never what a write this tick
 * made stale.
 */
import { describe, expect, it } from "bun:test";
import { conversationOf } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import { snapshotFromListing } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { listedFrom } from "../../shared/records/forge-claims.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  LAUNCH_CLAIM,
  launchClaim,
} from "../../shared/records/launch-claims.ts";
import type { LaunchDraft } from "../../shared/records/shared.ts";
import { listedPullRequest, restComment } from "../lib/forge-batch.ts";
import { listedOpen } from "../lib/forge.ts";
import { type Listing, tickComments } from "../lib/tick-comments.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { stoppedLedger } from "./fixtures.ts";

const URL = "https://github.com/jig-harness/jig/pull/572#issuecomment-";

/** The member's comment: a drive ledger, so the ledger's reader finds one. */
const LEDGER = ledgerBody(stoppedLedger(572, 16));

/** A launch claim, so the claim readers have one to find. */
const DRAFT: LaunchDraft = {
  stage: "drive",
  pr: 572,
  run: "tick",
  action: "rearm",
  record: "20261108T101407Z-0a1b2c3d",
  host: "host-a",
  owner: true,
  facts: "",
  writer: { login: "maintainer", host: "host-a" },
};
const CLAIM = claimBody(LAUNCH_CLAIM, launchClaim(DRAFT, 1));

/** Three comments of one pull request as the comment listing gave them: a member's ledger and launch claim, and a bot's. */
const LISTED = [
  {
    id: 6706843443,
    user: { login: "maintainer", type: "User" },
    author_association: "MEMBER",
    created_at: "2026-11-07T12:18:43Z",
    updated_at: "2026-11-08T10:14:07Z",
    html_url: `${URL}6706843443`,
    body: LEDGER,
  },
  {
    id: 6706843444,
    user: { login: "maintainer", type: "User" },
    author_association: "MEMBER",
    created_at: "2026-11-07T12:18:44Z",
    updated_at: "2026-11-07T12:18:44Z",
    html_url: `${URL}6706843444`,
    body: CLAIM,
  },
  {
    id: 6720231176,
    user: { login: "github-actions[bot]", type: "Bot" },
    author_association: "NONE",
    created_at: "2026-11-08T10:14:15Z",
    updated_at: "2026-11-08T10:14:15Z",
    html_url: `${URL}6720231176`,
    body: "A bot's comment.",
  },
];

/** The same two comments as the repository's query gave them. */
const QUERIED = [
  {
    databaseId: 6706843443,
    fullDatabaseId: "6706843443",
    url: `${URL}6706843443`,
    createdAt: "2026-11-07T12:18:43Z",
    updatedAt: "2026-11-08T10:14:07Z",
    authorAssociation: "MEMBER",
    body: LEDGER,
    author: { __typename: "User", login: "maintainer" },
  },
  {
    databaseId: 6706843444,
    fullDatabaseId: "6706843444",
    url: `${URL}6706843444`,
    createdAt: "2026-11-07T12:18:44Z",
    updatedAt: "2026-11-07T12:18:44Z",
    authorAssociation: "MEMBER",
    body: CLAIM,
    author: { __typename: "User", login: "maintainer" },
  },
  {
    databaseId: 6720231176,
    fullDatabaseId: "6720231176",
    url: `${URL}6720231176`,
    createdAt: "2026-11-08T10:14:15Z",
    updatedAt: "2026-11-08T10:14:15Z",
    authorAssociation: "NONE",
    body: "A bot's comment.",
    author: { __typename: "Bot", login: "github-actions" },
  },
];

/** What a reader of the listing reads of a comment. */
const read = (c: unknown) => {
  const r = c as (typeof LISTED)[number];
  return {
    id: r.id,
    login: r.user?.login,
    association: r.author_association,
    created: r.created_at,
    updated: r.updated_at,
    url: r.html_url,
    body: r.body,
  };
};

describe("the repository query's comments", () => {
  const mapped = QUERIED.map(restComment);

  it("read as the comment listing gives them: the numeric id, a bot's login with [bot], the association, the times, the link and the body", () => {
    expect(mapped.map(read)).toEqual(LISTED.map(read));
  });

  it("read the same to each reader of a listing", () => {
    expect(conversationOf(mapped)).toEqual(conversationOf(LISTED));
    const snapshot = snapshotFromListing(mapped, "maintainer");
    expect(snapshot.canonical?.comment.id).toBe(6706843443);
    expect(snapshot).toEqual(snapshotFromListing(LISTED, "maintainer"));
    const target = { repo: "jig-harness/jig", number: 572 };
    const claims = listedFrom(LAUNCH_CLAIM, mapped, target, null);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims).toEqual(listedFrom(LAUNCH_CLAIM, LISTED, target, null));
  });

  it("take the short id where the forge gives no full one, and a deleted author as the listing names it", () => {
    const { fullDatabaseId: _, ...short } = QUERIED[0] as (typeof QUERIED)[0];
    expect(restComment({ ...short, author: null })).toMatchObject({
      id: 6706843443,
      user: { login: "ghost" },
    });
    expect(restComment({ body: "no id" })).toBeNull();
  });
});

describe("the repository query's pull requests", () => {
  /** One open pull request as the pull request listing gave it, and as the query did. */
  const listing = {
    number: 613,
    url: "https://github.com/jig-harness/jig/pull/613",
    title: "Pull request 613",
    headRefName: "feature/613",
    createdAt: "2026-11-08T09:27:29Z",
    headRefOid: "0eac6188584ea9ade0535b45b6213515243f09a9",
    baseRefName: "main",
    mergeable: "MERGEABLE",
    isDraft: true,
    updatedAt: "2026-11-08T09:31:41Z",
    author: { login: "app/renovate", is_bot: true },
    labels: [{ name: "jig:driving" }],
  };
  const node = {
    ...listing,
    author: { __typename: "Bot", login: "renovate" },
    labels: {
      pageInfo: { hasNextPage: false },
      nodes: [{ name: "jig:driving" }],
    },
  };

  /** The pull request the query gave, in the listing's shape; the test fails when it does not read. */
  const listed = (value: unknown): Record<string, unknown> => {
    const read = listedPullRequest(value);
    expect(read).toMatchObject({ ok: true });
    return read.ok ? read.value : {};
  };
  /** Why the query's pull request does not read, which must be `unreadable`. */
  const refused = (value: unknown): string => {
    const read = listedPullRequest(value);
    expect(read.ok).toBe(false);
    if (read.ok) return "";
    expect(read.failure.code).toBe("unreadable");
    return read.failure.reason;
  };

  it("read as the pull request listing gives them, a bot author's login as app/<name>", () => {
    const read = { labels: true };
    const batched = listedOpen([listed(node)], read);
    expect(batched).toMatchObject({ ok: true });
    expect(batched).toEqual(listedOpen([listing], read));
    const unlabelled = listedOpen([listed(node)]);
    expect(unlabelled.ok && unlabelled.value[0]?.labels).toBeUndefined();
  });

  it("carry the issues the forge says each closes, with their repository, and nothing when those do not read", () => {
    const closing = [
      { number: 612, repository: { nameWithOwner: "jig-harness/jig" } },
    ];
    expect(
      listed({ ...node, closingIssuesReferences: { nodes: closing } }).closing,
    ).toEqual([{ number: 612, repository: "jig-harness/jig" }]);
    expect(listed(node).closing).toBeUndefined();
    expect(
      listed({
        ...node,
        closingIssuesReferences: { nodes: [{ number: 612 }] },
      }).closing,
    ).toBeUndefined();
  });

  it("do not read when one has more labels than one page holds", () => {
    expect(
      refused({
        ...node,
        labels: { ...node.labels, pageInfo: { hasNextPage: true } },
      }),
    ).toContain("more labels than one read holds");
  });

  it("do not read when one lacks its number or head branch, or has unreadable labels", () => {
    const { number: _n, ...noNumber } = node;
    const { headRefName: _h, ...noHead } = node;
    expect(refused(noNumber)).toContain("number or head branch");
    expect(refused(noHead)).toContain("number or head branch");
    expect(
      refused({
        ...node,
        labels: { ...node.labels, nodes: [{ name: "a" }, null] },
      }),
    ).toContain("unreadable labels");
    const { labels: _l, ...noLabels } = node;
    for (const labels of [
      null,
      { pageInfo: { hasNextPage: false }, nodes: null },
      { nodes: [{ name: "a" }] },
      { pageInfo: {}, nodes: [{ name: "a" }] },
    ])
      expect(refused({ ...noLabels, labels })).toContain("unreadable labels");
    expect(refused(noLabels)).toContain("unreadable labels");
  });
});

describe("the tick's listings filled from the query", () => {
  const SLUG = "example-org/example-repo";
  const counting = () => {
    const calls: number[] = [];
    const comments = tickComments({
      list: async (target): Promise<Listing> => {
        calls.push(target.number);
        return { ok: true, value: [{ id: 1 }] };
      },
    });
    return { calls, comments };
  };

  it("hold what the query read, from when it began, without listing it again", async () => {
    const { calls, comments } = counting();
    comments.seed(SLUG, 7, [{ id: 2 }], 1000);
    expect(await comments.read(SLUG, 7)).toEqual({
      ok: true,
      value: [{ id: 2 }],
    });
    expect(comments.startedAt(SLUG, 7)).toBe(1000);
    expect(calls).toEqual([]);
  });

  it("keep a listing already held", async () => {
    const { calls, comments } = counting();
    await comments.read(SLUG, 7);
    comments.seed(SLUG, 7, [{ id: 2 }], Date.now());
    expect(await comments.read(SLUG, 7)).toEqual({
      ok: true,
      value: [{ id: 1 }],
    });
    expect(calls).toEqual([7]);
  });

  it("never hold a query's comments that a write this tick made since it began", async () => {
    const { calls, comments } = counting();
    const began = Date.now() - 1000;
    comments.forget(SLUG, 7);
    comments.seed(SLUG, 7, [{ id: 2 }], began);
    expect(await comments.read(SLUG, 7)).toEqual({
      ok: true,
      value: [{ id: 1 }],
    });
    expect(calls).toEqual([7]);
    // A query that began after the write holds what it read.
    comments.forget(SLUG, 8);
    comments.seed(SLUG, 8, [{ id: 3 }], Date.now() + 1);
    expect(await comments.read(SLUG, 8)).toEqual({
      ok: true,
      value: [{ id: 3 }],
    });
  });
});

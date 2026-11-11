import { describe, expect, it } from "bun:test";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
  writes,
} from "./github-fixtures.ts";

const ref = (n: number, repo = "acme/app") => ({
  number: n,
  repository: { nameWithOwner: repo },
});

interface Comment {
  id: string;
  body: string;
  authorAssociation: string;
}

type Answer = (variables: Record<string, unknown>) => unknown;

/** An adapter whose repository keeps issues with comments and related links, and applies the writes. */
function repository(
  comments: Record<number, Comment[]>,
  links: Record<number, number[]> = {},
  opts: { uneditable?: Set<string>; refuse?: Set<string> } = {},
) {
  const numbers = [
    ...new Set([
      ...Object.keys(comments).map(Number),
      ...Object.keys(links).map(Number),
    ]),
  ].sort((a, b) => a - b);
  const linksOf = (n: number) => conn((links[n] ?? []).map((m) => ref(m)));
  const dated = (n: number) =>
    conn(
      (comments[n] ?? []).map((m) => ({
        ...m,
        createdAt: "2026-01-01T00:00:00Z",
      })),
    );
  const nodeOf = (id: unknown) => Number(String(id).slice(2));
  const answers: Record<string, Answer> = {
    TrackerLegacyRelated: () => ({
      repository: {
        issues: conn(
          numbers.map((n) => ({
            id: `I_${n}`,
            number: n,
            relatesTo: linksOf(n),
            comments: conn(comments[n] ?? []),
          })),
        ),
      },
    }),
    TrackerIssue: (v) =>
      oneIssue(
        issueNode({
          number: v.number as number,
          extra: {
            relatesTo: linksOf(v.number as number),
            blockedBy: conn([]),
            blocking: conn([]),
            duplicateOf: null,
            timelineItems: conn([]),
          },
        }),
      ),
    TrackerComments: (v) => ({
      repository: {
        issue: { id: `I_${v.number}`, comments: dated(v.number as number) },
      },
    }),
    TrackerAddRelatesTo: (v) => {
      if (opts.refuse?.has(String(v.relatedIssueId)))
        throw new Error("refused");
      const a = nodeOf(v.issueId);
      const b = nodeOf(v.relatedIssueId);
      links[a] = [...(links[a] ?? []), b];
      links[b] = [...(links[b] ?? []), a];
      return {};
    },
    TrackerUpdateComment: (v) => {
      const id = String(v.id);
      if (opts.uneditable?.has(id)) throw new Error("not allowed");
      for (const comment of Object.values(comments).flat())
        if (comment.id === id) comment.body = String(v.body);
      return {};
    },
  };
  return gitHub((c) => answers[c.op]?.(c.variables) ?? {});
}

const legacy = (id: string, target: number, authorAssociation = "OWNER") => ({
  id,
  body: `<!-- jig:related acme/app#${target} -->\nRelated to acme/app#${target}.`,
  authorAssociation,
});

describe("GitHub adapter: migrating related comments to native links", () => {
  it("converts each legacy comment once and a second run finds nothing", async () => {
    const comments = {
      1: [legacy("C1", 2)],
      2: [legacy("C2", 1)],
      3: [legacy("C3", 1)],
    };
    const links: Record<number, number[]> = {};
    const { t, calls } = repository(comments, links);
    const first = await t.migrateRelations?.();
    expect(first).toEqual({
      dryRun: false,
      scanned: 3,
      links: [
        { issue: "#1", related: "#2" },
        { issue: "#3", related: "#1" },
      ],
      converted: [
        { issue: "#1", related: "#2", comment: "C1" },
        { issue: "#2", related: "#1", comment: "C2" },
        { issue: "#3", related: "#1", comment: "C3" },
      ],
      unresolved: [],
      unmarked: [],
    });
    expect(links).toEqual({ 1: [2, 3], 2: [1], 3: [1] });
    expect(comments[1][0]?.body).toContain("jig:related-superseded");
    const written = writes(calls).length;
    const second = await t.migrateRelations?.();
    expect(second).toMatchObject({ links: [], converted: [], unmarked: [] });
    expect(writes(calls).length).toBe(written);
    expect(await t.listRelations("#1")).toEqual([
      { type: "related", issue: "#2" },
      { type: "related", issue: "#3" },
    ]);
  });

  it("writes nothing on a dry run, and ignores a comment by a stranger", async () => {
    const comments = {
      1: [legacy("C1", 2), legacy("C9", 5, "NONE")],
    };
    const { t, calls } = repository(comments);
    const report = await t.migrateRelations?.({ dryRun: true });
    expect(report?.dryRun).toBe(true);
    expect(report?.converted).toEqual([
      { issue: "#1", related: "#2", comment: "C1" },
    ]);
    expect(writes(calls)).toEqual([]);
  });

  it("only marks the comment when the link is already native, and resumes after a failed edit", async () => {
    const comments = { 1: [legacy("C1", 2)] };
    const links: Record<number, number[]> = { 1: [2], 2: [1] };
    const { t, calls } = repository(comments, links, {
      uneditable: new Set(["C1"]),
    });
    const stuck = await t.migrateRelations?.();
    expect(stuck?.links).toEqual([]);
    expect(stuck?.unmarked).toEqual([
      { issue: "#1", related: "#2", comment: "C1", reason: "not allowed" },
    ]);
    expect(writes(calls)).toEqual(["TrackerUpdateComment"]);
  });

  it("reports a comment naming an issue that is gone", async () => {
    const comments = { 1: [legacy("C1", 2)] };
    // Only the scan answers; every issue lookup finds nothing.
    const gone = gitHub((c) => {
      if (c.op === "TrackerLegacyRelated")
        return {
          repository: {
            issues: conn([
              {
                id: "I_1",
                number: 1,
                relatesTo: conn([]),
                comments: conn(comments[1]),
              },
            ]),
          },
        };
      return oneIssue(null);
    });
    const report = await gone.t.migrateRelations?.();
    expect(report?.unresolved).toEqual([
      {
        issue: "#1",
        related: "#2",
        why: "the issue does not exist or is not visible",
      },
    ]);
    expect(report?.converted).toEqual([]);
    expect(writes(gone.calls)).toEqual([]);
  });

  it("keeps the markers of a comment's other links when one cannot be converted", async () => {
    const comments = {
      1: [
        {
          id: "C1",
          body: `${legacy("x", 2).body}\n${legacy("x", 3).body}`,
          authorAssociation: "OWNER",
        },
      ],
    };
    const links: Record<number, number[]> = {};
    const { t } = repository(comments, links, { refuse: new Set(["I_3"]) });
    const report = await t.migrateRelations?.();
    expect(report?.converted).toEqual([
      { issue: "#1", related: "#2", comment: "C1" },
    ]);
    expect(report?.unresolved).toEqual([
      { issue: "#1", related: "#3", why: "refused" },
    ]);
    expect(comments[1][0]?.body).toContain("jig:related-superseded acme/app#2");
    expect(comments[1][0]?.body).toContain("<!-- jig:related acme/app#3 -->");
    // The pair GitHub refused does not stop the issues after it.
    expect(report?.scanned).toBe(1);
  });
});

/**
 * The conflict rates (`merge-conflict-rates/v1`): for each path, how many
 * merged pull requests of the window changed it, and how many of those met
 * a conflict before they merged. A pull request is one entry of the forge's
 * cohort, however many first-parent commits it put on the integration
 * branch; one that is neither conflicted nor observed clean is left out of
 * both counts.
 */
import { describe, expect, it } from "bun:test";
import type {
  Ancestry,
  ConflictEvidence,
} from "../../drive-pr/scripts/lib/fractal-conflicts.ts";
import { isoFromMs, parseMs } from "../../../shared/time.ts";
import type { CohortListing, CohortPr } from "../scripts/lib/cohort.ts";
import {
  buildRates,
  type FirstParent,
  mapFirstParents,
  parseRates,
  RATES_SCHEMA,
} from "../scripts/lib/rates.ts";

const DAY = 86_400_000;
const NOW = parseMs("2026-11-18T12:00:00Z");
const at = (ms: number) => isoFromMs(ms);
const oid = (c: string) => c.repeat(40);

function pr(
  number: number,
  o: Partial<CohortPr> & { merged?: number } = {},
): CohortPr {
  const merged = o.merged ?? NOW - number * DAY;
  return {
    number,
    createdAt: at(merged - DAY),
    mergedAt: at(merged),
    mergeCommit: o.mergeCommit ?? null,
    headRefOid: o.headRefOid ?? oid(String(number % 10)),
    baseRefName: "main",
    files: o.files ?? [],
    filesCut: o.filesCut ?? false,
    commitCount: o.commitCount ?? 1,
    commits: o.commits ?? [],
    forcePushed: o.forcePushed ?? false,
  };
}

const parent = (
  commit: string,
  parents: string[],
  subject: string,
  authorMs: number,
): FirstParent => ({
  commit,
  parents,
  subject,
  authorTime: Math.floor(authorMs / 1000),
});

describe("the first-parent commits of the integration branch", () => {
  const authored = NOW - 5 * DAY;
  // Newest first, as git lists them.
  const firstParents = [
    parent(
      oid("a"),
      [oid("b"), oid("9")],
      "Merge pull request #1 from o/x",
      NOW,
    ),
    // A rebase merge of #2: three commits, the last of them its merge commit.
    parent(oid("b"), [oid("c")], "third step", authored + 3000),
    parent(oid("c"), [oid("d")], "second step", authored + 2000),
    parent(
      oid("d"),
      [oid("e")],
      "a first step whose headline the forge cut short at its length",
      authored + 1000,
    ),
    // A commit pushed straight to the branch.
    parent(oid("e"), [oid("f")], "hotfix", authored),
    // A squash merge of #3, whose branch had two commits.
    parent(oid("f"), [oid("0")], "Squashed (#3)", authored - 1000),
  ];
  const prs = [
    pr(1, { mergeCommit: oid("a") }),
    pr(2, {
      mergeCommit: oid("b"),
      commitCount: 3,
      commits: [
        {
          subject: "a first step whose headline the forge cut short…",
          authoredAt: at(authored + 1000),
          committedAt: at(authored + 1000),
        },
        {
          subject: "second step",
          authoredAt: at(authored + 2000),
          committedAt: at(authored + 2000),
        },
        {
          subject: "third step",
          authoredAt: at(authored + 3000),
          committedAt: at(authored + 3000),
        },
      ],
    }),
    pr(3, {
      mergeCommit: oid("f"),
      commitCount: 2,
      commits: [
        {
          subject: "hotfix",
          authoredAt: at(authored - 9000),
          committedAt: at(authored - 9000),
        },
        {
          subject: "wip",
          authoredAt: at(authored - 8000),
          committedAt: at(authored - 8000),
        },
      ],
    }),
  ];

  it("maps a rebase merge's several commits to its one pull request, and leaves a commit the forge maps to none unknown", () => {
    const mapped = mapFirstParents(prs, firstParents);
    expect(mapped.byPr.get(1)).toEqual([oid("a")]);
    expect(mapped.byPr.get(2)).toEqual([oid("b"), oid("c"), oid("d")]);
    expect(mapped.byPr.get(3)).toEqual([oid("f")]);
    // Same subject as one of #3's commits, but not its author time: not #3's.
    expect(mapped.unknown).toEqual([oid("e")]);
  });

  it("never takes another pull request's merge commit into a rebase run", () => {
    const greedy = pr(4, {
      mergeCommit: oid("b"),
      commitCount: 5,
      commits:
        prs[1]?.commits.concat([
          {
            subject: "hotfix",
            authoredAt: at(authored),
            committedAt: at(authored),
          },
          {
            subject: "Squashed (#3)",
            authoredAt: at(authored - 1000),
            committedAt: at(authored - 1000),
          },
        ]) ?? [],
    });
    const mapped = mapFirstParents(
      [prs[0] as CohortPr, greedy, prs[2] as CohortPr],
      firstParents,
    );
    expect(mapped.byPr.get(4)).toEqual([
      oid("b"),
      oid("c"),
      oid("d"),
      oid("e"),
    ]);
    expect(mapped.byPr.get(3)).toEqual([oid("f")]);
    expect(mapped.unknown).toEqual([]);
  });
});

const listing: CohortListing = {
  pages: 1,
  listed: 6,
  reused: 0,
  cost: 1,
  from: "window",
};

describe("the rates", () => {
  const clean: Ancestry = { commits: new Set([oid("1")]), merges: new Set() };
  const prs = [
    // Conflicted: a replayed merge names it.
    pr(10, { files: ["src/x.ts"], mergeCommit: oid("a") }),
    // Observed clean: its ancestry holds no merge, and its branch was never force-pushed.
    pr(11, { files: ["src/x.ts", "src/y.ts"], mergeCommit: oid("b") }),
    // Unknown: its head is not in the clone.
    pr(12, { files: ["src/x.ts"], mergeCommit: oid("c") }),
    // Conflicted: the live record names it.
    pr(13, { files: ["src/y.ts"], mergeCommit: oid("d") }),
    // Unknown: a force-push can hide a rebase's conflicts.
    pr(14, { files: ["src/y.ts"], mergeCommit: oid("e"), forcePushed: true }),
    // A rebase merge, clean: the forge's files and its commits' files together.
    pr(15, { files: ["src/z.ts"], mergeCommit: oid("f"), commitCount: 2 }),
  ];
  const evidence: ConflictEvidence = {
    report: {
      schema: "merge-conflicts/v1",
      shallow: false,
      merges: [
        {
          commit: oid("7"),
          conflicted: true,
          pullRequest: 10,
          date: at(NOW - 11 * DAY),
        },
      ],
    },
    complete: true,
    events: [
      {
        type: "merge_conflict",
        ts: at(NOW - 14 * DAY),
        commit: oid("8"),
        path: "src/y.ts",
        pr: 13,
      },
    ],
  };
  const ancestry = (p: CohortPr): Ancestry => (p.number === 12 ? null : clean);
  const firstParents = [
    parent(oid("a"), [oid("0"), oid("1")], "Merge #10", NOW),
    parent(oid("b"), [oid("0"), oid("1")], "Merge #11", NOW),
    parent(oid("f"), [oid("6")], "rebased two", NOW),
    parent(oid("6"), [oid("5")], "rebased one", NOW),
    parent(oid("5"), [oid("4")], "a direct push", NOW),
  ];
  const rebased = {
    ...(prs[5] as CohortPr),
    commits: [
      { subject: "rebased one", authoredAt: at(NOW), committedAt: at(NOW) },
      { subject: "rebased two", authoredAt: at(NOW), committedAt: at(NOW) },
    ],
  };
  const cohort = [...prs.slice(0, 5), rebased];
  const files = (commit: string) =>
    commit === oid("6")
      ? ["src/w.ts"]
      : commit === oid("f")
        ? ["src/z.ts"]
        : null;
  const rates = buildRates({
    repository: "acme/widgets",
    range: {
      since: at(NOW - 30 * DAY),
      until: null,
      label: "the last 30 days",
    },
    generatedAt: at(NOW),
    prs: cohort,
    listing,
    firstParents,
    evidence,
    ancestry,
    commitFiles: files,
  });

  it("counts, for each path, the observed pull requests that changed it and those that met a conflict, leaving unknown ones out", () => {
    expect(rates.schema).toBe(RATES_SCHEMA);
    expect(rates.paths).toEqual([
      { path: "src/x.ts", merged: 2, conflicted: 1, unknown: 1 },
      { path: "src/y.ts", merged: 2, conflicted: 1, unknown: 1 },
      { path: "src/w.ts", merged: 1, conflicted: 0, unknown: 0 },
      { path: "src/z.ts", merged: 1, conflicted: 0, unknown: 0 },
    ]);
    expect(rates.cohort).toMatchObject({
      pullRequests: 6,
      conflicted: 2,
      clean: 2,
      unknown: 2,
    });
    expect(rates.pullRequests.map((p) => [p.number, p.observation])).toEqual([
      [10, "conflicted"],
      [11, "clean"],
      [12, "unknown"],
      [13, "conflicted"],
      [14, "unknown"],
      [15, "clean"],
    ]);
  });

  it("counts a rebase merge once, and says which first-parent commits no pull request accounts for", () => {
    expect(rates.pullRequests.find((p) => p.number === 15)?.commits).toEqual([
      oid("f"),
      oid("6"),
    ]);
    expect(rates.commits).toEqual({
      firstParent: 5,
      mapped: 4,
      unknown: 1,
      unknownCommits: [oid("5")],
    });
  });

  it("leaves a pull request unknown when the replay or the live record could not be read whole", () => {
    const partial = buildRates({
      repository: "acme/widgets",
      range: { since: null, until: null, label: "all history" },
      generatedAt: at(NOW),
      prs: [prs[1] as CohortPr],
      listing,
      firstParents: null,
      evidence: { ...evidence, complete: false },
      ancestry,
      commitFiles: () => null,
    });
    expect(partial.pullRequests[0]?.observation).toBe("unknown");
    expect(partial.paths).toEqual([
      { path: "src/x.ts", merged: 0, conflicted: 0, unknown: 1 },
      { path: "src/y.ts", merged: 0, conflicted: 0, unknown: 1 },
    ]);
    expect(partial.commits).toBeNull();
  });

  describe("a pull request whose file list the forge cut", () => {
    const merge = (n: number, extra: Partial<CohortPr> = {}) =>
      pr(n, {
        files: ["src/a.ts"],
        filesCut: true,
        mergeCommit: oid("a"),
        ...extra,
      });
    const rated = (
      cohortPr: CohortPr,
      parents: FirstParent[],
      read: (commit: string) => string[] | null,
    ) =>
      buildRates({
        repository: "acme/widgets",
        range: { since: null, until: null, label: "all history" },
        generatedAt: at(NOW),
        prs: [cohortPr],
        listing,
        firstParents: parents,
        evidence,
        ancestry: () => clean,
        commitFiles: read,
      });

    it("counts a merge commit whose files were read, and every path of them", () => {
      const r = rated(
        merge(30),
        [parent(oid("a"), [oid("0"), oid("1")], "Merge #30", NOW)],
        () => ["src/a.ts", "src/b.ts"],
      );
      expect(r.pullRequests[0]?.observation).toBe("clean");
      expect(r.cohort.filesCut).toBe(0);
      expect(r.paths.map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("leaves it unknown when the clone does not hold its commit", () => {
      const r = rated(
        merge(31),
        [parent(oid("a"), [oid("0"), oid("1")], "Merge #31", NOW)],
        () => null,
      );
      expect(r.pullRequests[0]?.observation).toBe("unknown");
      expect(r.cohort).toMatchObject({ filesCut: 1, unknown: 1, clean: 0 });
      expect(r.paths).toEqual([
        { path: "src/a.ts", merged: 0, conflicted: 0, unknown: 1 },
      ]);
    });

    it("leaves a rebase unknown when one of its commits cannot be read, or one is not mapped", () => {
      const sub = (subject: string) => ({
        subject,
        authoredAt: at(NOW),
        committedAt: at(NOW),
      });
      const rebase = merge(32, {
        mergeCommit: oid("f"),
        commitCount: 2,
        commits: [sub("one"), sub("two")],
      });
      const both = [
        parent(oid("f"), [oid("6")], "two", NOW),
        parent(oid("6"), [oid("5")], "one", NOW),
      ];
      const unread = rated(rebase, both, (c) =>
        c === oid("f") ? ["src/z.ts"] : null,
      );
      expect(unread.pullRequests[0]?.observation).toBe("unknown");
      const lone = rated(rebase, [both[0] as FirstParent], () => ["src/z.ts"]);
      expect(lone.pullRequests[0]?.observation).toBe("unknown");
      const whole = rated(rebase, both, () => ["src/z.ts"]);
      expect(whole.pullRequests[0]?.observation).toBe("clean");
    });
  });

  it("reads back what it wrote, and refuses another schema", () => {
    expect(parseRates(JSON.parse(JSON.stringify(rates)))).toEqual(
      JSON.parse(JSON.stringify(rates)),
    );
    expect(parseRates({ ...rates, schema: "merge-conflicts/v1" })).toBeNull();
    expect(
      parseRates({
        ...rates,
        paths: [{ path: "a", merged: -1, conflicted: 0 }],
      }),
    ).toBeNull();
  });
});

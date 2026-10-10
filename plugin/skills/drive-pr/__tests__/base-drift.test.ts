/**
 * base-drift.test.ts — the base-freshness probe and the predicate the round
 * acts on.
 *
 * Fixture-driven through `probeBaseDrift`'s injected `GitRunner` seam, the
 * same shape round-plan.test.ts uses for `checkLoad()`: no repository, no
 * network, and every git answer stated explicitly so a test asserts what the
 * probe DID with an answer rather than what this machine happened to give it.
 *
 * The properties worth pinning hardest are the ones that decide whether a
 * round spends a reviewer cycle and a Testbox on nothing:
 *
 *   - `overlap`, not `behind`, is the trigger. A base 200 commits ahead over
 *     files this PR never touches must read `no-overlap`.
 *   - a failed fetch degrades to a MARKED measurement, never to a silent zero
 *     — "nothing known to have changed" is not "nothing changed".
 */

import { describe, expect, it } from "bun:test";
import {
  type BaseDrift,
  driftLine,
  driftVerdict,
  type GitRunner,
  OVERLAP_SAMPLE,
  probeBaseDrift,
  verifyCheckoutIsPrHead,
  verifyOriginIsPrRepo,
} from "../scripts/lib/base-drift.ts";

/**
 * A git that answers from a table keyed on the subcommand, plus enough of the
 * argv to tell the two `diff --name-only` calls apart (the PR's side takes one
 * revision, the base's side takes two).
 */
interface Answers {
  fetch?: number;
  mergeBase?: string | null;
  behind?: string | null;
  prFiles?: string[] | null;
  untracked?: string[] | null;
  baseFiles?: string[] | null;
}

function fakeGit(a: Answers): {
  git: GitRunner;
  calls: string[][];
  opts: Array<{ timeoutSec?: number } | undefined>;
} {
  const calls: string[][] = [];
  const opts: Array<{ timeoutSec?: number } | undefined> = [];
  const ok = (stdout: string) => Promise.resolve({ code: 0, stdout });
  const bad = () => Promise.resolve({ code: 1, stdout: "" });
  const git: GitRunner = (args, callOpts) => {
    calls.push(args);
    opts.push(callOpts);
    const sub = args[2] ?? "";
    if (sub === "fetch")
      return Promise.resolve({ code: a.fetch ?? 0, stdout: "" });
    if (sub === "merge-base")
      return a.mergeBase === null ? bad() : ok(`${a.mergeBase ?? "MB"}\n`);
    if (sub === "rev-list")
      return a.behind === null ? bad() : ok(`${a.behind ?? "0"}\n`);
    if (sub === "ls-files")
      return a.untracked === null
        ? bad()
        : ok(`${(a.untracked ?? []).join("\n")}\n`);
    if (sub === "diff") {
      // `diff --no-renames --name-only <mergeBase>` is the PR's side;
      // `... <mergeBase> <baseRef>` is the base's. Keyed on the trailing arg
      // being the base ref itself, not on argv length: a length check would
      // silently start comparing the PR's diff against itself the day a flag
      // is added to both calls in `probeBaseDrift` (coderabbitai, PR #4279).
      const twoRevs = args.at(-1) === "origin/develop";
      const list = twoRevs ? a.baseFiles : a.prFiles;
      return list === null ? bad() : ok(`${(list ?? []).join("\n")}\n`);
    }
    return bad();
  };
  return { git, calls, opts };
}

async function probe(a: Answers) {
  const { git, calls, opts } = fakeGit(a);
  const r = await probeBaseDrift(git, "/repo", "develop", 120);
  return { r, calls, opts };
}

function drift(over: Partial<BaseDrift> = {}): BaseDrift {
  return {
    baseRef: "origin/develop",
    mergeBase: "MB",
    behind: 3,
    prFiles: 4,
    baseFiles: 9,
    overlapCount: 0,
    overlap: [],
    fetched: true,
    ...over,
  };
}

describe("probeBaseDrift", () => {
  it("fetches the base branch before measuring, and bounds that call", async () => {
    const { calls, opts } = await probe({});
    const fetchIndex = calls.findIndex((c) => c[2] === "fetch");
    expect(calls[fetchIndex]).toEqual([
      "-C",
      "/repo",
      "fetch",
      "--quiet",
      "origin",
      "+refs/heads/develop:refs/remotes/origin/develop",
    ]);
    // The bound itself — a regression dropping `{ timeoutSec: fetchSeconds }`
    // from the fetch call would leave every other assertion here green
    // (docomply-review, a reference-implementation pull request).
    expect(opts[fetchIndex]?.timeoutSec).toBe(120);
    // The fetch precedes every measurement — a probe that measured first would
    // be reporting the stale ref it exists to refresh.
    expect(calls[0]?.[2]).toBe("fetch");
  });

  it("bounds every LOCAL call with a deadline too, not just the fetch", async () => {
    const { calls, opts } = await probe({ behind: "1" });
    for (const [i, call] of calls.entries()) {
      if (call[2] === "fetch") continue;
      expect(opts[i]?.timeoutSec).toBeDefined();
      expect(opts[i]?.timeoutSec).toBeGreaterThan(0);
    }
  });

  it("measures the intersection, not the union, of the two changed-file sets", async () => {
    const { r } = await probe({
      behind: "7",
      prFiles: ["a.ts", "b.ts", "c.ts"],
      baseFiles: ["b.ts", "z.ts"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlap).toEqual(["b.ts"]);
    expect(r.drift.overlapCount).toBe(1);
    expect(r.drift.prFiles).toBe(3);
    expect(r.drift.baseFiles).toBe(2);
    expect(r.drift.behind).toBe(7);
  });

  it("counts an UNTRACKED file on the PR side — it blocks a merge exactly like a tracked one", async () => {
    const { r } = await probe({
      behind: "2",
      prFiles: ["a.ts"],
      untracked: ["new.ts"],
      baseFiles: ["new.ts"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlap).toEqual(["new.ts"]);
  });

  it("treats a directory/file collision as overlap even with zero exact-path matches", async () => {
    // The PR adds `foo/bar.ts` (implying `foo` is a directory); the base adds
    // a plain file named `foo`. No path string is shared, so a naive set
    // intersection reads `no-overlap` — but git cannot construct this merge
    // tree either.
    const { r } = await probe({
      behind: "1",
      prFiles: ["foo/bar.ts"],
      baseFiles: ["foo"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlapCount).toBe(1);
    expect(r.drift.overlap).toEqual(["foo"]);
    expect(driftVerdict(r.drift)).toBe("overlapping");
  });

  it("catches the collision from the other direction too — base adds the nested path", async () => {
    const { r } = await probe({
      behind: "1",
      prFiles: ["foo"],
      baseFiles: ["foo/bar.ts"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlapCount).toBe(1);
    expect(r.drift.overlap).toEqual(["foo"]);
  });

  it("does not double-count when a path collision coincides with an exact match", async () => {
    const { r } = await probe({
      behind: "2",
      prFiles: ["foo/bar.ts", "shared.ts"],
      baseFiles: ["foo", "shared.ts"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlapCount).toBe(2);
    expect(r.drift.overlap.sort()).toEqual(["foo", "shared.ts"]);
  });

  it("caps the overlap SAMPLE without capping the count", async () => {
    const many = Array.from(
      { length: OVERLAP_SAMPLE + 5 },
      (_, i) => `f${i}.ts`,
    );
    const { r } = await probe({ behind: "1", prFiles: many, baseFiles: many });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.overlapCount).toBe(OVERLAP_SAMPLE + 5);
    expect(r.drift.overlap).toHaveLength(OVERLAP_SAMPLE);
  });

  it("records a FAILED fetch instead of failing — and marks the measurement stale", async () => {
    const { r } = await probe({ fetch: 1, behind: "0" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.drift.fetched).toBe(false);
    // …and the staleness reaches the operator, on the one verdict whose
    // silence would otherwise be read as "nothing to do".
    expect(driftLine(r.drift)).toContain("cannot confirm");
  });

  it("fails when the merge-base cannot be resolved — there is no measurement to degrade", async () => {
    const { r } = await probe({ mergeBase: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toContain("merge-base");
  });

  it("fails when either changed-file listing fails, rather than reporting an empty overlap", async () => {
    for (const a of [
      { prFiles: null },
      { baseFiles: null },
      { untracked: null },
    ]) {
      const { r } = await probe({ behind: "3", ...a });
      expect(r.ok).toBe(false);
    }
  });

  it("fails on an unreadable commit count rather than treating it as zero", async () => {
    const { git } = fakeGit({});
    const wrapped: GitRunner = (args) =>
      args[2] === "rev-list"
        ? Promise.resolve({ code: 0, stdout: "not-a-number\n" })
        : git(args);
    const r = await probeBaseDrift(wrapped, "/repo", "develop", 120);
    expect(r.ok).toBe(false);
  });

  // `Number.parseInt` alone would read both of these as valid: it stops at
  // the first non-digit rather than rejecting the rest of the string, and a
  // leading '-' still satisfies `Number.isFinite` (docomply-review, a reference-implementation pull request).
  it.each(["2garbage", "-1"])(
    "fails on a malformed commit count %p rather than coercing it",
    async (raw) => {
      const { git } = fakeGit({});
      const wrapped: GitRunner = (args) =>
        args[2] === "rev-list"
          ? Promise.resolve({ code: 0, stdout: `${raw}\n` })
          : git(args);
      const r = await probeBaseDrift(wrapped, "/repo", "develop", 120);
      expect(r.ok).toBe(false);
    },
  );
});

describe("verifyOriginIsPrRepo", () => {
  function fakeOrigin(url: string | null): GitRunner {
    return (args) => {
      if (
        args[2] === "remote" &&
        args[3] === "get-url" &&
        args[4] === "origin"
      ) {
        return url === null
          ? Promise.resolve({ code: 1, stdout: "" })
          : Promise.resolve({ code: 0, stdout: `${url}\n` });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    };
  }

  it("passes when origin fetches exactly the PR-reported repository", async () => {
    const r = await verifyOriginIsPrRepo(
      fakeOrigin("git@github.com:example-org/example-repo.git"),
      "/repo",
      "example-org/example-repo",
    );
    expect(r.ok).toBe(true);
  });

  it("ignores the host — an ssh config alias still matches on owner/name", async () => {
    const r = await verifyOriginIsPrRepo(
      fakeOrigin("git@github-example:example-org/example-repo.git"),
      "/repo",
      "example-org/example-repo",
    );
    expect(r.ok).toBe(true);
  });

  it("refuses when origin fetches a different repository — the fork case", async () => {
    const r = await verifyOriginIsPrRepo(
      fakeOrigin("https://github.com/someone-else/docomply.git"),
      "/repo",
      "example-org/example-repo",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain("someone-else/docomply");
      expect(r.why).toContain("example-org/example-repo");
    }
  });

  it("refuses on an unparseable origin URL rather than guessing", async () => {
    const r = await verifyOriginIsPrRepo(
      fakeOrigin("not-a-url"),
      "/repo",
      "example-org/example-repo",
    );
    expect(r.ok).toBe(false);
  });

  it("refuses when origin has no fetch URL at all", async () => {
    const r = await verifyOriginIsPrRepo(
      fakeOrigin(null),
      "/repo",
      "example-org/example-repo",
    );
    expect(r.ok).toBe(false);
  });
});

describe("verifyCheckoutIsPrHead", () => {
  // Pins the fix for the gap the reviewer named (chatgpt-codex-connector, PR
  // #4279): an ancestor check ALONE is not proof this checkout is the PR's
  // own branch — a sibling branch created from, or later merged with, the
  // PR's head has `apiHead` as an ancestor of its own HEAD too, so an
  // ancestor-only check would pass and publish the sibling's drift as the
  // PR's own. The branch-name check must run, and must run FIRST.

  const HEAD_REF = "feature-branch";
  const API_HEAD = "deadbeefcafe";

  interface Answers {
    branch?: { code: number; stdout: string };
    ancestor?: { code: number; stdout: string };
  }

  function fakeGit(a: Answers): GitRunner {
    return (args) => {
      const sub = args[2] ?? "";
      if (sub === "rev-parse") {
        return Promise.resolve(
          a.branch ?? { code: 0, stdout: `${HEAD_REF}\n` },
        );
      }
      if (sub === "merge-base") {
        return Promise.resolve(a.ancestor ?? { code: 0, stdout: "" });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    };
  }

  it("passes when the checkout is on the PR head branch and HEAD is at or ahead of apiHead", async () => {
    const r = await verifyCheckoutIsPrHead(
      fakeGit({}),
      "/repo",
      HEAD_REF,
      API_HEAD,
    );
    expect(r.ok).toBe(true);
  });

  it("refuses when the checkout is on an unrelated branch, even though it is a descendant of apiHead (the sibling-branch case)", async () => {
    // The exact shape the reviewer named: a sibling branch created from the
    // PR's head. `--is-ancestor` would report success on its own — this
    // fixture never even stubs `merge-base`, so a regression that dropped the
    // branch check would show up as `bad()`'s generic refusal instead of this
    // test's own targeted one, not as a false pass.
    const r = await verifyCheckoutIsPrHead(
      fakeGit({ branch: { code: 0, stdout: "sibling-branch\n" } }),
      "/repo",
      HEAD_REF,
      API_HEAD,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toContain("sibling-branch");
      expect(r.why).toContain(HEAD_REF);
    }
  });

  it("refuses rather than guessing when the branch re-read itself fails to run", async () => {
    const r = await verifyCheckoutIsPrHead(
      fakeGit({ branch: { code: 1, stdout: "" } }),
      "/repo",
      HEAD_REF,
      API_HEAD,
    );
    expect(r.ok).toBe(false);
  });

  it("names a detached HEAD explicitly rather than quoting it as a branch", async () => {
    const r = await verifyCheckoutIsPrHead(
      fakeGit({ branch: { code: 0, stdout: "HEAD\n" } }),
      "/repo",
      HEAD_REF,
      API_HEAD,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("detached HEAD");
  });

  it("refuses when the branch name matches but HEAD is not apiHead or a descendant of it", async () => {
    // A same-named unrelated local branch: the name check alone is not
    // sufficient either, which is why the ancestor check still runs after it.
    const r = await verifyCheckoutIsPrHead(
      fakeGit({ ancestor: { code: 1, stdout: "" } }),
      "/repo",
      HEAD_REF,
      API_HEAD,
    );
    expect(r.ok).toBe(false);
  });
});

describe("driftVerdict", () => {
  it("is in-sync only when the base has not moved", () => {
    expect(driftVerdict(drift({ behind: 0, overlapCount: 0 }))).toBe("in-sync");
    // Even a base that moved over shared files is in-sync at behind 0 — the
    // count IS the "has it moved" question, and `overlapCount` is derived from
    // a diff that is empty when it has not.
    expect(driftVerdict(drift({ behind: 0, overlapCount: 5 }))).toBe("in-sync");
  });

  it("is no-overlap for a base that moved a long way over other files", () => {
    expect(driftVerdict(drift({ behind: 200, overlapCount: 0 }))).toBe(
      "no-overlap",
    );
  });

  it("is overlapping for a base one commit ahead over one shared file", () => {
    expect(driftVerdict(drift({ behind: 1, overlapCount: 1 }))).toBe(
      "overlapping",
    );
  });
});

describe("driftLine", () => {
  it("says nothing at all when in sync and the fetch succeeded", () => {
    expect(driftLine(drift({ behind: 0 }))).toBeNull();
  });

  it("names the count but prescribes nothing when there is no overlap", () => {
    const line = driftLine(drift({ behind: 12, overlapCount: 0 })) ?? "";
    expect(line).toContain("12 commit(s) ahead");
    expect(line).toContain("nothing to merge in");
    expect(line).not.toContain("base-sync.ts");
  });

  it("prescribes base-sync, before the validation plan, when there IS overlap", () => {
    const line =
      driftLine(
        drift({ behind: 4, overlapCount: 2, overlap: ["a.ts", "b.ts"] }),
      ) ?? "";
    expect(line).toContain("a.ts, b.ts");
    expect(line).toContain("base-sync.ts");
    expect(line).toContain("BEFORE resolving the validation plan");
  });

  it("reports the truncated remainder rather than implying the sample is the whole set", () => {
    const line =
      driftLine(drift({ behind: 1, overlapCount: 14, overlap: ["a.ts"] })) ??
      "";
    expect(line).toContain("+13 more");
  });

  it("marks every line from an unfetched measurement as stale", () => {
    for (const d of [
      drift({ behind: 0, fetched: false }),
      drift({ behind: 5, overlapCount: 0, fetched: false }),
      drift({ behind: 5, overlapCount: 1, overlap: ["a.ts"], fetched: false }),
    ]) {
      expect(driftLine(d) ?? "").toContain("stale");
    }
  });
});

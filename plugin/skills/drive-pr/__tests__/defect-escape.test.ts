/**
 * defect-escape.test.ts — the git-backed rename resolver, against a REAL repo.
 *
 * `loop-metrics.test.ts` pins `refindsFor`'s injected-predicate logic, but
 * that predicate is a hand-written stub there — it never exercises the actual
 * `renameHistoryOf`/`renameEquivalents` git walk this skill ships. Breaking
 * either of those entirely left that suite green (chatgpt-codex-connector
 * round 4, PR #4104). These tests close that gap by running the real
 * functions against a throwaway git repository built fresh per test.
 *
 * The repo is built with an explicit `cwd` on every `git` invocation, both
 * the fixture-building ones and the functions under test (`renameHistoryOf`/
 * `renameEquivalents` both take an optional, test-only `cwd`) — never via
 * `process.chdir` or an ambient repo location. A git HOOK's exported
 * `GIT_DIR`/`GIT_WORK_TREE` overrides `cwd`-less invocations and would
 * otherwise point a throwaway `git init` at the CALLER's real worktree
 * instead of the fixture (measured, an earlier change class — see
 * `verification-fit.test.ts`'s own header), so every git call here also
 * scrubs those variables the same way that suite does.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildJsonPayload,
  type Decline,
  type LadderScope,
  ladderDisclosureOf,
  MACRO_PROSE,
  MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET,
  type RenameCandidate,
  renameCandidateKey,
  renameEquivalents,
  renameHistoryFromRevision,
  renameHistoryOf,
  render,
} from "../scripts/defect-escape.ts";
import { baselineDocPath } from "../scripts/lib/escape-baseline.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

// Reuses the production scrubber, not a private copy of `GIT_LOCATION_VARS`.
// This fixture wants "every variable git actually reads for repository
// discovery, scrubbed the way git actually reads it" so its throwaway repos
// stay hermetic, and a private copy — even one sharing the same list — had
// already fallen behind once by re-deleting exact keys, which leaves an
// inherited Windows case variant like `Git_Dir` in place and still able to
// override `cwd` (chatgpt-codex-connector, a reference-implementation pull request; `GIT_NAMESPACE` was the
// same class of drift). It is not a frozen oracle of the production
// list: nothing here asserts its contents, so sharing it cannot make an
// assertion vacuous.
function scrubbedGitEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...gitIdentityEnv(), ...extra } as Record<string, string>;
}

let repo: string;

function execGit(args: string[], extraEnv: Record<string, string> = {}): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(extraEnv),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

/** One commit, with an explicit, deterministic author/committer date. */
function commitAt(iso: string, message: string): void {
  const dateEnv = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  execGit(["commit", "-q", "-m", message], dateEnv);
}

/** The full oid `ref` resolves to right now — used to capture a "reviewed
 * head" mid-fixture, the way `ThreadSample.reviewedHeadOid` captures the
 * commit a thread was actually raised against. */
function revParse(ref: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", ref], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

/** Run `git` in an ARBITRARY directory, not the shared `repo` fixture — used
 * to build a second, genuinely shallow clone of `repo` for the
 * shallow-history tests. */
function execGitIn(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "defect-escape-"));
  execGit(["init", "-q"]);
  execGit(["config", "user.email", "t@t.example"]);
  execGit(["config", "user.name", "Test"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("renameHistoryOf — a real --follow walk", () => {
  it("traces a genuine multi-hop rename with an intervening edit", () => {
    Bun.write(join(repo, "a.ts"), "line1\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    Bun.write(join(repo, "b.ts"), "line1\nline2\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "edit b.ts");

    execGit(["mv", "b.ts", "c.ts"]);
    commitAt("2026-01-04T00:00:00", "rename b to c");

    return renameHistoryOf("c.ts", "HEAD", "", "", repo).then((names) => {
      expect(names).toEqual(["b.ts", "a.ts"]);
    });
  });

  it("stops at a delete/recreate boundary, even though bare --follow does not", async () => {
    // The exact scenario chatgpt-codex-connector reproduced against real git
    // (round 2, PR #4104): a.ts renamed to b.ts, b.ts deleted, then an
    // unrelated file freshly added at b.ts. `--follow` ALONE walks straight
    // through the delete and reports the ORIGINAL rename (verified earlier
    // against real git, outside this suite) — this fixture proves the
    // production code's own status-walk stops it, not a hand-written double
    // of that logic (docomply-review round 6, a reference-implementation pull request: the title previously
    // read "does not stop", describing the bug rather than the fix this test
    // actually asserts against).
    Bun.write(join(repo, "a.ts"), "original content\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    execGit(["rm", "-q", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "delete b.ts");

    Bun.write(join(repo, "b.ts"), "totally unrelated content\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "add unrelated b.ts");

    const names = await renameHistoryOf("b.ts", "HEAD", "", "", repo);
    expect(names).toEqual([]);
  });

  it("bounds the walk by --since, excluding a rename that predates it", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    const bounded = await renameHistoryOf(
      "b.ts",
      "HEAD",
      "2026-01-03T00:00:00Z",
      "",
      repo,
    );
    expect(bounded).toEqual([]);

    const unbounded = await renameHistoryOf("b.ts", "HEAD", "", "", repo);
    expect(unbounded).toEqual(["a.ts"]);
  });

  it("bounds the walk by --until, excluding a rename that postdates it", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-05T00:00:00", "rename a to b");

    const bounded = await renameHistoryOf(
      "b.ts",
      "HEAD",
      "",
      "2026-01-03T00:00:00Z",
      repo,
    );
    expect(bounded).toEqual([]);

    const unbounded = await renameHistoryOf("b.ts", "HEAD", "", "", repo);
    expect(unbounded).toEqual(["a.ts"]);
  });

  it("traces a rename through a non-ASCII pathname (docomply-review round 7)", async () => {
    // Without -z, git C-quotes and octal-escapes a non-ASCII path
    // (`"b-\303\251.ts"` for `b-é.ts`), and a tab-split regex over that
    // output compares the quoted literal against the plain tracked name,
    // which can never match — silently discarding the chain.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b-é.ts"]);
    commitAt("2026-01-02T00:00:00", "rename to non-ASCII name");

    const names = await renameHistoryOf("b-é.ts", "HEAD", "", "", repo);
    expect(names).toEqual(["a.ts"]);
  });

  it("stops at a delete/recreate boundary that falls OUTSIDE the until window (chatgpt-codex-connector round 7)", async () => {
    // a.ts renamed to b.ts (within window); AFTER `until`, b.ts is deleted
    // and an unrelated file is freshly added at b.ts. If the delete/recreate
    // boundary records are skipped merely because they postdate `until`
    // (rather than processed unconditionally and only gated on whether their
    // OWN rename gets added to the output), the walk reaches straight
    // through to the real, but now-unrelated, a.ts->b.ts rename.
    Bun.write(join(repo, "a.ts"), "original\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b (within window)");
    const until = "2026-01-03T00:00:00Z";

    execGit(["rm", "-q", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "delete b.ts (AFTER until)");

    Bun.write(join(repo, "b.ts"), "unrelated recreation\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-05T00:00:00", "add unrelated b.ts (AFTER until)");

    const bounded = await renameHistoryOf("b.ts", "HEAD", "", until, repo);
    expect(bounded).toEqual([]);
  });

  it("does not stop early on a non-monotonic committer date (chatgpt-codex-connector round 7)", async () => {
    // Committer dates are author-controlled metadata, not a traversal-order
    // guarantee: git log --follow's own order can put an older-dated commit
    // BEFORE a younger-dated one. Here the newest commit in the DAG (the
    // tip) is dated Jan 1, while its own parent (the rename that actually
    // connects a.ts to b.ts) is dated Jan 3 — reproduced exactly as the
    // finding describes. A `break` at the first commit older than `since`
    // would hit the Jan-1 tip first and never reach the in-window Jan-3
    // rename sitting right behind it.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-03T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "rename a to b (dated Jan 3)");

    Bun.write(join(repo, "b.ts"), "x\nmore\n");
    execGit(["add", "b.ts"]);
    commitAt(
      "2026-01-01T00:00:00",
      "edit b.ts (the NEWEST commit, dated Jan 1)",
    );

    const names = await renameHistoryOf(
      "b.ts",
      "HEAD",
      "2026-01-02T00:00:00Z",
      "",
      repo,
    );
    expect(names).toEqual(["a.ts"]);
  });
});

describe("renameEquivalents — per-occurrence identity, never collapsed by pathname", () => {
  it("matches a candidate whose own trace shows the decline path", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "2026-01-03T00:00:00Z" },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      null,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });

  it("gives two occurrences of the SAME pathname independent answers rather than collapsing them", async () => {
    // Both candidates below share the literal pathname "b.ts" — the case a
    // Map keyed by pathname alone cannot represent: it can only ever hold
    // ONE anchor per string, so collapsing would apply whichever anchor won
    // the collapse to BOTH occurrences instead of resolving each on its own
    // terms. The two occurrences are constructed to demand DIFFERENT
    // answers so a collapsed implementation cannot pass this by accident:
    // `b.ts`'s real rename-from-`a.ts` event lands strictly between the two
    // candidates' own anchors, so the EARLIER occurrence's own window must
    // exclude it (no match) while the LATER occurrence's window must
    // include it (a match) — from the exact same underlying `git log`
    // history, discriminated only by each candidate's own per-occurrence
    // bound (docomply-review round 5, a reference-implementation pull request — the first version of this
    // fixture accidentally supplied only one candidate and could not have
    // caught this).
    Bun.write(join(repo, "a.ts"), "original\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add original a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-05T00:00:00", "rename original a to b");

    const before: RenameCandidate = {
      path: "b.ts",
      anchor: "2026-01-03T00:00:00Z", // strictly BEFORE the rename
    };
    const after: RenameCandidate = {
      path: "b.ts",
      anchor: "2026-01-10T00:00:00Z", // strictly AFTER the rename
    };
    const renamed = await renameEquivalents(
      "a.ts",
      [before, after],
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      null,
      "",
      "develop",
      repo,
    );
    expect(renamed.size).toBe(1);
    expect(renamed.has(renameCandidateKey(after))).toBe(true);
    expect(renamed.has(renameCandidateKey(before))).toBe(false);
  });

  it("excludes a candidate whose own window predates the connecting rename", async () => {
    // Codex's round-3/4 scenario: an unrelated ORIGINAL b.ts is accepted
    // early, then deleted; a later, unrelated rename creates a second b.ts.
    // The candidate's own anchor (its accepted thread's createdAt) must stay
    // BEFORE that later rename for the match to be correctly excluded.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts (decline anchors here)");

    Bun.write(join(repo, "b.ts"), "unrelated original\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "add unrelated original b.ts");

    execGit(["rm", "-q", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "delete original b.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt(
      "2026-01-04T00:00:00",
      "unrelated later rename creates second b.ts",
    );

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "2026-01-02T12:00:00Z" },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      null,
      "",
      "develop",
      repo,
    );
    expect(renamed.size).toBe(0);
  });
});

describe("renameHistoryFromRevision — ancestry-bounded walk, no date heuristic", () => {
  it("traces a multi-hop rename from a specific headOid, same stop-condition logic as renameHistoryOf", async () => {
    Bun.write(join(repo, "a.ts"), "line1\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    Bun.write(join(repo, "b.ts"), "line1\nline2\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "edit b.ts");

    execGit(["mv", "b.ts", "c.ts"]);
    commitAt("2026-01-04T00:00:00", "rename b to c");
    const headOid = revParse("HEAD");

    const hops = await renameHistoryFromRevision("c.ts", headOid, repo);
    expect(hops).not.toBeNull();
    expect(hops?.map((h) => h.path)).toEqual(["b.ts", "a.ts"]);
  });

  it("cannot see a rename that postdates headOid — ancestry bounds the walk with no --until needed", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");
    const beforeRename = revParse("HEAD");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b, AFTER headOid");

    // Walked from `beforeRename`, not `HEAD`: the rename is not yet an
    // ancestor of that revision, so it must not appear — the same guarantee
    // `renameHistoryOf`'s `--until` gives by filtering dates, given here for
    // free by ancestry instead.
    const hops = await renameHistoryFromRevision("a.ts", beforeRename, repo);
    expect(hops).toEqual([]);
  });

  it("stops at a delete/recreate boundary, same as renameHistoryOf", async () => {
    Bun.write(join(repo, "a.ts"), "original content\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    execGit(["rm", "-q", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "delete b.ts");

    Bun.write(join(repo, "b.ts"), "totally unrelated content\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "add unrelated b.ts");
    const headOid = revParse("HEAD");

    const hops = await renameHistoryFromRevision("b.ts", headOid, repo);
    expect(hops).toEqual([]);
  });

  it("returns null (never a confirmed-empty false rename) for a headOid this clone cannot read", async () => {
    // null, not [] — an unreachable headOid is "cannot tell", not "confirmed
    // no rename" (docomply-review, a reference-implementation pull request round 3).
    const hops = await renameHistoryFromRevision(
      "whatever.ts",
      "0".repeat(40),
      repo,
    );
    expect(hops).toBeNull();
  });
});

describe("renameEquivalents — revision-based match preferred over committer date", () => {
  it("matches via ancestry when both sides carry a reviewedHeadOid", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");
    const declineHeadOid = revParse("HEAD");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");
    const candidateHeadOid = revParse("HEAD");

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });

  it("excludes a rename whose commit predates the decline's own reviewed head", async () => {
    // The revision-based analogue of the `since`-exclusion test above: the
    // rename that connects a.ts to b.ts happened BEFORE the decline's own
    // reviewed head, so that incarnation of the pathname was already gone
    // by the time the decline observed a.ts as a live file — it cannot be
    // the same lineage.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts (unrelated lineage)");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b, BEFORE decline head");
    const candidateHeadOid = revParse("HEAD");

    Bun.write(join(repo, "unrelated.ts"), "y\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-03T00:00:00", "decline anchors here, after the rename");
    const declineHeadOid = revParse("HEAD");

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(renamed.size).toBe(0);
  });

  it("is immune to a backdated committer date that would fool the date-based fallback", async () => {
    // The exact class an earlier change exists for: the rename commit's OWN committer
    // date is set to predate the decline's thread entirely, which a
    // date-filtered `since` bound would read as "before the decline even
    // existed" and wrongly exclude — even though the rename is a genuine,
    // direct CHILD of the decline's own reviewed head in the commit graph.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-06-01T00:00:00", "add a.ts — decline anchors here");
    const declineHeadOid = revParse("HEAD");
    const declineCreatedAt = "2026-06-01T12:00:00Z";

    execGit(["mv", "a.ts", "b.ts"]);
    // Backdated to well BEFORE the decline's own commit, despite being its
    // direct child — exactly the "author-controlled metadata" the reviewer
    // flagged.
    commitAt("2020-01-01T00:00:00", "rename a to b, backdated committer date");
    const candidateHeadOid = revParse("HEAD");
    const candidateCreatedAt = "2026-06-02T00:00:00Z";

    const candidateWithOid: RenameCandidate = {
      path: "b.ts",
      anchor: candidateCreatedAt,
      headOid: candidateHeadOid,
    };
    const revisionBased = await renameEquivalents(
      "a.ts",
      [candidateWithOid],
      "HEAD",
      declineCreatedAt,
      "",
      declineHeadOid,
      declineCreatedAt,
      "develop",
      repo,
    );
    expect(revisionBased.has(renameCandidateKey(candidateWithOid))).toBe(true);

    // The date-based fallback, on the SAME fixture, is exactly the failure
    // this replaces: the backdated commit falls outside `since` and the
    // genuine rename is wrongly excluded.
    const candidateNoOid: RenameCandidate = {
      path: "b.ts",
      anchor: candidateCreatedAt,
    };
    const dateBased = await renameEquivalents(
      "a.ts",
      [candidateNoOid],
      "HEAD",
      declineCreatedAt,
      "",
      null,
      "",
      "develop",
      repo,
    );
    expect(dateBased.size).toBe(0);
  });

  it("falls back to the date-based path per-pair when only one side has a reviewedHeadOid", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");
    const candidateHeadOid = revParse("HEAD");

    // No declineHeadOid (`null`) — falls back to the date-based check, which
    // this fixture's since/anchor bounds are constructed to satisfy, proving
    // the fallback path still runs rather than the pair silently dropping.
    const candidates: RenameCandidate[] = [
      {
        path: "b.ts",
        anchor: "2026-01-03T00:00:00Z",
        headOid: candidateHeadOid,
      },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      null,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });

  it("falls back to the date-based path when the candidate OID is present but unreachable locally", async () => {
    // The class an earlier change found: a merged PR's branch is
    // deleted on GitHub, and the raw pre-squash-merge commit `originalCommit`
    // named is typically unreachable from this clone within days — even
    // though GraphQL still serves its oid. Presence of an OID string is not
    // evidence the revision walk can run; the pair must fall back to
    // `dateMatch`, not silently drop.
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");
    const declineHeadOid = revParse("HEAD");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");

    const unreachableCandidateOid = "1".repeat(40);
    const candidates: RenameCandidate[] = [
      {
        path: "b.ts",
        anchor: "2026-01-03T00:00:00Z",
        headOid: unreachableCandidateOid,
      },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });

  it("falls back to the date-based path when the DECLINE OID is present but unreachable locally", async () => {
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");
    const candidateHeadOid = revParse("HEAD");

    const unreachableDeclineOid = "2".repeat(40);
    const candidates: RenameCandidate[] = [
      {
        path: "b.ts",
        anchor: "2026-01-03T00:00:00Z",
        headOid: candidateHeadOid,
      },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "2026-01-01T00:00:00Z",
      "",
      unreachableDeclineOid,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });
});

describe("renameEquivalents — ancestry direction under squash-merge topology", () => {
  // Every fixture above is a single linear branch, where the "naive"
  // direction (declineHeadOid is an ancestor of the rename) and the actual
  // implementation (the rename is NOT an ancestor of declineHeadOid) agree
  // by construction — there is no branching to expose a difference. Real
  // history is not linear: GitHub deletes a PR's branch on squash-merge, so
  // a PR's own raw commits (what `reviewedHeadOid` names) never become an
  // ancestor of anything else — they are always a dead-end leaf off their
  // own fork point. These fixtures reproduce that shape explicitly, so a
  // regression to the naive direction reddens the FIRST test below (an earlier change
  // review round 1 — mutation-tested against exactly this class of fixture).
  //
  // The two tests are NOT symmetric in what they prove, and their names say
  // so: `isAncestor(rename, declineHeadOid) === true` is DECISIVE (the
  // "excludes" test below) — the rename provably predates the decline's own
  // fork point. `false` is not the mirror-image proof that the rename
  // postdates and RELATES to the decline; it only means ancestry cannot rule
  // it out, which is equally true for a genuinely later, UNRELATED,
  // coincidentally-named rename on a branch the decline's own fork never
  // touched (docomply-review, a reference-implementation pull request round 1 — see `revisionMatch`'s own
  // doc). The "matches" test below exercises that non-excluded case, where
  // this module's established WIDENS-never-NARROWS bias — not a proof of
  // causal relevance — is what produces the match.

  it("does not exclude (WIDENS-never-NARROWS default) when the rename lands on develop after the decline forked its own dead-end branch", async () => {
    Bun.write(join(repo, "unrelated.ts"), "base\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "base: add unrelated.ts");
    const base = revParse("HEAD");

    // The decline's OWN raw branch tip — forked from `base`, and NEVER an
    // ancestor of anything that lands on develop afterward. This is what a
    // squash-merged PR's branch tip looks like once its branch is deleted:
    // reachable only via this exact oid, not via `develop`'s own history.
    execGit(["checkout", "-q", "-b", "decline-branch", base]);
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-02T00:00:00", "decline's own raw PR commit — add a.ts");
    const declineHeadOid = revParse("HEAD");

    // Back on develop: a SEPARATE commit performs the squash-landing of that
    // same content (its own distinct oid — a real squash-merge never
    // fast-forwards through the branch's raw commits), then the rename.
    // `revParse` an existing commit's own branch rather than a hardcoded
    // name — this repo's `init.defaultBranch` may be `master` or `main`
    // depending on the environment's git config.
    execGit(["checkout", "-q", base]);
    execGit(["checkout", "-q", "-B", "develop-line"]);
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt(
      "2026-01-03T00:00:00",
      "squash-landing of an EARLIER, unrelated PR — add a.ts",
    );
    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "squash-landing of the rename PR — a to b");
    const candidateHeadOid = revParse("HEAD");

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(
      renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
    ).toBe(true);
  });

  it("excludes a rename that already landed BEFORE the decline forked its own dead-end branch off it", async () => {
    Bun.write(join(repo, "unrelated.ts"), "base\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "base: add unrelated.ts");

    // An EARLIER, unrelated rename lands on develop first.
    Bun.write(join(repo, "a.ts"), "earlier unrelated content\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-02T00:00:00", "add an earlier, unrelated a.ts");
    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-03T00:00:00", "rename the earlier a.ts to b.ts");
    const candidateHeadOid = revParse("HEAD");

    // The decline forks its OWN dead-end branch AFTER that rename already
    // landed, and observes a FRESH, reused a.ts — unrelated to the one
    // already renamed away. `candidateHeadOid`'s rename IS an ancestor of
    // this branch's fork point, so it cannot be the same lineage.
    execGit(["checkout", "-q", "-b", "decline-branch"]);
    Bun.write(join(repo, "a.ts"), "decline’s own fresh, reused a.ts\n");
    execGit(["add", "a.ts"]);
    commitAt(
      "2026-01-04T00:00:00",
      "decline's own raw PR commit — reused a.ts",
    );
    const declineHeadOid = revParse("HEAD");

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    const renamed = await renameEquivalents(
      "a.ts",
      candidates,
      "HEAD",
      "",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(renamed.size).toBe(0);
  });
});

// The "does not exclude" fixture above is the exact topology where ancestry
// alone cannot order the two branches — genuinely diverged, neither an
// ancestor of the other. These tests reuse it verbatim but add a `gh` PATH
// stub answering the "is this rename commit itself an already-merged PR's
// merge commit" lookup an earlier change added, to exercise the squash-merge
// tiebreaker that now runs before falling back to WIDENS in that exact case.
// Stubbed via a PATH shim (the `resolvePr` convention in
// self-inflicted.test.ts), never `mock.module` — `gh` is a real subprocess
// this code spawns, and a PATH shim is what lets the SAME production
// `ghCall` run unmodified against a script that reports what it actually
// received.
describe("renameEquivalents — squash-merge merged_at tiebreaker when ancestry cannot decide", () => {
  let stubBinDir: string;

  // The decline's own PR base ref for every test in this block — real
  // production code reads this from `PrSample.baseRefName`; here it is the
  // value `mergeCommitMergedAt` must see echoed back as `base.ref` in the
  // stubbed `gh api .../pulls` response before it will trust a `merged_at`
  // (docomply-review, a reference-implementation pull request round 2).
  const baseRefName = "develop";

  function stubGh(script: string): void {
    stubBinDir = mkdtempSync(join(tmpdir(), "defect-escape-gh-stub-"));
    const ghPath = join(stubBinDir, "gh");
    const guard = `#!/usr/bin/env bash
if [[ "$#" -ne 2 || "$1" != api ||
      ! "$2" =~ ^repos/[{]owner[}]/[{]repo[}]/commits/[[:xdigit:]]{40}/pulls$ ]]; then
  echo "gh-stub: unexpected command or flag: $*" >&2; exit 2
fi
`;
    writeFileSync(ghPath, guard + script);
    chmodSync(ghPath, 0o755);
  }

  async function withStubPath<T>(fn: () => Promise<T>): Promise<T> {
    const original = process.env.PATH;
    process.env.PATH = `${stubBinDir}:${original ?? ""}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = original;
      rmSync(stubBinDir, { recursive: true, force: true });
    }
  }

  it("rejects empty and slash-containing commit segments before serving a fixture", async () => {
    stubGh("echo fixture\n");
    await withStubPath(async () => {
      const ghPath = join(stubBinDir, "gh");
      for (const endpoint of [
        "repos/{owner}/{repo}/commits//pulls",
        `repos/{owner}/{repo}/commits/${"a".repeat(40)}/extra/pulls`,
      ]) {
        const result = Bun.spawnSync([ghPath, "api", endpoint]);
        expect(result.exitCode).toBe(2);
        expect(result.stdout.toString()).toBe("");
      }
    });
  });

  /** Builds the genuinely-diverged-branch topology shared by every test in
   * this block: a decline that forks its own dead-end branch, and a
   * SEPARATE develop-side lineage that later squash-lands an unrelated PR
   * and then the rename PR — the exact fixture the "does not exclude"
   * test above uses. The decline thread's own `createdAt` is NOT built into
   * the fixture: each test passes its own value straight to
   * `renameEquivalents`, so it can place it on either side of the stubbed
   * `merged_at` without rebuilding the topology. */
  function buildDivergedRenameFixture(): {
    declineHeadOid: string;
    candidateHeadOid: string;
  } {
    Bun.write(join(repo, "unrelated.ts"), "base\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "base: add unrelated.ts");
    const base = revParse("HEAD");

    execGit(["checkout", "-q", "-b", "decline-branch", base]);
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-02T00:00:00", "decline's own raw PR commit — add a.ts");
    const declineHeadOid = revParse("HEAD");

    execGit(["checkout", "-q", base]);
    execGit(["checkout", "-q", "-B", "develop-line"]);
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt(
      "2026-01-03T00:00:00",
      "squash-landing of an EARLIER, unrelated PR — add a.ts",
    );
    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "squash-landing of the rename PR — a to b");
    const candidateHeadOid = revParse("HEAD");

    return { declineHeadOid, candidateHeadOid };
  }

  afterEach(() => {
    // Best-effort: most tests already clean up via `withStubPath`'s own
    // `finally`. A test that throws before reaching it would otherwise leak
    // the temp dir — `rmSync` on an already-removed path is a silent no-op
    // under `force: true`.
    if (stubBinDir !== undefined) {
      rmSync(stubBinDir, { recursive: true, force: true });
    }
  });

  it("excludes when the rename commit is itself an already-merged PR whose real merged_at predates the decline thread — non-forgeable, where ancestry alone could not decide", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    // The stubbed merge commit's real `merged_at` predates the decline
    // thread's own `createdAt` below — decisive exclude via wall-clock
    // order, the tiebreaker an earlier change adds. `base.ref` matches this block's
    // own `baseRefName` so `mergeCommitMergedAt` accepts the entry.
    stubGh(`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/commits/${candidateHeadOid}/pulls" ]; then
  echo '[{"merge_commit_sha":"${candidateHeadOid}","merged_at":"2026-01-05T00:00:00Z","base":{"ref":"${baseRefName}"}}]'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
      expect(renamed.size).toBe(0);
    });
  });

  it("still WIDENS when the merge commit's PR targeted a DIFFERENT base ref than the decline's own — a matching merge_commit_sha alone must not decide (docomply-review, a reference-implementation pull request round 2)", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    // Identical to the "excludes" fixture above — same predating `merged_at`,
    // which WOULD decisively exclude if the base ref were ignored — except
    // this PR's own `base.ref` is a DIFFERENT branch than the decline's
    // `baseRefName`. `merge_commit_sha` matching this commit only proves the
    // commit was SOME PR's merge commit, never that it was merged into the
    // branch the decline itself is based against; without the base-ref
    // check, a squash-merge into an unrelated release/feature branch could
    // manufacture a decisive-looking `merged_at` for a rename that never
    // reached the decline's own branch at all.
    stubGh(`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/commits/${candidateHeadOid}/pulls" ]; then
  echo '[{"merge_commit_sha":"${candidateHeadOid}","merged_at":"2026-01-05T00:00:00Z","base":{"ref":"release/demo-stable"}}]'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    });
  });

  it("still WIDENS when the decline thread carries no readable createdAt, even though the sweep's own widened `since` (the containing PR's mergedAt) would have decided differently (docomply-review, a reference-implementation pull request round 2)", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    // The class the reviewer flagged: `renameEquivalents`'s own `since` is
    // permissive by design (`t.createdAt ?? merged`), so a decline thread
    // with no readable `createdAt` reaches this function with `since` set to
    // its containing PR's LATER `mergedAt` instead. The stubbed `merged_at`
    // below predates that widened `since` — if it ever leaked into the
    // tiebreaker as `declineCreatedAt`, it would decisively (and wrongly)
    // exclude this candidate. Passing the real, empty `declineCreatedAtStrict`
    // here (never `since`) must leave the tiebreaker unable to decide at all.
    const widenedSince = "2026-01-20T00:00:00Z"; // stands in for the PR's mergedAt
    stubGh(`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/commits/${candidateHeadOid}/pulls" ]; then
  echo '[{"merge_commit_sha":"${candidateHeadOid}","merged_at":"2026-01-05T00:00:00Z","base":{"ref":"${baseRefName}"}}]'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        widenedSince,
        "",
        declineHeadOid,
        // The thread's own, unwidened `createdAt` — unknown here, so `''`,
        // NEVER `widenedSince`.
        "",
        baseRefName,
        repo,
      );
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    });
  });

  it("still WIDENS (does not exclude) when the real merged_at POSTdates the decline thread — consistent with a genuine recurrence, not proof of one", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    stubGh(`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/commits/${candidateHeadOid}/pulls" ]; then
  echo '[{"merge_commit_sha":"${candidateHeadOid}","merged_at":"2026-01-20T00:00:00Z","base":{"ref":"${baseRefName}"}}]'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-01T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-01T00:00:00Z",
        baseRefName,
        repo,
      );
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    });
  });

  it("still WIDENS when gh reports the rename commit is not any PR's own merge commit", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    // A well-formed, empty answer — the common case, per the production
    // function's own doc: most hops are ordinary in-branch commits, never
    // anyone's merge commit.
    stubGh(`#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/{owner}/{repo}/commits/${candidateHeadOid}/pulls" ]; then
  echo '[]'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    });
  });

  it("still WIDENS when the gh lookup itself fails (network/auth failure — fails to WIDENS, never to a silent exclude)", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    stubGh(`#!/bin/sh
echo "gh-stub: simulated failure" >&2
exit 1
`);

    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
    ];
    await withStubPath(async () => {
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    });
  });

  it("does not re-hit the network for a second candidate sharing the same failing hop (docomply-review + chatgpt-codex-connector, a reference-implementation pull request round 3)", async () => {
    const { declineHeadOid, candidateHeadOid } = buildDivergedRenameFixture();
    // `stubGh` mints its own dir per test, so the counter file lives inside
    // the throwaway repo instead — created fresh by `beforeEach`, removed by
    // `afterEach`.
    const counterPath = join(repo, "gh-calls");
    stubGh(`#!/bin/sh
echo call >> '${counterPath}'
echo "gh-stub: simulated failure" >&2
exit 1
`);

    // Two distinct candidate OCCURRENCES (different \`anchor\`, so they are
    // not deduplicated by \`renameCandidateKey\`) that both resolve to the
    // IDENTICAL rename hop — the same \`candidateHeadOid\`, hence the same
    // \`mergeCommitMergedAt\` cache key. This is exactly the shape the finding
    // named: several candidates in one sweep sharing one hop.
    const candidates: RenameCandidate[] = [
      { path: "b.ts", anchor: "", headOid: candidateHeadOid },
      {
        path: "b.ts",
        anchor: "2026-02-01T00:00:00Z",
        headOid: candidateHeadOid,
      },
    ];
    await withStubPath(async () => {
      await renameEquivalents(
        "a.ts",
        candidates,
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
    });
    const calls = readFileSync(counterPath, "utf8")
      .trim()
      .split("\n")
      .filter((l: string) => l.length > 0);
    // Exactly one network call for both candidates — the second must be
    // served from the short-lived negative cache, not a fresh deadline.
    expect(calls.length).toBe(1);
  });

  it('short-circuits a brand-new distinct hop once the sweep-wide failure budget is spent (chatgpt-codex-connector, a reference-implementation pull request round 3: "distinct hops necessarily do likewise")', async () => {
    const counterPath = join(repo, "gh-calls");
    stubGh(`#!/bin/sh
echo call >> '${counterPath}'
echo "gh-stub: simulated failure" >&2
exit 1
`);

    Bun.write(join(repo, "unrelated.ts"), "base\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "base: add unrelated.ts");
    const base = revParse("HEAD");

    /** One independent diverged-branch rename fixture, isolated by index so
     * each produces a genuinely distinct `candidateHeadOid` (and therefore a
     * distinct `mergeCommitMergedAt` cache key) sharing the common `base`
     * above. Mirrors `buildDivergedRenameFixture`, parametrized. */
    function buildAt(i: number): {
      declineHeadOid: string;
      candidateHeadOid: string;
    } {
      const a = `a${i}.ts`;
      const b = `b${i}.ts`;
      execGit(["checkout", "-q", "-b", `decline-branch-${i}`, base]);
      Bun.write(join(repo, a), "x\n");
      execGit(["add", a]);
      commitAt("2026-01-02T00:00:00", `decline's own raw PR commit — add ${a}`);
      const declineHeadOid = revParse("HEAD");

      execGit(["checkout", "-q", base]);
      execGit(["checkout", "-q", "-B", `develop-line-${i}`]);
      Bun.write(join(repo, a), "x\n");
      execGit(["add", a]);
      commitAt(
        "2026-01-03T00:00:00",
        `squash-landing of an EARLIER, unrelated PR — add ${a}`,
      );
      execGit(["mv", a, b]);
      commitAt(
        "2026-01-04T00:00:00",
        `squash-landing of the rename PR — ${a} to ${b}`,
      );
      const candidateHeadOid = revParse("HEAD");

      return { declineHeadOid, candidateHeadOid };
    }

    // One `renameEquivalents` call per fixture mirrors production exactly:
    // each decline thread in a sweep makes its own call.
    const budget = MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET;
    await withStubPath(async () => {
      for (let i = 0; i < budget; i++) {
        const { declineHeadOid, candidateHeadOid } = buildAt(i);
        await renameEquivalents(
          `a${i}.ts`,
          [{ path: `b${i}.ts`, anchor: "", headOid: candidateHeadOid }],
          "HEAD",
          "2026-01-10T00:00:00Z",
          "",
          declineHeadOid,
          "2026-01-10T00:00:00Z",
          baseRefName,
          repo,
        );
      }
      const callsAtBudget = readFileSync(counterPath, "utf8")
        .trim()
        .split("\n")
        .filter((l: string) => l.length > 0).length;
      expect(callsAtBudget).toBe(budget);

      // One more, on a hop the breaker has never seen before — it must be
      // skipped without touching the network at all.
      const { declineHeadOid, candidateHeadOid } = buildAt(budget);
      await renameEquivalents(
        `a${budget}.ts`,
        [{ path: `b${budget}.ts`, anchor: "", headOid: candidateHeadOid }],
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
      const callsAfterBudget = readFileSync(counterPath, "utf8")
        .trim()
        .split("\n")
        .filter((l: string) => l.length > 0).length;
      expect(callsAfterBudget).toBe(budget);
    });
  });

  it("a conclusive response resets the failure budget instead of it accumulating toward a permanent trip (docomply-review, a reference-implementation pull request round 5)", async () => {
    const counterPath = join(repo, "gh-calls");
    // Fails on every call except the `budget`-th, which returns a
    // well-formed (if empty) response — the "conclusive success" the fix
    // resets the count on. If the reset did not happen, the four failures
    // that follow it would combine with the four already recorded to reach
    // the budget and trip the breaker prematurely.
    stubGh(`#!/bin/sh
echo call >> '${counterPath}'
n=$(wc -l < '${counterPath}' | tr -d ' ')
if [ "$n" = "${MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET}" ]; then
  echo '[]'
  exit 0
fi
echo "gh-stub: simulated failure" >&2
exit 1
`);

    Bun.write(join(repo, "unrelated.ts"), "base\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "base: add unrelated.ts");
    const base = revParse("HEAD");

    // Same shape as `buildAt` above: one independent diverged-branch rename
    // fixture per index, isolated so each produces a genuinely distinct
    // `candidateHeadOid` (and therefore a distinct `mergeCommitMergedAt`
    // cache key) while sharing the common `base` — and therefore the same
    // `cwd`-keyed budget counter.
    function buildAt(i: number): {
      declineHeadOid: string;
      candidateHeadOid: string;
    } {
      const a = `a${i}.ts`;
      const b = `b${i}.ts`;
      execGit(["checkout", "-q", "-b", `decline-branch-${i}`, base]);
      Bun.write(join(repo, a), "x\n");
      execGit(["add", a]);
      commitAt("2026-01-02T00:00:00", `decline's own raw PR commit — add ${a}`);
      const declineHeadOid = revParse("HEAD");

      execGit(["checkout", "-q", base]);
      execGit(["checkout", "-q", "-B", `develop-line-${i}`]);
      Bun.write(join(repo, a), "x\n");
      execGit(["add", a]);
      commitAt(
        "2026-01-03T00:00:00",
        `squash-landing of an EARLIER, unrelated PR — add ${a}`,
      );
      execGit(["mv", a, b]);
      commitAt(
        "2026-01-04T00:00:00",
        `squash-landing of the rename PR — ${a} to ${b}`,
      );
      const candidateHeadOid = revParse("HEAD");

      return { declineHeadOid, candidateHeadOid };
    }

    async function hopAt(i: number): Promise<void> {
      const { declineHeadOid, candidateHeadOid } = buildAt(i);
      await renameEquivalents(
        `a${i}.ts`,
        [{ path: `b${i}.ts`, anchor: "", headOid: candidateHeadOid }],
        "HEAD",
        "2026-01-10T00:00:00Z",
        "",
        declineHeadOid,
        "2026-01-10T00:00:00Z",
        baseRefName,
        repo,
      );
    }

    function callCount(): number {
      return readFileSync(counterPath, "utf8")
        .trim()
        .split("\n")
        .filter((l: string) => l.length > 0).length;
    }

    await withStubPath(async () => {
      const budget = MERGE_COMMIT_MERGED_AT_FAILURE_BUDGET;
      // budget - 1 failures, then the one conclusive success (the
      // budget-th call) — never enough failures in a row to trip.
      for (let i = 0; i < budget; i++) {
        await hopAt(i);
      }
      expect(callCount()).toBe(budget);

      // budget - 1 MORE failures. If the success above had not reset the
      // count, these would combine with the pre-reset failures and trip the
      // breaker here, short-circuiting the last of these calls.
      for (let i = budget; i < budget + budget - 1; i++) {
        await hopAt(i);
      }
      expect(callCount()).toBe(budget + budget - 1);

      // One more failure — the budget-th since the reset — trips it.
      await hopAt(budget + budget - 1);
      expect(callCount()).toBe(budget + budget);

      // And the next distinct hop is short-circuited, same as the sibling
      // "short-circuits a brand-new distinct hop" test above.
      await hopAt(budget + budget);
      expect(callCount()).toBe(budget + budget);
    });
  });
});

describe("renameCandidateKey — headOid is part of candidate identity", () => {
  it("is collision-safe against a path containing a space (docomply-review, a reference-implementation pull request round 3)", () => {
    // A plain `${path} ${anchor} ${headOid}` join is not collision-safe: a
    // git path CAN contain a space, so {path: "a", anchor:
    // "2026-01-01T00:00:00Z"} and {path: "a 2026-01-01T00:00:00Z", anchor:
    // ""} produced the identical joined string despite being two different
    // candidates.
    const a: RenameCandidate = { path: "a", anchor: "2026-01-01T00:00:00Z" };
    const b: RenameCandidate = {
      path: "a 2026-01-01T00:00:00Z",
      anchor: "",
    };
    expect(renameCandidateKey(a)).not.toBe(renameCandidateKey(b));
  });

  it("gives two occurrences sharing the same (path, anchor) but different headOid independent answers", async () => {
    // The composite key used to be (path, anchor) only. Two comments can
    // share a literal pathname AND the same to-the-second createdAt — not
    // far-fetched for a bot review posting several inline comments in one
    // batched submission — while carrying different originalCommit oids,
    // which changes whether revisionMatch accepts or excludes each one
    // independently (docomply-review, a reference-implementation pull request round 2).
    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-01T00:00:00", "add a.ts");
    const declineHeadOid = revParse("HEAD");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt("2026-01-02T00:00:00", "rename a to b");
    const candidateHeadOid = revParse("HEAD");

    // Both candidates share the exact same path AND anchor.
    const sharedAnchor = "2026-01-01T12:00:00Z";
    const withOid: RenameCandidate = {
      path: "b.ts",
      anchor: sharedAnchor,
      headOid: candidateHeadOid,
    };
    // No headOid: falls back to dateMatch, whose `until` (this candidate's
    // own anchor) predates the rename's committer date — excluded.
    const withoutOid: RenameCandidate = { path: "b.ts", anchor: sharedAnchor };

    const renamed = await renameEquivalents(
      "a.ts",
      [withOid, withoutOid],
      "HEAD",
      "",
      "",
      declineHeadOid,
      "",
      "develop",
      repo,
    );
    expect(renamed.size).toBe(1);
    expect(renamed.has(renameCandidateKey(withOid))).toBe(true);
    expect(renamed.has(renameCandidateKey(withoutOid))).toBe(false);
  });
});

describe("renameEquivalents — falls back on a shallow clone", () => {
  it("recovers via dateMatch when the candidate OID is fetched shallow but tip is fetched full", async () => {
    // A shallow clone's `git log --follow` does not error when it runs off
    // the fetched history — it stops at the grafted boundary commit, which
    // git can only diff against an EMPTY tree (no parent to compare), so
    // `--name-status` reports the boundary commit's own files as a plain
    // `A` (add), never an `R` (rename) — the rename that actually connects
    // a.ts to b.ts becomes invisible, not an error (chatgpt-codex-connector,
    // a reference-implementation pull request round 3).
    //
    // This is the real shape a CI checkout produces: `origin/develop` is
    // fetched at whatever depth the job configured (often full, or at least
    // deep), while a PR's OWN branch tip is fetched SEPARATELY — often much
    // shallower — so the SAME rename commit can be fully visible walking
    // from `tip` while being invisible walking from `candidateHeadOid`,
    // even though both point into the SAME clone. Reproduced against real
    // git, not asserted.
    Bun.write(join(repo, "unrelated.ts"), "x\n");
    execGit(["add", "unrelated.ts"]);
    commitAt("2026-01-01T00:00:00", "commit0: develop base");
    const declineHeadOid = revParse("HEAD");

    Bun.write(join(repo, "a.ts"), "x\n");
    execGit(["add", "a.ts"]);
    commitAt("2026-01-02T00:00:00", "commit1: add a.ts");

    execGit(["mv", "a.ts", "b.ts"]);
    commitAt(
      "2026-01-03T00:00:00",
      "commit2: rename a to b (squash-landed on develop)",
    );

    Bun.write(join(repo, "b.ts"), "x\nmore\n");
    execGit(["add", "b.ts"]);
    commitAt("2026-01-04T00:00:00", "commit3: develop tip");
    const developTip = revParse("HEAD");

    // The candidate's OWN PR branch forks from develop's tip.
    execGit(["checkout", "-q", "-b", "candidate-branch"]);
    Bun.write(join(repo, "unrelated2.ts"), "z\n");
    execGit(["add", "unrelated2.ts"]);
    commitAt("2026-01-05T00:00:00", "candidate's own PR commit");
    const candidateHeadOid = revParse("HEAD");

    const shallow = mkdtempSync(join(tmpdir(), "defect-escape-shallow-"));
    try {
      execGitIn(shallow, ["init", "-q"]);
      execGitIn(shallow, ["remote", "add", "origin", repo]);
      // develop's tip: fetched FULL (no depth limit) — sees the real rename.
      execGitIn(shallow, ["fetch", "-q", "origin", developTip]);
      // the candidate's own head: fetched SEPARATELY and SHALLOW — becomes
      // a parentless graft in this clone, even though its true history (in
      // `repo`) does include the rename.
      execGitIn(shallow, [
        "fetch",
        "-q",
        "--depth",
        "1",
        "origin",
        candidateHeadOid,
      ]);

      const candidates: RenameCandidate[] = [
        { path: "b.ts", anchor: "", headOid: candidateHeadOid },
      ];
      const renamed = await renameEquivalents(
        "a.ts",
        candidates,
        developTip,
        "",
        "",
        declineHeadOid,
        "",
        "develop",
        shallow,
      );
      // Without the shallow guard, `revisionMatch` would walk
      // candidateHeadOid's (truncated) history, find no rename hop, and
      // return a DEFINITIVE `false` — which short-circuits `renamed ??
      // dateMatch(...)` in `renameEquivalents` (`false` is not nullish, so
      // the date-based fallback is never even attempted). With the guard,
      // `revisionMatch` returns `null` instead, and `dateMatch` — walking
      // from `developTip`, whose history IS complete in this clone — finds
      // the real rename.
      expect(
        renamed.has(renameCandidateKey(candidates[0] as RenameCandidate)),
      ).toBe(true);
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
  });
});

describe("--ladder-only fails closed on an unresolvable marker", () => {
  const SCRIPT = join(import.meta.dir, "..", "scripts", "defect-escape.ts");

  /**
   * Spawned with the ladder config pointed somewhere it is NOT, and with the
   * marker resolution happening BEFORE any GitHub call — so this probe never
   * touches the network, and a regression that moved the resolution after the
   * sweep would show up as a hang or a `gh` error rather than this exit.
   */
  const run = (
    configPath: string,
  ): { code: number; stdout: string; stderr: string } => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "GIT_DIR" && k !== "GIT_WORK_TREE")
        env[k] = v;
    }
    env.GROUNDWORK_REVIEW_TRIAGE_CONFIG = configPath;
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "--since",
        "2026-08-06",
        "--until",
        "2026-08-13",
        "--ladder-only",
      ],
      { encoding: "utf8", env },
    );
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };

  it("refuses rather than reporting an unfiltered or empty sample", () => {
    const r = run(join(tmpdir(), "no-such-review-triage.yaml"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("could not resolve");
    // The dangerous alternative is a clean, empty sample — which a reader
    // takes as "the ladder declined nothing that came back".
    expect(r.stdout).toBe("");
  });

  it("refuses on a config that parses but is not a valid ladder", () => {
    const dir = mkdtempSync(join(tmpdir(), "ladder-escape-"));
    try {
      const p = join(dir, "review-triage.yaml");
      writeFileSync(p, "version: 2\n");
      const r = run(p);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// `Decline.category`, threaded from `ThreadSample.category` at
// `declines.push(...)` and printed by `render()`. `render()` is a pure
// function of a `Decline[]` and needs no repository, unlike this file's other
// tests — a minimal fixture is enough to pin the wiring and the render format.
describe("render — the per-decline category tag", () => {
  function decline(over: Partial<Decline> = {}): Decline {
    return {
      pr: 42,
      prTitle: "a pr",
      mergedAt: "2026-08-01T00:00:00Z",
      outcome: "wont-fix",
      path: "a.ts",
      line: 10,
      reason: "declined on effort",
      category: "unknown",
      url: "https://example.invalid/1",
      startedBy: "a-human",
      declinedAt: "2026-08-01T01:00:00Z",
      supersededCandidate: false,
      refoundIn: [],
      followUps: [],
      laterFixCommits: [],
      ...over,
    };
  }

  it("prints the decline’s own category next to its outcome", () => {
    const out = render(
      [decline({ category: "security" })],
      "2026-08-01",
      "2026-08-07",
      1,
      false,
      0,
      0,
      0,
      null,
    );
    expect(out).toContain("[wont-fix/security]");
  });

  it("prints unknown for a decline whose finding carried no category tag", () => {
    const out = render(
      [decline({ category: "unknown" })],
      "2026-08-01",
      "2026-08-07",
      1,
      false,
      0,
      0,
      0,
      null,
    );
    expect(out).toContain("[wont-fix/unknown]");
  });

  it("points the reader at the consumer's baseline document", () => {
    const out = render(
      [decline({})],
      "2026-08-01",
      "2026-08-07",
      1,
      false,
      0,
      0,
      0,
      null,
    );
    const tail = out.trimEnd().split("\n").at(-1)?.trim();
    expect(tail).toBe(baselineDocPath());
  });
});

// `--ladder-only` matches a decline by its trailing public marker
// line, which proves the reply ENDS WITH the marker, not that
// `triage-ladder.ts` generated it. That residual is not closable by any
// recognizer (rule 3, `.claude/rules/document-scanning-gates.md`), so it was
// settled as an explicit scope decision instead — and rule 6 requires the
// scope of a structural verdict to be stated in the GATE'S OWN OUTPUT, not
// only in its source comments, because the reader who over-reads it is
// reading the summary. These probes are what keeps that statement from being
// dropped in a later render rewrite.
describe("render — --ladder-only states the scope of its own verdict (rule 6)", () => {
  function decline(over: Partial<Decline> = {}): Decline {
    return {
      pr: 42,
      prTitle: "a pr",
      mergedAt: "2026-08-01T00:00:00Z",
      outcome: "wont-fix",
      path: "a.ts",
      line: 10,
      reason: "declined on effort",
      category: "unknown",
      url: "https://example.invalid/1",
      startedBy: "a-human",
      declinedAt: "2026-08-01T01:00:00Z",
      supersededCandidate: false,
      refoundIn: [],
      followUps: [],
      laterFixCommits: [],
      ...over,
    };
  }

  const scoped = (over: Partial<LadderScope> = {}, declineCount = 1): string =>
    render(
      Array.from({ length: declineCount }, () => decline()),
      "2026-08-01",
      "2026-08-07",
      1,
      false,
      0,
      0,
      0,
      {
        marker: "review-triage ladder",
        excluded: 3,
        macroShaped: 1,
        ...over,
      },
    );

  it("says the narrowing derives marker presence, not ladder provenance", () => {
    const out = scoped();
    expect(out).toContain("MARKER PRESENCE, not ladder provenance");
    // The concrete reason, so the disclaimer is falsifiable rather than
    // ritual: the marker is public reply text anyone can copy.
    expect(out).toContain("public reply text");
  });

  it("names the bias direction as TIGHTENING, which is the counter-intuitive one", () => {
    // The direction is the opposite of the reassuring reading, and getting it
    // backwards is how a reader dismisses a polluted series. A copied marker
    // inflates the escape rate's DENOMINATOR, so escapes look rarer — and
    // `review-loop-baseline.md` § What this licenses reads a LOW escape rate
    // as evidence FOR declining more ("evidence for an earlier change's direction"),
    // while `review-triage.yaml` § calibration treats an escape as the signal
    // that a band is too strict. Pollution therefore licenses declining MORE.
    //
    // This probe exists because the first version of this output asserted the
    // exact inverse ("loosens the ladder, never tightens it") — a claim false
    // of the mechanism beside it, printed to the operator. Pinning the
    // direction is what stops that regressing.
    const out = scoped();
    expect(out).toContain("licenses declining MORE, not less");
    expect(out).not.toContain("loosens the ladder");
  });

  it("names the owner of the truth question rather than stopping at the disclaimer", () => {
    // Rule 6 explicitly refuses a scope statement that stands in for an
    // owner: this one points at the monthly calibration read, which has a
    // cadence and a place a polluted series would be noticed.
    expect(scoped()).toContain(".config/review-triage.yaml § calibration");
  });

  it("reports the per-run macro-prose ratio, but never derives a clean-pollution verdict from equality", () => {
    // The one-off measurement that settled the scope decision is worth
    // nothing a month later, so the same check runs every time. Equal counts
    // are reported as matching the TEMPLATE SHAPE, not as proof of clean
    // provenance — `LadderScope.macroShaped`'s own doc comment concedes a
    // hand-written decline that copies the whole macro clause counts here
    // too, so equality can never license "no pollution visible" (
    // docomply-review a reference-implementation pull request). Anything less than equality still sends the
    // reader to the replies.
    expect(scoped({ macroShaped: 1 })).toContain(
      "1/1 carry triage-ladder.ts's rendered prose",
    );
    expect(scoped({ macroShaped: 1 })).toContain(
      "matches the rendered template shape",
    );
    expect(scoped({ macroShaped: 1 })).not.toContain("no pollution visible");
    expect(scoped({ macroShaped: 0 })).toContain("READ THE REMAINDER BY HAND");
    expect(scoped({ macroShaped: 0 })).not.toContain(
      "matches the rendered template shape",
    );
  });

  it("does not claim a template-shape match on an empty sample (0/0)", () => {
    // `--ladder-only` admitting zero declines makes both `macroShaped` and
    // `declines.length` zero, and `0 === 0` is true — without the explicit
    // `declines.length > 0` guard this reads as "(matches the rendered
    // template shape)" for a sample that provides no evidence at all
    // (docomply-review a reference-implementation pull request).
    const out = scoped({ macroShaped: 0 }, 0);
    expect(out).toContain("0/0");
    expect(out).toContain("READ THE REMAINDER BY HAND");
    expect(out).not.toContain("matches the rendered template shape");
  });

  // The reported ratio is only worth printing if `MACRO_PROSE` actually
  // separates the two populations, so it is pinned from both sides: the
  // decoy the issue named must not count, and the config's CURRENT rendered
  // templates must. The second half is what catches a reword of the clause
  // itself — that would silently drive the reported count toward zero and
  // read as pollution where there is none.
  describe("MACRO_PROSE separates macro output from a copied marker line", () => {
    const MARKER = "\n\n<!-- review-triage ladder -->";

    it("does not count a hand-written decline that copied only the marker", () => {
      // Verbatim from an earlier change's problem statement — the decoy that motivates
      // the whole scope decision.
      expect(
        MACRO_PROSE.test(`**wont-fix** — ordinary rubric decline.${MARKER}`),
      ).toBe(false);
      // Mentioning the ladder in prose is not being generated by it.
      expect(
        MACRO_PROSE.test(
          `**wont-fix** — this predates the review-triage ladder entirely.${MARKER}`,
        ),
      ).toBe(false);
      // Nearest miss: the macro's opening clause without the band/round
      // parenthetical that only the macro emits.
      expect(
        MACRO_PROSE.test(
          `**wont-fix** — declined by the review-triage ladder.${MARKER}`,
        ),
      ).toBe(false);
    });

    it("counts a triage config's own rendered templates", async () => {
      // Rendered from a triage config (the review skill's fixture) rather than hand-copied:
      // the config is an independent source of truth here (the recognizer
      // does not read it), so this is a real cross-check, not a tautology.
      // Parsed with the YAML loader rather than grepped — a block scalar's
      // continuation lines are exactly what a line-anchored regex drops, and
      // dropping them here would leave the probe asserting a prefix that
      // matches nothing like the real reply.
      const yaml = (await import("js-yaml")) as {
        load: (s: string) => unknown;
      };
      const cfg = yaml.load(
        readFileSync(
          join(
            import.meta.dirname,
            "../../resolve-review-comments/__tests__/fixtures/review-triage.yaml",
          ),
          "utf8",
        ),
      ) as { reply?: Record<string, unknown> };
      const templates = [cfg.reply?.wont_fix, cfg.reply?.deferred].filter(
        (t): t is string => typeof t === "string",
      );
      // Fail closed: a config shape this probe cannot read must not read as
      // "no templates to check, therefore clean".
      expect(templates).toHaveLength(2);
      for (const raw of templates) {
        const rendered = raw
          .replaceAll("{marker}", "review-triage ladder")
          .replaceAll("{config}", ".config/review-triage.yaml")
          .replaceAll("{band}", "late")
          .replaceAll("{round}", "12")
          .replaceAll("{severity}", "medium")
          .replaceAll("{category}", "correctness")
          .replaceAll("{tier}", "2")
          .replaceAll("{clauses}", "min_severity: high");
        expect(MACRO_PROSE.test(rendered)).toBe(true);
      }
    });
  });

  it("says nothing about provenance when --ladder-only is not in play", () => {
    // The scope statement is about the NARROWING. An unnarrowed sample makes
    // no ladder claim at all, so printing it there would be noise that
    // trains the reader to skip it.
    const out = render(
      [decline()],
      "2026-08-01",
      "2026-08-07",
      1,
      false,
      0,
      0,
      0,
      null,
    );
    expect(out).not.toContain("MARKER PRESENCE");
  });
});

// docomply-review, a reference-implementation pull request round 2: `render()`'s rule-6 scope disclosure for
// `--ladder-only` was never reachable through `--json`, because `main()`
// serialized `{ ladder, declines }` straight from the loop's own local
// variables instead of going through `render()` or anything derived from it.
// `.config/review-triage.yaml` § calibration invokes exactly
// `--ladder-only --json` (triage-rubric.md § Calibrating the ladder), so the
// monthly human reader consuming the JSON never saw the caveat at all — and
// every prior probe here called `render()` directly, so none of them could
// have failed on that CLI branch. `buildJsonPayload` is the function `main()`
// actually calls for `--json`, so calling it directly here tests the real
// branch rather than a re-implementation of it.
describe("buildJsonPayload — --json carries the same ladder disclosure render prints (rule 6, docomply-review a reference-implementation pull request round 2)", () => {
  function decline(over: Partial<Decline> = {}): Decline {
    return {
      pr: 42,
      prTitle: "a pr",
      mergedAt: "2026-08-01T00:00:00Z",
      outcome: "wont-fix",
      path: "a.ts",
      line: 10,
      reason: "declined on effort",
      category: "unknown",
      url: "https://example.invalid/1",
      startedBy: "a-human",
      declinedAt: "2026-08-01T01:00:00Z",
      supersededCandidate: false,
      refoundIn: [],
      followUps: [],
      laterFixCommits: [],
      ...over,
    };
  }

  it("is null when --ladder-only was not passed, matching render()", () => {
    const payload = buildJsonPayload(
      [decline()],
      "2026-08-01",
      "2026-08-07",
      40,
      1,
      false,
      0,
      0,
      0,
      null,
    );
    expect(payload.ladder).toBeNull();
  });

  it("carries scope, bias, owner and the macro-prose ratio note alongside the raw counts", () => {
    const ladder: LadderScope = {
      marker: "review-triage ladder",
      excluded: 3,
      macroShaped: 1,
    };
    const payload = buildJsonPayload(
      [decline()],
      "2026-08-01",
      "2026-08-07",
      40,
      1,
      false,
      0,
      0,
      0,
      ladder,
    );
    expect(payload.ladder).not.toBeNull();
    // Raw counts survive untouched — this is additive, not a replacement.
    expect(payload.ladder?.marker).toBe("review-triage ladder");
    expect(payload.ladder?.excluded).toBe(3);
    expect(payload.ladder?.macroShaped).toBe(1);
    // The disclosure itself: the same three things rule 6 requires render()
    // to state (scope, bias, owner) plus the per-run pollution ratio.
    expect(payload.ladder?.disclosure.scopeCaveat).toContain(
      "MARKER PRESENCE, not ladder provenance",
    );
    expect(payload.ladder?.disclosure.bias).toBe("tightening");
    expect(payload.ladder?.disclosure.owner).toBe(
      ".config/review-triage.yaml § calibration",
    );
    expect(payload.ladder?.disclosure.macroShapedRatio).toBe("1/1");
    expect(payload.ladder?.disclosure.macroShapedNote).toContain(
      "matches the rendered template shape",
    );
  });

  it("never claims a template-shape match on an empty sample (0/0), same as render()", () => {
    const ladder: LadderScope = {
      marker: "review-triage ladder",
      excluded: 0,
      macroShaped: 0,
    };
    const payload = buildJsonPayload(
      [],
      "2026-08-01",
      "2026-08-07",
      40,
      1,
      false,
      0,
      0,
      0,
      ladder,
    );
    expect(payload.ladder?.disclosure.macroShapedRatio).toBe("0/0");
    expect(payload.ladder?.disclosure.macroShapedNote).toContain(
      "READ THE REMAINDER BY HAND",
    );
    expect(payload.ladder?.disclosure.macroShapedNote).not.toContain(
      "matches the rendered template shape",
    );
  });

  // The parity claim itself: whatever `render()` prints for a given
  // (ladder, declines) pair, `buildJsonPayload`'s disclosure for the SAME
  // pair states the same scope, owner and ratio note — derived from the one
  // shared `ladderDisclosureOf`, not two prose copies that can drift apart.
  it("states exactly what render() states, for the same inputs", () => {
    for (const macroShaped of [0, 1]) {
      const ladder: LadderScope = {
        marker: "review-triage ladder",
        excluded: 2,
        macroShaped,
      };
      const declines = [decline()];
      const text = render(
        declines,
        "2026-08-01",
        "2026-08-07",
        1,
        false,
        0,
        0,
        0,
        ladder,
      );
      const payload = buildJsonPayload(
        declines,
        "2026-08-01",
        "2026-08-07",
        40,
        1,
        false,
        0,
        0,
        0,
        ladder,
      );
      const disclosure = payload.ladder?.disclosure;
      expect(disclosure).toBeDefined();
      if (disclosure === undefined) continue;
      expect(text).toContain(disclosure.scopeCaveat);
      expect(text).toContain(disclosure.owner);
      expect(text).toContain(
        `${disclosure.macroShapedRatio} carry triage-ladder.ts's rendered prose`,
      );
      expect(text).toContain(disclosure.macroShapedNote);
    }
  });
});

describe("ladderDisclosureOf — the ratio never licenses a bound in either direction (docomply-review, a reference-implementation pull request round 2)", () => {
  it("is diagnostic, never a claim of zero pollution, at 100% match", () => {
    const d = ladderDisclosureOf(
      { marker: "x", excluded: 0, macroShaped: 2 },
      2,
    );
    expect(d.macroShapedNote).toContain("NOT proof against pollution");
    expect(d.macroShapedNote).not.toContain("no pollution");
  });

  it("always reports the bias as tightening, never the reassuring direction", () => {
    const d = ladderDisclosureOf(
      { marker: "x", excluded: 0, macroShaped: 0 },
      1,
    );
    expect(d.bias).toBe("tightening");
  });
});

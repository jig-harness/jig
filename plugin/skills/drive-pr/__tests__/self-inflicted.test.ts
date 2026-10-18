/**
 * self-inflicted.test.ts — the `SELF-INFLICTED` labelling: the decision
 * (`labelRecord`) against an injected blame seam, and the git-backed resolver
 * (`gitDeps`) plus the CLI against a real throwaway repository.
 *
 * Both halves are here deliberately, and the second is the load-bearing one:
 * a suite that only injects a hand-written predicate never exercises the
 * git-backed resolver at all.
 *
 * What every `null` assertion here is pinning: `null` means NOT MEASURED, and
 * `false` is the positive claim "I checked, and this is not your own doing".
 * Collapsing the two would make the label most confidently wrong exactly where
 * it is least informed, so each unanswerable case gets its own probe.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ghRepoEnv, gitIdentityEnv, resolvePr } from "../scripts/lib/proc.ts";
import {
  gitDeps,
  labelRecord,
  labelSummaryFinding,
} from "../scripts/self-inflicted.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

const GH_FLAG_GUARD = `#!/bin/sh
(
# These are the command forms this fixture actually models: ambient PR
# resolution, the resolved PR's base, and the current repository. Matching
# each argv slot also rejects a selector hidden inside one quoted argument.
if [ "$#" -eq 6 ] && [ "$1" = pr ] && [ "$2" = view ] &&
   [ "$3" = --json ] && [ "$4" = number ] &&
   [ "$5" = -q ] && [ "$6" = .number ]; then
  :
elif [ "$#" -eq 7 ] && [ "$1" = pr ] && [ "$2" = view ] &&
     [ "$3" = 42 ] && [ "$4" = --json ] &&
     [ "$5" = baseRefName ] && [ "$6" = -q ] &&
     [ "$7" = .baseRefName ]; then
  :
elif [ "$#" -eq 4 ] && [ "$1" = repo ] && [ "$2" = view ] &&
     [ "$3" = --json ] && [ "$4" = owner,name ]; then
  :
else
  echo "gh: unsupported command signature: $*" >&2; exit 2
fi
) || exit $?
`;

/**
 * Per-test budget for every probe that touches the real repository, well past
 * bun's 5s default. A CLI probe spawns a fresh runtime that type-strips a
 * TypeScript entrypoint and then makes one `git rev-list` plus a `git blame`
 * per record; a `gitDeps` probe makes the same git calls in-process. Under the
 * concurrent-suite load this repo's gates run at, both exceed 5s often enough
 * to be a flake rather than a signal — and a timed-out CLI probe reports as
 * `exitCode: 143` (SIGTERM), which reads as a script fault rather than as the
 * budget it is (measured here: two probes failed that way before this existed).
 */
const CLI_TIMEOUT_MS = 60_000;

const PR_SHA = "f".repeat(40);
const OLD_SHA = "1".repeat(40);

/** A blame seam that always answers `sha`, or always fails when null. */
const blaming = (sha: string | null) => async () => sha;

describe("labelRecord — the three-valued decision", () => {
  it("true when the anchor line’s commit is one of the PR’s own", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false },
        new Set([PR_SHA]),
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
  });

  it("false when the line predates the PR", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false },
        new Set([PR_SHA]),
        blaming(OLD_SHA),
      ),
    ).toEqual({ selfInflicted: false, selfInflictedCommit: undefined });
  });

  it("null when the PR’s commit set could not be resolved", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false },
        null,
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  it("null for a PR-level thread with no path", async () => {
    for (const path of [null, undefined, "", "   "]) {
      expect(
        await labelRecord(
          { path, line: 2 },
          new Set([PR_SHA]),
          blaming(PR_SHA),
        ),
      ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
    }
  });

  // `git blame -L 1.5,1.5` is a parse error and a NaN would stringify into the
  // argument as the literal `NaN`, so the integrality check is not cosmetic.
  it("null for a missing, fractional, NaN or out-of-range line", async () => {
    for (const line of [null, undefined, 0, -3, 1.5, Number.NaN]) {
      expect(
        await labelRecord(
          { path: "a.ts", line },
          new Set([PR_SHA]),
          blaming(PR_SHA),
        ),
      ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
    }
  });

  // An outdated thread's `line` addresses a diff that is no longer the head's,
  // so blaming it reads a line the reviewer never commented on. `null` rather
  // than a confident answer about the wrong code.
  it("null for an outdated anchor, even when the blame WOULD have said true", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: true },
        new Set([PR_SHA]),
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  // A LEFT-side anchor numbers the PRE-image, not HEAD — never outdated, so
  // this is a distinct case from the one above, not a duplicate of it.
  it("null for a LEFT-side anchor, even when isOutdated is false and blame WOULD have said true", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false, diffSide: "LEFT" },
        new Set([PR_SHA]),
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  it("measures a RIGHT-side anchor normally", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false, diffSide: "RIGHT" },
        new Set([PR_SHA]),
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
  });

  it("null when blame itself could not answer", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false },
        new Set([PR_SHA]),
        blaming(null),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  // An EMPTY commit set is a real answer — the branch is at its base, nothing
  // pushed yet — and every thread is correctly `false`, never `null`.
  it("false for every record when the PR has no commits of its own", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 2, isOutdated: false },
        new Set<string>(),
        blaming(OLD_SHA),
      ),
    ).toEqual({ selfInflicted: false, selfInflictedCommit: undefined });
  });
});

// A multi-line GitHub comment's `line` names only the range's END; `startLine`
// names its start when the two differ. These probes exercise the range scan
// `labelRecord` added for it; without them no labelRecord test had a
// `startLine` case.
describe("labelRecord — the multi-line range (`startLine`)", () => {
  /** A blame seam keyed by LINE NUMBER, for a range where lines disagree. */
  const blamingByLine =
    (map: Record<number, string | null>) =>
    async (_path: string, line: number): Promise<string | null> =>
      map[line] ?? null;

  // `startDiffSide: 'RIGHT'` pins the new straddling-range guard (below) out
  // of the way, so this test still isolates what it names: blame results.
  it("true when a PR commit wrote the range’s START line but not its END line", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          startDiffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: PR_SHA, 3: OLD_SHA, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
  });

  it("false only once every line in the range was checked and none is the PR’s own", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          startDiffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: OLD_SHA, 3: OLD_SHA, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: false, selfInflictedCommit: undefined });
  });

  // A `false` would overclaim here: line 3 was never actually checked, so the
  // range is not fully ruled out — even though no CHECKED line matched.
  it("null when a line in the range could not be blamed and no earlier line matched", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          startDiffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: OLD_SHA, 3: null, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  // PRESENT-but-invalid range metadata is a different claim from ABSENT
  // metadata: the record asserts a range this function cannot trust, so
  // silently substituting `line` (the single-line behavior) would produce a
  // `false` that quietly narrowed its own claim without saying so.
  it("null for a startLine that is present but malformed or inverted", async () => {
    for (const startLine of [
      "2", // wrong type
      1.5, // fractional
      0, // out of range
      -1, // out of range
      Number.NaN,
      20, // inverted: past `line`
    ]) {
      expect(
        await labelRecord(
          { path: "a.ts", line: 10, startLine, isOutdated: false },
          new Set([PR_SHA]),
          blaming(PR_SHA),
        ),
      ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
    }
  });

  // Absent — `undefined` or `null` — is the canonical enumerator's own
  // convention for a single-line comment, and must degrade to exactly the
  // existing single-line behavior rather than being treated as malformed.
  it("an absent startLine behaves exactly like a record with no such field", async () => {
    for (const startLine of [undefined, null]) {
      expect(
        await labelRecord(
          { path: "a.ts", line: 2, startLine, isOutdated: false },
          new Set([PR_SHA]),
          blaming(PR_SHA),
        ),
      ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
    }
  });

  // GitHub allows `startDiffSide` to differ from `diffSide` (the side of
  // `line`, the range's end) on a comment whose range straddles a hunk
  // boundary — `diffSide === 'RIGHT'` alone describes only the endpoint.
  it("null for a genuinely multi-line range whose startDiffSide is LEFT", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          diffSide: "RIGHT",
          startDiffSide: "LEFT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: PR_SHA, 3: OLD_SHA, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  // Absent/malformed `startDiffSide` on a genuinely multi-line range is NOT
  // MEASURED, not a guessed `true`/`false` — the same fail-closed posture as
  // every other unconfirmed range property in this function.
  it("null for a genuinely multi-line range with no startDiffSide at all", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          diffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: PR_SHA, 3: OLD_SHA, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
  });

  // A confirmed RIGHT-to-RIGHT range is unaffected by the new guard — proof
  // it narrows only the straddling case, not every multi-line comment.
  it("still labels a genuinely multi-line range whose startDiffSide is RIGHT", async () => {
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 4,
          startLine: 2,
          isOutdated: false,
          diffSide: "RIGHT",
          startDiffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        blamingByLine({ 2: PR_SHA, 3: OLD_SHA, 4: OLD_SHA }),
      ),
    ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
  });

  // A single-line comment (no distinct startLine) has no straddling range to
  // guard against — the new check must not fire for it regardless of
  // `startDiffSide`.
  it("a single-line record is unaffected by startDiffSide", async () => {
    expect(
      await labelRecord(
        { path: "a.ts", line: 4, isOutdated: false, diffSide: "RIGHT" },
        new Set([PR_SHA]),
        blaming(PR_SHA),
      ),
    ).toEqual({ selfInflicted: true, selfInflictedCommit: PR_SHA });
  });

  // The aggregate deadline bounds the loop's own STARTING of new calls; a
  // range that runs out of budget partway through must read `null`, not a
  // `false` that quietly narrowed its own claim to only the lines it had time
  // to check. `blame` here never resolves to `PR_SHA` — the aggregate
  // deadline is what stops the scan, not a genuine miss.
  it("null when the aggregate range deadline is exhausted before every line is checked", async () => {
    let calls = 0;
    expect(
      await labelRecord(
        {
          path: "a.ts",
          line: 5,
          startLine: 1,
          isOutdated: false,
          startDiffSide: "RIGHT",
        },
        new Set([PR_SHA]),
        async () => {
          calls += 1;
          return OLD_SHA;
        },
        Date.now() - 1, // already expired
      ),
    ).toEqual({ selfInflicted: null, selfInflictedCommit: undefined });
    // The deadline is checked BEFORE the first call, so an already-expired
    // one must make zero blame calls — proof the check runs where the
    // comment says it does, not merely that the result happens to be null.
    expect(calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The git-backed half: a real repository, a real `git blame`, the real CLI.
// ---------------------------------------------------------------------------

function scrubbedGitEnv(): Record<string, string> {
  // Same scrub the production code applies, for the same reason: a caller
  // running inside a git hook has GIT_DIR/GIT_WORK_TREE exported at ITS
  // repository, and those override `cwd` outright — the fixture repo's commits
  // would land in the real worktree's history instead. Reuses the production
  // scrubber rather than re-deleting `GIT_LOCATION_VARS` by exact key: on
  // Windows an inherited case variant like `Git_Dir` survives an exact-match
  // delete and still overrides `cwd`, which only `gitIdentityEnv()`'s
  // case-folding delete closes.
  return gitIdentityEnv() as Record<string, string>;
}

let repo: string;
let baseSha = "";
let roundOneSha = "";
let decoySha = "";

function execGit(args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(),
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function revParse(rev: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", rev], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedGitEnv(),
  });
  return proc.stdout.toString().trim();
}

// 60s, not bun's 5s default. This hook spawns ~10 `git` subprocesses, and
// under the concurrent-suite load this repo's gates run at, that reliably
// exceeds 5s — the hook is then killed mid-`git` and the failure surfaces as
// "git add -A failed" with an EMPTY stderr, which reads as a git fault rather
// than as the timeout it is (measured here; the same collision
// `verification-fit.test.ts` hits).
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "drive-pr-self-inflicted-"));
  execGit(["init", "-q", "."]);
  execGit(["config", "user.email", "test@example.invalid"]);
  execGit(["config", "user.name", "Test"]);
  execGit(["config", "commit.gpgsign", "false"]);
  execGit(["config", "core.autocrlf", "false"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/a.ts"), "line1\nline2\nline3\n");
  // Present in the head tree but NEVER touched by the feature branch — the
  // only shape that can distinguish `labelSummaryFinding`'s `false` (a real
  // file this PR did not write) from its `null` (a path that is not there at
  // all). Without it every path in this fixture is either PR-authored or
  // absent, and a mutation collapsing the two stays green.
  writeFileSync(join(repo, "src/untouched.ts"), "untouched\n");
  execGit(["add", "-A"]);
  execGit(["commit", "-q", "-m", "base"]);
  execGit(["branch", "-M", "base-branch"]);
  baseSha = revParse("HEAD");
  execGit(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repo, "src/a.ts"), "line1\nROUND-1-FIX\nline3\n");
  execGit(["add", "-A"]);
  execGit(["commit", "-q", "-m", "round 1 fix"]);
  roundOneSha = revParse("HEAD");
  // A dash-leading filename, committed here rather than inside its own test:
  // fixture state (the `feature` branch and its HEAD) is shared across every
  // probe in this suite, so mutating it mid-test would couple later probes to
  // this one's ordering.
  writeFileSync(join(repo, "-dash.ts"), "decoy\n");
  execGit(["add", "-A"]);
  execGit(["commit", "-q", "-m", "add a dash-leading filename"]);
  decoySha = revParse("HEAD");
  // A NON-ASCII filename, committed on the feature branch. `git diff
  // --name-only` C-QUOTES this under the default `core.quotePath` while `git
  // ls-tree -z` emits it raw, so the two path sets stop being comparable and a
  // file this PR genuinely touched labels `false`. Only a non-ASCII path
  // exercises that; every other fixture path here is plain ASCII and passes
  // either way.
  writeFileSync(join(repo, "src/café.ts"), "non-ascii\n");
  execGit(["add", "-A"]);
  execGit(["commit", "-q", "-m", "add a non-ascii filename"]);
  // A DECOY `origin/develop`, deliberately pointing at an unrelated orphan
  // commit rather than at this fixture's base. Without it, a hardcoded
  // `origin/develop` fallback in the script would simply fail to resolve here
  // and degrade to the same all-`null` answer the correct behaviour gives —
  // so the "refuses to guess the base" probe could not tell the two apart, and
  // a mutation reinstating the fallback stayed green (measured).
  //
  // With it, guessing resolves to a range that shares no history with HEAD, so
  // `rev-list` returns EVERY commit on this branch — including the base
  // commit — and the base line labels `true` instead of `null`. That is
  // precisely the real-world failure the no-hardcoded-base rule exists for: a
  // PR filed against a release branch has its whole base history counted as
  // its own work.
  execGit(["checkout", "-q", "--orphan", "unrelated"]);
  writeFileSync(join(repo, "unrelated.txt"), "unrelated\n");
  execGit(["add", "-A"]);
  execGit(["commit", "-q", "-m", "unrelated orphan"]);
  const orphanSha = revParse("HEAD");
  execGit(["checkout", "-q", "feature"]);
  execGit(["update-ref", "refs/remotes/origin/develop", orphanSha]);
}, 60_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
}, 60_000);

describe("gitDeps — the real resolver", () => {
  it(
    "resolves the PR’s own commits and excludes the base’s",
    async () => {
      const deps = gitDeps(repo, "base-branch", "HEAD");
      const commits = await deps.prCommits();
      expect(commits).not.toBeNull();
      expect(commits?.has(roundOneSha)).toBe(true);
      expect(commits?.has(baseSha)).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "null when the base ref cannot be resolved — never an empty set",
    async () => {
      // The distinction the whole three-valued vocabulary rests on: an
      // unresolvable base must not degrade into "this PR has no commits", which
      // would label every finding `false`.
      expect(await gitDeps(repo, "no-such-ref", "HEAD").prCommits()).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  // An EMPTY base string must not reach `rev-list` at all: `..HEAD` is legal
  // git meaning `HEAD..HEAD`, which resolves to the empty set — "this PR wrote
  // nothing", i.e. `false` for every finding, on the one input that
  // established nothing. Verified by mutation: dropping the guard turns this
  // probe from `null` into an empty Set.
  it(
    "null for an EMPTY base — `..HEAD` must never be run as a range",
    async () => {
      expect(await gitDeps(repo, "", "HEAD").prCommits()).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "blames the PR’s own line to the PR’s own commit",
    async () => {
      expect(
        await gitDeps(repo, "base-branch", "HEAD").blame("src/a.ts", 2),
      ).toBe(roundOneSha);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "blames an untouched line to the base commit",
    async () => {
      expect(
        await gitDeps(repo, "base-branch", "HEAD").blame("src/a.ts", 1),
      ).toBe(baseSha);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "null for a path that is not in the tree, and for a line past its end",
    async () => {
      const deps = gitDeps(repo, "base-branch", "HEAD");
      expect(await deps.blame("src/missing.ts", 1)).toBeNull();
      expect(await deps.blame("src/a.ts", 9999)).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  // A path is a PATH, whatever it looks like. The `--` in the blame argv is
  // what makes that true, and a dash-leading name is what proves it: without
  // the separator git parses `-dash.ts` as a bundle of short options and
  // fails, so the label silently degrades to `null` for every finding on such
  // a file. Verified by mutation — deleting the `--` keeps this suite green if
  // the fixture path is merely revision-SHAPED (`HEAD`), because the argv's
  // revision slot is already occupied by `head` and git reads the trailing
  // argument as a path regardless.
  //
  // Reachable, not theoretical: `path` arrives from GitHub's review-thread
  // API, and a dash-leading filename is legal in git.
  it(
    "treats a dash-leading path as a path, not as options",
    async () => {
      expect(
        await gitDeps(repo, "base-branch", "HEAD").blame("-dash.ts", 1),
      ).toBe(decoySha);
    },
    CLI_TIMEOUT_MS,
  );

  // Every probe above passes `'HEAD'` for both `base` and `head`, so a mutation
  // dropping `head` from the blame argv (git then blaming the working tree
  // instead of the requested revision) keeps the suite green. Blaming at
  // `base-branch` for a line that only exists there, while HEAD is `feature`,
  // is what actually pins the argv slot.
  it(
    "blames against the requested --head revision, not the working tree",
    async () => {
      expect(
        await gitDeps(repo, "base-branch", "base-branch").blame("src/a.ts", 2),
      ).toBe(baseSha);
    },
    CLI_TIMEOUT_MS,
  );
});

/**
 * The FILE-level measurement path for summary-only findings.
 *
 * The gap this closes is not "these findings were mislabelled": they carried
 * NO label, so the ladder's `fail_open.inert_when_unknown: [severity,
 * self_inflicted]` held it inert for every summary-only finding in every
 * round. Every probe below therefore pins a MEASURED value where `unknown`
 * used to be the only honest answer, plus the `null` cases that must stay
 * unmeasured rather than become a confident `false`.
 */
describe("labelSummaryFinding — the file-level decision", () => {
  const PR = new Set(["src/a.ts"]);
  const HEAD = new Set(["src/a.ts", "src/untouched.ts"]);

  it("true when the path is one the PR’s own commits touched", async () => {
    expect(await labelSummaryFinding({ path: "src/a.ts" }, PR, HEAD)).toEqual({
      selfInflicted: true,
      selfInflictedGranularity: "file",
    });
  });

  it("false when the file is in the tree but the PR never touched it", async () => {
    // The STRONGER half of the claim: no line in a file this PR never wrote
    // can be its own work, so `false` here is sounder than a line-level one.
    expect(
      await labelSummaryFinding({ path: "src/untouched.ts" }, PR, HEAD),
    ).toEqual({ selfInflicted: false, selfInflictedGranularity: "file" });
  });

  it("null for a path the reviewer’s prose named that is not in the tree", async () => {
    // NOT `false`. A summary bullet's path is prose, so an unresolvable one
    // establishes nothing about who wrote it — and `false` is a positive
    // claim the ladder reads as "measured, and not yours".
    expect(
      await labelSummaryFinding({ path: "src/ghost.ts" }, PR, HEAD),
    ).toEqual({ selfInflicted: null, selfInflictedGranularity: "file" });
  });

  it("true for a file this PR DELETED — the PR-path check comes first", async () => {
    // Absent from the head tree, but present in the PR's own changed set.
    // Ordering the head-tree probe first would label a finding about the
    // deletion `null`, losing the one measurement that is unambiguous.
    expect(
      await labelSummaryFinding(
        { path: "src/gone.ts" },
        new Set(["src/gone.ts"]),
        HEAD,
      ),
    ).toEqual({ selfInflicted: true, selfInflictedGranularity: "file" });
  });

  it("null with no usable path, and for a whitespace-only one", async () => {
    for (const rec of [{}, { path: "" }, { path: "   " }, { path: 7 }]) {
      expect(await labelSummaryFinding(rec, PR, HEAD)).toEqual({
        selfInflicted: null,
        selfInflictedGranularity: "file",
      });
    }
  });

  it("null when either path set is unresolvable — never a guess", async () => {
    expect(await labelSummaryFinding({ path: "src/a.ts" }, null, HEAD)).toEqual(
      { selfInflicted: null, selfInflictedGranularity: "file" },
    );
    // An unreadable head tree collapses only the false/null split: `true` is
    // still measured off `prPaths` alone.
    expect(await labelSummaryFinding({ path: "src/a.ts" }, PR, null)).toEqual({
      selfInflicted: true,
      selfInflictedGranularity: "file",
    });
    expect(
      await labelSummaryFinding({ path: "src/untouched.ts" }, PR, null),
    ).toEqual({ selfInflicted: null, selfInflictedGranularity: "file" });
  });

  it("carries the granularity marker on every answer, measured or not", async () => {
    // The field's absence must never be readable as "line-level". A consumer
    // acting on `selfInflicted: true` has to be able to tell this weaker
    // file-level claim from `labelRecord`'s.
    for (const path of ["src/a.ts", "src/untouched.ts", "src/ghost.ts"]) {
      expect(
        (await labelSummaryFinding({ path }, PR, HEAD))
          .selfInflictedGranularity,
      ).toBe("file");
    }
  });
});

describe("gitDeps — the file-level resolvers", () => {
  it(
    "prPaths lists what the PR touched and excludes what it did not",
    async () => {
      const paths = await gitDeps(repo, "base-branch", "HEAD").prPaths();
      expect(paths).not.toBeNull();
      expect(paths?.has("src/a.ts")).toBe(true);
      expect(paths?.has("-dash.ts")).toBe(true);
      expect(paths?.has("src/untouched.ts")).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "prPaths and headPaths agree on a NON-ASCII path — no quoting asymmetry",
    async () => {
      // `git diff --name-only` without `-z` emits `"src/caf\303\251.ts"`
      // while `ls-tree -z` emits `src/café.ts`. Comparing those two sets
      // labels a file this PR WROTE as `false` — a confident wrong answer on
      // the stronger half of the tri-state, which can decline a regression
      // the PR itself authored. Verified by mutation: dropping `-z` from
      // `prPaths` turns this probe red.
      const deps = gitDeps(repo, "base-branch", "HEAD");
      const prPaths = await deps.prPaths();
      const headPaths = await deps.headPaths();
      expect(prPaths?.has("src/café.ts")).toBe(true);
      expect(headPaths?.has("src/café.ts")).toBe(true);
      expect(
        await labelSummaryFinding({ path: "src/café.ts" }, prPaths, headPaths),
      ).toEqual({ selfInflicted: true, selfInflictedGranularity: "file" });
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "prPaths is null for an unresolvable base, and for an EMPTY one",
    async () => {
      // Same distinction `prCommits` rests on: `..HEAD` is legal git that
      // resolves to nothing, which would label every finding `false`.
      expect(await gitDeps(repo, "no-such-ref", "HEAD").prPaths()).toBeNull();
      expect(await gitDeps(repo, "", "HEAD").prPaths()).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "headPaths lists the tree, including files the PR never touched",
    async () => {
      const paths = await gitDeps(repo, "base-branch", "HEAD").headPaths();
      expect(paths?.has("src/untouched.ts")).toBe(true);
      expect(paths?.has("src/a.ts")).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "headPaths is null for an unresolvable head",
    async () => {
      expect(
        await gitDeps(repo, "base-branch", "no-such-ref").headPaths(),
      ).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );
});

// A DEDICATED repo, not the shared `feature`/`base-branch` fixture above: this
// probe needs `base-branch` to advance PAST the point `feature` forked from
// it, and mutating the shared fixture's branches would couple every earlier
// probe in this file to run-order (the same hazard the top-level `beforeAll`
// documents about the dash-leading-filename commit).
//
// `git diff base..head` (two-dot) is NOT `git rev-list base..head`'s
// exclusion sense, despite looking like the same notation — `git diff` two-dot
// is a direct two-tree comparison with no merge-base logic at all, exactly
// `git diff base head`. So once `base-branch` has moved past the commit
// `feature` forked from, a file `base-branch` alone changed shows up as
// "different" between the two endpoint trees purely because the trees
// disagree there — and `prPaths()` mislabelled it as this PR's own.
// Verified by mutation: reverting
// `prPaths`' diff range from `${base}...${resolvedHead}` back to
// `${base}..${resolvedHead}` turns this probe red.
describe("gitDeps — prPaths ignores base-only churn on an unmerged, advanced base", () => {
  let repo: string;

  function execIn(cwd: string, args: string[]): void {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: scrubbedGitEnv(),
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${proc.stderr.toString()}`,
      );
    }
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "drive-pr-self-inflicted-base-adv-"));
    execIn(repo, ["init", "-q", "."]);
    execIn(repo, ["config", "user.email", "test@example.invalid"]);
    execIn(repo, ["config", "user.name", "Test"]);
    execIn(repo, ["config", "commit.gpgsign", "false"]);
    execIn(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "shared.ts"), "base\n");
    execIn(repo, ["add", "-A"]);
    execIn(repo, ["commit", "-q", "-m", "base"]);
    execIn(repo, ["branch", "-M", "base-branch"]);
    execIn(repo, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(repo, "own.ts"), "feature\n");
    execIn(repo, ["add", "-A"]);
    execIn(repo, ["commit", "-q", "-m", "feature commit"]);
    // `base-branch` now advances PAST the fork point, touching `shared.ts` —
    // a file `feature` never touched — without `feature` ever merging it in.
    execIn(repo, ["checkout", "-q", "base-branch"]);
    writeFileSync(join(repo, "shared.ts"), "base-advanced\n");
    execIn(repo, ["add", "-A"]);
    execIn(repo, ["commit", "-q", "-m", "base advances, touches shared.ts"]);
    execIn(repo, ["checkout", "-q", "feature"]);
  }, 60_000);

  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  }, 60_000);

  it(
    "excludes a file only the advanced base touched, includes the PR’s own",
    async () => {
      const paths = await gitDeps(repo, "base-branch", "feature").prPaths();
      expect(paths).not.toBeNull();
      expect(paths?.has("own.ts")).toBe(true);
      expect(paths?.has("shared.ts")).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );
});

describe("self-inflicted.ts CLI — --summary-report", () => {
  async function runCli(
    stdin: string,
    args: string[] = [
      "--summary-report",
      "--repo",
      "",
      "--base",
      "base-branch",
    ],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const argv = args.map((a, i) => (args[i - 1] === "--repo" ? repo : a));
    const proc = Bun.spawn(
      [process.execPath, join(SCRIPTS, "self-inflicted.ts"), ...argv],
      {
        stdin: new Response(stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: scrubbedGitEnv(),
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  const finding = (fingerprint: string, path: string) => ({
    fingerprint,
    source: "body",
    path,
    line: 2,
    severity: "high",
    category: "unknown",
    text: "a finding",
    addressed: false,
  });

  const report = {
    pr: 4501,
    stickyCommentId: 99,
    declaredUnanchored: 0,
    total: 3,
    findings: [
      finding("f1", "src/a.ts"),
      finding("f2", "src/untouched.ts"),
      finding("f3", "src/ghost.ts"),
    ],
    unaddressed: [finding("f1", "src/a.ts"), finding("f3", "src/ghost.ts")],
  };

  it(
    "labels every finding, keeps the envelope, and mirrors into unaddressed",
    async () => {
      const r = await runCli(JSON.stringify(report));
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(
        out.findings.map((f: { selfInflicted: unknown }) => f.selfInflicted),
      ).toEqual([true, false, null]);
      // The envelope the driver's own convergence checks read must survive.
      expect(out.pr).toBe(4501);
      expect(out.stickyCommentId).toBe(99);
      expect(out.total).toBe(3);
      // Original fields passed THROUGH, not merely labelled.
      expect(out.findings[0].severity).toBe("high");
      expect(out.findings[0].text).toBe("a finding");
      // `unaddressed` shares findings with `findings`; labelling the two
      // independently is how one finding ends up with two answers.
      expect(
        out.unaddressed.map((f: { selfInflicted: unknown }) => f.selfInflicted),
      ).toEqual([true, null]);
      expect(out.unaddressed[0].selfInflictedGranularity).toBe("file");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "labels everything null — loudly — when the base cannot be resolved",
    async () => {
      const r = await runCli(JSON.stringify(report), [
        "--summary-report",
        "--repo",
        "",
        "--base",
        "no-such-ref",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("NOT MEASURED");
      expect(
        JSON.parse(r.stdout).findings.map(
          (f: { selfInflicted: unknown }) => f.selfInflicted,
        ),
      ).toEqual([null, null, null]);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed on a malformed document rather than emitting a partial one",
    async () => {
      // Same posture as the NDJSON path's unparsable line: this output IS the
      // pass's summary-finding list, so a silently truncated one hides work.
      for (const [stdin, why] of [
        ["not json at all", "expects one summary-findings.ts JSON document"],
        ["[1,2,3]", "is not a report"],
        ['{"pr":1}', "has no `findings` array"],
        ['{"pr":1,"findings":[7]}', "finding is not an object"],
      ] as const) {
        const r = await runCli(stdin);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain(why);
        expect(r.stdout.trim()).toBe("");
      }
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "survives a report larger than one stdin chunk with a multi-byte character on the boundary",
    async () => {
      // Bun yields `Buffer` chunks over a PIPE (65536 bytes, then the
      // remainder). Without `process.stdin.setEncoding('utf8')`, `raw +=
      // chunk` stringifies each one INDEPENDENTLY, so a multi-byte character
      // straddling the boundary becomes U+FFFD — and `JSON.parse` still
      // succeeds, so nothing says so.
      //
      // Two properties of this probe are load-bearing, and BOTH were
      // established by mutation rather than assumed:
      //
      //  1. It must go through a REAL SHELL PIPE. `Bun.spawn` with
      //     `stdin: new Response(...)` (what `runCli` uses) and a `<file`
      //     redirect both deliver the payload without splitting it, and
      //     reproduce nothing — measured: 0 replacement chars against the
      //     unfixed code, versus 2 through `cat |`. A shell pipe is also the
      //     shape `SKILL.md` § 2 actually documents.
      //  2. The em-dash's byte position is COMPUTED, not guessed. A fixture
      //     that is merely "big" reproduces nothing — 113 KB of dense
      //     multi-byte prose happened to align cleanly and passed against the
      //     unfixed code (measured).
      const dash = "\u2014";
      const build = (pad: number) =>
        JSON.stringify({
          pr: 1,
          findings: [
            {
              ...finding("f1", "src/a.ts"),
              text: "a".repeat(pad) + dash + "b".repeat(4000),
            },
          ],
          unaddressed: [],
        });
      let payload = "";
      for (let pad = 65000; pad < 66200; pad++) {
        const candidate = build(pad);
        const at = Buffer.from(candidate, "utf8").indexOf(
          Buffer.from(dash, "utf8"),
        );
        if (at < 65536 && 65536 < at + 3) {
          payload = candidate;
          break;
        }
      }
      // The probe is only meaningful if the straddling fixture was actually
      // constructed — an empty payload would pass every assertion below
      // vacuously.
      expect(payload).not.toBe("");

      const dir = mkdtempSync(join(tmpdir(), "drive-pr-si-stdin-"));
      try {
        const fixture = join(dir, "report.json");
        writeFileSync(fixture, payload);
        const script = join(SCRIPTS, "self-inflicted.ts");
        const proc = Bun.spawn(
          [
            "sh",
            "-c",
            `cat "$1" | "$2" "$3" --summary-report --repo "$4" --base base-branch`,
            "sh",
            fixture,
            process.execPath,
            script,
            repo,
          ],
          { stdout: "pipe", stderr: "pipe", env: scrubbedGitEnv() },
        );
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(stdout).not.toContain("\uFFFD");
        const out = JSON.parse(stdout);
        expect(out.findings[0].text).toContain(dash);
        expect(out.findings[0].fingerprint).toBe("f1");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed on a present-but-non-array unaddressed",
    async () => {
      // ABSENT is fine; PRESENT-BUT-WRONG-SHAPE must not pass through
      // unlabelled while every other shape violation exits 1 — that would
      // make this mode's own fail-closed promise false.
      const r = await runCli(
        JSON.stringify({
          pr: 1,
          findings: [finding("f1", "src/a.ts")],
          unaddressed: "not an array",
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("non-array `unaddressed`");
      expect(r.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "labels a report that carries no `unaddressed` key at all",
    async () => {
      const r = await runCli(
        JSON.stringify({ pr: 1, findings: [finding("f1", "src/a.ts")] }),
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).findings[0].selfInflicted).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed when unaddressed names a finding that is not in findings",
    async () => {
      const r = await runCli(
        JSON.stringify({
          pr: 1,
          findings: [finding("f1", "src/a.ts")],
          unaddressed: [finding("nope", "src/a.ts")],
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not in findings");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed when two findings repeat one fingerprint",
    async () => {
      const r = await runCli(
        JSON.stringify({
          pr: 1,
          findings: [finding("f1", "src/a.ts"), finding("f1", "src/b.ts")],
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("repeats fingerprint");
      expect(r.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed on a finding with no usable fingerprint, rather than silently keying it under `undefined`",
    async () => {
      // Two findings that both omit `fingerprint` used to collide under the
      // single JS Map key `undefined` — the second overwriting the first —
      // so a later malformed `unaddressed` entry could silently resolve to
      // whichever one won that collision.
      const bare = {
        source: "body",
        path: "src/a.ts",
        line: 2,
        severity: "high",
        category: "unknown",
        text: "a finding",
        addressed: false,
      };
      const r = await runCli(JSON.stringify({ pr: 1, findings: [bare, bare] }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("unusable fingerprint");
      expect(r.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "fails closed when an unaddressed entry carries no usable fingerprint of its own",
    async () => {
      const r = await runCli(
        JSON.stringify({
          pr: 1,
          findings: [finding("f1", "src/a.ts"), finding("f2", "src/b.ts")],
          unaddressed: [{}],
        }),
      );
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("unaddressed entry has no usable fingerprint");
      expect(r.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS,
  );
});

describe("self-inflicted.ts CLI — the stream contract", () => {
  async function runCli(
    stdin: string,
    args: string[] = ["--repo", "", "--base", "base-branch"],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const argv = args.map((a, i) => (args[i - 1] === "--repo" ? repo : a));
    const proc = Bun.spawn(
      [process.execPath, join(SCRIPTS, "self-inflicted.ts"), ...argv],
      {
        stdin: new Response(stdin),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...scrubbedGitEnv(), ...env },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it(
    "labels a stream and preserves every original field",
    async () => {
      const r = await runCli(
        [
          JSON.stringify({
            threadId: "T1",
            path: "src/a.ts",
            line: 2,
            isOutdated: false,
            url: "https://example.invalid/1",
          }),
          JSON.stringify({
            threadId: "T2",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
          }),
          JSON.stringify({ threadId: "T3", path: null, line: null }),
        ].join("\n"),
      );
      expect(r.exitCode).toBe(0);
      const out = r.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      expect(out.length).toBe(3);
      expect(out[0].selfInflicted).toBe(true);
      expect(out[0].selfInflictedCommit).toBe(roundOneSha);
      // Not merely labelled — passed THROUGH. This stream is the pass's thread
      // list, so a dropped field is a lost handle.
      expect(out[0].threadId).toBe("T1");
      expect(out[0].url).toBe("https://example.invalid/1");
      expect(out[1].selfInflicted).toBe(false);
      expect(out[1].selfInflictedCommit).toBeUndefined();
      expect(out[2].selfInflicted).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "labels severity from the thread’s first comment, recognizing both a bold token and a priority badge",
    async () => {
      const r = await runCli(
        [
          JSON.stringify({
            threadId: "T1",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [
              { author: "shadow-review", body: "🟠 **high** · correctness" },
            ],
          }),
          JSON.stringify({
            threadId: "T2",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [
              {
                author: "chatgpt-codex-connector",
                body: "**![P1 Badge](https://img.shields.io/badge/P1-orange) Mechanize severity**",
              },
            ],
          }),
          JSON.stringify({
            threadId: "T3",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [{ author: "a-human", body: "no severity token here" }],
          }),
          JSON.stringify({
            threadId: "T4",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
          }),
          JSON.stringify({
            threadId: "T5",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [
              { author: "another-bot", body: "🟠 **high** · correctness" },
            ],
          }),
        ].join("\n"),
        undefined,
        // The configured reviewer, whose comments are read in Jig's format.
        { DRIVE_PR_REVIEWER_APP: "shadow-review" },
      );
      expect(r.exitCode).toBe(0);
      const out = r.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      expect(out[0].severity).toBe("high");
      expect(out[1].severity).toBe("high"); // P1 badge → high, not unknown
      expect(out[2].severity).toBe("unknown");
      expect(out[3].severity).toBe("unknown"); // no comments field at all
      // Jig's format from a login that is not the configured reviewer.
      expect(out[4].severity).toBe("unknown");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "labels CodeRabbit’s pipe-delimited severity field through the NDJSON stream, gated on CodeRabbit authorship",
    async () => {
      // `severityOfRecord` (self-inflicted.ts's own extractor) threads
      // `comments[0].author` into `severityOf` with no reshaping — this is
      // the one place that wiring is exercised through the actual CLI
      // stream, rather than by calling `severityOf` directly.
      const coderabbitBody =
        "_🩺 Stability & Availability_ | _🔴 Critical_ | _⚡ Quick win_";
      const r = await runCli(
        [
          JSON.stringify({
            threadId: "T1",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [{ author: "coderabbitai", body: coderabbitBody }],
          }),
          // Identical shape, a different author — must stay `unknown`, the
          // same authorship gate `severityOf` enforces directly. Catches a
          // regression where `severityOfRecord` stops forwarding the real
          // author (or forwards a wrong one), which no direct `severityOf`
          // test can see.
          JSON.stringify({
            threadId: "T2",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [{ author: "some-other-bot", body: coderabbitBody }],
          }),
        ].join("\n"),
      );
      expect(r.exitCode).toBe(0);
      const out = r.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      expect(out[0].severity).toBe("blocker");
      expect(out[1].severity).toBe("unknown");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "labels category from the thread’s first comment, same fallback contract as severity",
    async () => {
      const r = await runCli(
        [
          JSON.stringify({
            threadId: "T1",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [
              {
                author: "shadow-review",
                body: "🟠 **high** · 🏷️ category: data-integrity · confidence: high",
              },
            ],
          }),
          JSON.stringify({
            threadId: "T2",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
            comments: [{ author: "a-human", body: "no category token here" }],
          }),
          JSON.stringify({
            threadId: "T3",
            path: "src/a.ts",
            line: 1,
            isOutdated: false,
          }),
        ].join("\n"),
      );
      expect(r.exitCode).toBe(0);
      const out = r.stdout
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l));
      expect(out[0].category).toBe("data-integrity");
      expect(out[1].category).toBe("unknown");
      expect(out[2].category).toBe("unknown"); // no comments field at all
    },
    CLI_TIMEOUT_MS,
  );

  // A record already carrying `selfInflictedCommit` — this script's own
  // output piped back through itself, or a hand-crafted fixture — must have
  // it CLEARED when the fresh label disagrees. Spreading the input record
  // before the label (`{ ...rec, ...label }`) only overwrites a key the
  // label object actually carries; a label branch that merely OMITTED the
  // key left the stale value standing, contradicting `selfInflicted: false`
  // in the same record. Verified by mutation: reverting `labelRecord` to
  // return `{ selfInflicted: false }` (no explicit `undefined`) turns this
  // red while the un-mutated suite above still passes, because that fixture
  // never carries a pre-existing `selfInflictedCommit` to leak.
  it(
    "clears a stale selfInflictedCommit when the fresh label is false",
    async () => {
      const r = await runCli(
        JSON.stringify({
          threadId: "T1",
          path: "src/a.ts",
          line: 1, // blames to baseSha, not a PR commit → selfInflicted: false
          isOutdated: false,
          selfInflictedCommit: "d".repeat(40),
        }),
      );
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.selfInflicted).toBe(false);
      expect(out.selfInflictedCommit).toBeUndefined();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "clears a stale selfInflictedCommit when the fresh label is null",
    async () => {
      const r = await runCli(
        JSON.stringify({
          threadId: "T1",
          path: "src/missing.ts", // not in the tree → selfInflicted: null
          line: 1,
          isOutdated: false,
          selfInflictedCommit: "d".repeat(40),
        }),
      );
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout.trim());
      expect(out.selfInflicted).toBeNull();
      expect(out.selfInflictedCommit).toBeUndefined();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "handles a final line with no trailing newline",
    async () => {
      const r = await runCli(
        JSON.stringify({ threadId: "T1", path: "src/a.ts", line: 2 }),
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim()).selfInflicted).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "an empty stream is exit 0 and no output",
    async () => {
      const r = await runCli("");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("");
    },
    CLI_TIMEOUT_MS,
  );

  // A dropped record would hide a FINDING, not a label — so a malformed line
  // is fatal rather than skipped, and nothing partial is emitted.
  it(
    "refuses an unparsable line rather than dropping it",
    async () => {
      const r = await runCli(
        `${JSON.stringify({ threadId: "T1", path: "src/a.ts", line: 2 })}\nnot json\n`,
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("unparsable");
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "refuses a line that parses but is not a record",
    async () => {
      const r = await runCli("[1,2,3]\n");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("not a thread record");
    },
    CLI_TIMEOUT_MS,
  );

  // Silence here would read as "nothing was self-inflicted" — the inversion
  // the three-valued vocabulary exists to prevent.
  it(
    "says so loudly when the commit set is unresolvable, and still exits 0",
    async () => {
      const r = await runCli(
        `${JSON.stringify({ threadId: "T1", path: "src/a.ts", line: 2 })}\n`,
        ["--repo", "", "--base", "no-such-ref"],
      );
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("NOT MEASURED");
      expect(JSON.parse(r.stdout.trim()).selfInflicted).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "rejects an unknown flag and a value-less flag",
    async () => {
      expect((await runCli("", ["--nope"])).exitCode).toBe(2);
      expect((await runCli("", ["--base"])).exitCode).toBe(2);
    },
    CLI_TIMEOUT_MS,
  );

  // A second positional PR must not silently retarget the run — the caller's
  // FIRST argument was overwritten with no usage error, so `self-inflicted.ts
  // 123 456` measured against 456 with nothing saying 123 was ever named.
  it(
    "rejects a second positional argument rather than retargeting the PR",
    async () => {
      const r = await runCli("", ["123", "456"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("extra positional argument");
    },
    CLI_TIMEOUT_MS,
  );

  // A flag-looking token as a flag's value must not be swallowed — otherwise
  // `--base --repo /tmp` reads `--repo` as `--base`'s value and treats
  // `/tmp` as an unintended positional PR, silently measuring against the
  // wrong base and the wrong PR instead of refusing.
  it(
    "rejects a flag value that looks like another flag rather than swallowing it",
    async () => {
      const r = await runCli("", ["--base", "--head", "HEAD"]);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("requires a value");
    },
    CLI_TIMEOUT_MS,
  );

  /** Spawn the CLI with an explicit env, bypassing `runCli`'s fixed flags. */
  async function runCliWithEnv(
    env: Record<string, string>,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(
      [process.execPath, join(SCRIPTS, "self-inflicted.ts"), ...args],
      {
        // `resolvePr`'s ambient fallback (`gh pr view` with no explicit
        // target) reads the CHILD PROCESS's own cwd, not `--repo` — so
        // without this, the two probes below that omit `--base` leak the
        // TEST RUNNER's real repository and its real, currently-open PR
        // into a probe that exists specifically to prove nothing gets
        // guessed. This fixture repo has no `gh`-visible remote, so running
        // there makes the ambient lookup fail the way the probes intend.
        cwd: repo,
        stdin: new Response(
          `${JSON.stringify({ threadId: "T1", path: "src/a.ts", line: 2 })}\n`,
        ),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...scrubbedGitEnv(), ...env },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  // `base-sync.ts` states the rule for the identical question: the base comes
  // from the PR's own `baseRefName`, never a hardcoded `develop`. With no
  // `--base`, no `$DRIVE_PR_BASE_REF`, and no resolvable PR (this fixture repo
  // has no GitHub remote), the honest answer is NOT MEASURED — not a guess at
  // `origin/develop`, which on a PR filed against a release branch would count
  // that whole branch's history as this PR's own work.
  //
  // `DRIVE_PR_BASE_REF` is cleared EXPLICITLY rather than merely left unset:
  // this suite inherits the caller's environment, so a driver that exported it
  // would otherwise make the probe pass on the ambient value instead of on the
  // behaviour under test.
  it(
    "refuses to guess the base — no --base and no resolvable PR is all-null",
    async () => {
      const r = await runCliWithEnv({ DRIVE_PR_BASE_REF: "" }, [
        "--repo",
        repo,
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("NOT MEASURED");
      // The record here anchors to a line the PR DID write, so `null` alone
      // would also be produced by a guess that failed to resolve. The decoy
      // `origin/develop` (see beforeAll) makes a guess resolve instead, and it
      // would answer `true` — so this assertion distinguishes "refused to
      // guess" from "guessed and could not read it".
      expect(JSON.parse(r.stdout.trim()).selfInflicted).toBeNull();
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "honours $DRIVE_PR_BASE_REF when no --base is given",
    async () => {
      const r = await runCliWithEnv({ DRIVE_PR_BASE_REF: "base-branch" }, [
        "--repo",
        repo,
      ]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim()).selfInflicted).toBe(true);
    },
    CLI_TIMEOUT_MS,
  );
});

// `resolveBaseRef` (self-inflicted.ts, private) calls `resolvePr` and its own
// `gh pr view <target>` with `cwd: repo` — the worktree named by `--repo`/
// `$DRIVE_PR_WORKTREE` — rather than the process's own ambient cwd. Tested
// directly against the shared `resolvePr`, since a full CLI round-trip would
// have to fake an entire resolvable base branch to observe the difference.
describe("resolvePr — cwd routes to the named repository, not the ambient one", () => {
  let stubBinDir: string;
  let repoA: string;
  let repoB: string;

  beforeAll(() => {
    stubBinDir = mkdtempSync(join(tmpdir(), "drive-pr-resolvepr-stub-"));
    repoA = mkdtempSync(join(tmpdir(), "drive-pr-resolvepr-a-"));
    repoB = mkdtempSync(join(tmpdir(), "drive-pr-resolvepr-b-"));
    // Answers a bare `gh pr view --json number -q .number` with a number that
    // names WHICH directory it was invoked from — the only way to observe
    // which `cwd` the call actually carried. The directory is identified by a
    // marker file, not by comparing `pwd` with a path: a shell reports the
    // resolved path on macOS (`/private/var/...`) and an msys-style one on
    // Windows (`/c/Users/...`), so no path string matches across platforms.
    writeFileSync(join(repoA, "gh-stub-number"), "111\n");
    writeFileSync(join(repoB, "gh-stub-number"), "222\n");
    const stub = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ]; then
  if [ -f ./gh-stub-number ]; then cat ./gh-stub-number; exit 0; fi
  echo "gh-stub: unexpected cwd: $(pwd)" >&2; exit 1
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`;
    const ghPath = join(stubBinDir, "gh");
    writeFakeProgram(ghPath, GH_FLAG_GUARD + stub);
  });

  afterAll(() => {
    rmSync(stubBinDir, { recursive: true, force: true });
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  // Import-time module state (`ghCallTimeoutSeconds`'s cache) makes this an
  // in-process call, not a spawn, but `resolvePr`/`ghCall`/`run` all thread
  // `cwd` down to the real `child_process.spawn`, so PATH still has to route
  // to the stub the same way a CLI probe's `env` would.
  function withStubPath<T>(fn: () => Promise<T>): Promise<T> {
    const original = process.env.PATH;
    process.env.PATH = `${stubBinDir}${delimiter}${original ?? ""}`;
    return fn().finally(() => {
      process.env.PATH = original;
    });
  }

  it("resolves against the passed cwd, not process.cwd()", async () => {
    await withStubPath(async () => {
      expect(await resolvePr("", repoA)).toBe("111");
      expect(await resolvePr("", repoB)).toBe("222");
    });
  });

  it("an explicit PR still short-circuits — cwd is never consulted", async () => {
    await withStubPath(async () => {
      expect(await resolvePr("999", repoA)).toBe("999");
    });
  });
});

// `gh` gives `GH_REPO` precedence over local repository discovery even when
// `cwd` names a perfectly good checkout, so `cwd` alone is not sufficient to
// anchor a `resolvePr` call there — an inherited `GH_REPO` could redirect it
// to a THIRD repository regardless. Tested with a
// stub that reports what it actually received, not `pwd`: the vulnerability
// this guards is that `gh` would obey `GH_REPO` over `cwd`, which a `pwd`-
// keyed stub cannot distinguish from the correct, unaffected behavior.
describe("resolvePr — an ambient GH_REPO must not override cwd", () => {
  let stubBinDir: string;
  let repoA: string;

  beforeAll(() => {
    stubBinDir = mkdtempSync(
      join(tmpdir(), "drive-pr-resolvepr-gh-repo-stub-"),
    );
    repoA = realpathSync(
      mkdtempSync(join(tmpdir(), "drive-pr-resolvepr-gh-repo-a-")),
    );
    const stub = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ]; then
  if [ -n "$GH_REPO" ]; then
    echo "leaked:$GH_REPO"
  else
    echo "clean"
  fi
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`;
    const ghPath = join(stubBinDir, "gh");
    writeFakeProgram(ghPath, GH_FLAG_GUARD + stub);
  });

  afterAll(() => {
    rmSync(stubBinDir, { recursive: true, force: true });
    rmSync(repoA, { recursive: true, force: true });
  });

  it("does not forward an ambient GH_REPO to the cwd-bound gh call", async () => {
    const originalPath = process.env.PATH;
    const originalGhRepo = process.env.GH_REPO;
    process.env.PATH = `${stubBinDir}${delimiter}${originalPath ?? ""}`;
    process.env.GH_REPO = "attacker-owner/attacker-repo";
    try {
      expect(await resolvePr("", repoA)).toBe("clean");
    } finally {
      process.env.PATH = originalPath;
      if (originalGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = originalGhRepo;
    }
  });
});

// Windows environment-variable names are case-insensitive, so an exact-match
// `delete env.GH_REPO` leaves an inherited `Gh_Repo` in place there, still
// honored by `gh` — the same trap `gitIdentityEnv()` already guards against
// for `GIT_DIR`. Drives `process.platform`
// directly rather than spawning `gh`, since the hazard is in `ghRepoEnv()`'s
// own key-matching, not in anything a subprocess stub could observe.
describe("ghRepoEnv — case-insensitive removal on Windows", () => {
  it("removes a differently-cased GH_REPO on win32", () => {
    const savedPlatform = process.platform;
    const originalMixedCase = process.env.Gh_Repo;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      process.env.Gh_Repo = "attacker-owner/attacker-repo";
      expect(ghRepoEnv().Gh_Repo).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
      if (originalMixedCase === undefined) delete process.env.Gh_Repo;
      else process.env.Gh_Repo = originalMixedCase;
    }
  });
});

// `resolveBaseRef` (self-inflicted.ts, private) refuses to fetch from an
// unverified `origin`, and refuses to trust the ref when the fetch itself
// fails — both UNRESOLVED (the caller's all-`null` stream), never a guess
// read off whatever `origin/<base>` happens to be on disk.
// Tested through the full CLI, since
// `resolveBaseRef` is not exported and its `gh`/`git` calls are not an
// injected seam the way `gitDeps` is.
describe("resolveBaseRef — origin verification and fetch failure are UNRESOLVED, never guessed", () => {
  let stubBinDir: string;
  let baseRefRepo: string;
  let fetchFailOriginRoot: string;

  function execIn(cwd: string, args: string[]): void {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: scrubbedGitEnv(),
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${proc.stderr.toString()}`,
      );
    }
  }

  function writeGhStub(script: string): void {
    const ghPath = join(stubBinDir, "gh");
    writeFakeProgram(ghPath, GH_FLAG_GUARD + script);
  }

  // A second, local-only "remote" repository — never reached over the network
  // — for the fetch-failure probe below. Nested two directories deep so its
  // absolute path's last two segments are `example-org/example-repo`: `repoOfUrl`
  // (see its own header) extracts `owner/name` from the last two path
  // segments of ANY git URL form, host-agnostic, so a plain local path
  // parses exactly like a real `https://…/example-org/example-repo.git` would —
  // letting verification pass while the fetch itself has nothing to succeed
  // against (it is never given a `develop` branch, or any commit at all).
  let fetchFailOrigin: string;

  beforeAll(() => {
    stubBinDir = mkdtempSync(join(tmpdir(), "drive-pr-baseref-stub-"));
    baseRefRepo = realpathSync(
      mkdtempSync(join(tmpdir(), "drive-pr-baseref-repo-")),
    );
    execIn(baseRefRepo, ["init", "-q", "."]);
    execIn(baseRefRepo, ["config", "user.email", "test@example.invalid"]);
    execIn(baseRefRepo, ["config", "user.name", "Test"]);
    execIn(baseRefRepo, ["config", "commit.gpgsign", "false"]);
    execIn(baseRefRepo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(baseRefRepo, "a.ts"), "line1\n");
    execIn(baseRefRepo, ["add", "-A"]);
    execIn(baseRefRepo, ["commit", "-q", "-m", "init"]);

    fetchFailOriginRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "drive-pr-baseref-origin-")),
    );
    fetchFailOrigin = join(fetchFailOriginRoot, "example-org", "example-repo");
    mkdirSync(fetchFailOrigin, { recursive: true });
    execIn(fetchFailOrigin, ["init", "-q", "."]);
    // 60s, not bun's 5s default — see the identical comment on the file's
    // top-level `beforeAll`: this hook spawns several `git` subprocesses, and
    // under the concurrent-suite load this repo's gates run at, that reliably
    // exceeds 5s.
  }, 60_000);

  afterAll(() => {
    if (stubBinDir) rmSync(stubBinDir, { recursive: true, force: true });
    if (baseRefRepo) rmSync(baseRefRepo, { recursive: true, force: true });
    if (fetchFailOriginRoot) {
      rmSync(fetchFailOriginRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("the fake gh requires the modeled projections and selectors", () => {
    writeGhStub("echo accepted\n");
    const ghPath = join(stubBinDir, "gh");
    for (const args of [
      ["repo", "view"],
      ["repo", "view", "--json", "name"],
      ["repo", "view", "wrong/repo", "--json", "owner,name"],
      ["pr", "view", "wrong-pr", "--json", "baseRefName", "-q", ".baseRefName"],
      ["pr", "view", "42 --json", "baseRefName", "-q", ".baseRefName"],
    ]) {
      const result = Bun.spawnSync([ghPath, ...args]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        "unsupported command signature",
      );
    }
    expect(
      Bun.spawnSync([ghPath, "repo", "view", "--json", "owner,name"]).exitCode,
    ).toBe(0);
  });

  // `gh pr view --json number -q .number` (ambient, `resolvePr`'s own call —
  // no target between `view` and `--json`) resolves PR 42; `gh pr view 42
  // --json baseRefName -q .baseRefName` resolves the base branch name; `gh
  // repo view --json owner,name` answers the PR's own repository.
  const GH_STUB = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ]; then
  echo "42"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "develop"
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo '{"owner":{"login":"example-org"},"name":"example-repo"}'
  exit 0
fi
echo "gh-stub: unhandled command: $*" >&2
exit 1
`;

  async function runWithStub(): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }> {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "self-inflicted.ts"),
        "--repo",
        baseRefRepo,
      ],
      {
        stdin: new Response(
          `${JSON.stringify({ threadId: "T1", path: "a.ts", line: 1 })}\n`,
        ),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...scrubbedGitEnv(),
          DRIVE_PR_BASE_REF: "",
          PATH: `${stubBinDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it(
    "refuses to fetch — and labels every record null — when origin does not name the PR’s own repository",
    async () => {
      writeGhStub(GH_STUB);
      // A real, resolvable `origin` naming a DIFFERENT repository than the
      // stub `gh repo view` reports — a concrete mismatch, not merely an
      // absent remote (which would fail for the weaker reason "no fetch URL
      // at all" and never exercise `verifyOriginIsPrRepo`'s comparison).
      execIn(baseRefRepo, [
        "remote",
        "add",
        "origin",
        "https://github.com/some-other-org/some-other-repo.git",
      ]);
      try {
        const r = await runWithStub();
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain("not this PR's own repository");
        expect(r.stderr).toContain("NOT MEASURED");
        expect(JSON.parse(r.stdout.trim()).selfInflicted).toBeNull();
      } finally {
        execIn(baseRefRepo, ["remote", "remove", "origin"]);
      }
    },
    CLI_TIMEOUT_MS,
  );

  it(
    "refuses to trust the ref — and labels every record null — when the fetch itself fails",
    async () => {
      writeGhStub(GH_STUB);
      // Verification passes: `fetchFailOrigin`'s path parses to the exact
      // `owner/name` the stub `gh repo view` reports (see its own comment
      // above `repoOfUrl` is host-agnostic, so a local path works). It is a
      // real, local, network-free repository — so the fetch fails fast and
      // deterministically (no `develop` branch, no commit at all to name
      // one) rather than depending on network reachability, and that failure
      // must not be read as "proceed with whatever origin/develop is already
      // on disk".
      // Added as a file URL: `repoOfUrl` reads `owner/name` out of git URL
      // forms, and a Windows drive-letter path is not one.
      execIn(baseRefRepo, [
        "remote",
        "add",
        "origin",
        pathToFileURL(fetchFailOrigin).href,
      ]);
      try {
        const r = await runWithStub();
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain("could not refresh origin/develop");
        expect(r.stderr).toContain("NOT MEASURED");
        expect(JSON.parse(r.stdout.trim()).selfInflicted).toBeNull();
      } finally {
        execIn(baseRefRepo, ["remote", "remove", "origin"]);
      }
    },
    CLI_TIMEOUT_MS,
  );
});

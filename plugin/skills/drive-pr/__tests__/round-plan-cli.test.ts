import { prBaseGh, addOrigin, realGitForShell } from "./round-plan-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
/**
 * drive-pr suite: announce-merge-ready.ts, marker overrides, round-delta.ts, round-plan.ts, the PR-target channel and guarded-push.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import {
  SCRIPTS,
  writeVerifiedSha,
  tmpRoot,
  binDir,
  scratchClean,
  gitCleanEnv,
  makeScratchRepo,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  byPlatform,
  skipsOnWindows,
} from "../../../../lib/test-helpers/windows-skip.ts";

useDrivePrSuite();

describe("round-plan.ts", () => {
  async function roundPlan(args: string[], stateDir: string, repo: string) {
    addOrigin(repo);
    const proc = Bun.spawn(
      scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", ...args),
      {
        cwd: repo,
        env: {
          ...gitCleanEnv(),
          PATH: `${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it("defaults to the CUMULATIVE plan even with a verified SHA recorded", async () => {
    // drive-pr `SKILL.md` § 5's validation plan requires re-resolving the
    // complete change after each review fix, not once per PR. A delta plan
    // derived from round N's own diff cannot contain the check that catches an
    // interaction with a file round 1 changed — and the cumulative tree is what
    // gets pushed. So the presence of a verified SHA must not silently narrow
    // the plan; only an explicit --delta may.
    const { dir: repo, head } = makeScratchRepo("rp-cumulative");
    const stateDir = scopedStateDir(mkdtempSync(join(tmpRoot, "rp-")), repo);
    const base = Bun.spawnSync(
      ["git", "update-ref", "refs/remotes/origin/develop", "HEAD~1"],
      { cwd: repo, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    if (base.exitCode !== 0) throw new Error(base.stderr.toString());
    // Keep the resolver deterministic and independent of the live checkout's
    // pending merge, catalog, and uncommitted files.
    mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
    writeFileSync(
      join(repo, "tools", "change-areas", "resolve.ts"),
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          seedAreas: [],
          validation: {
            localChecks: [],
            verificationChecks: [],
            testbox: { required: false },
          },
          reviewSkills: [],
        }),
      )});`,
    );
    writeVerifiedSha(stateDir, head);

    const dflt = await roundPlan([], stateDir, repo);
    expectSpawnExit(dflt, 0);
    expect(dflt.stdout).toContain("round-plan (cumulative");

    const delta = await roundPlan(["--delta"], stateDir, repo);
    expectSpawnExit(delta, 0);
    expect(delta.stdout).toContain("round-plan (delta");
    // And an opt-in delta says what it traded away, so the choice is visible in
    // the round's own transcript rather than only in this file. Asserted here
    // because the delta base is HEAD, so the file list is empty on a clean
    // checkout and non-empty on a dirty one — and the caveat must survive BOTH.
    // An empty delta is where it matters most: "nothing to validate this round"
    // is the most convincing possible way to read a scoping choice as an
    // all-clear. (This is why the assertion failed only in CI first time round.)
    expect(delta.stdout).toContain("DELTA plan");
  });

  it("diffs against the base of the remote repository.remote names, not origin's", async () => {
    // A clone whose only remote is `upstream`: the round's base must be read
    // through that remote's tracking ref, and its URL checked, with no
    // `origin` anywhere.
    const { dir: repo } = makeScratchRepo("rp-remote");
    const stateDir = scopedStateDir(mkdtempSync(join(tmpRoot, "rp-")), repo);
    const git = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        env: gitCleanEnv(),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git(["remote", "add", "upstream", "https://github.com/acme/widgets.git"]);
    git(["update-ref", "refs/remotes/upstream/develop", "HEAD~1"]);
    mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
    writeFileSync(
      join(repo, "tools", "change-areas", "resolve.ts"),
      `process.stdout.write(${JSON.stringify(
        JSON.stringify({
          seedAreas: [],
          validation: {
            localChecks: [],
            verificationChecks: [],
            testbox: { required: false },
          },
          reviewSkills: [],
        }),
      )});`,
    );
    const run = async (env: Record<string, string>) => {
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "round-plan.ts"), "999"),
        {
          cwd: repo,
          env: {
            ...gitCleanEnv(),
            PATH: `${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_STATE_DIR: stateDir,
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const configured = await run({ JIG__REPOSITORY__REMOTE: "upstream" });
    expectSpawnExit(configured, 0);
    expect(configured.stdout).toContain("round-plan (cumulative");

    // Without the setting the drive looks for `origin`, which this clone
    // does not have, and refuses rather than diffing against something else.
    const unset = await run({});
    expectSpawnExit(unset, 1);
    expect(unset.stderr).toContain("no fetch URL for the remote 'origin'");
  });

  // ── Testbox decay ──────────────────────────────────────────────
  //
  // The scenario these pin is one measured on a live drive: a cumulative plan
  // holding `testbox.required: true` on the strength of round-1 `profile: full`
  // files, while the pre-push hook skipped the mandatory heavy phase on the
  // very same commit because its own (push-range) scope saw nothing
  // full-profile. Both were right; an operator following both got opposite
  // instructions. The plan now answers once and prints the divergence.
  //
  // Every probe runs against a DEDICATED SCRATCH REPOSITORY with a stubbed
  // resolver, never against this checkout. An earlier design fabricated the
  // base in the real repo with `git commit-tree -p HEAD` over a throwaway
  // index, and it was wrong twice over. It hashed the developer's whole
  // worktree into the repository's object store (in a Conductor worktree, the
  // main clone's) on every commit, since lefthook runs this suite on all of
  // them. And the base it built was a DESCENDANT of HEAD — a state the driver
  // cannot produce, because `set-verified` records HEAD itself, so a recorded
  // SHA is always HEAD or an ancestor. Those probes only passed because
  // `cat-file -e` asks whether an object exists rather than whether it is
  // behind HEAD; the ancestry guard they now pin is exactly that distinction,
  // and it is what exposed the fabrication as impossible.
  //
  // A scratch repo makes the history explicit instead: C0 (also the stand-in
  // `origin/develop`) and C1, so "verified is an ancestor" and "verified is
  // HEAD" are both reachable honestly, and the outcome does not depend on what
  // the developer happens to have modified.
  describe("Testbox decay against the last green-verified SHA", () => {
    let repo: string;
    /** C0 — the merge-base, doubling as `origin/develop`. */
    let c0: string;
    /** C1 — HEAD, adding one file on top of C0. */
    let c1: string;

    const ADDED_REL = "tools/change-areas/probe-added.txt";

    // An explicit identity, not the ambient one: `git commit` and
    // `git commit-tree` write real commit objects and refuse without a
    // committer. A CI runner has no `user.email` configured and cannot
    // auto-detect one from `runner@ip-…(none)`, so probes relying on the
    // ambient identity failed there (measured on the Testbox) while passing on
    // any developer machine. Passed as env, never `git config`.
    const IDENTITY = {
      GIT_AUTHOR_NAME: "drive-pr probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "drive-pr probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
    };

    const git = (args: string[], env: Record<string, string> = {}) => {
      const out = Bun.spawnSync(["git", ...args], {
        cwd: repo,
        // gitCleanEnv() strips every GIT_* pointer (see its doc comment), so a
        // git hook's exported GIT_DIR cannot redirect these at the real
        // repository — which is also why `cwd` alone is not enough.
        env: { ...gitCleanEnv(), ...IDENTITY, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (out.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${out.stderr.toString()}`,
        );
      }
      return out.stdout.toString().trim();
    };

    beforeAll(() => {
      repo = mkdtempSync(join(tmpRoot, "rp-repo-"));
      git(["init", "-q", "-b", "main"]);
      git(["config", "commit.gpgsign", "false"]);
      git(["config", "core.autocrlf", "false"]);
      git(["config", "core.hooksPath", "/dev/null"]);
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "C0", "--no-verify"]);
      c0 = git(["rev-parse", "HEAD"]);
      // round-plan.ts resolves its cumulative base as
      // `git merge-base origin/develop HEAD`, so the scratch repo needs that
      // ref to exist. A plain ref update is enough — no remote is contacted.
      git(["update-ref", "refs/remotes/origin/develop", c0]);
      addOrigin(repo);

      mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
      writeFileSync(join(repo, ADDED_REL), "added in C1\n");
      git(["add", "-A"]);
      git(["commit", "-qm", "C1", "--no-verify"]);
      c1 = git(["rev-parse", "HEAD"]);
      // The stubbed resolver below is written INTO this repo, at the path
      // round-plan.ts spawns. Left visible to git it would be an untracked
      // file in the very diff round-plan resolves — making every "nothing has
      // changed since the verified SHA" probe see a change, and decay probes
      // fail for a reason that has nothing to do with decay. `info/exclude` is
      // the repo-local ignore that `--exclude-standard` honours and that no
      // committed `.gitignore` has to carry.
      writeFileSync(
        join(repo, ".git", "info", "exclude"),
        "tools/change-areas/resolve.ts\n",
      );
    });

    /**
     * A stand-in for `tools/change-areas/resolve.ts`, written INTO the scratch
     * repo at the path round-plan.ts resolves. The first call answers as the
     * real resolver would for a `profile: full` plan; the second — the delta
     * read — answers `delta`.
     *
     * Stubbing the resolver is what lets these probes assert a fixed outcome:
     * the real one would answer from `catalog.yaml`, so every probe would
     * depend on which paths happen to be `profile: full` today. The counter
     * lives in a file because each call is a separate process.
     *
     * It stubs the SCRIPT, not the interpreter. The earlier version shimmed a
     * `bun` on PATH and keyed on argv[1] — which silently stopped intercepting
     * anything the moment round-plan.ts started spawning the resolver under
     * `tsArgv` (process.execPath + an absolute path) instead of a hardcoded
     * `bun`, i.e. the moment the cross-platform fix these probes should have
     * been indifferent to landed. Stubbing the file keeps the probes about the
     * decay logic rather than about how the resolver happens to be launched.
     */
    const resolverShim = (delta?: { body?: string; exit?: number }) => {
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-"));
      const second =
        delta === undefined
          ? `console.error('unexpected second resolve'); process.exit(1);`
          : delta.exit
            ? `console.error('resolver exploded'); process.exit(1);`
            : `process.stdout.write(${JSON.stringify(`${delta.body}\n`)}); process.exit(0);`;
      const plan = JSON.stringify(
        `{"seedAreas":["catalog-self"],"validation":{"localChecks":["pnpm check-types"],"verificationChecks":[],"testbox":{"required":true,"command":"echo box","reason":"area-opt-in","requiredBy":[{"area":"catalog-self","files":["${ADDED_REL}"]}]}},"reviewSkills":[]}\n`,
      );
      mkdirSync(join(repo, "tools", "change-areas"), { recursive: true });
      writeFileSync(
        join(repo, "tools", "change-areas", "resolve.ts"),
        `import { readFileSync, writeFileSync } from 'node:fs';
const countFile = ${JSON.stringify(join(dir, "count"))};
let n = 0;
try {
  n = Number.parseInt(readFileSync(countFile, 'utf8').trim(), 10) || 0;
} catch {}
writeFileSync(countFile, String(n + 1));
if (n === 0) {
  process.stdout.write(${plan});
  process.exit(0);
}
${second}
`,
      );
      return dir;
    };

    /** A delta plan the resolver would emit for a file in a Testbox-opted-in area. */
    const DELTA_FULL =
      '{"seedAreas":["catalog-self"],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{"required":true,"command":"echo box","reason":"area-opt-in","requiredBy":[]}},"reviewSkills":[]}';

    const planIn = async (
      stateDir: string,
      shimDir: string,
      args: string[] = ["--json"],
    ) => {
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", ...args),
        {
          cwd: repo,
          env: {
            ...gitCleanEnv(),
            ...IDENTITY,
            PATH: `${shimDir}${delimiter}${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_STATE_DIR: stateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const setVerified = async (stateDir: string, sha: string) => {
      writeVerifiedSha(stateDir, sha);
    };

    it("fails closed with no verified SHA — and says WHICH files hold the requirement", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-noverified-")),
        repo,
      );
      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.planRequired).toBe(true);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      // Never evaluated — there is no base to evaluate it against.
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain("fail-closed");
      // The floor this issue asked for: when the box IS required, the plan
      // names the evidence. The rule's name alone (`reason`) was true and
      // useless on twelve consecutive rounds of one measured drive.
      expect(
        plan.testboxDecision.requiredBy.flatMap(
          (entry: { files: string[] }) => entry.files,
        ),
      ).toContain(ADDED_REL);
    });

    it("fails closed when the recorded verified SHA is not a commit in this clone", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-badsha-")),
        repo,
      );
      const bogus = "f".repeat(40);
      await setVerified(stateDir, bogus);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      // Cleared, not echoed: nothing downstream should read a SHA this clone
      // cannot resolve as if it were a real verification point.
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain(bogus.slice(0, 12));
    });

    // A corrupted state file can carry a SYMBOLIC ref (e.g. `HEAD`) instead of
    // a 40-character SHA and still pass `isUsableState`'s bare `typeof ===
    // 'string'` check —
    // `set-verified`'s own CLI validation refuses this shape outright, so the
    // corruption is modeled the same way the TRIAGE_CHECK_FAILED fixture
    // does: seed a well-formed state via the CLI, then hand-edit the one
    // field. Both `cat-file -e HEAD^{commit}` and `merge-base --is-ancestor
    // HEAD HEAD` resolve successfully — `HEAD` moves WITH the tree being
    // validated against it — so a missing format check here would silently
    // accept a base that answers "nothing changed" no matter what this
    // round's commits actually touched.
    it("fails closed when the recorded verified SHA is a symbolic ref, not a SHA", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-symbolicref-")),
        repo,
      );
      await setVerified(stateDir, "f".repeat(40));
      const statePath = join(stateDir, "drive-pr-999.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.verifiedSha = "HEAD";
      writeFileSync(statePath, JSON.stringify(state));

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain(
        "not a 40-character commit SHA",
      );
    });

    // Existing is not ancestral. `cat-file -e` answers "is this object here",
    // which a rebased or force-pushed SHA still satisfies while sitting on a
    // history HEAD is not on — and the delta is then taken against an unrelated
    // tree, whose answer says nothing about this one.
    it("refuses to decay against a verified SHA that is not an ancestor of HEAD", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-offbranch-")),
        repo,
      );
      // A parentless commit carrying HEAD's own tree: a real, resolvable
      // object on a history of its own — the shape a force-pushed base leaves
      // behind. Its tree matches HEAD exactly, so a missing ancestry check
      // would compute an empty delta and decay.
      const orphan = git([
        "commit-tree",
        `${c1}^{tree}`,
        "-m",
        "off-branch probe",
      ]);
      await setVerified(stateDir, orphan);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.verifiedSha).toBe(null);
      expect(plan.testboxDecision.note).toContain("not an ancestor of HEAD");
      expect(plan.testboxDecision.note).toContain("fail-closed");
    });

    it("decays a cumulative requirement held up only by files unchanged since the verified SHA", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-decay-")),
        repo,
      );
      // HEAD itself — what `set-verified` records at the end of a round. The
      // cumulative diff C0..C1 still contains the `profile: full` file, so the
      // plan asks for a box; nothing has changed since C1, so the delta is
      // empty and the requirement is stale rather than owed.
      await setVerified(stateDir, c1);

      const { stdout } = await planIn(stateDir, resolverShim());
      const plan = JSON.parse(stdout);

      // The cumulative plan still says yes — that answer is not wrong, just
      // stale.
      expect(plan.testboxDecision.planRequired).toBe(true);
      // Nothing has changed since a tree whose gates passed green, so the box
      // would re-run a suite that already passed on exactly this content.
      expect(plan.testboxDecision.incrementalRequired).toBe(false);
      expect(plan.testboxDecision.decayed).toBe(true);
      expect(plan.testboxDecision.required).toBe(false);
      expect(plan.testboxDecision.verifiedSha).toBe(c1);
      // `validation` stays exactly as the resolver emitted it, so the payload
      // carries two answers. It must say IN THE PAYLOAD which one to act on —
      // a consumer reading `validation.testbox.required` would still warm a box.
      expect(plan.testboxDecision.note).toContain(
        "act on testboxDecision.required",
      );
      // The cheap cumulative checks are NOT decayed with it — the whole point
      // of the split is that "is the tree valid" and "does this round warrant a
      // box" are different questions with different scopes.
      expect(plan.validation.localChecks).toContain("pnpm check-types");
      expect(plan.validation.testbox.required).toBe(true);

      // …and the human-readable form states the divergence rather than leaving
      // it to be discovered, naming both the stale files and the base.
      const text = await planIn(stateDir, resolverShim(), []);
      expect(text.stdout).toContain("Testbox: NOT required this round");
      expect(text.stdout).toContain(ADDED_REL);
      expect(text.stdout).toContain(c1.slice(0, 12));
      expect(text.stdout).toContain("pre-push hook");
    });

    it("does NOT decay when a full-profile file changed since the verified SHA", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-nodecay-")),
        repo,
      );
      // C0 — a genuine ancestor, and one that predates the `profile: full`
      // file, so it is in the delta as well as the cumulative diff and the
      // requirement is live rather than stale.
      await setVerified(stateDir, c0);

      const { stdout } = await planIn(
        stateDir,
        resolverShim({ body: DELTA_FULL }),
      );
      const plan = JSON.parse(stdout);

      expect(plan.testboxDecision.planRequired).toBe(true);
      expect(plan.testboxDecision.incrementalRequired).toBe(true);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
    });

    it.skipIf(
      skipsOnWindows(
        "git-bash",
        "the configured command runs through cmd.exe, which reports a missing program as a shell that could not be started, not as a failed command",
      ),
    )(
      "names the configured plan command when its program is missing",
      async () => {
        // The plan command runs through the shell, which reports a missing
        // program as exit 127; the message names the configuration field the
        // operator has to look at. The stub resolver is written but
        // unreachable — a PATH with no `bun` on it is the whole probe.
        const stateDir = scopedStateDir(
          mkdtempSync(join(tmpRoot, "rp-nobun-")),
          repo,
        );
        const dir = resolverShim({ body: DELTA_FULL });
        // Launched by ABSOLUTE runtime path, not through the `#!/usr/bin/env bun`
        // shebang: the shebang needs bun on PATH too, so it would fail at 127
        // before round-plan.ts ran a line, and the probe would pass for the wrong
        // reason. The script runs; only the resolver's `bun` is missing.
        const proc = Bun.spawn(
          [process.execPath, join(SCRIPTS, "round-plan.ts"), "999", "--json"],
          {
            cwd: repo,
            env: {
              ...gitCleanEnv(),
              ...IDENTITY,
              // `binDir` carries the gh/git stubs this harness needs; what it does
              // NOT carry is bun. The system directories supply the shell (and, on
              // Windows, the real git and sh, which live apart from any bun).
              PATH: [
                dir,
                prBaseGh(),
                binDir,
                // Windows keeps git and sh in Git for Windows' own directories.
                ...byPlatform("Windows keeps git and sh apart", {
                  windows: [Bun.which("git"), Bun.which("sh")].map((p) =>
                    dirname(p as string),
                  ),
                  posix: ["/usr/bin", "/bin"],
                }),
              ].join(delimiter),
              DRIVE_PR_STATE_DIR: stateDir,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stderr, exitCode] = await Promise.all([
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expectSpawnExit({ stdout: null, stderr, exitCode }, 1);
        expect(stderr).toContain("drive.validation_plan_command failed");
      },
    );

    // The decay argument is built entirely on `validation.testbox.required`, so
    // the read has to be as fail-closed as the argument claims to be. A bare
    // `jq -r` on a field the resolver stopped emitting exits 0 with the text
    // `null` — neither `true` nor `false` — and the requirement evaporates
    // silently. That is the one failure mode this block must never have.
    it('STOPS rather than reading a non-boolean testbox.required as "no box needed"', async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-badcontract-")),
        repo,
      );
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-bad-"));
      writeFileSync(
        join(repo, "tools", "change-areas", "resolve.ts"),
        `process.stdout.write(
  '{"seedAreas":[],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{}},"reviewSkills":[]}\\n',
);
process.exit(0);
`,
      );

      const { stdout, stderr, exitCode } = await planIn(stateDir, dir);

      expectSpawnExit({ stdout, stderr, exitCode }, 1);
      expect(stderr).toContain("boolean validation.testbox.required");
      // And emphatically NOT a plan that a caller could act on: a printed
      // "Testbox: not required" is the fail-open this pins shut.
      expect(stdout).not.toContain("not required");
    });

    // Both delta-side branches are NON-fatal by design — an unusable delta is
    // the ambiguous case the block resolves by keeping the cumulative answer.
    // That makes them the dangerous ones: a regression here does not exit 1, it
    // decays the requirement and prints "do not warm one", which is the exact
    // fail-open the whole block argues against.
    for (const probe of [
      {
        label: "returns a non-boolean testbox.required",
        delta: {
          body: '{"seedAreas":[],"validation":{"localChecks":[],"verificationChecks":[],"testbox":{}},"reviewSkills":[]}',
        },
        note: "did not emit a boolean testbox requirement",
      },
      {
        label: "fails outright",
        delta: { exit: 1 },
        note: "the delta resolution failed",
      },
    ]) {
      it(`keeps the cumulative answer when the DELTA resolution ${probe.label}`, async () => {
        const stateDir = scopedStateDir(
          mkdtempSync(join(tmpRoot, "rp-deltafail-")),
          repo,
        );
        // C0: an ancestor with a non-empty delta, so the decay is refused on
        // the DELTA's merits rather than on the ancestry guard above.
        await setVerified(stateDir, c0);

        const { stdout, stderr, exitCode } = await planIn(
          stateDir,
          resolverShim(probe.delta),
        );
        expectSpawnExit({ stdout, stderr, exitCode }, 0);
        const plan = JSON.parse(stdout);

        expect(plan.testboxDecision.planRequired).toBe(true);
        expect(plan.testboxDecision.incrementalRequired).toBe(null);
        expect(plan.testboxDecision.decayed).toBe(false);
        expect(plan.testboxDecision.required).toBe(true);
        expect(plan.testboxDecision.note).toContain(probe.note);
        expect(plan.testboxDecision.note).toContain("fail-closed");
      });
    }

    /**
     * A `git` that fails the file-listing diff for ONE revision and defers
     * every other invocation to the real binary, so nothing but the step under
     * test is disturbed. Scoping it to a revision is what lets the delta probe
     * reach its branch at all: a shim that failed every `--no-renames` diff
     * would trip the cumulative listing first and exit before the delta ran.
     */
    const gitShimFailingDiffFor = (rev: string) => {
      const dir = mkdtempSync(join(tmpRoot, "rp-shim-git-"));
      const real = realGitForShell();
      writeFakeProgram(
        join(dir, "git"),
        `#!/usr/bin/env bash
diffish=0
for a in "$@"; do [ "$a" = "--no-renames" ] && diffish=1; done
if [ "$diffish" = "1" ]; then
  for a in "$@"; do
    if [ "$a" = "${rev}" ]; then
      echo "fatal: bad object (probe)" >&2
      exit 128
    fi
  done
fi
exec "${real}" "$@"
`,
      );
      return dir;
    };

    // The resolver shim rides along: without it the real `resolve.ts` runs in a
    // scratch repo that has no such file, the plan dies at "the change-area
    // resolver failed", and a probe asserting a non-zero exit would pass for
    // entirely the wrong reason.
    const planWithGitShim = async (stateDir: string, gitDir: string) => {
      const proc = Bun.spawn(
        scriptArgv(join(SCRIPTS, "round-plan.ts"), "999", "--json"),
        {
          cwd: repo,
          env: {
            ...gitCleanEnv(),
            ...IDENTITY,
            PATH: `${gitDir}${delimiter}${resolverShim({ body: DELTA_FULL })}${delimiter}${prBaseGh()}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
            DRIVE_PR_STATE_DIR: stateDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    // Both file lists are built the same way and carry the same fail-open:
    // `{ git diff; git ls-files; } | sort -u` reports only `sort`'s status, so a
    // failing `git diff` exits 0 and its missing output reads as "nothing
    // changed". On the cumulative side that prints "no files changed — nothing
    // to validate"; on the delta side it decays the Testbox requirement.
    it("refuses to emit a plan when the cumulative file list cannot be computed", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-difffail-")),
        repo,
      );
      const { stdout, stderr, exitCode } = await planWithGitShim(
        stateDir,
        gitShimFailingDiffFor(c0),
      );

      expectSpawnExit({ stdout, stderr, exitCode }, 1);
      expect(stderr).toContain("cannot list the files changed since");
      // Never the empty-plan branch, whose wording an operator would read as
      // an all-clear.
      expect(stdout).not.toContain("nothing to validate");
    });

    it("keeps the cumulative answer when the DELTA file list cannot be computed", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpRoot, "rp-deltadifffail-")),
        repo,
      );
      // Verified at C1 so the delta diff names a DIFFERENT revision than the
      // cumulative one (whose base is C0) — the cumulative listing therefore
      // succeeds and the failure lands squarely on the delta.
      await setVerified(stateDir, c1);

      const { stdout, stderr, exitCode } = await planWithGitShim(
        stateDir,
        gitShimFailingDiffFor(c1),
      );

      expectSpawnExit({ stdout, stderr, exitCode }, 0);
      const plan = JSON.parse(stdout);
      // Without the check this is the worst case in the whole block: an empty
      // delta, `incrementalRequired: false`, and a decayed "do not warm one".
      expect(plan.testboxDecision.incrementalRequired).toBe(null);
      expect(plan.testboxDecision.decayed).toBe(false);
      expect(plan.testboxDecision.required).toBe(true);
      expect(plan.testboxDecision.note).toContain(
        "delta file list could not be computed",
      );
      expect(plan.testboxDecision.note).toContain("fail-closed");
    });
  });

  // The empty branch is a hand-written stub of the resolver's shape rather than
  // the resolver's own output, so it is the one place the JSON contract can
  // drift without any type ever complaining. A consumer that iterates
  // `requiredBy` unconditionally works on every non-empty plan and crashes on
  // the empty one — a shape bug that only ever fires on the quietest round.
  it("emits the SAME testbox shape on an empty plan as on a resolved one", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpRoot, "rp-empty-")),
      scratchClean.dir,
    );
    // A clean scratch repo: nothing changed since its own HEAD, so the file
    // list is empty by construction rather than by hoping this worktree is
    // clean (it is not, mid-round).
    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "round-plan.ts"),
        "999",
        "--since",
        scratchClean.head,
        "--json",
      ),
      {
        cwd: scratchClean.dir,
        // gitCleanEnv, not process.env: a git hook exports GIT_DIR and
        // GIT_INDEX_FILE, so under `lefthook`'s pre-commit this probe would
        // resolve `--show-toplevel` to the REAL repository despite its cwd,
        // fail to find the scratch HEAD, and exit 1. It passed standalone and
        // failed at commit time — measured, not hypothesised.
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_STATE_DIR: stateDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    expect(stderr).toBe("");
    const plan = JSON.parse(stdout);

    expect(plan.empty).toBe(true);
    // Arrays, not absent — `?.` and `|| []` at the consumer are exactly the
    // defensive noise a stable contract exists to remove.
    expect(plan.testboxDecision.requiredBy).toEqual([]);
    expect(plan.validation.testbox.requiredBy).toEqual([]);
    // Every OTHER field of the stub too, not just the one that drifted: the
    // point is the whole shape, and an assertion covering one field leaves the
    // next omission to be found the same way this one was.
    expect(plan.testboxDecision.required).toBe(false);
    expect(plan.testboxDecision.planRequired).toBe(false);
    expect(plan.testboxDecision.incrementalRequired).toBe(null);
    expect(plan.testboxDecision.decayed).toBe(false);
    expect(plan.testboxDecision.verifiedSha).toBe(null);
    expect(plan.testboxDecision.note).toBe(null);
    // The rest of the resolver's testbox contract, for the same reason.
    expect(plan.validation.testbox.required).toBe(false);
    expect(plan.validation.testbox.command).toBe(null);
    expect(plan.validation.testbox.reason).toBe(null);
  });
});

/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ExitError } from "../scripts/lib/cli";
import { LEAVE_OPEN_MARKER } from "../scripts/lib/outcome.ts";
import {
  assertRemoteMutationAllowed,
  leaseFilesFor,
  leasePathFor,
  parseDirIdentityToken,
  parseLease,
  readLease,
  stateDirIdentityToken,
} from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  writeVerifiedSha,
  HEAD,
  PREV,
  GIT_PUSH_FLAG_GUARD,
  ACTOR,
  type Fixture,
  STICKY_ROUND,
  binDir,
  scratchClean,
  scratchOther,
  gitCleanEnv,
  makeScratchRepo,
  makeUnresolvedMergeRepo,
  makeBaseSyncMergeRepo,
  makeRenameRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

describe("answer-summary-finding.ts", () => {
  // `head` sets the PR head the stubbed API reports; `cwd` is the worktree the
  // script inspects. The accepted path now reads BOTH, so its probes run in a
  // scratch repo — the real checkout is dirty whenever anyone is editing it,
  // and its HEAD is not the fixture's.
  async function answer(
    args: string[],
    reason: string,
    opts: {
      head?: string;
      cwd?: string;
      stickyRound?: null;
      backlog?: boolean;
      fixDependentAddressed?: Fixture["fixDependentAddressed"];
      env?: Record<string, string>;
      /** Runs after the fixture exists, before the script does. */
      seed?: (stateDir: string) => void;
    } = {},
  ) {
    const { dir, stateDir } = writeFixture({
      ...(opts.head ? { head: opts.head } : {}),
      // `null` models a sticky with no `ai-review-round` marker, which is what
      // decides whether the posted marker carries a round at all.
      ...(opts.stickyRound === null ? { stickyRound: null } : {}),
      ...(opts.backlog === undefined ? {} : { backlog: opts.backlog }),
      ...(opts.fixDependentAddressed === undefined
        ? {}
        : { fixDependentAddressed: opts.fixDependentAddressed }),
    });
    opts.seed?.(stateDir);
    const proc = Bun.spawn(
      [join(SCRIPTS, "answer-summary-finding.ts"), ...args, "999"],
      {
        cwd: opts.cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          // The script now consults the session lease before it posts
          //, so every probe needs a state dir of its own. Left
          // unset, the fence would read the REAL clone's drive state and a
          // live drive in this worktree would refuse the whole describe block.
          DRIVE_PR_STATE_DIR: stateDir,
          // And since PR #4107 round 16 the override REQUIRES its identity
          // beside it: `$DRIVE_PR_STATE_DIR` without
          // `$DRIVE_PR_STATE_DIR_IDENTITY` is a superseded driver and
          // refuses. This is what a current `drive.ts` would have exported
          // for this fixture, so the probe exercises the ordinary path rather
          // than the refusal.
          DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
          ...opts.env,
        },
        stdin: new TextEncoder().encode(reason),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const posted = await Bun.file(join(dir, "posted.jsonl"))
      .text()
      .catch(() => "");
    return { exitCode, stderr, posted, stateDir };
  }

  it("composes a body opening with the outcome token plus a marker per finding", async () => {
    const r = await answer(
      [
        "--outcome",
        "wont-fix",
        "--fingerprint",
        "abc123",
        "--fingerprint",
        "def456",
      ],
      "valid, but docs polish on an unchanged file.",
    );
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.posted).body as string;
    expect(body.startsWith("**wont-fix** — valid, but docs polish")).toBe(true);
    expect(body).toContain("<!-- drive-pr-addressed: abc123 -->");
    expect(body).toContain("<!-- drive-pr-addressed: def456 -->");
  });

  it("rejects an outcome outside the closed vocabulary", async () => {
    const r = await answer(
      ["--outcome", "fixed", "--fingerprint", "abc123"],
      "reason",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("closed-vocabulary");
  });

  it("rejects a reason that already opens with an outcome token (#3995 round 10)", async () => {
    // Measured on this skill's own PR. The token is composed from --outcome, so
    // a reason carrying one too posts `**accepted** — **accepted** — …`, which
    // the reviewer-scoring harvester reads as a malformed sample — and the
    // marker posts regardless, so the finding reads as answered and no later
    // pass revisits it. The mistake is natural because `reply-to-thread.ts`
    // REQUIRES the token, and a held finding's reason is written the same way.
    const r = await answer(
      ["--outcome", "rejected", "--fingerprint", "abc123"],
      "**rejected** — the finding is wrong, and here is why.",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("already opens with an outcome token");
    // Nothing may be posted: a doubled token cannot be un-posted, only PATCHed.
    expect(r.posted).toBe("");
  });

  // The case above supplies the token at BYTE ZERO, which a naive `case $REASON
  // in '**rejected**'*)` would also catch — so it pins the guard's existence but
  // not its leading-whitespace normalization, and reverting `reason_check` to a
  // direct `$REASON` test keeps it green. A reason naturally starts with
  // indentation or a blank line when it is pasted out of an indented block or a
  // heredoc, and those are exactly the inputs that slipped through before
  // (docomply-review, a reference-implementation pull request round 17). Each variant is asserted separately:
  // one table row failing must name which whitespace shape regressed.
  for (const [label, reason] of [
    [
      "leading spaces",
      "  **rejected** — the finding is wrong, and here is why.",
    ],
    ["a leading tab", "\t**moot** — the code it names is already gone."],
    [
      "a leading blank line",
      "\n**wont-fix** — declined per the triage rubric (docs tier).",
    ],
  ] as const) {
    it(`rejects a reason whose outcome token is preceded by ${label} (#3995 round 17)`, async () => {
      // `rejected`, deliberately NOT `accepted`: the fix-dependent outcomes
      // also exit 2 when `--pushed-sha` is missing, so on a regressed guard an
      // `accepted` probe still exits 2 — for an unrelated reason — and only the
      // stderr assertion would discriminate. A durable outcome posts
      // immediately, so with the guard gone this reaches the POST and all three
      // assertions below fail independently.
      const r = await answer(
        ["--outcome", "rejected", "--fingerprint", "abc123"],
        reason,
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("already opens with an outcome token");
      expect(r.posted).toBe("");
    });
  }

  it("rejects a bare outcome with no reason", async () => {
    const r = await answer(
      ["--outcome", "rejected", "--fingerprint", "abc123"],
      "",
    );
    expect(r.exitCode).toBe(2);
  });

  it("requires at least one fingerprint", async () => {
    const r = await answer(["--outcome", "rejected"], "reason");
    expect(r.exitCode).toBe(2);
  });

  // The fingerprint reaches summary-findings.ts through the marker and nowhere
  // else. `@` is read back as a landed-SHA suffix, whitespace truncates the
  // marker's `[^\s>]+` capture, and `>` closes the HTML comment early — each
  // posts an answer under a key that is not the finding's, so the finding stays
  // unaddressed on every later head and the drive can NEVER converge. Rejecting
  // at the boundary is the only place that failure is visible.
  it.each(["abc@def", "abc def", "abc>def", "-leading-dash"])(
    "refuses a fingerprint the addressed marker cannot carry: %s",
    async (fp) => {
      const r = await answer(
        ["--outcome", "rejected", "--fingerprint", fp],
        "reason",
      );
      expect(r.exitCode).toBe(2);
      expect(r.posted).toBe("");
    },
  );

  // The FIX-DEPENDENT outcomes are held exactly like an accepted THREAD. Their
  // marker is proof the finding is answered, so it must not exist before the
  // change that answers it is on the PR: otherwise a failed gate or rejected
  // push leaves proof of work that never landed, and the next status check
  // converges over it. `moot` is one of them because it says the code the
  // finding describes is GONE — usually removed by this very round.
  it.each(["accepted", "moot"])(
    "refuses a %s answer with no --pushed-sha",
    async (outcome) => {
      const r = await answer(
        ["--outcome", outcome, "--fingerprint", "abc123"],
        "answered it.",
      );
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("--pushed-sha");
      expect(r.posted).toBe("");
    },
  );

  it("stamps the pushed SHA into a moot marker too", async () => {
    // A durable moot marker suppresses the finding forever, so a later round
    // that reintroduces the code inherits the answer that described its
    // absence. The SHA is what lets the marker expire once the reviewer has
    // looked at that head.
    const r = await answer(
      [
        "--outcome",
        "moot",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "the function it describes was deleted in this round.",
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      `<!-- drive-pr-addressed: abc123@${scratchClean.head}#${STICKY_ROUND} -->`,
    );
  });

  it("leaves a DURABLE outcome’s marker unstamped", async () => {
    // rejected / wont-fix / deferred assert something about the finding's
    // merit, which no commit changes. Stamping them would re-ask a standing
    // decision on every push.
    const r = await answer(
      ["--outcome", "wont-fix", "--fingerprint", "abc123"],
      "declined per the triage rubric.",
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      "<!-- drive-pr-addressed: abc123 -->",
    );
  });

  it("refuses an accepted answer whose --pushed-sha is not the PR head", async () => {
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        PREV,
      ],
      "fixed it.",
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not PR #999");
    expect(r.posted).toBe("");
  });

  it("accepts an accepted answer once the fix IS the PR head", async () => {
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "fixed it.",
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toStartWith("**accepted**");
  });

  // The SHA is what lets collectAddressed stop honouring the marker once the
  // reviewer has reviewed that head and is STILL reporting the finding. Without
  // it the marker is content-keyed and suppresses a regression forever.
  it("stamps the pushed SHA and the sticky round into an accepted marker", async () => {
    // The round is what bounds the winddown exemption in `collectAddressed`
    //. It is read back off the SAME reconciliation call this script
    // already makes, so producer and consumer read one field off one comment
    // rather than two sources that can disagree.
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "fixed it.",
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      `<!-- drive-pr-addressed: abc123@${scratchClean.head}#${STICKY_ROUND} -->`,
    );
  });

  it("omits the round when the sticky stamps none, rather than inventing one", async () => {
    // No round to measure elapsed rounds against means the exemption cannot be
    // bounded, and an unbounded exemption is the defect. The marker therefore
    // carries no round and `collectAddressed` withholds the exemption from it —
    // one re-answer, which stamps a round once the reviewer emits one again.
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "fixed it.",
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        stickyRound: null,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      `<!-- drive-pr-addressed: abc123@${scratchClean.head} -->`,
    );
  });

  // The probes below pin what the REMOVED `--held-at-sha` gate made
  // impossible (PR #4049 rounds 4-7). It required `--pushed-sha` to be a strict
  // descendant of the SHA the finding was held at, to prove a commit landed
  // since — but it proved a commit landed in the ROUND, never that the commit
  // was this finding's (two findings held together share a held SHA), so it
  // never caught the description-only answer it was built for, while it DID
  // refuse these two legitimate ones. Both now post. What bounds a false answer
  // is the expiry in `collectAddressed`, not a gate here.
  it("answers a first-time moot at an unchanged head — the removal predates the hold", async () => {
    // `moot` means the code the finding describes is already gone. When an
    // earlier round removed it, triage holds the finding at the CURRENT head
    // and no further commit is owed — so a round whose work is entirely
    // moot/rejected pushes nothing and answers at the same SHA it held at.
    // Under the old gate this could never be answered at all, and the drive
    // could not converge without manufacturing an unrelated commit
    // (chatgpt-codex-connector, a reference-implementation pull request round 7).
    const r = await answer(
      [
        "--outcome",
        "moot",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "the function it describes was already deleted in an earlier round.",
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      `<!-- drive-pr-addressed: abc123@${scratchClean.head}#${STICKY_ROUND} -->`,
    );
  });

  it("renews a lapsed marker at the same head — the re-answer path", async () => {
    // A marker whose winddown exemption has lapsed (posted at round 1, sticky
    // now at 7, bound 3) is expired but still ON the PR, over a fix that landed
    // rounds ago and is still perfectly good: `collectAddressed` re-asks the
    // finding and the driver renews the marker at the SAME head, because there
    // is nothing new to commit (chatgpt-codex-connector, a reference-implementation pull request round 4).
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "b9a7a18089043564",
        "--pushed-sha",
        scratchClean.head,
      ],
      "still fixed; renewing the lapsed marker.",
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        backlog: true,
        fixDependentAddressed: [
          {
            fingerprint: "b9a7a18089043564",
            sha: scratchClean.head,
            round: 1,
          },
        ],
      },
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.posted).body as string).toContain(
      `<!-- drive-pr-addressed: b9a7a18089043564@${scratchClean.head}#${STICKY_ROUND} -->`,
    );
  });

  // The API check alone is satisfied BEFORE any push: local HEAD already equals
  // the API head then, so `--pushed-sha "$(git rev-parse HEAD)"` passes while
  // the fix is still an uncommitted edit — and the marker is permanent proof of
  // work that never happened.
  it("refuses an accepted answer while the working tree is dirty", async () => {
    const dirty = makeScratchRepo("scratch-dirty");
    writeFileSync(join(dirty.dir, "seed.txt"), "the uncommitted fix\n");
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        dirty.head,
      ],
      "fixed it.",
      { head: dirty.head, cwd: dirty.dir },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("working tree is dirty");
    expect(r.posted).toBe("");
  });

  it("refuses an accepted answer whose SHA is not THIS worktree HEAD", async () => {
    // The SHA is the PR's head, so the API check passes — but it was read off
    // the PR rather than being the commit this checkout actually made.
    const r = await answer(
      [
        "--outcome",
        "accepted",
        "--fingerprint",
        "abc123",
        "--pushed-sha",
        scratchClean.head,
      ],
      "fixed it.",
      { head: scratchClean.head, cwd: scratchOther.dir },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("worktree's HEAD");
    expect(r.posted).toBe("");
  });

  // A durable outcome must NOT carry one: it is a claim about the finding, and
  // dating it would make the driver re-ask a standing wont-fix on every push.
  it("leaves a durable outcome undated", async () => {
    const r = await answer(
      ["--outcome", "wont-fix", "--fingerprint", "abc123"],
      "declined per the rubric.",
    );
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.posted).body as string;
    expect(body).toContain("<!-- drive-pr-addressed: abc123 -->");
    expect(body).not.toContain("abc123@");
  });

  it("still posts a non-accepted outcome with no --pushed-sha", async () => {
    const r = await answer(
      ["--outcome", "rejected", "--fingerprint", "abc123"],
      "the finding is wrong.",
    );
    expect(r.exitCode).toBe(0);
  });

  it("refuses to POST when this tree`s drive lease has been taken over", async () => {
    // The per-key claim protocol narrows the concurrent-dispatch
    // window; it does not close this one. Its claim is taken and released
    // around a POST that runs OUTSIDE the state mutex, so a session whose
    // lease was taken over in between still reached the API — and a duplicate
    // top-level answer, unlike a drive-state write, cannot be undone: it
    // carries its own `drive-pr-addressed` marker and enters the
    // reviewer-scoring sample twice.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const r = await answer(
        ["--outcome", "rejected", "--fingerprint", "abc123"],
        "the finding is wrong.",
        {
          // Another LIVE session in this same tree holds the lease, seeded
          // through drive-state.ts itself rather than by hand — a fabricated
          // record would agree only with this test's idea of the format, and
          // `readLease` reads an unparseable one as ABSENT, which is the
          // allowed branch.
          seed: (stateDir) => {
            const seed = Bun.spawnSync(
              [
                join(SCRIPTS, "drive-state.ts"),
                "phase",
                "999",
                "--set",
                "triage",
              ],
              {
                env: {
                  ...gitCleanEnv(),
                  DRIVE_PR_STATE_DIR: stateDir,
                  DRIVE_PR_SESSION: String(holder.pid),
                },
                stdout: "pipe",
                stderr: "pipe",
              },
            );
            expect(seed.exitCode).toBe(0);
            // The population the probe rests on: no lease file means nothing
            // to refuse, and the assertions below would pass vacuously.
            expect(
              readdirSync(stateDir).filter((f) =>
                /^pr-drive-lease-999-wt-[0-9a-f]{16}\.json$/.test(f),
              ),
            ).toHaveLength(1);
          },
          env: { DRIVE_PR_SESSION: String(process.pid) },
        },
      );
      expect(r.exitCode).toBe(11);
      // The assertion the issue is about: nothing reached the API.
      expect(r.posted).toBe("");
      expect(r.stderr).toContain(`pid ${holder.pid}`);
      expect(r.stderr).toContain("clear-lease 999");
    } finally {
      holder.kill();
    }
  });
});

describe("assert-post-allowed.ts (the external-mutation fence)", () => {
  // The CLI surface `/resolve-review-comments` reaches across the skill
  // boundary for. Its refusal semantics are exercised end-to-end through
  // `reply-to-thread.ts` in that skill's own suite; what is unique here is how
  // it SCOPES the question — which PR's lease it looks at, and what it does
  // with an argument it cannot use.
  function stateDirFor(name: string): string {
    return mkdtempSync(join(tmpdir(), `fence-${name}-`));
  }

  // Writes ONLY the per-PR lease file, under this test's own (real) actor —
  // unlike `seedLease` below, which goes through `drive-state.ts phase` and
  // so, as a `LEASED_COMMANDS` side effect, ALSO claims a TREE lease
  // for the same actor. That side effect is exactly right for a
  // real session, but it defeats a test whose whole point is isolating the
  // PER-PR fence's OWN narrowing logic: the tree fence does not narrow by
  // `--pr` at all, so a `seedLease`-based fixture makes every `--pr`-scoped
  // assertion here fail for a reason unrelated to what it tests
  // (docomply-review round 10, a reference-implementation pull request — the tree fence is now wired into
  // `answer-summary-finding.ts`'s posting path too, which this suite's
  // `fence()` helper spawns).
  function seedRawPrLease(stateDir: string, pr: string, pid: number): void {
    writeFileSync(
      leasePathFor(stateDir, pr, ACTOR),
      JSON.stringify({
        holder: "session",
        pid,
        host: hostname(),
        platform: process.platform,
        actor: ACTOR,
        worktree: "",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "phase",
        generation: "e".repeat(32),
        sessionStarted: "",
      }),
    );
  }

  function seedLease(stateDir: string, pr: string, pid: number): void {
    const seed = Bun.spawnSync(
      [join(SCRIPTS, "drive-state.ts"), "phase", pr, "--set", "triage"],
      {
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_SESSION: String(pid),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(seed.exitCode).toBe(0);
    expect(
      readdirSync(stateDir).filter((f) =>
        new RegExp(`^pr-drive-lease-${pr}-wt-[0-9a-f]{16}\\.json$`).test(f),
      ),
    ).toHaveLength(1);
  }

  async function fence(
    stateDir: string,
    args: string[],
    env: Record<string, string> = {},
  ) {
    const proc = Bun.spawn([join(SCRIPTS, "assert-post-allowed.ts"), ...args], {
      env: {
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_SESSION: String(process.pid),
        // PINNED to this test's own directory, never inherited. `gitCleanEnv()`
        // strips only `GIT_*`, so every other ambient variable passes through
        // — and if this suite runs under a live `drive.ts` orchestration, that
        // driver exported `$DRIVE_PR_STATE_DIR_IDENTITY` for ITS OWN state
        // directory. Inherited here it names a different directory than the
        // per-test one, so every test would refuse for a reason that has
        // nothing to do with what it asserts (CodeRabbit, PR #4107 round 16).
        //
        // A correct baseline rather than an empty one, because since round 16
        // the override path REQUIRES one: `$DRIVE_PR_STATE_DIR` without
        // `$DRIVE_PR_STATE_DIR_IDENTITY` is a superseded driver and refuses.
        // So the default here is what a current `drive.ts` would have
        // exported for this fixture. `...env` still overrides, so a test that
        // wants a stale, malformed or absent baseline sets one explicitly.
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
        DRIVE_PR_SESSION_STARTED: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr };
  }

  /**
   * The fence with NO `$DRIVE_PR_STATE_DIR` at all — the standalone
   * `/resolve-review-comments` shape, which resolves its own state directory
   * from git and has no inherited baseline by construction. Kept separate
   * from `fence()` rather than expressed as an override, because "the
   * variable is absent" and "the variable is empty" are different inputs and
   * this helper exists to exercise the first.
   */
  async function fenceNoOverride(args: string[]) {
    const env: Record<string, string> = {
      ...gitCleanEnv(),
      DRIVE_PR_SESSION: String(process.pid),
      DRIVE_PR_SESSION_STARTED: "",
    };
    delete env.DRIVE_PR_STATE_DIR;
    delete env.DRIVE_PR_STATE_DIR_IDENTITY;
    const proc = Bun.spawn([join(SCRIPTS, "assert-post-allowed.ts"), ...args], {
      env,
      // The repo root, so the non-override path resolves a REAL git common
      // dir — the whole point of this helper is to exercise that resolution
      // rather than an injected one.
      cwd: join(import.meta.dir, "..", "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stderr };
  }

  it("--pr narrows to that drive: a live lease on ANOTHER PR does not refuse", async () => {
    // The narrowing exists so a caller who knows its PR is not refused by a
    // lease that has nothing to do with it. Without it, `answer-summary-
    // finding.ts` posting to #999 would be blocked by a leftover live lease on
    // some other PR in the same tree.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("other-pr");
      seedRawPrLease(d, "888", holder.pid);
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(0);
      // Same state, same holder — only the scope differs. Both halves are
      // asserted together so a fence that had stopped reading leases entirely
      // cannot pass the first half alone.
      expect((await fence(d, ["--pr", "888"])).exitCode).toBe(11);
      // And with no PR named it is the tree, not a drive, that is checked.
      expect((await fence(d, [])).exitCode).toBe(11);
    } finally {
      holder.kill();
    }
  });

  it("canonicalizes --pr before matching, so a leading zero still finds the live lease", async () => {
    // `isDigits` accepts "0999" — GitHub's numeric issue route treats it
    // identically to "999" — but a strict `===` against the lease filename's
    // own canonical PR segment would not match, silently narrowing this
    // caller to zero candidates and authorizing the POST past a live lease
    // that should have refused it (chatgpt-codex-connector, a reference-implementation pull request
    // round 7).
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("leading-zero");
      seedLease(d, "999", holder.pid);
      expect((await fence(d, ["--pr", "0999"])).exitCode).toBe(11);
      expect((await fence(d, ["--pr", "00999"])).exitCode).toBe(11);
    } finally {
      holder.kill();
    }
  });

  it("with --pr, checks the lease PR-WIDE — a live lease from a DIFFERENT tree still refuses", async () => {
    // The actor-wide search below is blind to every OTHER tree's leases by
    // construction: a driver can legitimately move to a different worktree
    // (this tree's died, a successor started fresh elsewhere), and a pass
    // left running in the OLD tree — which holds no lease of its own here —
    // must still see that successor's live lease to refuse correctly.
    // Without the PR-wide search, `leaseFilesForActor` finds zero candidates
    // under THIS tree's own (nonexistent) lease and wrongly allows the post
    // (chatgpt-codex-connector, a reference-implementation pull request round 8).
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("pr-wide-foreign-tree");
      // A raw lease under a FOREIGN actor — never this test's own tree — is
      // the only way to exercise the cross-tree case without spawning a
      // second real worktree.
      const foreignPath = leasePathFor(d, "999", "wt-0000000000000face");
      writeFileSync(
        foreignPath,
        JSON.stringify({
          holder: "session",
          pid: holder.pid,
          host: hostname(),
          platform: process.platform,
          actor: "wt-0000000000000face",
          worktree: "/tmp/some-other-worktree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          // Required since round 15 — this fixture is about the CROSS-TREE
          // search, so it must parse cleanly and reach the holder-naming
          // refusal (11) rather than stopping at the unreadable one (1).
          sessionStarted: "",
        }),
      );
      const r = await fence(d, ["--pr", "999"]);
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain("DIFFERENT working tree");
      expect(r.stderr).toContain("/tmp/some-other-worktree");
      // With no PR named, the search stays actor-wide (no network round-trip
      // to spend discovering one) and does not see the foreign lease.
      expect((await fence(d, [])).exitCode).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("canonicalizes --pr with BigInt, not Number — no precision loss above 2^53", async () => {
    // `String(Number(pr))` is LOSSY past `Number.MAX_SAFE_INTEGER`
    // (9007199254740992): the next integer up, "9007199254740993", silently
    // rounds DOWN to "9007199254740992" under a float round-trip. The old
    // canonicalization would then search for the WRONG (rounded) PR, find no
    // lease under it, and allow the post past the real, live one — the exact
    // reproduction docomply-review gave (round 10).
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("pr-bigint");
      const huge = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 1
      seedLease(d, huge, holder.pid);
      const r = await fence(d, ["--pr", huge]);
      expect(r.exitCode).toBe(11);
      expect(r.stderr).toContain(`PR #${huge}`);
    } finally {
      holder.kill();
    }
  });

  it("defaults the PR to $DRIVE_PR_TARGET, which only a drive.ts pass has set", async () => {
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("target");
      seedRawPrLease(d, "888", holder.pid);
      expect((await fence(d, [], { DRIVE_PR_TARGET: "999" })).exitCode).toBe(0);
      expect((await fence(d, [], { DRIVE_PR_TARGET: "888" })).exitCode).toBe(
        11,
      );
      // An explicit --pr wins over the environment: the flag is what a caller
      // that KNOWS its PR passes, and silently preferring the ambient value
      // would answer a different question than the one asked.
      expect(
        (await fence(d, ["--pr", "999"], { DRIVE_PR_TARGET: "888" })).exitCode,
      ).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("refuses a malformed --pr rather than widening to the whole tree", async () => {
    // Downgrading to the actor-wide check would answer a broader question than
    // the caller asked, and could report a refusal about a drive they never
    // named.
    const d = stateDirFor("bad-pr");
    const r = await fence(d, ["--pr", "nine-nine-nine"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--pr must be a number");
    expect((await fence(d, ["--what"])).exitCode).toBe(2);
    expect((await fence(d, ["--nope"])).exitCode).toBe(2);
  });

  it("allows when the state dir holds no lease at all", async () => {
    expect((await fence(stateDirFor("empty"), [])).exitCode).toBe(0);
  });

  it("fails CLOSED when the inherited $DRIVE_PR_STATE_DIR has vanished", async () => {
    // Distinct from the "no lease at all" case above: there the fence
    // resolved a directory that legitimately may never have been created (no
    // drive has ever run here). An INHERITED override is a different claim —
    // `drive.ts` exports it only after establishing its own state, so the
    // directory necessarily existed a moment ago. If it is gone now (a
    // renamed git common dir, a moved worktree), that is an anomaly this
    // fence must not read as "no lease", or a pass whose inherited path went
    // stale mid-drive posts unfenced (chatgpt-codex-connector, a reference-implementation pull request
    // round 6).
    const gone = join(mkdtempSync(join(tmpdir(), "fence-vanished-")), "state");
    // Deliberately never created — `mkdtempSync` made the PARENT, `state`
    // itself does not exist, which is the "existed, then moved away" shape an
    // override implies without this test paying for an actual rename.
    const r = await fence(gone, []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("could not be read");
  });

  it("fails CLOSED when the inherited $DRIVE_PR_STATE_DIR is a dangling symlink", async () => {
    // A path-based `stat` alone would pass this — it follows the link and
    // fails only when actually asked to enumerate — but this fence now
    // enumerates the override directory as its OWN existence check
    // (`readdirSync` directly, no separate `stat` first): a dangling symlink
    // makes that same call fail with `ENOENT` on the real target, exactly
    // like the wholly-vanished case above (chatgpt-codex-connector, a reference-implementation pull request
    // round 7).
    const parent = mkdtempSync(join(tmpdir(), "fence-symlink-"));
    const link = join(parent, "state-link");
    symlinkSync(join(parent, "state-target-does-not-exist"), link);
    const r = await fence(link, []);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("could not be read");
  });

  it("fails CLOSED when the lease set cannot be enumerated", async () => {
    // Rule 1 of .claude/rules/document-scanning-gates.md. A state dir that is
    // a FILE makes `readdirSync` fail with ENOTDIR — neither "no leases" nor
    // "a lease" — and the only safe reading of an unreadable answer, in front
    // of a mutation with no undo, is "do not post".
    //
    // Asserted for the --pr path SPECIFICALLY, because that is the one a
    // direct `leasePathFor` read would have failed open on: `existsSync` of a
    // path under a file answers false, which is indistinguishable from a tree
    // that has never been driven.
    const notADir = join(mkdtempSync(join(tmpdir(), "fence-notadir-")), "f");
    writeFileSync(notADir, "not a directory\n");
    expect((await fence(notADir, ["--pr", "999"])).exitCode).not.toBe(0);
    expect((await fence(notADir, [])).exitCode).not.toBe(0);
  });

  it("fails CLOSED on a lease file it can enumerate but cannot READ", async () => {
    // The class one level below the probe above, and the half that was still
    // open: fencing the DIRECTORY while an unreadable FILE inside it read as
    // "no lease" and permitted the post (docomply-review, a reference-implementation pull request round 1).
    // `readLease` collapses absent and unreadable to the same `null`, which is
    // the right ruling for CLAIMING and the wrong one here.
    //
    // Both corruptions are exercised, because they take different paths in:
    // unparseable bytes fail the shape check, an unreadable mode fails the
    // open. Each is asserted separately so one regressing names itself.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      for (const [label, corrupt] of [
        ["malformed JSON", (f: string) => writeFileSync(f, "{ not json")],
        ["a partial record", (f: string) => writeFileSync(f, '{"pid":123}')],
        // A DIRECTORY at the lease path, not `chmod 000`: mode bits are
        // ignored by root, so that fixture asserted the wrong branch (exit
        // 11, a valid live lease) on a root runner. `EISDIR` on the open is
        // uid-independent.
        [
          "a directory in its place",
          (f: string) => {
            rmSync(f);
            mkdirSync(f);
          },
        ],
      ] as const) {
        const d = stateDirFor(`unreadable-${label.replace(/\s+/g, "-")}`);
        seedLease(d, "999", holder.pid);
        const file = join(
          d,
          readdirSync(d).filter((f) =>
            /^pr-drive-lease-999-wt-[0-9a-f]{16}\.json$/.test(f),
          )[0] ?? "",
        );
        // The probe is only meaningful if the UNCORRUPTED lease refuses —
        // otherwise a fence that had stopped reading leases entirely would
        // pass the corrupted case for the wrong reason.
        expect({
          label,
          code: (await fence(d, ["--pr", "999"])).exitCode,
        }).toEqual({ label, code: 11 });
        corrupt(file);
        const r = await fence(d, ["--pr", "999"]);
        expect({ label, code: r.exitCode }).toEqual({ label, code: 1 });
        expect(r.stderr).toContain("could not be read");
      }
    } finally {
      holder.kill();
    }
  });

  it("still allows when the enumerated lease file is genuinely GONE", async () => {
    // The other side of the same read, and the reason it is not simply "any
    // null refuses": a `clear-lease` or `reset` landing between the
    // enumeration and the read means nobody is driving, which is the
    // documented revoked-without-successor residual, not an unreadable file.
    const holder = Bun.spawn(["sleep", "600"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const d = stateDirFor("vanished");
      seedLease(d, "999", holder.pid);
      const file = join(
        d,
        readdirSync(d).filter((f) =>
          /^pr-drive-lease-999-wt-[0-9a-f]{16}\.json$/.test(f),
        )[0] ?? "",
      );
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(11);
      rmSync(file);
      // "Genuinely gone" now has to mean gone on BOTH axes: `seedLease` claims
      // a TREE lease too, which the removed per-PR file alone does
      // not touch, and the tree fence does not narrow by `--pr` — so without
      // this, a still-alive `holder` would leave the tree lease live and this
      // assertion would refuse for a reason unrelated to what it tests
      // (docomply-review round 10, a reference-implementation pull request). Awaited, not just signalled: a
      // `pidAlive` check on a killed-but-not-yet-reaped process can still see
      // it as running.
      holder.kill();
      await holder.exited;
      expect((await fence(d, ["--pr", "999"])).exitCode).toBe(0);
    } finally {
      holder.kill();
    }
  });

  it("fails CLOSED when the git probe fails for an OPERATIONAL reason", async () => {
    // Reproduced by chatgpt-codex-connector on PR #4107 round 1: with `git`
    // off $PATH the probe failed, the failure was read as "no drive state",
    // and the fence exited 0 having checked no lease at all.
    //
    // No $DRIVE_PR_STATE_DIR: the override short-circuits the probe, so
    // setting it would test nothing. cwd is this repo, which IS a repository —
    // the only thing broken is git's reachability.
    // Spawned through the ABSOLUTE runtime, not the shebang: `#!/usr/bin/env
    // bun` needs $PATH to find bun too, so an emptied $PATH would kill the
    // script before it ever probed git — a probe that asserts nothing about
    // the fence.
    const broken = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "assert-post-allowed.ts"),
        "--pr",
        "999",
      ],
      {
        env: {
          ...gitCleanEnv(),
          PATH: "/nonexistent",
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(broken.stderr).text(),
      broken.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("exited 127");

    // And the case it must NOT swallow with it: genuinely outside a
    // repository still posts, because no drive state can exist there. Run
    // from a temp dir with a working git, so the ONLY difference from the
    // probe above is which failure git produced.
    const outside = mkdtempSync(join(tmpdir(), "fence-outside-repo-"));
    const ok = Bun.spawn(
      [join(SCRIPTS, "assert-post-allowed.ts"), "--pr", "999"],
      {
        cwd: outside,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    expect(await ok.exited).toBe(0);
  });

  it("refuses when the `.git` marker EXISTS but the filesystem cannot resolve it", async () => {
    // The filesystem census that replaced the exit-128 check retained the same
    // temporal hole one step further in (chatgpt-codex-connector P2 and
    // docomply-review high, PR #4107 round 4, independently): `existsSync`
    // reports `false` for confirmed absence and for indeterminate failure
    // alike. A drive writes a live lease and the marker THEN becomes a broken
    // symlink (or an ancestor becomes unsearchable); the walk runs to the root,
    // concludes no repository is in play, and the POST is authorised without
    // the still-live lease ever being read.
    //
    // A broken symlink is the uid-independent half of that pair — an EACCES
    // fixture asserts nothing when the suite runs as root, which CI may.
    // `existsSync` follows the link and reports false; `lstat` succeeds,
    // because the marker entry plainly exists.
    //
    // Every OTHER clause of the fence's fail-closed conjunction is satisfied so
    // that `repositoryIsInPlay` is the sole decider (document-scanning-gates.md
    // § 5): $DRIVE_PR_STATE_DIR is empty so the override cannot short-circuit
    // the probe, git is on $PATH and runs cleanly, and it exits 128 "not a git
    // repository" — measured — so `stateDir` is empty and `timedOut` is false.
    const lost = mkdtempSync(join(tmpdir(), "fence-marker-lost-"));
    symlinkSync("/nonexistent/gitdir-target", join(lost, ".git"));

    // The entry exists, and `existsSync` still says it does not: the exact
    // discrepancy the fence used to resolve in favour of posting.
    expect(existsSync(join(lost, ".git"))).toBe(false);
    expect(() => lstatSync(join(lost, ".git"))).not.toThrow();

    const refused = Bun.spawn(
      [join(SCRIPTS, "assert-post-allowed.ts"), "--pr", "999"],
      {
        cwd: lost,
        env: {
          ...gitCleanEnv(),
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(refused.stderr).text(),
      refused.exited,
    ]);
    expect(code).not.toBe(0);
    // Specifically the "this IS a repository, so the lease is unknown" refusal,
    // so a regression that merely refused for an unrelated reason cannot pass.
    expect(stderr).toContain("this IS a repository");
  });

  it('refuses a git fatal that is NOT "no repository", inside a repository', async () => {
    // Exit 128 is git's GENERIC fatal status — dubious ownership, permissions,
    // corruption — so reading it as "no repository, therefore no lease" is the
    // same fail-open as reading a missing binary that way, one step narrower.
    // Found independently by both reviewers on PR #4107 round 2, and their
    // refutation is the reachable part: a drive writes a live lease, the
    // repository THEN becomes unreadable, and the lease is still sitting there.
    //
    // An invalid `GIT_DIR` produces a 128 that is emphatically not "there is no
    // repository here" — cwd is this repo throughout.
    const broken = Bun.spawn(
      [
        process.execPath,
        join(SCRIPTS, "assert-post-allowed.ts"),
        "--pr",
        "999",
      ],
      {
        env: {
          ...gitCleanEnv(),
          GIT_DIR: "/nonexistent/definitely-not-a.git",
          DRIVE_PR_SESSION: String(process.pid),
          DRIVE_PR_STATE_DIR: "",
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, code] = await Promise.all([
      new Response(broken.stderr).text(),
      broken.exited,
    ]);
    expect(code).not.toBe(0);
    // Specifically the 128 path, so a regression that merely refused for some
    // other reason cannot pass this.
    expect(stderr).toContain("exited 128");
    expect(stderr).toContain("IS a repository");
  });

  describe("state-directory identity (PR #4107 findings A and C)", () => {
    // `resolveFenceContext`'s override path freezes the NAME LIST from one
    // `readdirSync`, but `assertRemoteMutationAllowed` still has to OPEN each
    // candidate afterwards to learn who holds it — a genuine second
    // filesystem touch. Renaming the state directory away and creating an
    // EMPTY one at the same pathname raises no `ENOENT` anywhere that second
    // read could see: the enumerated name simply is not there anymore, and
    // `readLeaseForFence` reports `absent` for a lease that is still live in
    // the directory that moved.
    //
    // These probes call `assertRemoteMutationAllowed` directly, in-process,
    // with a hand-built `ctx` — the same shape `resolveFenceContext`'s
    // override branch returns — rather than spawning `assert-post-allowed.ts`
    // and racing it: the enumeration and the per-candidate read happen inside
    // ONE function call with no `await` between them, so a subprocess-level
    // race would depend on scheduling this suite cannot control. Calling the
    // real, exported function directly and performing the rename-and-recreate
    // between building `ctx` and invoking it reproduces the exact race
    // deterministically, on the real production code — matching lock.test.ts's
    // own convention of planting the directory state a race would have left
    // rather than trying to win one live.
    function foreignLeaseJson(actor: string): string {
      return JSON.stringify({
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor,
        worktree: "/some/other/tree",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "a".repeat(32),
        sessionStarted: "",
      });
    }

    it("fails CLOSED when the state directory is renamed away and replaced empty before a candidate lease is read", async () => {
      const parent = mkdtempSync(join(tmpdir(), "fence-rename-race-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      const foreignActor = "wt-0000000000000dea1";
      // This lease is genuinely LIVE: pid is this test's own process, which
      // is alive throughout, and `lastSeen` is fresh. If the fix silently
      // read the swap as "absent", this lease would still be live in the
      // directory that moved.
      writeFileSync(
        leasePathFor(stateDir, "999", foreignActor),
        foreignLeaseJson(foreignActor),
      );

      // What `resolveFenceContext`'s override branch would have captured:
      // the enumeration, and this directory's identity in the same breath.
      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks (round 16) and is BigInt-valued (round 17, since
      // 64-bit dev/ino round when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      // The race: move the directory away — the live lease is still inside
      // it — and recreate an empty one at the exact same pathname. Neither
      // step raises ENOENT anywhere.
      const moved = `${stateDir}.moved-away`;
      renameSync(stateDir, moved);
      mkdirSync(stateDir);
      expect(
        existsSync(join(moved, `pr-drive-lease-999-${foreignActor}.json`)),
      ).toBe(true);
      expect(
        existsSync(join(stateDir, `pr-drive-lease-999-${foreignActor}.json`)),
      ).toBe(false);

      let threw: unknown;
      try {
        await assertRemoteMutationAllowed(
          {
            stateDir,
            actor: "wt-0000000000000m1ne",
            session: {
              pid: process.pid,
              host: hostname(),
              source: "CLAUDE_PID",
              sessionStarted: "",
            },
            fromOverride: true,
            overrideEntries,
            stateDirIdentity: { dev: before.dev, ino: before.ino },
          },
          "999",
          "test-fence",
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ExitError);
      expect((threw as ExitError).code).toBe(1);
      expect((threw as Error).message).toBe("exit 1");
    });

    it("fails CLOSED on the same swap even when NO candidate lease file matched (the final re-check)", async () => {
      // Zero matching candidates means the per-candidate `absent` re-check
      // above never runs at all — the loop body never executes — so the ONLY
      // thing standing between a swapped directory and a silent "allowed" is
      // the identity re-check `assertRemoteMutationAllowed` performs
      // immediately before it returns.
      const parent = mkdtempSync(join(tmpdir(), "fence-rename-race-empty-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      // Present, but matches no PR/actor prefix at all.
      writeFileSync(join(stateDir, "unrelated-file.json"), "{}");

      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks (round 16) and is BigInt-valued (round 17, since
      // 64-bit dev/ino round when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      const moved = `${stateDir}.moved-away`;
      renameSync(stateDir, moved);
      mkdirSync(stateDir);

      let threw: unknown;
      try {
        await assertRemoteMutationAllowed(
          {
            stateDir,
            actor: "wt-0000000000000m1ne",
            session: {
              pid: process.pid,
              host: hostname(),
              source: "CLAUDE_PID",
              sessionStarted: "",
            },
            fromOverride: true,
            overrideEntries,
            stateDirIdentity: { dev: before.dev, ino: before.ino },
          },
          "999",
          "test-fence",
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(ExitError);
      expect((threw as ExitError).code).toBe(1);
    });

    it("does NOT refuse when the directory is untouched (no false positive from the identity check)", async () => {
      // The regression guard: an ordinary, race-free call — same shape as
      // above but with no rename in between — must still allow, matching
      // every OTHER passing test in this describe block that exercises the
      // override path via the real `assert-post-allowed.ts` binary.
      const parent = mkdtempSync(join(tmpdir(), "fence-no-race-"));
      const stateDir = join(parent, "state");
      mkdirSync(stateDir);
      const overrideEntries = readdirSync(stateDir);
      // `statSync(..., { bigint: true })`, matching production: the identity
      // FOLLOWS symlinks (round 16) and is BigInt-valued (round 17, since
      // 64-bit dev/ino round when read as numbers). Hand-building it from
      // `lstatSync`'s numeric fields would compare a rounded, link-scoped
      // identity against a followed BigInt one and never agree.
      const before = statSync(stateDir, { bigint: true });

      // Awaited directly, not wrapped in `expect(() => ...).not.toThrow()` —
      // that matcher only ever tests a SYNCHRONOUS call and would pass
      // vacuously against a rejected promise now that this function is
      // async: a thrown `ExitError` inside the promise never
      // reaches the synchronous try/catch `toThrow()` builds internally, so
      // it would report "did not throw" regardless of the outcome. Letting
      // the rejection propagate out of this `it(..., async () => { ... })`
      // is what actually fails the test if this call refuses.
      //
      // The returned lock is captured and released — a formerly-void call
      // now resolves to a still-HELD `PathLock`, and discarding
      // it here would leave both the lock directory and `createLock`'s
      // process/signal listeners live for the rest of this test run
      // (docomply-review, a reference-implementation pull request round 6).
      const lock = await assertRemoteMutationAllowed(
        {
          stateDir,
          actor: "wt-0000000000000m1ne",
          session: {
            pid: process.pid,
            host: hostname(),
            source: "CLAUDE_PID",
            sessionStarted: "",
          },
          fromOverride: true,
          overrideEntries,
          stateDirIdentity: { dev: before.dev, ino: before.ino },
        },
        "999",
        "test-fence",
      );
      lock?.release();
      lock?.dispose();
    });
  });

  describe("session-started token (PR #4107 finding B — pid recycling)", () => {
    // `isMine` used to match a held lease against the caller's session on
    // (pid, host) alone. If a driver dies and the OS later recycles its
    // exact pid for an unrelated NEW drive-pr session, this caller's
    // inherited $DRIVE_PR_SESSION still names that pid — these probes fake
    // that exact shape by seeding a lease under THIS TEST'S OWN pid (always
    // alive) while asserting a DIFFERENT $DRIVE_PR_SESSION_STARTED than the
    // one on disk, the token `drive.ts` mints once per launch and exports
    // alongside $DRIVE_PR_SESSION.
    function leaseJson(actor: string, sessionStarted: string): string {
      return JSON.stringify({
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor,
        worktree: "/some/other/tree",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "b".repeat(32),
        sessionStarted,
      });
    }

    it("refuses a pid-recycled lease that carries a DIFFERENT session-started token, even though pid+host match", async () => {
      const d = stateDirFor("token-mismatch");
      const foreignActor = "wt-000000000000f00d";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        leaseJson(foreignActor, "new-session-token"),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "old-driver-token",
      });
      expect(r.exitCode).toBe(11);
    });

    it("still recognizes its own lease when the session-started token matches", async () => {
      const d = stateDirFor("token-match");
      const sameActor = "wt-000000000000face2";
      writeFileSync(
        leasePathFor(d, "999", sameActor),
        leaseJson(sameActor, "same-token"),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "same-token",
      });
      expect(r.exitCode).toBe(0);
    });

    it("falls back to bare pid+host when THIS caller carries no session-started token (legacy harness, SKILL.md § 6)", async () => {
      const d = stateDirFor("token-none-none");
      const legacyActor = "wt-0000000000000leg";
      writeFileSync(
        leasePathFor(d, "999", legacyActor),
        leaseJson(legacyActor, ""),
      );
      // Forced to '' rather than merely omitted: this suite may itself be
      // running under a live drive.ts orchestration, whose own
      // $DRIVE_PR_SESSION_STARTED `gitCleanEnv()` would otherwise carry
      // straight through and silently give this caller a token after all —
      // the exact ambient leak that makes "carries no token" a claim this
      // test must assert explicitly, not assume from an unset override.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "",
      });
      expect(r.exitCode).toBe(0);
    });

    it("refuses when this caller carries no token but the on-disk lease does (proof of a different process)", async () => {
      const d = stateDirFor("token-none-vs-some");
      const foreignActor = "wt-0000000000000tkn";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        leaseJson(foreignActor, "some-token"),
      );
      // See the sibling test above for why this must be forced rather than
      // left to an ambient default.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "",
      });
      expect(r.exitCode).toBe(11);
    });

    it("REFUSES a lease with no sessionStarted key — the field is required, not tolerated", async () => {
      // No `sessionStarted` key at all — the shape a lease written by
      // superseded code has on disk. An earlier revision normalized it to ''
      // so such records kept parsing; that is an accepts-both-shapes parser,
      // which the pre-GA BWC stance rules out, and it quietly kept the weaker
      // pid/host-only ownership decision alive for exactly those records
      // (chatgpt-codex-connector, a reference-implementation pull request round 15).
      //
      // The case that must keep working is a token-LESS session, and it does:
      // the VALUE '' is legal (asserted in the sibling test below). Only the
      // absent KEY is rejected, and lease state is ephemeral, so that is a
      // rollout detail rather than a migration.
      const d = stateDirFor("token-field-missing");
      const legacyActor = "wt-0000000000000pre";
      writeFileSync(
        leasePathFor(d, "999", legacyActor),
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: legacyActor,
          worktree: "/some/other/tree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          // sessionStarted omitted deliberately.
        }),
      );
      // Exit 1, not 11: the record no longer parses, so it is UNREADABLE
      // rather than a nameable holder — and the fence's standing rule is that
      // a lease file it enumerated but cannot read is the question going
      // unanswered, never an all-clear. The one thing it must not be is
      // exit 0.
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "caller-has-a-token",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("could not be read");
    });

    it("accepts sessionStarted: '' — a token-LESS session is legal, only the absent key is not", async () => {
      // The distinction the strict read turns on, and the reason it costs
      // nothing: an interactive $CLAUDE_PID session, or a hand-set
      // $DRIVE_PR_SESSION, genuinely carries no token and writes ''. That
      // record must parse and must still refuse a foreign live session.
      const d = stateDirFor("token-field-empty");
      const foreignActor = "wt-0000000000000fff";
      writeFileSync(
        leasePathFor(d, "999", foreignActor),
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor: foreignActor,
          worktree: "/some/other/tree",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_SESSION_STARTED: "caller-has-a-token",
      });
      expect(r.exitCode).toBe(11); // parsed as a genuine, live, foreign lease
    });
  });

  describe("$DRIVE_PR_STATE_DIR_IDENTITY — the driver-established baseline (PR #4107 round 14, finding C)", () => {
    // The window every OTHER identity check in this fence is blind to: the
    // swap completed BEFORE this pass started. The fence then enumerates the
    // replacement, captures ITS identity, finds it perfectly stable for the
    // whole run, and authorizes the post — while the live lease sits in the
    // directory that moved. Only a baseline observed before the swap can
    // answer that, and the driver is the one thing that observed it.

    it("fails CLOSED when the directory was swapped BEFORE the pass started", async () => {
      // Fixture built so this clause is the SOLE decider (document-scanning-
      // gates.md § 5): the replacement is a real, readable, EMPTY directory,
      // so every other check in the chain passes and the unfixed code
      // authorizes the post with exit 0. Only the driver baseline differs.
      const original = stateDirFor("identity-swapped-before");
      const identity = stateDirIdentityToken(original);
      expect(identity).not.toBe(""); // the baseline itself must be real

      // The swap: move the real directory aside, put an empty one at the
      // same pathname. No ENOENT is raised anywhere by either operation.
      const moved = `${original}-moved`;
      renameSync(original, moved);
      mkdirSync(original);

      const r = await fence(original, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: identity,
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("not the one this drive resolved");

      // Mutation check: the SAME fixture with a baseline naming the
      // REPLACEMENT passes. Everything else in the chain is identical — the
      // replacement is real, readable and empty — so the identity comparison
      // is provably the sole decider, and the refusal above is not some
      // earlier clause firing.
      //
      // (Phrased as a matching baseline rather than an absent one, because
      // since round 16 an absent baseline on the override path refuses in its
      // own right, which would make an absent-baseline mutation check pass
      // for the wrong reason.)
      const matching = await fence(original, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(original),
      });
      expect(matching.exitCode).toBe(0);
    });

    it("allows when the inherited baseline still matches", async () => {
      const d = stateDirFor("identity-matches");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(d),
      });
      expect(r.exitCode).toBe(0);
    });

    it("REFUSES an absent baseline on the override path — no compatibility path for superseded drivers", async () => {
      // `$DRIVE_PR_STATE_DIR` is set only by `drive.ts`, which since round 16
      // either exports the identity beside it or refuses to start. So an
      // override arriving without one can only come from a superseded driver,
      // and allowing it would preserve the unfenced pre-baseline behaviour
      // indefinitely — the dual-path tolerance pre-GA policy rejects
      // (docomply-review / chatgpt-codex-connector, a reference-implementation pull request round 16).
      const d = stateDirFor("identity-absent");
      const r = await fence(d, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: "",
      });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("is not");
    });

    it("still allows a baseline-less caller on the NON-override path", async () => {
      // The case the refusal above must not catch: no `$DRIVE_PR_STATE_DIR`
      // at all, which is how `/resolve-review-comments` runs standalone. That
      // path resolves the state dir itself and has never had a baseline to
      // inherit, so "never existed" stays the ordinary case rather than an
      // anomaly. This is why removing the override-path compatibility branch
      // costs nothing legitimate.
      const r = await fenceNoOverride(["--pr", "999"]);
      expect(r.exitCode).toBe(0);
    });

    it("FOLLOWS a symlinked state dir, so a swap of its TARGET is caught (PR #4107 round 16)", async () => {
      // The link's own inode is untouched by a target rename-and-recreate, so
      // an `lstat`-based identity matches straight through the swap while
      // `readdirSync` — which follows — enumerates the replacement. Fixture
      // is built so the identity clause is the sole decider: the replacement
      // target is a real, readable, EMPTY directory, so everything else in
      // the chain passes and only the followed-vs-not choice decides.
      const parent = mkdtempSync(join(tmpdir(), "fence-symlink-target-"));
      const target = join(parent, "real-state");
      mkdirSync(target);
      const link = join(parent, "state-link");
      symlinkSync(target, link);

      // Baseline captured through the link, as the driver would.
      const identity = stateDirIdentityToken(link);
      expect(identity).not.toBe("");

      // Swap the TARGET, leaving the link itself completely untouched.
      renameSync(target, `${target}-moved`);
      mkdirSync(target);

      const r = await fence(link, ["--pr", "999"], {
        DRIVE_PR_STATE_DIR_IDENTITY: identity,
      });
      expect(r.exitCode).toBe(1);
      // Mutation check: the link's own inode did NOT change, so an
      // lstat-based identity would have matched and returned 0 here. That is
      // what makes this test about following the link and nothing else.
      expect(stateDirIdentityToken(link)).not.toBe(identity);
    });

    it("fails CLOSED on a baseline that is PRESENT but unparseable", async () => {
      // Absent and malformed are different questions: something set this and
      // this process cannot tell what it meant, in front of a mutation with
      // no undo.
      const d = stateDirFor("identity-malformed");
      for (const bad of ["garbage", "12:", ":34", "1:2:3", "x:y"]) {
        const r = await fence(d, ["--pr", "999"], {
          DRIVE_PR_STATE_DIR_IDENTITY: bad,
        });
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("not a");
      }
    });
  });

  describe("single-snapshot lease decisions (PR #4107 round 15)", () => {
    it("parseLease REJECTS a record whose sessionStarted key is absent, and accepts an empty one", () => {
      // The unit-level statement of the same rule the fence tests above
      // exercise end-to-end. Asserted on the parser directly so a future
      // refactor that reintroduces the lenient default fails here first,
      // where the reason is written down.
      const base = {
        holder: "session",
        pid: 1,
        host: "h",
        platform: "darwin",
        actor: "wt-1",
        worktree: "/w",
        startedAt: "2026-01-01T00:00:00Z",
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "f".repeat(32),
      };
      expect(parseLease(JSON.stringify(base))).toBeNull();
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: 5 })),
      ).toBeNull();
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: "" }))
          ?.sessionStarted,
      ).toBe("");
      expect(
        parseLease(JSON.stringify({ ...base, sessionStarted: "tok" }))
          ?.sessionStarted,
      ).toBe("tok");
    });

    it("stateDirIdentityToken reports UNREADABLE as empty, and drive.ts refuses on it rather than omitting the baseline", () => {
      // Two halves of the same guard (PR #4107 round 16).
      //
      // The contract: '' means "could not establish", never "there is none".
      expect(
        stateDirIdentityToken(join(tmpdir(), "definitely-not-here-4107")),
      ).toBe("");
      expect(stateDirIdentityToken(tmpdir())).not.toBe("");

      // And the consumer fails closed on it. PINNED from source rather than
      // executed, deliberately: `drive.ts` resolves its state directory and
      // writes its driver log INTO it before reaching this guard, so by the
      // time the guard runs a stat failure is only reachable as a transient
      // race that no deterministic fixture can stage. That is exactly the
      // case the finding describes, and `.claude/rules/document-scanning-
      // gates.md` § 3 prefers a verbatim pin over a text-matching model for
      // "does this code actually do X" — so the pin is on the refusal itself,
      // and it fails if the omit-the-variable form ever returns.
      const src = readFileSync(join(SCRIPTS, "drive.ts"), "utf8");
      expect(src).toContain(
        "could not establish the identity of the drive state directory",
      );
      expect(src).toContain(
        "process.env.DRIVE_PR_STATE_DIR_IDENTITY = stateDirIdentity;",
      );
      // The superseded shape: exporting only when non-empty, i.e. treating an
      // unreadable identity as "no baseline inherited".
      expect(src).not.toContain(
        "if (stateDirIdentity !== '')\n    process.env.DRIVE_PR_STATE_DIR_IDENTITY",
      );
    });

    it("carries a 64-bit dev/ino through the token without rounding (PR #4107 round 17)", () => {
      // Node's NUMERIC stat fields round past Number.MAX_SAFE_INTEGER, and
      // filesystems do expose dev/ino above it. Rounding either compares two
      // different directories as identical — a swap the fence should catch —
      // or, with a safe-integer guard, refuses every child fence on such a
      // machine even though nothing moved.
      //
      // Asserted on the token grammar rather than on a real filesystem,
      // because staging a >2^53 inode is not something a test can arrange
      // portably. The property under test is the transport: a value that
      // Number cannot represent exactly must survive the round trip.
      const big = 2n ** 63n - 1n;
      const token = `${big}:${big + 1n}`;
      expect(Number(big).toString()).not.toBe(big.toString()); // rounds, as Number
      expect(parseDirIdentityToken(token)).toEqual({
        kind: "ok",
        id: { dev: big, ino: big + 1n },
      });

      // And a real directory's token round-trips to the same identity the
      // producer computed, so the grammar above is the one actually used.
      const d = stateDirFor("identity-roundtrip");
      const st = statSync(d, { bigint: true });
      expect(parseDirIdentityToken(stateDirIdentityToken(d))).toEqual({
        kind: "ok",
        id: { dev: st.dev, ino: st.ino },
      });
    });

    it("leasePathFor and the reader agree on a NONCANONICAL pr (PR #4107 round 16)", () => {
      // The producer used to persist whatever spelling it was handed, so an
      // explicit `0999` wrote `pr-drive-lease-0999-*` while a posting caller
      // canonicalized its own target to `999` and filtered on that prefix —
      // missing the live lease and authorizing the reply. Canonicalizing at
      // the shared boundary is what makes the two agree by construction.
      const d = stateDirFor("pr-canonicalization");
      const actor = "wt-0000000000000abc";
      const padded = leasePathFor(d, "0999", actor);
      const plain = leasePathFor(d, "999", actor);
      expect(padded).toBe(plain);

      // And the reader finds a lease written under the padded spelling.
      writeFileSync(
        padded,
        JSON.stringify({
          holder: "session",
          pid: process.pid,
          host: hostname(),
          platform: process.platform,
          actor,
          worktree: "/w",
          startedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          command: "hold",
          generation: "f".repeat(32),
          sessionStarted: "",
        }),
      );
      expect(leaseFilesFor(d, "999")).toEqual([plain]);
      expect(leaseFilesFor(d, "0999")).toEqual([plain]);
    });

    it("parseLease decides from the TEXT it is handed, never by re-reading a path", () => {
      // The property that closes the file-only swap: the fence reads the
      // bytes once and judges those bytes. If the parser could still be fed a
      // pathname, a rename-and-replace between the read and the parse would
      // decide the outcome. Handing it text that no file contains — while a
      // file of the same name holds something different — is what proves the
      // decision is snapshot-bound.
      const d = stateDirFor("single-snapshot");
      const p = leasePathFor(d, "999", "wt-0000000000000abc");
      const live = {
        holder: "session",
        pid: process.pid,
        host: hostname(),
        platform: process.platform,
        actor: "wt-0000000000000abc",
        worktree: "/w",
        startedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        command: "hold",
        generation: "f".repeat(32),
        sessionStarted: "the-snapshot",
      };
      writeFileSync(p, JSON.stringify({ ...live, sessionStarted: "ON-DISK" }));
      // Same path on disk says 'ON-DISK'; the parser is handed 'the-snapshot'
      // and must answer about what it was handed.
      expect(parseLease(JSON.stringify(live))?.sessionStarted).toBe(
        "the-snapshot",
      );
      expect(readLease(p)?.sessionStarted).toBe("ON-DISK");
    });
  });
});

describe("resolve-held-thread.ts", () => {
  // `resolve-thread.ts`'s mutation is unconditional — no notion of which push
  // justifies a resolve. This wrapper is what SKILL.md § 6 calls instead for a
  // held thread; these probes need BOTH a drive-state.ts state dir (to seed
  // `hold`/`bump-round`) and a gh/git fixture (to satisfy the --pushed-sha
  // checks) — a combination neither the `drive-state.ts durability` probes
  // (state only) nor the `answer-summary-finding.ts` probes (gh/git only, no
  // state) exercise on their own.

  /**
   * The state these probes stand `resolve-held-thread.ts` up against — the
   * earlier steps of the SAME pass (§ 1's `bump-round`, § 3's `hold`, § 6's
   * `set-verified`), not another driver's work.
   *
   * So it runs in the working tree the probe then resolves from. It used to
   * inherit the suite's own cwd — the real repository — while `resolveHeld`
   * ran in a scratch repo, which made the seed and the action two different
   * ACTORS. That was invisible until an earlier change gated admission PR-wide, and
   * then the seed's live lease refused the action with exit 13. The gate is
   * right and the fixture was wrong: one tree drives one PR, and a probe that
   * straddles two was modelling a state production cannot reach.
   *
   * `gitCleanEnv`, and a handoff dir under the per-test state dir, for the two
   * reasons `resolveHeld` already documents: a git hook exports `GIT_DIR`, and
   * an unset `$DRIVE_PR_HANDOFF_DIR` writes `.context/` into whichever scratch
   * repo the cwd names — `scratchClean` is SHARED, so that dirties it for
   * every later probe's clean-tree check.
   */
  async function seed(
    stateDir: string,
    args: string[],
    stdin?: string,
    cwd: string = scratchClean.dir,
    /**
     * Seed at ladder tier 3 — no session identity. Only for the probe that
     * deliberately seeds from a DIFFERENT tree than it resolves from: that
     * state is reachable by TAKEOVER (the seeding tree stops, another is
     * admitted and works the batch), and a takeover means the predecessor is
     * precisely NOT still holding the PR.
     *
     * Since an earlier change tier 3 leaves a `worktree`-held lease like any other
     * holder, so that "stops" has to be PERFORMED — `seedDone` below is where
     * — rather than being implied by the absence of an artefact. A pid-less
     * holder has no process whose exit could stand for it.
     */
    sessionless = false,
  ) {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      cwd,
      env: {
        ...gitCleanEnv(),
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_HANDOFF_DIR: join(stateDir, "handoff"),
        ...(sessionless ? { DRIVE_PR_SESSION: "", CLAUDE_PID: "" } : {}),
      },
      stdin: stdin !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`seed failed: ${args.join(" ")}\n${stderr}`);
    }
  }

  /**
   * The seeding tree stops driving, so the resolving tree may be admitted.
   *
   * The takeover premise `seed`'s `sessionless` flag describes, made explicit
   *. It drops the lease and nothing else — the holds it seeded are
   * the whole point and stay exactly where they are, which is what makes them
   * a promise the NEXT tree inherits rather than state it wrote itself.
   */
  async function seedDone(stateDir: string, cwd: string) {
    await seed(stateDir, ["clear-lease", "999"], undefined, cwd, true);
  }

  async function readState(stateDir: string, args: string[]) {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      env: { ...process.env, DRIVE_PR_STATE_DIR: stateDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`readState failed: ${args.join(" ")}`);
    }
    return stdout.trim();
  }

  async function resolveHeld(
    stateDir: string,
    args: string[],
    opts: {
      head?: string;
      cwd?: string;
      resolveThreadFails?: boolean;
      threads?: Fixture["threads"];
      /** Content-bearing fixture flag files — name → content, written into
       * the fixture dir before spawning. Used by the stub's opt-in branches
       * (e.g. `rehold-key-after-first-noderead`, `reopen-on-second-noderead`). */
      fixtureFiles?: Record<string, string>;
    } = {},
  ) {
    const { dir } = writeFixture({
      ...(opts.head ? { head: opts.head } : {}),
      ...(opts.threads ? { threads: opts.threads } : {}),
    });
    if (opts.resolveThreadFails) {
      writeFileSync(join(dir, "resolve-thread-fails"), "");
    }
    for (const [name, content] of Object.entries(opts.fixtureFiles ?? {})) {
      writeFileSync(join(dir, name), content);
    }
    const proc = Bun.spawn(
      [join(SCRIPTS, "resolve-held-thread.ts"), ...args, "999"],
      {
        cwd: opts.cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          // claim-held mutates state (review round 2), so — like every other
          // state-mutating probe in this file — it regenerates a handoff file
          // via `git rev-parse --show-toplevel`. Left unset, that resolves to
          // whichever scratch repo `cwd` points at (scratchClean/scratchOther
          // are SHARED across tests), writing an untracked `.context/` into
          // it that then fails every LATER test's dirty-tree check in that
          // same repo. Point it at the fixture's own scratch dir instead.
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
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
    const resolved = await Bun.file(join(dir, "resolved-threads.jsonl"))
      .text()
      .catch(() => "");
    return { stdout: stdout.trim(), stderr, exitCode, resolved };
  }

  /**
   * A thread fixture whose latest comment is a real trusted `**accepted**`
   * reply —
   * NOT the bare synthetic single "finding" comment `{ id, bot: true }`
   * alone produces, which is no longer sufficient once `resolve-held-
   * thread.ts` re-verifies the latest comment's own outcome, not merely its
   * url. Pair with `ACCEPTED_COMMENT_URL` as the `hold --comment-url`.
   */
  function acceptedReplyThread(
    id: string,
  ): NonNullable<Fixture["threads"]>[number] {
    return {
      id,
      bot: true,
      comments: [
        { authorAssociation: "NONE", body: "a finding" },
        {
          author: "example-user-2",
          authorAssociation: "OWNER",
          body: "**accepted** — fixed.",
        },
      ],
    };
  }
  const ACCEPTED_COMMENT_URL = "https://example.invalid/PRRT_a/comment-1";

  it("resolves a thread held and pushed within the SAME round", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-happy-"));
    // Mirror the real sequence: step 1's gate counts the round for the head
    // under review BEFORE triage, then hold records that round. Nothing bumps
    // `.rounds` again until the NEXT round's own gate — SKILL.md § 6's own
    // post-push status wait passes `--no-count` for exactly this reason
    // — so the fix, pushed on a DIFFERENT head than the one that
    // was under review, still resolves against the same recorded round.
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      // Matches `threadCommentNodes()`'s deterministic comment-1 URL for
      // `acceptedReplyThread` below — so the comment-staleness
      // recheck (which re-fetches the thread's live latest comment via
      // `node(id:...)` and compares both its URL AND its outcome against
      // this hold) reads this hold as CURRENT rather than stale.
      "--comment-url",
      ACCEPTED_COMMENT_URL,
    ]);
    // SKILL.md § 6's own `set-verified`, called right after guarded-push.ts
    // lands the fix — the second half of what a claim now requires (review
    // round 2).
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        threads: [acceptedReplyThread("PRRT_a")],
      },
    );
    expect(r.exitCode).toBe(0);
    // Proves the mutation actually ran, carrying THIS thread's id — not just
    // that the checks above it passed.
    expect(r.stdout).toBe("true");
    expect(r.resolved.trim()).toBe("PRRT_a");
  });

  // an earlier change finding (chatgpt-codex-connector, round 5): the
  // comment-staleness recheck. `finish-round.ts`'s own pre-push guard already
  // confirmed the hold's `commentUrl` matched the thread's latest comment —
  // but that runs BEFORE `guarded-push.ts`, which SKILL.md documents as
  // potentially taking tens of minutes. A reply landing on the thread during
  // that window must not be silently resolved by the drain that follows.
  it("restores (never resolves) when a NEW comment landed on the thread after it was held", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-stale2-"));
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      // The hold's own reply is comment-0; a SECOND comment (fixture below)
      // lands after it, modeling exactly the window this finding names.
      "--comment-url",
      "https://example.invalid/PRRT_a/comment-0",
    ]);
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        threads: [
          {
            id: "PRRT_a",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "original finding" },
              { authorAssociation: "NONE", body: "a NEW, unrelated remark" },
            ],
          },
        ],
      },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.resolved).toBe("");
    expect(r.stderr).toContain("latest comment moved past");
    // The item survives the failed attempt — held, not lost — so the next
    // round's enumeration finds it again rather than silently dropping it.
    const held = JSON.parse(await readState(stateDir, ["held", "999"]));
    expect(held).toEqual([
      expect.objectContaining({ key: "PRRT_a", outcome: "accepted" }),
    ]);
  });

  // an earlier change finding (chatgpt-codex-connector, round 7): a GitHub
  // comment keeps its permalink when EDITED, so the url-only check above
  // cannot catch a trusted reply whose outcome token was removed or changed
  // after it was held. The url still matches; only the body no longer does.
  it("restores (never resolves) when the held reply was EDITED after being held (same URL, different outcome)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-edited-"));
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/PRRT_a/comment-1",
    ]);
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        threads: [
          {
            id: "PRRT_a",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              // Same comment (same URL, comment-1), but its body no longer
              // carries the '**accepted**' outcome the hold was made for —
              // modeling a human editing the comment after triage-thread.ts
              // posted it.
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "actually let me re-check this first",
              },
            ],
          },
        ],
      },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.resolved).toBe("");
    expect(r.stderr).toContain("no longer carries the outcome 'accepted'");
    const held = JSON.parse(await readState(stateDir, ["held", "999"]));
    expect(held).toEqual([
      expect.objectContaining({ key: "PRRT_a", outcome: "accepted" }),
    ]);
  });

  // Reviewer bots post a confirming follow-up within seconds of an
  // outcome reply, so the strict "the held reply is the latest comment" rule
  // lost that race on every drain (4–5 cycles on PR #4618). The narrow
  // exceptions below, and the near misses around each that must still refuse.
  describe("bot confirmation race", () => {
    const CONFIRMATION_MARKER =
      "<!-- coderabbit-skip-review-comment-follow-up -->";

    /** The held `**accepted**` reply at comment-1, then `later` after it. */
    function heldThenLater(
      later: NonNullable<NonNullable<Fixture["threads"]>[number]["comments"]>,
      isResolved = false,
    ): NonNullable<Fixture["threads"]>[number] {
      const base = acceptedReplyThread("PRRT_a");
      return {
        ...base,
        isResolved,
        comments: [...(base.comments ?? []), ...later],
      };
    }

    async function holdAndResolve(
      label: string,
      thread: NonNullable<Fixture["threads"]>[number],
    ) {
      const stateDir = mkdtempSync(
        join(tmpdir(), `resolve-held-bot-${label}-`),
      );
      await seed(stateDir, ["bump-round", "999", "--head", PREV]);
      await seed(stateDir, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        ACCEPTED_COMMENT_URL,
      ]);
      await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
      const r = await resolveHeld(
        stateDir,
        ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
        { head: scratchClean.head, cwd: scratchClean.dir, threads: [thread] },
      );
      const held = JSON.parse(await readState(stateDir, ["held", "999"]));
      return { ...r, held };
    }

    function expectRefusedAndRestored(r: {
      exitCode: number;
      resolved: string;
      stderr: string;
      held: unknown;
    }) {
      expect(r.exitCode).not.toBe(0);
      expect(r.resolved).toBe("");
      expect(r.stderr).toContain("latest comment moved past");
      expect(r.held).toEqual([
        expect.objectContaining({ key: "PRRT_a", outcome: "accepted" }),
      ]);
    }

    it("resolves when the only later comment is CodeRabbit's own confirmation", async () => {
      const r = await holdAndResolve(
        "confirm",
        heldThenLater([
          {
            author: "coderabbitai",
            bot: true,
            body: `\`@example-user\`, confirmed.\n\n${CONFIRMATION_MARKER}\n`,
          },
        ]),
      );
      expect(r.exitCode).toBe(0);
      expect(r.resolved.trim()).toBe("PRRT_a");
      expect(r.held).toEqual([]);
    });

    it("drains an already-resolved thread WITHOUT a mutation", async () => {
      // A bot follow-up that matches no confirmation shape at all: the
      // resolved thread is what drains it, not the comment.
      const r = await holdAndResolve(
        "resolved",
        heldThenLater(
          [{ author: "coderabbitai", bot: true, body: "free-form analysis" }],
          true,
        ),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("true");
      expect(r.resolved).toBe("");
      expect(r.stderr).toContain("already resolved on GitHub");
      expect(r.held).toEqual([]);
    });

    it("still refuses and restores on a trailing HUMAN comment, marker or not", async () => {
      // Near miss: a human quoting the marker is still a human.
      expectRefusedAndRestored(
        await holdAndResolve(
          "human",
          heldThenLater([
            {
              author: "someone",
              authorAssociation: "MEMBER",
              bot: false,
              body: `not so fast\n${CONFIRMATION_MARKER}`,
            },
          ]),
        ),
      );
    });

    it("still refuses when the trailing CodeRabbit comment carries an outcome token", async () => {
      expectRefusedAndRestored(
        await holdAndResolve(
          "outcome",
          heldThenLater([
            {
              author: "coderabbitai",
              bot: true,
              body: `**rejected** — this does not fix it.\n${CONFIRMATION_MARKER}`,
            },
          ]),
        ),
      );
    });

    it("still refuses a CodeRabbit follow-up WITHOUT the confirmation marker", async () => {
      expectRefusedAndRestored(
        await holdAndResolve(
          "nomarker",
          heldThenLater([
            {
              author: "coderabbitai",
              bot: true,
              body: "I still see the race on line 40.",
            },
          ]),
        ),
      );
    });

    it("still refuses the marker from a bot that is not CodeRabbit", async () => {
      expectRefusedAndRestored(
        await holdAndResolve(
          "otherbot",
          heldThenLater([
            {
              author: "chatgpt-codex-connector",
              bot: true,
              body: `looks fine\n${CONFIRMATION_MARKER}`,
            },
          ]),
        ),
      );
    });

    it("still refuses a human comment hidden BEHIND a later CodeRabbit confirmation", async () => {
      // Every later comment must qualify, not merely the last one — the
      // human speaks first, the bot's confirmation lands last.
      expectRefusedAndRestored(
        await holdAndResolve(
          "mixed",
          heldThenLater([
            {
              author: "someone",
              authorAssociation: "MEMBER",
              bot: false,
              body: "wait, one more thing",
            },
            {
              author: "coderabbitai",
              bot: true,
              body: `confirmed.\n${CONFIRMATION_MARKER}`,
            },
          ]),
        ),
      );
    });
  });

  // Review finding (docomply-review, a reference-implementation pull request round 1): `dropReheldKey()`'s
  // own cleanup — for a key that has REAPPEARED in `held` since `claim-held`
  // removed the original entry (a concurrent driver's own reconciliation
  // re-holding it) — used to delete unconditionally on the strength of the
  // `isResolved: true` read `staleCheck` took EARLIER. That assumes
  // resolution is monotonic, which GitHub does not guarantee: any writer can
  // UNRESOLVE a thread, so the reappeared entry can be a legitimate, FRESH
  // re-triage made after the thread was reopened, not a stale leftover. The
  // fix re-verifies `isResolved` immediately before the delete rather than
  // trusting the earlier read.
  describe("dropReheldKey's re-verification before deleting a REAPPEARED hold", () => {
    it("does NOT delete a re-appeared hold when the live re-check finds the thread REOPENED", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-reopen-"));
      await seed(stateDir, ["bump-round", "999", "--head", PREV]);
      await seed(stateDir, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        ACCEPTED_COMMENT_URL,
      ]);
      await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
      const r = await resolveHeld(
        stateDir,
        ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
        {
          head: scratchClean.head,
          cwd: scratchClean.dir,
          threads: [{ ...acceptedReplyThread("PRRT_a"), isResolved: true }],
          fixtureFiles: {
            "rehold-key-after-first-noderead": "PRRT_a",
            "reopen-on-second-noderead": "",
          },
        },
      );
      expect(r.exitCode).toBe(0);
      // The already-resolved fast path: no resolveReviewThread mutation.
      expect(r.stdout.trim()).toBe("true");
      expect(r.resolved).toBe("");
      // The concurrent driver's re-appeared hold must SURVIVE.
      expect(await readState(stateDir, ["held-keys", "999"])).toBe("PRRT_a");
    });

    it("STILL deletes a re-appeared hold when the live re-check confirms the thread is STILL resolved", async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-reappear-"));
      await seed(stateDir, ["bump-round", "999", "--head", PREV]);
      await seed(stateDir, [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        ACCEPTED_COMMENT_URL,
      ]);
      await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
      const r = await resolveHeld(
        stateDir,
        ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
        {
          head: scratchClean.head,
          cwd: scratchClean.dir,
          threads: [{ ...acceptedReplyThread("PRRT_a"), isResolved: true }],
          fixtureFiles: {
            "rehold-key-after-first-noderead": "PRRT_a",
            // No reopen flag: BOTH node(id:) reads say still resolved.
          },
        },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("true");
      // Original cleanup behaviour preserved: a re-appeared hold that is
      // still genuinely stale (the thread is still resolved on the
      // re-check) is deleted exactly as before this fix.
      expect(await readState(stateDir, ["held-keys", "999"])).toBe("");
    });
  });

  // The other half of the same finding: a thread that became TRUNCATED
  // between hold and resolve must also refuse — the visible tail can no
  // longer be confirmed to be the real latest comment at all.
  it("restores (never resolves) when the thread became comment-TRUNCATED after it was held", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-trunc-"));
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/PRRT_a",
    ]);
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
    const { dir } = writeFixture({
      head: scratchClean.head,
      threads: [{ id: "PRRT_a", bot: true }],
    });
    // `writeFixture` always serves `hasNextPage: false` — fabricate the
    // truncated shape directly, the same pattern finish-round.ts's own
    // truncated-thread tests use.
    const threadsPath = join(dir, "threads.json");
    const parsed = JSON.parse(readFileSync(threadsPath, "utf8"));
    parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
    writeFileSync(threadsPath, JSON.stringify(parsed));
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "resolve-held-thread.ts"),
        "--key",
        "PRRT_a",
        "--pushed-sha",
        scratchClean.head,
        "999",
      ],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("comment-truncated");
    const resolved = await Bun.file(join(dir, "resolved-threads.jsonl"))
      .text()
      .catch(() => "");
    expect(resolved).toBe("");
  });

  // an earlier change finding (docomply-review, round 6): a comment node with
  // no readable `url` must refuse outright, never be silently dropped from
  // the population. Filtering it out would shift "the latest comment" to an
  // OLDER node, which can coincidentally still match the hold's own
  // `commentUrl` — resolving a thread whose real latest comment could not
  // actually be confirmed.
  it("restores (never resolves) when the latest comment node has no readable URL", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-badurl-"));
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/PRRT_a/comment-0",
    ]);
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);
    const { dir } = writeFixture({
      head: scratchClean.head,
      threads: [
        {
          id: "PRRT_a",
          bot: true,
          comments: [
            { authorAssociation: "NONE", body: "original finding" },
            { authorAssociation: "NONE", body: "a NEW, unrelated remark" },
          ],
        },
      ],
    });
    // Corrupt the LATEST comment's own `url` — a naive `.filter()` would drop
    // it and let `comment-0`'s url (the hold's own) read as "the latest",
    // silently matching.
    const threadsPath = join(dir, "threads.json");
    const parsed = JSON.parse(readFileSync(threadsPath, "utf8"));
    parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[1].url =
      null;
    writeFileSync(threadsPath, JSON.stringify(parsed));
    const proc = Bun.spawn(
      [
        join(SCRIPTS, "resolve-held-thread.ts"),
        "--key",
        "PRRT_a",
        "--pushed-sha",
        scratchClean.head,
        "999",
      ],
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot read");
    const resolved = await Bun.file(join(dir, "resolved-threads.jsonl"))
      .text()
      .catch(() => "");
    expect(resolved).toBe("");
  });

  // The documented recovery path (SKILL.md § 3): a reply already sits on
  // GitHub from an interrupted earlier pass, and the round genuinely DID
  // advance since then. Re-triaging re-runs `hold` (upsert-by-key), which
  // refreshes the recorded round to the current one — that is what is
  // supposed to turn a round mismatch back into a match, not just what
  // produces one in the first place.
  it("a re-hold after a genuine round advance clears the mismatch it would otherwise flag", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-rehold-"));
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-2",
    ]);
    // A crash, then a later pass discovers a genuinely new round (some other
    // work landed) and re-triages: the reply is already on GitHub, so step 3
    // re-runs `hold` rather than replying again.
    await seed(stateDir, ["bump-round", "999", "--head", "deadbeef"]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      // Matches `acceptedReplyThread()`'s deterministic comment-1 URL — see
      // the identical note in the happy-path test above.
      "--comment-url",
      ACCEPTED_COMMENT_URL,
    ]);
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);

    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        threads: [acceptedReplyThread("PRRT_a")],
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.resolved.trim()).toBe("PRRT_a");
  });

  // The review-flagged bypass (round 2): an unrelated push lands WITHOUT ever
  // going through a counting drive-status.ts gate, so `.rounds` never
  // advances — a round-only comparison would read this as a match, even
  // though this SHA never went through the validate → push → set-verified
  // sequence the hold's reply was actually waiting on.
  it("refuses a push that never went through set-verified, even though the round never advanced", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "resolve-held-thread-unverified-"),
    );
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-4",
    ]);
    // No `set-verified` call at all — this push reached the PR head and this
    // worktree some other way (a manual push, a bypassed step 6), and no
    // counting gate ran either, so `.rounds` is still exactly what it was at
    // hold time.
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("is not the push recorded against");
    expect(r.resolved).toBe("");
    // Refused, not consumed.
    expect(await readState(stateDir, ["held-keys", "999"])).toBe("PRRT_a");
  });

  it("restores a claimed item to `held` when the resolve mutation itself fails", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "resolve-held-thread-mutation-fails-"),
    );
    // Seeded from ANOTHER tree, on purpose: `restore-held` takes the actor as
    // an ARGUMENT rather than re-deriving it, precisely so a restore cannot
    // launder ownership onto the restoring tree (and its own comment
    // in drive-state.ts). Seeding and resolving from one tree would make that
    // laundering invisible — the two values would coincide.
    //
    // Reachable, and this is the shape it is reachable in: a hold outlives the
    // tree that made it, so tree A holds, A's session ends, and B is admitted
    // BECAUSE A's lease is no longer live — then B works the batch. Seeded
    // sessionless for exactly that reason; a LIVE foreign lease would be
    // refused at the PR-wide gate, correctly, and would not be a takeover.
    const seedTree = scratchOther.dir;
    await seed(
      stateDir,
      ["bump-round", "999", "--head", PREV],
      undefined,
      seedTree,
      true,
    );
    await seed(
      stateDir,
      [
        "hold",
        "999",
        "--key",
        "PRRT_a",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        // Matches `acceptedReplyThread()`'s deterministic comment-1 URL —
        // see the identical note on the happy-path test above.
        "--comment-url",
        ACCEPTED_COMMENT_URL,
      ],
      undefined,
      seedTree,
      true,
    );
    await seed(
      stateDir,
      ["stamp-held", "999", "--sha", scratchClean.head],
      undefined,
      seedTree,
      true,
    );
    // …and then stops, which is the half of the takeover the resolving tree
    // below depends on. Without it that tree meets a live foreign holder and
    // is refused at the PR-wide gate — correctly, but this probe is about what
    // `resolve-held-thread.ts` does when its own mutation fails, not about
    // being kept out.
    await seedDone(stateDir, seedTree);
    // The actor the hold actually carries, read rather than re-derived: the
    // derivation is deliberately not overridable (actor.ts), so a copy of its
    // sha256 formula here would be a second implementation free to drift from
    // the one under test.
    const seededActor =
      (
        JSON.parse(await readState(stateDir, ["held", "999"])) as {
          actor: string;
        }[]
      )[0]?.actor ?? "";

    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        resolveThreadFails: true,
        threads: [acceptedReplyThread("PRRT_a")],
      },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.resolved).toBe("");
    expect(r.stderr).toContain("restored it to the held batch");

    const held = JSON.parse(await readState(stateDir, ["held", "999"]));
    // The restored entry carries its ORIGINAL commentUrl forward — a restore
    // that dropped it would read as provenance-free to the next standalone
    // reconciliation, which treats that as a different (superseding) comment
    // and downgrades a hold that was never actually invalidated
    // (docomply-review round 11, a reference-implementation pull request).
    //
    // And its `actor` + `verifiedSha`, for a sharper reason still:
    // `set-verified` has already run for this push and will not run again, so
    // a restore that dropped the stamp would leave the item unclaimable — the
    // retry this restore exists to enable could never happen.
    //
    // `seededActor` is the SEEDING tree's, not the resolving one's, which is
    // what makes this an anti-laundering assertion rather than a tautology: a
    // `restore-held` that re-derived the actor would write the resolving
    // tree's id here and this would fail.
    expect(held).toEqual([
      {
        key: "PRRT_a",
        kind: "thread",
        outcome: "accepted",
        round: 1,
        commentUrl: ACCEPTED_COMMENT_URL,
        actor: seededActor,
        verifiedSha: scratchClean.head,
      },
    ]);
    // Not merely present — actually usable: a retry against the same push must
    // now succeed, which is the property the restored stamp buys.
    const retry = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      {
        head: scratchClean.head,
        cwd: scratchClean.dir,
        threads: [acceptedReplyThread("PRRT_a")],
      },
    );
    expect(retry.exitCode).toBe(0);
    expect(retry.resolved.trim()).toBe("PRRT_a");
  });

  // The acceptance probe: a thread held in one round must not
  // resolve against a push that landed in a LATER round without re-confirming
  // it first — even though that later push passes every SHA check (it is a
  // perfectly valid, clean, current PR head). Only the round comparison
  // catches the cross-push resolve.
  it("refuses to resolve against a push from a LATER round than the hold (cross-push resolve)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-stale-"));
    // Round 1: the thread is triaged and held against the head under review.
    await seed(stateDir, ["bump-round", "999", "--head", PREV]);
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-6",
    ]);
    // Round 2: a DIFFERENT push landed — another actor, another thread's fix,
    // or simply the drive resuming several rounds later — without this thread
    // ever being re-triaged, so the held record is now stale relative to the
    // round counter.
    await seed(stateDir, ["bump-round", "999", "--head", scratchClean.head]);
    // The later push IS a genuine verified push, so `verifiedSha` matches and
    // the round comparison is the only check that can refuse this resolve.
    await seed(stateDir, ["stamp-held", "999", "--sha", scratchClean.head]);

    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      { head: scratchClean.head, cwd: scratchClean.dir },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("held in round 1");
    expect(r.stderr).toContain("round is 2");
    expect(r.resolved).toBe("");
  });

  it("refuses when no held item carries the key", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "resolve-held-thread-missing-"),
    );
    const r = await resolveHeld(stateDir, [
      "--key",
      "PRRT_ghost",
      "--pushed-sha",
      scratchClean.head,
    ]);
    // Exit 4, matching `claim-held`'s own exit for the identical condition —
    // a caller (finish-round.ts) must see one code for "not in the held
    // batch at all" regardless of which of the two catches it, since that is
    // the one case worth re-reading the batch over rather than recording a
    // permanent refusal (chatgpt-codex-connector, a reference-implementation pull request).
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no held item with key 'PRRT_ghost'");
  });

  it("refuses a held FINDING — the wrong kind for this script", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-kind-"));
    await seed(
      stateDir,
      [
        "hold",
        "999",
        "--key",
        "f00d",
        "--kind",
        "finding",
        "--outcome",
        "moot",
      ],
      "no longer applies",
    );
    const r = await resolveHeld(stateDir, [
      "--key",
      "f00d",
      "--pushed-sha",
      scratchClean.head,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("is a held 'finding', not a 'thread'");
  });

  it("refuses when --pushed-sha is not the PR head", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "resolve-held-thread-apihead-"),
    );
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-7",
    ]);
    const r = await resolveHeld(stateDir, [
      "--key",
      "PRRT_a",
      "--pushed-sha",
      PREV,
    ]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not PR #999");
  });

  it("refuses when --pushed-sha is not THIS worktree HEAD", async () => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "resolve-held-thread-localhead-"),
    );
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-8",
    ]);
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", scratchClean.head],
      { head: scratchClean.head, cwd: scratchOther.dir },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("worktree's HEAD");
  });

  it("refuses while the working tree is dirty", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-dirty-"));
    await seed(stateDir, [
      "hold",
      "999",
      "--key",
      "PRRT_a",
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      "https://example.invalid/seed-comment-9",
    ]);
    const dirty = makeScratchRepo("scratch-held-thread-dirty");
    writeFileSync(join(dirty.dir, "seed.txt"), "an uncommitted fix\n");
    const r = await resolveHeld(
      stateDir,
      ["--key", "PRRT_a", "--pushed-sha", dirty.head],
      { head: dirty.head, cwd: dirty.dir },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("working tree is dirty");
  });

  it("requires --key", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-nokey-"));
    const r = await resolveHeld(stateDir, ["--pushed-sha", scratchClean.head]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--key is required");
  });

  it("requires --pushed-sha", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "resolve-held-thread-nosha-"));
    const r = await resolveHeld(stateDir, ["--key", "PRRT_a"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--pushed-sha is required");
  });
});

// The round-finish sequence as ONE command. Every probe below is a
// spawn probe by necessity, not by preference: what is under test is an
// ORDERING across real processes — a push that must not happen before a
// dirty-tree refusal, a stamp that must not happen before the push, a status
// call whose flag must leave a durable counter alone, and a drain that must
// dispatch through the same claim mechanics a hand-driven § 6 used. None of
// that is a total function of an input, so none of it is reachable without
// the process boundaries it is a statement about.
describe("finish-round.ts", () => {
  let finishSeq = 0;

  /**
   * A `git` on PATH that RECORDS a `push` instead of performing one, and
   * delegates every other subcommand to the real binary.
   *
   * The alternative — the fully-stubbed `git` the `guarded-push.ts` block uses
   * — cannot serve these probes: they need `rev-parse HEAD`, `status
   * --porcelain` and the git-dir marker probe to answer TRUTHFULLY about a
   * real scratch repository, because "did it refuse before pushing" is a claim
   * about those answers. Intercepting only `push` keeps every one of them real
   * while leaving the one irreversible act observable as a file.
   */
  function recordingGit(dir: string, pushLog: string): string {
    const real = Bun.which("git");
    if (real === null) throw new Error("no real git on PATH");
    const bin = join(dir, "gitbin");
    mkdirSync(bin, { recursive: true });
    const p = join(bin, "git");
    writeFileSync(
      p,
      [
        "#!/usr/bin/env bash",
        'if [ "${1:-}" = "push" ]; then',
        `  ${GIT_PUSH_FLAG_GUARD}`,
        `  printf '%s\\n' "$*" >> ${JSON.stringify(pushLog)}`,
        '  echo "   abc..def  HEAD -> main"',
        "  exit 0",
        "fi",
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(p, 0o755);
    return bin;
  }

  it("the fake git push rejects an unsupported flag before reporting success", () => {
    const dir = mkdtempSync(join(tmpdir(), "finish-round-git-flag-"));
    try {
      const bin = recordingGit(dir, join(dir, "push.log"));
      const result = Bun.spawnSync([
        join(bin, "git"),
        "push",
        "--forse-with-lease",
        "origin",
        "abc:refs/heads/feature/test",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        "unknown argument: --forse-with-lease",
      );
      expect(existsSync(join(dir, "push.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake git push rejects the remote and refspec swapped (docomply-review round 2)", () => {
    // Presence checks alone ("did 'origin' and a refspec token occur
    // somewhere") would still accept an accidentally swapped invocation —
    // guarded-push.ts always calls git(['push', ...extra, 'origin', refspec]),
    // so the remote must come immediately before the refspec.
    const dir = mkdtempSync(join(tmpdir(), "finish-round-git-swap-"));
    try {
      const bin = recordingGit(dir, join(dir, "push.log"));
      const result = Bun.spawnSync([
        join(bin, "git"),
        "push",
        "abc:refs/heads/feature/test",
        "origin",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        "expected remote 'origin' first",
      );
      expect(existsSync(join(dir, "push.log"))).toBe(false);

      // Sanity: the correctly ordered call still succeeds.
      const ok = Bun.spawnSync([
        join(bin, "git"),
        "push",
        "origin",
        "abc:refs/heads/feature/test",
      ]);
      expect(ok.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake git push rejects a refspec with an empty source", () => {
    const dir = mkdtempSync(join(tmpdir(), "finish-round-git-empty-source-"));
    try {
      const bin = recordingGit(dir, join(dir, "push.log"));
      const result = Bun.spawnSync([
        join(bin, "git"),
        "push",
        "origin",
        ":refs/heads/feature/test",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        "expected a refs/heads/* refspec",
      );
      expect(existsSync(join(dir, "push.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the fake gh rejects an empty flag value before serving a fixture", () => {
    const result = Bun.spawnSync([
      join(binDir, "gh"),
      "pr",
      "view",
      "--json",
      "",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("missing flag value");
  });

  it("the fake gh rejects a snapshot projection without required fields", () => {
    const result = Bun.spawnSync([
      join(binDir, "gh"),
      "pr",
      "view",
      "4981",
      "--json",
      "number,labels",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("unexpected --json projection");
  });

  it("the fake gh returns only requested fields from a valid projection", () => {
    const { dir } = writeFixture({});
    const result = Bun.spawnSync(
      [join(binDir, "gh"), "pr", "view", "999", "--json", "state"],
      { env: { ...process.env, DRIVE_PR_FIXTURES: dir } },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ state: "OPEN" });
  });

  it("the fake gh rejects a selector outside its PR fixture", () => {
    const result = Bun.spawnSync([
      join(binDir, "gh"),
      "pr",
      "view",
      "998",
      "--json",
      "state",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("expected PR selector 999");
  });

  /**
   * A scratch repo with an `origin` whose owner/name match the fixture PR's
   * head repository — `guarded-push.ts` compares those before it pushes, and a
   * repo with no remote at all would be refused for a reason none of these
   * probes is about.
   */
  function scratchWithOrigin(): { dir: string; head: string } {
    const r = makeScratchRepo(`finish-round-${++finishSeq}`);
    Bun.spawnSync(
      [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:example-org/example-repo.git",
      ],
      { cwd: r.dir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    // `refs/remotes/origin/develop`, pointing at `makeScratchRepo`'s FIRST
    // commit (HEAD~1) — every real worktree has this fetched, and the
    // an earlier change untriaged-thread guard's `roundBase` falls back to
    // `git merge-base origin/develop HEAD` whenever no verified SHA is
    // recorded, which is the common case for these probes (none of them call
    // `set-verified` before reaching the guard unless a test explicitly
    // does). Without this ref that fallback fails outright in a scratch repo
    // that never fetched anything, and the guard would refuse EVERY probe
    // below with TRIAGE_CHECK_FAILED — including the ones that have nothing
    // to do with triage — rather than only the ones it exists to catch.
    const headParentRes = Bun.spawnSync(["git", "rev-parse", "HEAD~1"], {
      cwd: r.dir,
      env: gitCleanEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const headParent = headParentRes.stdout.toString().trim();
    // an earlier change finding (coderabbitai): assert both setup calls
    // actually succeeded — a failed `rev-parse` would silently hand
    // `update-ref` an empty ref name, and a failed `update-ref` would leave
    // `origin/develop` unset, both producing a repo shape the probes below
    // assert against for the wrong reason.
    expect(headParentRes.exitCode).toBe(0);
    expect(headParent).not.toBe("");
    const updateRefRes = Bun.spawnSync(
      ["git", "update-ref", "refs/remotes/origin/develop", headParent],
      { cwd: r.dir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    expect(updateRefRes.exitCode).toBe(0);
    return r;
  }

  function stateEnv(stateDir: string, fixtureDir: string) {
    return {
      ...gitCleanEnv(),
      DRIVE_PR_STATE_DIR: stateDir,
      // Required beside the override since PR #4107 round 16 — an unaccompanied
      // `$DRIVE_PR_STATE_DIR` reads as a superseded driver and refuses.
      DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
      // An unset handoff dir writes `.context/` into whichever repo `cwd`
      // names, which then fails that repo's OWN clean-tree check on the very
      // next probe (`resolve-held-thread.ts`'s harness documents the same
      // trap).
      DRIVE_PR_HANDOFF_DIR: join(fixtureDir, "handoff"),
      // The identical trap, for the mailbox: `guarded-push.ts`'s hold-push
      // check takes the inbox lock, which creates `.context/drive-mailbox/` in
      // whichever repo `resolveMailboxDir()` resolves to when this env var
      // is unset — the scratch repo `cwd` here. That directory is untracked
      // in the scratch repo (unlike the real worktree, which gitignores
      // `.context/`), so it fails `resolve-held-thread.ts`'s and
      // `answer-summary-finding.ts`'s own dirty-tree check on the drain
      // that runs right after the push, the same way an unset
      // `DRIVE_PR_HANDOFF_DIR` used to.
      DRIVE_PR_MAILBOX_DIR: join(fixtureDir, "mailbox"),
      // set-ci-hold is test-only fixture seeding (PR #4681 round 4) —
      // harmless to set unconditionally here since no other command reads
      // this variable.
      DRIVE_PR_ALLOW_TEST_CI_HOLD_SEED: "1",
    };
  }

  /** Run one `drive-state.ts` command against a probe's state, and require it. */
  async function seed(
    stateDir: string,
    fixtureDir: string,
    cwd: string,
    args: string[],
    stdin?: string,
  ): Promise<string> {
    const proc = Bun.spawn([join(SCRIPTS, "drive-state.ts"), ...args], {
      cwd,
      env: { ...stateEnv(stateDir, fixtureDir), PATH: process.env.PATH ?? "" },
      stdin: stdin !== undefined ? "pipe" : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`seed failed: ${args.join(" ")}\n${stderr}`);
    }
    return stdout.trim();
  }

  interface FinishOpts {
    fixture?: Fixture;
    /** The tree the round is finished from. Defaults to a fresh scratch repo. */
    repo?: { dir: string; head: string };
    /** Reuse an EXISTING state dir instead of the fixture's fresh one. */
    stateDir?: string;
    /**
     * Reuse an EXISTING fixture dir, so a re-run sees the GitHub side an
     * earlier run left (labels, timeline, posted comments) rather than a
     * fresh PR that never carried them.
     */
    fixtureDir?: string;
    /** Runs against the state dir in force, from the probe's own tree. */
    seedState?: (ctx: {
      stateDir: string;
      fixtureDir: string;
      cwd: string;
    }) => Promise<void>;
    args?: string[];
  }

  async function finishRound(opts: FinishOpts = {}) {
    const repo = opts.repo ?? scratchWithOrigin();
    const { dir, stateDir: fresh } =
      opts.fixtureDir === undefined
        ? writeFixture({
            threads: [{ id: "PRRT_live", path: "a.ts", bot: true }],
            ...(opts.fixture ?? {}),
            head: repo.head,
          })
        : { dir: opts.fixtureDir, stateDir: undefined };
    const stateDir = opts.stateDir ?? fresh;
    if (stateDir === undefined)
      throw new Error("a reused fixture dir needs its state dir too");
    const pushLog = join(dir, "pushed.log");
    const gitBin = recordingGit(dir, pushLog);
    await opts.seedState?.({ stateDir, fixtureDir: dir, cwd: repo.dir });
    const proc = Bun.spawn(
      [join(SCRIPTS, "finish-round.ts"), "999", "--json", ...(opts.args ?? [])],
      {
        cwd: repo.dir,
        env: {
          ...stateEnv(stateDir, dir),
          PATH: `${gitBin}:${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
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
    const read = async (name: string) =>
      await Bun.file(join(dir, name))
        .text()
        .catch(() => "");
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      report = {};
    }
    return {
      exitCode,
      stdout,
      stderr,
      report,
      pushed: await read("pushed.log"),
      posted: await read("posted.jsonl"),
      resolved: await read("resolved-threads.jsonl"),
      stateDir,
      fixtureDir: dir,
      repo,
    };
  }

  // ── The pre-push refusals ────────────────────────────────────────────────

  it("refuses a DIRTY worktree, and pushes nothing", async () => {
    const repo = scratchWithOrigin();
    writeFileSync(
      join(repo.dir, "uncommitted.txt"),
      "a fix nobody committed\n",
    );
    const r = await finishRound({ repo });
    expect(r.exitCode).toBe(3);
    expect(r.report.state).toBe("REFUSED_UNCLEAN");
    expect(r.report.pushed).toBe(false);
    // The load-bearing half: the refusal is worth nothing if it lands AFTER
    // the one irreversible act. An empty push log is the only evidence of
    // that ordering that the script cannot self-report.
    expect(r.pushed).toBe("");
    expect(r.stderr).toContain("uncommitted.txt");
  });

  it("refuses an unconcluded merge whose worktree reads CLEAN, and pushes nothing", async () => {
    // `git status --porcelain` — even hardened — reports empty for a conflict
    // resolved back to the already-committed tree, while MERGE_HEAD sits in
    // the git-dir. A dirty-tree predicate alone passes this; the marker probe
    // is what refuses it.
    const repo = makeUnresolvedMergeRepo(`finish-round-merge-${++finishSeq}`);
    Bun.spawnSync(
      [
        "git",
        "remote",
        "add",
        "origin",
        "git@github.com:example-org/example-repo.git",
      ],
      { cwd: repo.dir, env: gitCleanEnv(), stdout: "pipe", stderr: "pipe" },
    );
    const r = await finishRound({ repo });
    expect(r.exitCode).toBe(3);
    expect(r.report.state).toBe("REFUSED_UNCLEAN");
    expect(String(r.report.reason)).toContain("MERGE_HEAD");
    expect(r.pushed).toBe("");
  });

  // ── The push refusal, propagated ─────────────────────────────────────────

  it("re-acquires ci:hold after a human unlabel only once fresh required CI completed", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "set-ci-hold",
          "999",
          "--set",
          "held",
          "--event-id",
          "LE_1",
          "--head",
          Bun.spawnSync(["git", "rev-parse", "HEAD"], {
            cwd,
            env: gitCleanEnv(),
          })
            .stdout.toString()
            .trim(),
          "--actor-name",
          "drive-user",
          "--created-at",
          "2026-09-10T09:59:00Z",
          "--check-run-watermark",
          "10000",
        ]);
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            {
              node_id: "LE_1",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "drive-user" },
              created_at: "2026-09-10T09:59:00Z",
            },
            {
              node_id: "LE_2",
              event: "unlabeled",
              label: { name: "ci:hold" },
              actor: { login: "human-user" },
              created_at: "2026-09-10T10:00:00Z",
            },
          ]),
        );
        const runsPath = join(fixtureDir, "check-runs.json");
        const runs = JSON.parse(readFileSync(runsPath, "utf8")) as {
          check_runs: Array<{ id: number; name: string }>;
        };
        for (const run of runs.check_runs) {
          if (
            ["code-quality-and-build", "tests", "Schema gate"].includes(
              run.name,
            )
          )
            run.id += 20_000;
        }
        writeFileSync(runsPath, JSON.stringify(runs));
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.pushed).not.toBe("");
    const state = JSON.parse(
      readFileSync(join(r.stateDir, "drive-pr-999.json"), "utf8"),
    ) as { ciHold: { phase: string; eventId: string } };
    expect(state.ciHold).toMatchObject({ phase: "held", eventId: "LE_3" });
  });

  it("recovers an interrupted acquisition followed by a human removal without wedging", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
          cwd,
          env: gitCleanEnv(),
        })
          .stdout.toString()
          .trim();
        await seed(stateDir, fixtureDir, cwd, [
          "set-ci-hold",
          "999",
          "--set",
          "held",
          "--event-id",
          "LE_seed",
          "--head",
          head,
          "--actor-name",
          "drive-user",
          "--created-at",
          "2026-09-10T09:58:00Z",
          "--check-run-watermark",
          "10000",
        ]);
        const statePath = join(stateDir, "drive-pr-999.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
          string,
          unknown
        >;
        state.ciHold = {
          phase: "acquiring",
          previousEventId: null,
          head,
          actor: "drive-user",
          createdAt: "2026-09-10T09:59:00Z",
          checkRunWatermark: 10_000,
        };
        writeFileSync(statePath, JSON.stringify(state));
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            {
              node_id: "LE_1",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "drive-user" },
              created_at: "2026-09-10T09:59:00Z",
            },
            {
              node_id: "LE_2",
              event: "unlabeled",
              label: { name: "ci:hold" },
              actor: { login: "human-user" },
              created_at: "2026-09-10T10:00:00Z",
            },
          ]),
        );
      },
    });
    expect(r.exitCode).toBe(4);
    expect(r.pushed).toBe("");
    const state = JSON.parse(
      readFileSync(join(r.stateDir, "drive-pr-999.json"), "utf8"),
    ) as { ciHold: Record<string, unknown> };
    expect(state.ciHold).toMatchObject({
      phase: "released",
      eventId: "LE_2",
      checkRunWatermark: 10_000,
      source: "external",
    });
  });

  it("preserves an interrupted acquisition while its live label event lags across a head move", async () => {
    const r = await finishRound({
      fixture: { threads: [], ciHeld: true },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
          cwd,
          env: gitCleanEnv(),
        })
          .stdout.toString()
          .trim();
        await seed(stateDir, fixtureDir, cwd, [
          "set-ci-hold",
          "999",
          "--set",
          "held",
          "--event-id",
          "LE_seed",
          "--head",
          head,
          "--actor-name",
          "drive-user",
          "--created-at",
          "2026-09-10T09:58:00Z",
          "--check-run-watermark",
          "10000",
        ]);
        const statePath = join(stateDir, "drive-pr-999.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
          string,
          unknown
        >;
        state.ciHold = {
          phase: "acquiring",
          previousEventId: null,
          head: PREV,
          actor: "drive-user",
          createdAt: "2026-09-10T09:59:00Z",
          checkRunWatermark: 10_000,
        };
        writeFileSync(statePath, JSON.stringify(state));
      },
    });
    expect(r.exitCode).toBe(4);
    expect(r.pushed).toBe("");
    const state = JSON.parse(
      readFileSync(join(r.stateDir, "drive-pr-999.json"), "utf8"),
    ) as { ciHold: Record<string, unknown> };
    expect(state.ciHold).toMatchObject({
      phase: "acquiring",
      head: PREV,
      previousEventId: null,
    });
  });

  it("recovers an interrupted release with intervening transitions without wedging", async () => {
    const r = await finishRound({
      fixture: { threads: [] },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
          cwd,
          env: gitCleanEnv(),
        })
          .stdout.toString()
          .trim();
        await seed(stateDir, fixtureDir, cwd, [
          "set-ci-hold",
          "999",
          "--set",
          "held",
          "--event-id",
          "LE_1",
          "--head",
          head,
          "--actor-name",
          "drive-user",
          "--created-at",
          "2026-09-10T09:58:00Z",
          "--check-run-watermark",
          "10000",
        ]);
        const statePath = join(stateDir, "drive-pr-999.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
          string,
          unknown
        >;
        state.ciHold = {
          phase: "releasing",
          heldEventId: "LE_1",
          addedAtHead: head,
          heldActor: "drive-user",
          heldCreatedAt: "2026-09-10T09:58:00Z",
          head,
          actor: "drive-user",
          createdAt: "2026-09-10T09:59:00Z",
          checkRunWatermark: 10_000,
        };
        writeFileSync(statePath, JSON.stringify(state));
        writeFileSync(
          join(fixtureDir, "timeline.json"),
          JSON.stringify([
            {
              node_id: "LE_1",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "drive-user" },
              created_at: "2026-09-10T09:58:00Z",
            },
            {
              node_id: "LE_2",
              event: "unlabeled",
              label: { name: "ci:hold" },
              actor: { login: "drive-user" },
              created_at: "2026-09-10T09:59:00Z",
            },
            {
              node_id: "LE_3",
              event: "labeled",
              label: { name: "ci:hold" },
              actor: { login: "human-user" },
              created_at: "2026-09-10T09:59:30Z",
            },
            {
              node_id: "LE_4",
              event: "unlabeled",
              label: { name: "ci:hold" },
              actor: { login: "human-user" },
              created_at: "2026-09-10T10:00:00Z",
            },
          ]),
        );
      },
    });
    expect(r.exitCode).toBe(4);
    expect(r.pushed).toBe("");
    const state = JSON.parse(
      readFileSync(join(r.stateDir, "drive-pr-999.json"), "utf8"),
    ) as { ciHold: Record<string, unknown> };
    expect(state.ciHold).toMatchObject({
      phase: "released",
      eventId: "LE_4",
      checkRunWatermark: 10_000,
      source: "external",
    });
  });

  it("propagates guarded-push.ts's merged-PR refusal as its own exit 5, stamping nothing", async () => {
    const r = await finishRound({ fixture: { prState: "MERGED" } });
    expect(r.exitCode).toBe(5);
    expect(r.report.state).toBe("PR_NOT_OPEN");
    expect(r.pushed).toBe("");
    // Nothing downstream may run either: a stamp recorded here would vouch for
    // a push that never happened, and every held item would then read as
    // dispatchable against it.
    expect(r.report.stamped).toBe(false);
  });

  // ── The head-sync wait counts no round ───────────────────────────────────

  it("does not advance the durable round counter (the --no-count flag)", async () => {
    let stateDirSeen = "";
    let fixtureSeen = "";
    let cwdSeen = "";
    const r = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        stateDirSeen = stateDir;
        fixtureSeen = fixtureDir;
        cwdSeen = cwd;
        // Step 1's gate counted the head that was UNDER REVIEW. The fix is
        // pushed on a different head, and nothing in step 6 may count it.
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.report.headSynced).toBe(true);
    const after = await seed(stateDirSeen, fixtureSeen, cwdSeen, [
      "rounds",
      "999",
    ]);
    expect(after).toBe("1");

    // Non-vacuity: the head finish-round just synced to IS countable, so a
    // `rounds` that stayed at 1 above is the flag working — not a head the
    // counter would have ignored anyway. A `--no-count` regression shows up
    // here as 1 (finish-round already counted this head, so the counting call
    // finds `lastCountedHead` equal and returns), never as 2.
    const counting = Bun.spawn(
      [join(SCRIPTS, "drive-status.ts"), "999", "--json", "--once"],
      {
        cwd: cwdSeen,
        env: {
          ...stateEnv(stateDirSeen, fixtureSeen),
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: fixtureSeen,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    await counting.exited;
    const bumped = await seed(stateDirSeen, fixtureSeen, cwdSeen, [
      "rounds",
      "999",
    ]);
    expect(bumped).toBe("2");
  });

  // ── The drain ────────────────────────────────────────────────────────────

  it("drains a held thread and a held finding in one run", async () => {
    const r = await finishRound({
      fixture: {
        threads: [
          { id: "PRRT_live", path: "a.ts", bot: true },
          {
            id: "PRRT_held",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "**accepted** — fixed.",
              },
            ],
          },
        ],
      },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_held",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          // Matches `threadCommentNodes()`'s deterministic comment-1 URL for
          // a thread with an explicit `comments` array ending in a real
          // trusted accepted reply — required since resolve-held-thread.ts's
          // an earlier change drain-time recheck re-verifies both the latest
          // comment's URL AND its outcome (round 7), not merely its URL.
          "--comment-url",
          "https://example.invalid/PRRT_held/comment-1",
        ]);
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-held-1",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "the extractor now bounds the retry, as asked.",
        );
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.report.state).toBe("FINISHED");
    // The thread went through the wrapper's mutation, and the finding through
    // a real POST — not merely "the script reported success".
    expect(r.resolved.trim()).toBe("PRRT_held");
    expect(r.posted.trim().split("\n").length).toBe(1);
    expect(JSON.parse(r.posted).body).toContain("fp-held-1");
    // Released one at a time as each dispatch succeeded, so a successor reads
    // back an empty batch rather than a batch it must re-derive.
    const held = await seed(r.stateDir, r.fixtureDir, r.repo.dir, [
      "held",
      "999",
    ]);
    expect(JSON.parse(held)).toEqual([]);
  });

  it("aborts as BATCH_UNREADABLE, not a per-item refusal, when release-held cannot read state after the answer already posted (chatgpt-codex-connector, a reference-implementation pull request round 9)", async () => {
    const r = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-release-unreadable",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "the extractor now bounds the retry, as asked.",
        );
        // The claim succeeds against GOOD state; the state file only becomes
        // unreadable as a side effect of the gh stub's own POST — i.e. AFTER
        // the claim, so this exercises the release step's own exit-3
        // handling, not the claim step's (already-covered) one.
        writeFileSync(join(fixtureDir, "corrupt-state-on-post"), "");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.report.state).toBe("BATCH_UNREADABLE");
    // The answer really did post — the irreversible half succeeded — so the
    // report must say so rather than reading like nothing happened.
    expect(r.posted.trim().split("\n").length).toBe(1);
    expect(JSON.parse(r.posted).body).toContain("fp-release-unreadable");
    expect(String(r.report.reason)).toContain("fp-release-unreadable");
  });

  it("reports a per-item refusal and still drains the rest of the batch", async () => {
    const r = await finishRound({
      // `PRRT_stale` needs no live thread entry: `claim-held` refuses it on
      // the round mismatch BEFORE resolve-held-thread.ts's own an earlier change
      // staleness recheck ever runs. `PRRT_current` DOES reach that recheck.
      fixture: {
        threads: [
          { id: "PRRT_live", path: "a.ts", bot: true },
          {
            id: "PRRT_current",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "**accepted** — fixed.",
              },
            ],
          },
        ],
      },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        // A thread held in an EARLIER round — the shape a crash between the
        // reply and the resolve leaves behind. `claim-held` refuses it on the
        // round check, and that refusal must not take the current round's own
        // held thread down with it.
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_stale",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/held-comment-stale",
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          HEAD,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_current",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/PRRT_current/comment-1",
        ]);
      },
    });
    expect(r.exitCode).toBe(6);
    expect(r.report.state).toBe("PARTIAL");
    const items = r.report.items as Array<Record<string, unknown>>;
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("PRRT_current")?.action).toBe("resolved");
    expect(byKey.get("PRRT_stale")?.action).toBe("refused");
    // The refusing script's own diagnostic, not a re-worded one — that text is
    // what names the § 3 reconciliation the operator has to perform.
    expect(String(byKey.get("PRRT_stale")?.diagnostic)).toContain(
      "was held in round",
    );
    // The good one really did resolve; the refusal did not abort the drain.
    expect(r.resolved.trim()).toBe("PRRT_current");
    // And the refused one is STILL held, so a re-run after reconciling finds it.
    const held = JSON.parse(
      await seed(r.stateDir, r.fixtureDir, r.repo.dir, ["held", "999"]),
    ) as Array<{ key: string }>;
    expect(held.map((h) => h.key)).toEqual(["PRRT_stale"]);
  });

  it("re-reads the batch instead of refusing when a CONCURRENT resolve removes a different held thread (chatgpt-codex-connector, a reference-implementation pull request round 8/9)", async () => {
    const r = await finishRound({
      // Only PRRT_vanisher needs a live thread entry: PRRT_victim is released
      // (vanish-key-on-resolve below) before its own dispatch would reach
      // resolve-held-thread.ts's an earlier change staleness recheck at all.
      fixture: {
        threads: [
          { id: "PRRT_live", path: "a.ts", bot: true },
          {
            id: "PRRT_vanisher",
            bot: true,
            comments: [
              { authorAssociation: "NONE", body: "a finding" },
              {
                author: "example-user-2",
                authorAssociation: "OWNER",
                body: "**accepted** — fixed.",
              },
            ],
          },
        ],
      },
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        // Held in this order — `held`'s array preserves hold order, and the
        // drain processes `pending` in that same order, so PRRT_vanisher is
        // dispatched first.
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_vanisher",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/PRRT_vanisher/comment-1",
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "hold",
          "999",
          "--key",
          "PRRT_victim",
          "--kind",
          "thread",
          "--outcome",
          "accepted",
          "--comment-url",
          "https://example.invalid/held-comment-victim",
        ]);
        // Resolving PRRT_vanisher has a side effect, via the shared gh stub's
        // resolveReviewThread branch, of releasing PRRT_victim — simulating a
        // CONCURRENT driver resolving it between this drain's own batch
        // snapshot and its own dispatch reaching it.
        writeFileSync(join(fixtureDir, "vanish-key-on-resolve"), "PRRT_victim");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.report.state).toBe("FINISHED");
    // Only the real mutation — PRRT_vanisher — actually resolved via the API;
    // PRRT_victim was already gone by the time its own dispatch would have
    // run, so no second mutation call for it exists.
    expect(r.resolved.trim()).toBe("PRRT_vanisher");
    const items = r.report.items as Array<Record<string, unknown>>;
    const byKey = new Map(items.map((i) => [i.key, i]));
    expect(byKey.get("PRRT_vanisher")?.action).toBe("resolved");
    // A stale outcome (exit 4: "not in the held batch") is never recorded as
    // a refusal — recording it would have made a batch that genuinely
    // finished report PARTIAL over work that was never really outstanding.
    expect(byKey.has("PRRT_victim")).toBe(false);
    const held = JSON.parse(
      await seed(r.stateDir, r.fixtureDir, r.repo.dir, ["held", "999"]),
    ) as Array<{ key: string }>;
    expect(held).toEqual([]);
  });

  it("re-running after a completed drain dispatches nothing a second time", async () => {
    const first = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-resume-1",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "bounded, as asked.",
        );
      },
    });
    expect(first.exitCode).toBe(0);
    expect(first.posted.trim().split("\n").length).toBe(1);

    // The SAME state dir and the SAME tree, run again — the crash-recovery
    // shape. `answer-summary-finding.ts`'s none-answered path posts a NEW
    // top-level comment on every call, so a second dispatch here is a
    // duplicate standing claim on the PR that no later round undoes.
    const second = await finishRound({
      repo: first.repo,
      stateDir: first.stateDir,
      fixtureDir: first.fixtureDir,
    });
    expect(second.exitCode).toBe(0);
    expect(second.report.items).toEqual([]);
    expect(second.posted).toBe(first.posted);
  });

  it("refuses a held finding whose claim is still live, rather than answering it twice", async () => {
    // The interrupted-dispatch shape: a pass claimed the key, and died before
    // `release-held`. The claim file is what stops the successor — and it must
    // stop it BEFORE the POST, since that POST is the non-idempotent one.
    const r = await finishRound({
      seedState: async ({ stateDir, fixtureDir, cwd }) => {
        await seed(stateDir, fixtureDir, cwd, [
          "bump-round",
          "999",
          "--head",
          PREV,
        ]);
        await seed(
          stateDir,
          fixtureDir,
          cwd,
          [
            "hold",
            "999",
            "--key",
            "fp-inflight-1",
            "--kind",
            "finding",
            "--outcome",
            "accepted",
          ],
          "bounded, as asked.",
        );
        // The predecessor's own § 6 stamp, then its claim — left standing.
        const localHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
          cwd,
          env: gitCleanEnv(),
          stdout: "pipe",
        })
          .stdout.toString()
          .trim();
        await seed(stateDir, fixtureDir, cwd, [
          "stamp-held",
          "999",
          "--sha",
          localHead,
        ]);
        await seed(stateDir, fixtureDir, cwd, [
          "claim-held",
          "999",
          "--key",
          "fp-inflight-1",
          "--kind",
          "finding",
          "--pushed-sha",
          localHead,
        ]);
      },
    });
    expect(r.exitCode).toBe(6);
    expect(r.report.state).toBe("PARTIAL");
    // Nothing was posted — the whole point.
    expect(r.posted).toBe("");
    const items = r.report.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe("refused");
    expect(String(items[0]?.diagnostic)).toContain("already claimed");
  });

  // ── The untriaged-thread refusal ──────────────────────────────
  //
  // `scratchWithOrigin()`'s repo has TWO commits: a `seed.txt` write (the
  // stand-in for `origin/develop`, per that helper's own `update-ref`) and a
  // `seed.txt` REWRITE on top of it (HEAD) — so `seed.txt` is always "a file
  // this round's own commits touched" against the cumulative fallback base,
  // with zero extra repo setup per probe. `a.ts` (the suite-wide default
  // thread path used by every OTHER `finish-round.ts` probe above) is never
  // touched by that diff, which is what keeps this guard silent for all of
  // them.
  describe("the untriaged-thread refusal", () => {
    it("refuses when the held batch is empty and an unresolved thread anchors a file this round touched, with no qualifying reply", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.report.pushed).toBe(false);
      // The load-bearing half, same as the DIRTY-worktree probe above: the
      // refusal is worth nothing if it lands after the one irreversible act.
      expect(r.pushed).toBe("");
      // The diagnostic must name the offending thread — id, path, and url —
      // so an operator can act on it directly.
      expect(String(r.report.reason)).toContain("PRRT_untriaged");
      expect(String(r.report.reason)).toContain("seed.txt");
      expect(String(r.report.reason)).toContain(
        "https://example.invalid/PRRT_untriaged",
      );
    });

    // an earlier change finding (chatgpt-codex-connector): a PR that closed or
    // merged between the last round's push and this one still has offending
    // threads sitting on GitHub, but there is nothing left to triage-and-
    // retry against — `guarded-push.ts` would report PR_NOT_OPEN a few lines
    // later regardless, so this guard reports it directly instead of getting
    // there first with the misleading REFUSED_UNTRIAGED reason.
    it("reports PR_NOT_OPEN instead of REFUSED_UNTRIAGED when the PR closed before this check ran", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
          prState: "MERGED",
        },
      });
      expect(r.exitCode).toBe(5);
      expect(r.report.state).toBe("PR_NOT_OPEN");
      expect(r.pushed).toBe("");
      expect(r.report.stamped).toBe(false);
    });

    // an earlier change finding, round 4 (docomply-review): a FAILED liveness
    // read must not fall through to REFUSED_UNTRIAGED — that verdict's own
    // wording tells the operator to triage and retry, which is wrong advice
    // when liveness itself could not be confirmed. Per document-scanning-
    // gates.md rule 1, an unreadable external read is a gate failure.
    it("reports TRIAGE_CHECK_FAILED, not REFUSED_UNTRIAGED, when the liveness read itself fails", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
          liveProbeFails: true,
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.report.state).toBe("TRIAGE_CHECK_FAILED");
      expect(r.pushed).toBe("");
    });

    // an earlier change finding, round 8 (chatgpt-codex-connector): the
    // documented non-atomic window in triage-thread.ts (reply posted, but
    // the process is killed before the durable hold is recorded). A bare
    // `currentReplyOutcome`-based check would exempt this thread on the strength of
    // its valid, current reply alone, letting the round finish without ever
    // recording the promised accepted outcome anywhere.
    it("STILL refuses a thread whose latest comment is a valid CURRENT accepted reply but carries NO hold at all", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_reply_no_hold",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**accepted** — fixed, but the process died before drive-state.ts hold ran.",
                },
              ],
            },
          ],
        },
        // No hold seeded at all — the crash left nothing behind.
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_reply_no_hold");
      expect(String(r.report.reason)).toContain("complete the missing hold");
      expect(String(r.report.reason)).not.toContain(
        "post a fresh reply via reply-to-thread.ts directly",
      );
    });

    it("STILL refuses when the held batch is non-empty but the hold is on a DIFFERENT thread", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          // A DIFFERENT held item, on an unrelated key — a hold correlates
          // per-thread, so this must not excuse `PRRT_untriaged`, which was
          // never triaged and never held.
          await seed(stateDir, fixtureDir, cwd, [
            "hold",
            "999",
            "--key",
            "PRRT_other",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/held-other",
          ]);
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_untriaged");
    });

    it("does NOT refuse when the held batch carries a hold on THIS SAME thread (a prior undrained triage decision)", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_untriaged",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**accepted** — fixed.",
                },
              ],
            },
          ],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          // The hold's own key IS the offending thread's id, AND its
          // `--comment-url` matches the thread's actual latest comment — a
          // real trusted accepted reply, required since resolve-held-
          // thread.ts's an earlier change drain-time recheck re-verifies both the
          // latest comment's URL AND its outcome (round 7) — so the hold is
          // CURRENT: a triage decision already made and posted, pending
          // only the drain.
          await seed(stateDir, fixtureDir, cwd, [
            "hold",
            "999",
            "--key",
            "PRRT_untriaged",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/PRRT_untriaged/comment-1",
          ]);
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
      expect(r.pushed).not.toBe("");
    });

    // an earlier change finding, round 9 (docomply-review): a comment keeps
    // its permalink when EDITED, so a hold's url matching the latest comment
    // is not enough — the comment's own outcome must still match what was
    // held. This is the pre-push counterpart to the identical fix already
    // made in resolve-held-thread.ts's drain-time recheck (round 7); the
    // reviewer's own point was that the drain-time check runs AFTER the
    // irreversible push, so this guard must catch it BEFORE.
    it("STILL refuses when the held reply was EDITED to a DIFFERENT outcome (same URL)", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_edited",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                // Same comment-1 URL the hold below points at, but its body
                // no longer says 'accepted' — modeling a human editing the
                // comment after triage-thread.ts posted it and the hold was
                // recorded.
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**rejected** — actually not a bug, editing my earlier reply.",
                },
              ],
            },
          ],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          await seed(stateDir, fixtureDir, cwd, [
            "hold",
            "999",
            "--key",
            "PRRT_edited",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/PRRT_edited/comment-1",
          ]);
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_edited");
      // an earlier change finding, round 13 (docomply-review): the remedy TEXT
      // itself, not just the refusal, must name the actual case — an earlier
      // cut's `currentReplyNeedsOnlyAHold` read true for ANY qualifying
      // outcome (not only accepted/moot), so an edited-to-`rejected` thread
      // with an EXISTING held record was told "no hold was recorded" —
      // false, since a mismatched hold is not the same defect as no hold at
      // all and points an operator at the wrong recovery story.
      const reason = String(r.report.reason);
      expect(reason).toContain("held 'accepted' outcome");
      expect(reason).toContain("now reads as 'rejected'");
      expect(reason).toContain("EDITED in place after being held");
      expect(reason).not.toContain("no hold was recorded");
    });

    // ── an earlier change finding (chatgpt-codex-connector, round 2): a hold
    // must be revalidated against the thread's LATEST comment, not merely
    // its key ─────────────────────────────────────────────────────────────
    it("STILL refuses when the held reply is STALE — a newer comment landed on the thread after it was held", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_stale_hold",
              path: "seed.txt",
              bot: true,
              // Two comments: `threadCommentNodes` gives these deterministic
              // URLs `.../PRRT_stale_hold/comment-0` and `.../comment-1` —
              // the hold below points at the FIRST, modeling a reviewer or
              // human posting a second comment after the accepted reply was
              // held but before this round's push completed.
              comments: [
                { authorAssociation: "NONE", body: "original finding" },
                { authorAssociation: "NONE", body: "a NEW, unrelated remark" },
              ],
            },
          ],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          await seed(stateDir, fixtureDir, cwd, [
            "hold",
            "999",
            "--key",
            "PRRT_stale_hold",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/PRRT_stale_hold/comment-0",
          ]);
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_stale_hold");
      // an earlier change finding, round 7: a STALE hold gets the
      // direct-post-supersession remedy, not the plain "triage-thread.ts"
      // instruction — `triage-thread.ts` alone would just reconcile to the
      // stale hold and refuse again next round.
      expect(String(r.report.reason)).toContain("reply-to-thread.ts");
    });

    // Review finding (docomply-review, a reference-implementation pull request round 1): this guard used
    // to judge a hold's currency against the thread's LITERAL latest
    // comment only, so a CodeRabbit confirmation landing BEFORE the push —
    // the common case, since it reacts within seconds of the reply, well
    // inside a round's own triage-to-push window — refused the round on the
    // very comment resolve-held-thread.ts's an earlier change exception exists to
    // tolerate. That post-push exception was therefore unreachable in the
    // documented finish-round path whenever the race resolved before the
    // push. `isThreadHoldCurrent` now shares the identical predicate
    // (`./lib/bot-confirmation.ts`) pre-push.
    describe("bot confirmation race, pre-push", () => {
      const CONFIRMATION_MARKER =
        "<!-- coderabbit-skip-review-comment-follow-up -->";

      it("does NOT refuse when the held reply is followed ONLY by a trusted bot confirmation", async () => {
        const r = await finishRound({
          fixture: {
            threads: [
              {
                id: "PRRT_confirmed",
                path: "seed.txt",
                bot: true,
                comments: [
                  { authorAssociation: "NONE", body: "a finding" },
                  {
                    author: "example-user-2",
                    authorAssociation: "OWNER",
                    body: "**accepted** — fixed in this round.",
                  },
                  {
                    author: "coderabbitai",
                    bot: true,
                    body: `\`@example-user-2\`, confirmed.\n\n${CONFIRMATION_MARKER}\n`,
                  },
                ],
              },
            ],
          },
          seedState: async ({ stateDir, fixtureDir, cwd }) => {
            await seed(stateDir, fixtureDir, cwd, [
              "hold",
              "999",
              "--key",
              "PRRT_confirmed",
              "--kind",
              "thread",
              "--outcome",
              "accepted",
              "--comment-url",
              "https://example.invalid/PRRT_confirmed/comment-1",
            ]);
          },
        });
        expect(r.exitCode).toBe(0);
        expect(r.report.state).toBe("FINISHED");
        expect(r.pushed).not.toBe("");
      });

      // Near miss: the confirming bot's IDENTITY is right but the SHAPE is
      // not — no marker, so this is an ordinary (non-confirming) CodeRabbit
      // remark and must still be treated as a genuinely new, untriaged
      // comment.
      it("STILL refuses when the trailing CodeRabbit comment carries no confirmation marker", async () => {
        const r = await finishRound({
          fixture: {
            threads: [
              {
                id: "PRRT_no_marker",
                path: "seed.txt",
                bot: true,
                comments: [
                  { authorAssociation: "NONE", body: "a finding" },
                  {
                    author: "example-user-2",
                    authorAssociation: "OWNER",
                    body: "**accepted** — fixed in this round.",
                  },
                  {
                    author: "coderabbitai",
                    bot: true,
                    body: "I still see the same issue on line 40.",
                  },
                ],
              },
            ],
          },
          seedState: async ({ stateDir, fixtureDir, cwd }) => {
            await seed(stateDir, fixtureDir, cwd, [
              "hold",
              "999",
              "--key",
              "PRRT_no_marker",
              "--kind",
              "thread",
              "--outcome",
              "accepted",
              "--comment-url",
              "https://example.invalid/PRRT_no_marker/comment-1",
            ]);
          },
        });
        expect(r.exitCode).toBe(7);
        expect(r.report.state).toBe("REFUSED_UNTRIAGED");
        expect(r.pushed).toBe("");
      });

      // Near miss: the SHAPE is right (marker present) but the IDENTITY is
      // not — a different bot must not borrow CodeRabbit's exemption.
      it("STILL refuses when the confirmation marker comes from a bot that is not CodeRabbit", async () => {
        const r = await finishRound({
          fixture: {
            threads: [
              {
                id: "PRRT_other_bot",
                path: "seed.txt",
                bot: true,
                comments: [
                  { authorAssociation: "NONE", body: "a finding" },
                  {
                    author: "example-user-2",
                    authorAssociation: "OWNER",
                    body: "**accepted** — fixed in this round.",
                  },
                  {
                    author: "chatgpt-codex-connector",
                    bot: true,
                    body: `looks fine\n${CONFIRMATION_MARKER}`,
                  },
                ],
              },
            ],
          },
          seedState: async ({ stateDir, fixtureDir, cwd }) => {
            await seed(stateDir, fixtureDir, cwd, [
              "hold",
              "999",
              "--key",
              "PRRT_other_bot",
              "--kind",
              "thread",
              "--outcome",
              "accepted",
              "--comment-url",
              "https://example.invalid/PRRT_other_bot/comment-1",
            ]);
          },
        });
        expect(r.exitCode).toBe(7);
        expect(r.report.state).toBe("REFUSED_UNTRIAGED");
        expect(r.pushed).toBe("");
      });
    });

    // The other half: a thread with NO hold and NO qualifying reply at all
    // gets the ORDINARY remedy — running `triage-thread.ts` there genuinely
    // posts a fresh reply, so there is no loop to warn about.
    it("names the ORDINARY remedy (not the supersession one) for a thread with no hold and no reply at all", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(String(r.report.reason)).toContain("PRRT_untriaged");
      expect(String(r.report.reason)).toContain(
        "triage it via triage-thread.ts",
      );
      expect(String(r.report.reason)).not.toContain("reply-to-thread.ts");
    });

    // an earlier change finding, round 8 (docomply-review): a TRUNCATED thread
    // with a hold on its own key would otherwise read as "stale" and get the
    // reply-to-thread.ts supersession remedy — but triage-thread.ts refuses a
    // truncated thread UNCONDITIONALLY, so that remedy is just as broken as
    // plain triage-thread.ts for this case. The only remedy that works is
    // drive-state.ts park.
    it("names the PARK remedy (not the supersession one) for a TRUNCATED thread with a hold on its own key", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_trunc_held", path: "seed.txt", bot: true }],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          await seed(stateDir, fixtureDir, cwd, [
            "hold",
            "999",
            "--key",
            "PRRT_trunc_held",
            "--kind",
            "thread",
            "--outcome",
            "accepted",
            "--comment-url",
            "https://example.invalid/PRRT_trunc_held",
          ]);
          const threadsPath = join(fixtureDir, "threads.json");
          const parsed = JSON.parse(readFileSync(threadsPath, "utf8"));
          parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
          writeFileSync(threadsPath, JSON.stringify(parsed));
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(String(r.report.reason)).toContain("PRRT_trunc_held");
      expect(String(r.report.reason)).toContain("drive-state.ts park");
      expect(String(r.report.reason)).not.toContain("reply-to-thread.ts");
    });

    it("does NOT refuse when the unresolved thread anchors a file this round did not touch", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            { id: "PRRT_elsewhere", path: "some/other/file.ts", bot: true },
          ],
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });

    it("does NOT refuse a merit reply carrying the ACTUAL LEAVE_OPEN_MARKER on a HUMAN-started thread (the --leave-open case)", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              // Human-started (round 22 review finding, P1): the leave-open
              // exemption is documented as human-thread-only, so this
              // fixture's own opening comment must not be bot-authored.
              id: "PRRT_left_open",
              path: "seed.txt",
              bot: false,
              comments: [
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "a human-opened finding",
                },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: `**deferred** — tracked separately; leaving this thread open on purpose.\n\n${LEAVE_OPEN_MARKER}`,
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });

    // an earlier change finding, round 14 (P1, chatgpt-codex-connector): the
    // earlier fix for the accepted/moot crash-before-HOLD window (round 8)
    // did not cover the separate merit-outcome crash-before-RESOLVE window.
    // A rejected/wont-fix/deferred reply with no --leave-open marker sitting
    // on a thread this script only ever sees as UNRESOLVED cannot be a
    // legitimately-finished dispatch — a finished one would have called
    // resolve-thread.ts and the thread would not be in this list at all.
    it("STILL refuses an unmarked merit reply sitting on a thread that was never resolved", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_unresolved_merit",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**wont-fix** — pre-existing, not part of this diff.",
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      const reason = String(r.report.reason);
      expect(reason).toContain("PRRT_unresolved_merit");
      expect(reason).toContain("the thread was never resolved");
      expect(reason).not.toContain("no hold was recorded");
    });

    // an earlier change finding, round 22 (P1, chatgpt-codex-connector): the
    // leave-open marker is human-thread-only by design. A BOT-started thread
    // wrongly marked leave-open (an operator mistake `triage-thread.ts`
    // itself does not prevent in code) must still refuse — and its remedy
    // must not be "re-run triage-thread.ts", since that would keep honoring
    // the same misapplied marker on reconciliation regardless of flags.
    it("STILL refuses a BOT-started thread wrongly marked leave-open, naming resolve-thread.ts directly", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_bot_left_open",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a bot finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: `**wont-fix** — pre-existing, not part of this diff.\n\n${LEAVE_OPEN_MARKER}`,
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      const reason = String(r.report.reason);
      expect(reason).toContain("PRRT_bot_left_open");
      expect(reason).toContain("not confirmed human-started");
      expect(reason).toContain("resolve-thread.ts PRRT_bot_left_open directly");
    });

    // an earlier change finding, round 25 (high, chatgpt-codex-connector): a
    // trusted author can EDIT an existing marked wont-fix/deferred reply's
    // outcome word to `accepted` in place, leaving the LEAVE_OPEN_MARKER
    // trailing line untouched — GitHub preserves it, and no posting-time
    // validation ever re-runs against an edit. `accepted` is ALWAYS
    // fix-dependent (needs a hold); the marker must never exempt it.
    it("STILL refuses a HUMAN-started thread whose marked reply was edited to accepted", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_edited_to_accepted",
              path: "seed.txt",
              bot: false,
              comments: [
                { authorAssociation: "OWNER", body: "a human-opened finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  // Same URL/position a wont-fix+marker reply would have had
                  // before being edited in place — the marker survives the
                  // edit, only the outcome word changed.
                  body: `**accepted** — actually let's just fix it.\n\n${LEAVE_OPEN_MARKER}`,
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      const reason = String(r.report.reason);
      expect(reason).toContain("PRRT_edited_to_accepted");
      expect(reason).toContain("no hold was recorded");
    });

    // an earlier change finding (chatgpt-codex-connector): the offending check
    // used to scan backward and accept the FIRST trusted qualifying reply it
    // found, so an earlier round's accepted reply kept exempting the thread
    // even after a fresh, unaddressed comment landed on it afterward — the
    // short-circuiting `&&` in the offending filter meant `isThreadHoldCurrent`
    // (which DOES check staleness) was never even reached for this thread.
    it("STILL refuses when a qualifying reply exists but is NOT the latest comment — fresh feedback landed after it", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_superseded_reply",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**accepted** — fixed in abc1234.",
                },
                {
                  author: "example-review",
                  authorAssociation: "NONE",
                  body: "Actually the fix missed an edge case — see below.",
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_superseded_reply");
    });

    it("does NOT refuse when there are no unresolved threads at all", async () => {
      const r = await finishRound({ fixture: { threads: [] } });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });

    it("refuses with TRIAGE_CHECK_FAILED (fail-closed) when list-unresolved-threads.ts itself fails", async () => {
      const r = await finishRound({
        fixture: {
          // Fails the FIRST `graphql` call of the whole invocation — which,
          // ahead of the push, is this guard's OWN `list-unresolved-
          // threads.ts` spawn, since drive-status.ts's reconciliation sweep
          // (the usual first caller) has not run yet at this point in the
          // sequence.
          sweepThreadListingFailsOnce: true,
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.report.state).toBe("TRIAGE_CHECK_FAILED");
      expect(r.pushed).toBe("");
    });

    it("fails closed on a TRUNCATED thread with no visible qualifying reply — never silently excludes it", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_truncated", path: "seed.txt", bot: true }],
        },
        seedState: async ({ fixtureDir }) => {
          // `writeFixture` always serves `hasNextPage: false` for a fixture
          // thread's comments — no `Fixture['threads']` field exposes
          // `commentsTruncated`, so the GraphQL page shape is fabricated
          // directly, exactly as an earlier change's own spec sanctions for this case.
          const threadsPath = join(fixtureDir, "threads.json");
          const parsed = JSON.parse(readFileSync(threadsPath, "utf8"));
          parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
          writeFileSync(threadsPath, JSON.stringify(parsed));
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(String(r.report.reason)).toContain("PRRT_truncated");
    });

    // an earlier change finding, round 5 (docomply-review): a `commentsTruncated`
    // thread's visible list is only the first 100 comments, so its last
    // VISIBLE comment is not necessarily the thread's real latest — hidden
    // feedback past the cap could supersede a qualifying reply that happens
    // to sit in the visible window. `triage-thread.ts` refuses a truncated
    // thread outright for the identical reason; this guard must agree.
    it("STILL refuses a TRUNCATED thread even when its last VISIBLE comment qualifies", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_truncated_qualifying",
              path: "seed.txt",
              bot: true,
              comments: [
                { authorAssociation: "NONE", body: "a finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**accepted** — fixed in abc1234.",
                },
              ],
            },
          ],
        },
        seedState: async ({ fixtureDir }) => {
          const threadsPath = join(fixtureDir, "threads.json");
          const parsed = JSON.parse(readFileSync(threadsPath, "utf8"));
          parsed.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
          writeFileSync(threadsPath, JSON.stringify(parsed));
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(String(r.report.reason)).toContain("PRRT_truncated_qualifying");
    });

    // Branch coverage for `roundBase()`'s NEW half (round-plan.ts's own
    // Testbox-decay tests already cover the shared validity chain — empty /
    // unknown-commit / non-ancestor / valid verified SHA — through
    // `roundBase` itself, since round-plan.ts now calls it too; see this
    // file's `describe('round-plan.ts', …)`). What only a `finish-round.ts`
    // probe can exercise is `roundBase` actually being CONSUMED as a base to
    // diff against, not merely validated:
    it("uses a valid recorded verified SHA as the round base — not the cumulative fallback — when one is recorded", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
        seedState: async ({ stateDir, cwd }) => {
          const localHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
            cwd,
            env: gitCleanEnv(),
            stdout: "pipe",
          })
            .stdout.toString()
            .trim();
          // Verified AT HEAD itself — nothing has changed since it, so
          // `seed.txt` is NOT among this round's own touched files under the
          // valid-SHA branch, even though the identical thread trips the
          // guard under the cumulative fallback (the very first probe in
          // this block, which records no verified SHA at all). A pass here
          // is only possible if `roundBase` actually resolved and used this
          // SHA rather than falling back to `origin/develop`.
          writeVerifiedSha(stateDir, localHead);
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });

    // ── an earlier change finding 1: a PARKED thread must not wedge a drive ──
    //
    // `drive-state.ts park` writes to `state.parked`, a list DISJOINT from
    // `state.held` — so a parked thread is, by construction, still unresolved
    // on GitHub, carries no qualifying reply (that is usually WHY it was
    // parked), and is absent from the held batch. Left unhandled, this guard
    // would refuse EVERY round from here on with no available remedy: its own
    // printed remedy ("triage it via triage-thread.ts") is refused BY
    // `triage-thread.ts` for exactly the case SKILL.md § 4 says to park
    // instead (a `commentsTruncated` thread).
    it("does NOT refuse when the untriaged thread is PARKED — a parked thread is a recorded human decision, not evidence of skipped triage", async () => {
      const r = await finishRound({
        fixture: {
          // `PRRT_live` on `a.ts` (untouched by this round's own commits, so
          // this guard was never going to fire for it either way) rides
          // along so the PR still carries a genuinely-unresolved, unparked
          // thread of its own — otherwise the ONLY unresolved thread on the
          // PR is the fully parked one, and `drive-status.ts`'s OWN
          // evaluation (a separate concern from this guard, but reached
          // because a non-refusing round still pushes and waits for head
          // sync) reads "the one open thread is parked" as HITL_PARKED and
          // retries against this fixture's one-shot `gh` stub, which cannot
          // answer a retry and times out the probe on an unrelated axis. This
          // guard's own verdict is unaffected either way; a live sibling
          // thread just keeps the round's OVERALL shape ordinary so the probe
          // stays about `checkUntriagedThreads` alone.
          threads: [
            { id: "PRRT_live", path: "a.ts", bot: true },
            { id: "PRRT_parked", path: "seed.txt", bot: true },
          ],
        },
        seedState: async ({ stateDir, fixtureDir, cwd }) => {
          await seed(stateDir, fixtureDir, cwd, [
            "park",
            "999",
            "--key",
            "PRRT_parked",
            "--kind",
            "thread",
            "--reason",
            "commentsTruncated — triage-thread.ts itself refuses this one; see SKILL.md § 4",
          ]);
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
      expect(r.pushed).not.toBe("");
    });

    // Fail-closed on the verified-SHA read itself (an earlier change finding,
    // docomply-review round 2). Before that fix, `readVerifiedSha` (inside
    // `roundBase`, the FIRST drive-state.ts read this guard makes) swallowed
    // its own subprocess failure into `''` — indistinguishable from "no round
    // has verified yet" — and silently fell back to the cumulative
    // merge-base, so a fully corrupt state file sailed straight past
    // `roundBase` and was only ever caught later, at the `parked-keys` read.
    // Now the SAME corruption is caught here first, before either of those
    // later reads is even attempted.
    it("refuses with TRIAGE_CHECK_FAILED (fail-closed) when the verified-SHA read itself fails", async () => {
      const r = await finishRound({
        fixture: {
          threads: [{ id: "PRRT_untriaged", path: "seed.txt", bot: true }],
        },
        seedState: async ({ stateDir }) => {
          // Malformed from the start — no well-formed write precedes this
          // one. `drive-pr-999.json` is the exact per-PR state file every
          // `drive-state.ts` subcommand against PR 999 reads.
          writeFileSync(
            join(stateDir, "drive-pr-999.json"),
            '{"pr": 999, "rounds"',
          );
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.report.state).toBe("TRIAGE_CHECK_FAILED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain(
        "cannot resolve a base to diff",
      );
      expect(String(r.report.reason)).toContain("drive-state.ts verified");
    });

    // ── an earlier change finding 2: base-sync merges must not inflate "this
    // round's own commits" ──────────────────────────────────────────────────
    //
    // `changedFilesSince` (what this guard used before the fix) diffs the
    // verified SHA against the working tree directly, so it silently included
    // every file a base-sync merge (SKILL.md § 5 runs `base-sync.ts` every
    // round) brought in from `origin/develop` — not just what this round's
    // own commits touched. `makeBaseSyncMergeRepo` builds exactly that shape:
    // a merge landing between the verified SHA and HEAD, alongside a real
    // single-parent round commit touching a DIFFERENT file.
    it("excludes a file a base-sync merge brought in from develop — only this round's own non-merge commit's file counts as touched", async () => {
      const repo = makeBaseSyncMergeRepo(
        `finish-round-basesync-${++finishSeq}`,
      );
      const r = await finishRound({
        repo: { dir: repo.dir, head: repo.head },
        fixture: {
          threads: [
            { id: "PRRT_dev_file", path: "develop-only.txt", bot: true },
          ],
        },
        seedState: async ({ stateDir }) => {
          writeVerifiedSha(stateDir, repo.verifiedSha);
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
      expect(r.pushed).not.toBe("");
    });

    // The negative control: the round's OWN file, on the OTHER side of the
    // same merge, must still trip the guard — proving the exclusion above is
    // about the MERGE, not a blanket "nothing after the verified SHA counts".
    it("still catches an untriaged thread anchored to the round's own file, even with a base-sync merge in between", async () => {
      const repo = makeBaseSyncMergeRepo(
        `finish-round-basesync-own-${++finishSeq}`,
      );
      const r = await finishRound({
        repo: { dir: repo.dir, head: repo.head },
        fixture: {
          threads: [
            { id: "PRRT_round_file", path: "round-only.txt", bot: true },
          ],
        },
        seedState: async ({ stateDir }) => {
          writeVerifiedSha(stateDir, repo.verifiedSha);
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("round-only.txt");
      expect(String(r.report.reason)).toContain("PRRT_round_file");
    });

    // ── an earlier change finding (chatgpt-codex-connector): a `git mv` in
    // this round's own commit must not hide the thread anchored to the
    // pre-rename path ──────────────────────────────────────────────────────
    it("catches an untriaged thread anchored to a file this round's own commit RENAMED away from", async () => {
      const repo = makeRenameRepo(`finish-round-rename-${++finishSeq}`);
      const r = await finishRound({
        repo: { dir: repo.dir, head: repo.head },
        fixture: {
          threads: [{ id: "PRRT_pre_rename", path: "old-name.txt", bot: true }],
        },
        seedState: async ({ stateDir }) => {
          writeVerifiedSha(stateDir, repo.verifiedSha);
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("old-name.txt");
      expect(String(r.report.reason)).toContain("PRRT_pre_rename");
    });

    // an earlier change finding, round 14 (chatgpt-codex-connector): a
    // thread's own OPENING comment is the finding, not a reply to it, even
    // when a trusted author's opening text happens to parse as the outcome
    // grammar. Before the fix, `currentReplyOutcome` read the single
    // comment as "the latest comment" and exempted the thread on the
    // strength of it, even though nobody had ever REPLIED.
    it("STILL refuses a thread whose only comment is a trusted OPENING comment that parses as an outcome", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              id: "PRRT_opening_only",
              path: "seed.txt",
              bot: false,
              comments: [
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  body: "**wont-fix** — pre-existing, not part of this diff.",
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_opening_only");
      // The generic never-triaged remedy, not the crash-before-hold one —
      // there is no hold and no ACTUAL reply, so nothing was ever dispatched.
      expect(String(r.report.reason)).toContain(
        "triage it via triage-thread.ts",
      );
    });

    // A genuine SECOND comment (an actual reply) after the opening one must
    // still be recognized — the fix narrows "which comment counts", not
    // "whether any reply can ever count".
    it("exempts a thread once a SECOND comment (an actual reply) carries the outcome", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            {
              // Human-started (round 22 review finding, P1): the marker
              // this test relies on to sidestep the separate merit-resolve
              // requirement is human-thread-only, so this fixture's own
              // opening comment must not be bot-authored either.
              id: "PRRT_real_reply",
              path: "seed.txt",
              bot: false,
              comments: [
                { authorAssociation: "OWNER", body: "a human-opened finding" },
                {
                  author: "example-user-2",
                  authorAssociation: "OWNER",
                  // Marked leave-open — this test is only about which
                  // COMMENT counts as the reply, not about the separate
                  // merit-outcome resolve requirement (round 14 finding,
                  // covered by its own dedicated test above).
                  body: `**wont-fix** — pre-existing, not part of this diff.\n\n${LEAVE_OPEN_MARKER}`,
                },
              ],
            },
          ],
        },
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });

    // an earlier change finding, round 14 (chatgpt-codex-connector): a
    // `--bots-only` round must not be refused by an untouched HUMAN thread —
    // continuous bots-only mode is explicitly scoped to never act on human
    // threads (SKILL.md's own "the identical mistake" caveat is about the
    // default, non-bots-only case).
    it("a human-started thread with no reply STILL refuses by default (no --bots-only)", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            { id: "PRRT_human_untouched", path: "seed.txt", bot: false },
          ],
        },
      });
      expect(r.exitCode).toBe(7);
      expect(r.report.state).toBe("REFUSED_UNTRIAGED");
      expect(r.pushed).toBe("");
      expect(String(r.report.reason)).toContain("PRRT_human_untouched");
    });

    it("the identical human-started thread does NOT refuse a round finished with --bots-only", async () => {
      const r = await finishRound({
        fixture: {
          threads: [
            { id: "PRRT_human_untouched2", path: "seed.txt", bot: false },
          ],
        },
        args: ["--bots-only"],
      });
      expect(r.exitCode).toBe(0);
      expect(r.report.state).toBe("FINISHED");
    });
  });
});

describe("list-unresolved-threads.ts", () => {
  // The crash-recovery guard in drive-pr/SKILL.md § 3 trusts a thread comment
  // opening with a bold outcome token as proof an earlier pass already
  // triaged it — but ONLY when that comment's `authorAssociation` is
  // OWNER/MEMBER/COLLABORATOR (mirroring summary-findings.ts's
  // TRUSTED_ASSOCIATIONS gate on the same class of world-writable marker). The
  // guard itself is agent-followed prose, not code, so the only thing this
  // repo's test suite CAN pin is the mechanism the prose depends on: that the
  // field the agent must check actually reaches the NDJSON output this
  // script emits, sourced from the real GraphQL response shape.
  it("carries each comment's authorAssociation through to the NDJSON output", async () => {
    const { dir } = writeFixture({
      threads: [
        {
          id: "PRRT_spoofed",
          path: "a.ts",
          bot: false,
          authorAssociation: "NONE",
        },
        {
          id: "PRRT_trusted",
          path: "b.ts",
          bot: false,
          authorAssociation: "OWNER",
        },
      ],
    });
    const proc = Bun.spawn(
      [
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            threadId: string;
            comments: Array<{ authorAssociation: string }>;
          },
      );
    const spoofed = lines.find((l) => l.threadId === "PRRT_spoofed");
    const trusted = lines.find((l) => l.threadId === "PRRT_trusted");
    expect(spoofed?.comments[0]?.authorAssociation).toBe("NONE");
    expect(trusted?.comments[0]?.authorAssociation).toBe("OWNER");
  });

  // an earlier change finding, round 24 (high, chatgpt-codex-connector):
  // `confirmedHumanStarted` must fail CLOSED (`false`) on a malformed or
  // absent opening-comment author shape — `ThreadCommentNode.author` and its
  // `__typename` are both optional in the real GraphQL response type, so
  // this is a modeled possibility, not a hypothetical. The `writeFixture`
  // thread DSL always constructs a definite `Bot`/`User` `__typename`
  // (via its `bot` boolean), so it cannot express this malformed shape —
  // this test writes `threads.json` directly to exercise the real GraphQL
  // response types the fixture DSL can't reach.
  it("confirmedHumanStarted fails closed on a malformed/absent opening-comment author", async () => {
    const { dir } = writeFixture({ threads: [] });
    writeFileSync(
      join(dir, "threads.json"),
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRRT_no_author",
                    isResolved: false,
                    isOutdated: false,
                    path: "a.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      // No `author` key at all on the opening comment — the
                      // exact optional-field shape `ThreadCommentNode` models.
                      nodes: [
                        { authorAssociation: "OWNER", body: "a finding" },
                      ],
                    },
                  },
                  {
                    id: "PRRT_null_author",
                    isResolved: false,
                    isOutdated: false,
                    path: "b.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          author: null,
                          authorAssociation: "OWNER",
                          body: "a finding",
                        },
                      ],
                    },
                  },
                  {
                    id: "PRRT_no_typename",
                    isResolved: false,
                    isOutdated: false,
                    path: "c.ts",
                    line: 1,
                    comments: {
                      pageInfo: { hasNextPage: false },
                      nodes: [
                        {
                          author: { login: "someone" },
                          authorAssociation: "OWNER",
                          body: "a finding",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const proc = Bun.spawn(
      [
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as { threadId: string; confirmedHumanStarted: unknown },
      );
    for (const id of [
      "PRRT_no_author",
      "PRRT_null_author",
      "PRRT_no_typename",
    ]) {
      const line = lines.find((l) => l.threadId === id);
      expect(line?.confirmedHumanStarted).toBe(false);
    }
  });

  // The gh stub answers every `graphql` call with the same fixture file
  // regardless of the query text, so the first test alone would still pass
  // if the GraphQL query stopped requesting `authorAssociation` (the field
  // would just be `null` against the real API). Asserting against the
  // SCRIPT'S SOURCE FILE would be satisfied by an unrelated comment or string
  // containing this shape anywhere in the file, so instead run the script for
  // real and pin the query text the gh stub actually received on this
  // invocation (captured to `last-graphql-query.txt` in `beforeAll`).
  it("requests authorAssociation in the GraphQL comments selection", async () => {
    const { dir } = writeFixture({ threads: [] });
    const proc = Bun.spawn(
      [
        join(
          SCRIPTS,
          "..",
          "..",
          "resolve-review-comments",
          "scripts",
          "list-unresolved-threads.ts",
        ),
        "999",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const submittedQuery = readFileSync(
      join(dir, "last-graphql-query.txt"),
      "utf8",
    );
    expect(submittedQuery).toMatch(
      /nodes\{\s*url\s+author\{[^}]*\}\s*authorAssociation\s+body\s*\}/,
    );
  });
});

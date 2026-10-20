/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readdirSync, writeFileSync } from "node:fs";

import { join, delimiter } from "node:path";

import { stateDirIdentityToken } from "../scripts/lib/state/lease";

import {
  SCRIPTS,
  PREV,
  type Fixture,
  STICKY_ROUND,
  binDir,
  scratchClean,
  scratchOther,
  gitCleanEnv,
  makeScratchRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

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
      scriptArgv(join(SCRIPTS, "answer-summary-finding.ts"), ...args, "999"),
      {
        cwd: opts.cwd,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          // The script consults the session lease before it posts, so
          // every probe needs a state dir of its own. Left
          // unset, the fence would read the REAL clone's drive state and a
          // live drive in this worktree would refuse the whole describe block.
          DRIVE_PR_STATE_DIR: stateDir,
          // And the override REQUIRES its identity beside it:
          // `$DRIVE_PR_STATE_DIR` without `$DRIVE_PR_STATE_DIR_IDENTITY` is a
          // superseded driver and refuses. This is what a current `drive.ts`
          // would have exported for this fixture, so the probe exercises the
          // ordinary path rather than the refusal.
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

  it("rejects a reason that already opens with an outcome token", async () => {
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
  //. Each variant is asserted separately:
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
    it(`rejects a reason whose outcome token is preceded by ${label}`, async () => {
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
  // impossible. It required `--pushed-sha` to be a strict
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
    // could not converge without manufacturing an unrelated commit.
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
    // is nothing new to commit.
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
              scriptArgv(
                join(SCRIPTS, "drive-state.ts"),
                "phase",
                "999",
                "--set",
                "triage",
              ),
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

/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  PREV,
  binDir,
  gitCleanEnv,
  makeUnresolvedMergeRepo,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();
describe("finish-round.ts", () => {
  const findingsFinishRoundFixtures = createFindingsFinishRoundFixtures();
  const {
    finishSequence,
    recordingGit,
    scratchWithOrigin,
    stateEnv,
    seed,
    finishRound,
  } = findingsFinishRoundFixtures;

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

  it("the fake git push rejects the remote and refspec swapped", () => {
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
    const repo = makeUnresolvedMergeRepo(
      `finish-round-merge-${++finishSequence.value}`,
    );
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
      scriptArgv(join(SCRIPTS, "drive-status.ts"), "999", "--json", "--once"),
      {
        cwd: cwdSeen,
        env: {
          ...stateEnv(stateDirSeen, fixtureSeen),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
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
          // trusted accepted reply — required because resolve-held-thread.ts's
          // drain-time recheck re-verifies both the latest comment's URL AND
          // its outcome, not merely its URL.
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

  it("aborts as BATCH_UNREADABLE, not a per-item refusal, when release-held cannot read state after the answer already posted", async () => {
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
});

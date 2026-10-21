import { scopedStateDir } from "./scoped-state-dir.ts";
/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join, delimiter } from "node:path";

import {
  SCRIPTS,
  PREV,
  type Fixture,
  binDir,
  scratchClean,
  gitCleanEnv,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";

import { createFindingsResolveHeldFixtures } from "./drive-pr-findings-resolve-held-fixtures.ts";

useDrivePrSuite();
describe("resolve-held-thread.ts", () => {
  const findingsResolveHeldFixtures = createFindingsResolveHeldFixtures();
  const {
    seed,
    readState,
    resolveHeld,
    acceptedReplyThread,
    ACCEPTED_COMMENT_URL,
  } = findingsResolveHeldFixtures;

  it("resolves a thread held and pushed within the SAME round", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-happy-")),
      scratchClean.dir,
    );
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
    // lands the fix — the second half of what a claim requires.
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

  // The comment-staleness recheck. `finish-round.ts`'s own pre-push guard
  // already confirmed the hold's `commentUrl` matched the thread's latest
  // comment — but that runs BEFORE `guarded-push.ts`, which SKILL.md documents
  // as potentially taking tens of minutes. A reply landing on the thread during
  // that window must not be silently resolved by the drain that follows.
  it("restores (never resolves) when a NEW comment landed on the thread after it was held", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-stale2-")),
      scratchClean.dir,
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

  // A GitHub comment keeps its permalink when EDITED, so the url-only check
  // above cannot catch a trusted reply whose outcome token was removed or
  // changed after it was held. The url still matches; only the body no longer
  // does.
  it("restores (never resolves) when the held reply was EDITED after being held (same URL, different outcome)", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-edited-")),
      scratchClean.dir,
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
  // lost that race on every drain (measured: 4–5 cycles). The narrow
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
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpdir(), `resolve-held-bot-${label}-`)),
        scratchClean.dir,
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

  // `dropReheldKey()`'s own cleanup — for a key that has REAPPEARED in `held`
  // since `claim-held` removed the original entry (a concurrent driver's own
  // reconciliation re-holding it) — used to delete unconditionally on the
  // strength of the `isResolved: true` read `staleCheck` took EARLIER. That
  // assumes resolution is monotonic, which GitHub does not guarantee: any
  // writer can UNRESOLVE a thread, so the reappeared entry can be a legitimate,
  // FRESH re-triage made after the thread was reopened, not a stale leftover.
  // The fix re-verifies `isResolved` immediately before the delete rather than
  // trusting the earlier read.
  describe("dropReheldKey's re-verification before deleting a REAPPEARED hold", () => {
    it("does NOT delete a re-appeared hold when the live re-check finds the thread REOPENED", async () => {
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpdir(), "resolve-held-reopen-")),
        scratchClean.dir,
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
      const stateDir = scopedStateDir(
        mkdtempSync(join(tmpdir(), "resolve-held-reappear-")),
        scratchClean.dir,
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-trunc-")),
      scratchClean.dir,
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
      scriptArgv(
        join(SCRIPTS, "resolve-held-thread.ts"),
        "--key",
        "PRRT_a",
        "--pushed-sha",
        scratchClean.head,
        "999",
      ),
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
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

  // A comment node with no readable `url` must refuse outright, never be
  // silently dropped from the population. Filtering it out would shift "the latest comment" to an
  // OLDER node, which can coincidentally still match the hold's own
  // `commentUrl` — resolving a thread whose real latest comment could not
  // actually be confirmed.
  it("restores (never resolves) when the latest comment node has no readable URL", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-badurl-")),
      scratchClean.dir,
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
      scriptArgv(
        join(SCRIPTS, "resolve-held-thread.ts"),
        "--key",
        "PRRT_a",
        "--pushed-sha",
        scratchClean.head,
        "999",
      ),
      {
        cwd: scratchClean.dir,
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-rehold-")),
      scratchClean.dir,
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

  // The bypass: an unrelated push lands WITHOUT ever
  // going through a counting drive-status.ts gate, so `.rounds` never
  // advances — a round-only comparison would read this as a match, even
  // though this SHA never went through the validate → push → set-verified
  // sequence the hold's reply was actually waiting on.
  it("refuses a push that never went through set-verified, even though the round never advanced", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-unverified-")),
      scratchClean.dir,
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
});

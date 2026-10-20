/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { LEAVE_OPEN_MARKER } from "../scripts/lib/outcome.ts";

import {
  writeVerifiedSha,
  gitCleanEnv,
  makeBaseSyncMergeRepo,
  makeRenameRepo,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();
describe("finish-round.ts", () => {
  const findingsFinishRoundFixtures = createFindingsFinishRoundFixtures();
  const { finishSequence, seed, finishRound } = findingsFinishRoundFixtures;
  describe("the untriaged-thread refusal", () => {
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
          // directly.
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

    // A `commentsTruncated`
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

    // ── A PARKED thread must not wedge a drive ──
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

    // Fail-closed on the verified-SHA read itself. In an earlier version,
    // `readVerifiedSha` (inside
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

    // ── Base-sync merges must not inflate "this round's own commits" ───────
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
        `finish-round-basesync-${++finishSequence.value}`,
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
        `finish-round-basesync-own-${++finishSequence.value}`,
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

    // ── A `git mv` in this round's own commit must not hide the thread
    // anchored to the pre-rename path ────────────────────────────────────
    it("catches an untriaged thread anchored to a file this round's own commit RENAMED away from", async () => {
      const repo = makeRenameRepo(
        `finish-round-rename-${++finishSequence.value}`,
      );
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

    // A
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
              // Human-started: the marker
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
                  // merit-outcome resolve requirement (covered by its own
                  // dedicated test above).
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

    // A
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

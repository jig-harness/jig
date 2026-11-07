/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";

import { LEAVE_OPEN_MARKER } from "../scripts/lib/outcome.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

import { useDrivePrSuite } from "./drive-pr-harness.ts";
import { createFindingsFinishRoundFixtures } from "./drive-pr-findings-finish-round-fixtures.ts";

useDrivePrSuite();
describe("finish-round.ts", () => {
  const findingsFinishRoundFixtures = createFindingsFinishRoundFixtures();
  const { seed, finishRound } = findingsFinishRoundFixtures;
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

    // A PR that closed or merged between the last round's push and this one
    // still has offending threads sitting on GitHub, but there is nothing left
    // to triage-and-retry against — `guarded-push.ts` would report PR_NOT_OPEN
    // a few lines later regardless, so this guard reports it directly instead
    // of getting there first with the misleading REFUSED_UNTRIAGED reason.
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

    // A FAILED liveness
    // read must not fall through to REFUSED_UNTRIAGED — that verdict's own
    // wording tells the operator to triage and retry, which is wrong advice
    // when liveness itself could not be confirmed. An unreadable external
    // read is a gate failure, and the gate fails closed.
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

    // The
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
          // real trusted accepted reply, required because resolve-held-
          // thread.ts's drain-time recheck re-verifies both the latest
          // comment's URL AND its outcome — so the hold is
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

    // A comment keeps
    // its permalink when EDITED, so a hold's url matching the latest comment
    // is not enough — the comment's own outcome must still match what was
    // held. This is the pre-push counterpart to the identical fix already
    // made in resolve-held-thread.ts's drain-time recheck; the point is that
    // the drain-time check runs AFTER the
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
      // The remedy TEXT
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

    // ── A hold must be revalidated against the thread's LATEST comment, not
    // merely its key ─────────────────────────────────────────────────────
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
      // A STALE hold gets the
      // direct-post-supersession remedy, not the plain "triage-thread.ts"
      // instruction — `triage-thread.ts` alone would just reconcile to the
      // stale hold and refuse again next round.
      expect(String(r.report.reason)).toContain("reply-to-thread.ts");
    });

    // A CodeRabbit confirmation usually lands BEFORE the push — it reacts
    // within seconds of the reply, well inside a round's own triage-to-push
    // window. Judging a hold's currency against the thread's LITERAL latest
    // comment only would refuse the round on the very comment
    // resolve-held-thread.ts's post-push bot-confirmation exception exists to
    // tolerate, so `isThreadHoldCurrent` shares that identical predicate
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

      // A listed bot's chat acknowledgement is transparent too; one that
      // embeds a finding is a newer comment the guard refuses over.
      for (const [label, body, finished] of [
        [
          "does NOT refuse when the held reply is followed ONLY by a listed bot's chat acknowledgement",
          "<!-- coderabbit-ai-generated:v1 -->\nThanks: the fix is noted, and nothing further is requested.\n",
          true,
        ],
        [
          "STILL refuses when the chat acknowledgement embeds a finding",
          "<!-- coderabbit-ai-generated:v1 -->\nThanks. One more:\n\n_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_\n\nStill wrong.\n",
          false,
        ],
      ] as const)
        it(label, async () => {
          const r = await finishRound({
            fixture: {
              threads: [
                {
                  id: "PRRT_acknowledged",
                  path: "seed.txt",
                  bot: true,
                  comments: [
                    { authorAssociation: "NONE", body: "a finding" },
                    {
                      author: "example-user-2",
                      authorAssociation: "OWNER",
                      body: "**accepted** — fixed in this round.",
                    },
                    { author: "coderabbitai", bot: true, body },
                  ],
                },
              ],
            },
            seedState: async ({ stateDir, fixtureDir, cwd }) => {
              await seed(stateDir, fixtureDir, cwd, [
                "hold",
                "999",
                "--key",
                "PRRT_acknowledged",
                "--kind",
                "thread",
                "--outcome",
                "accepted",
                "--comment-url",
                "https://example.invalid/PRRT_acknowledged/comment-1",
              ]);
            },
          });
          if (finished) {
            expectSpawnExit(r, 0);
            expect(r.report.state).toBe("FINISHED");
          } else {
            expectSpawnExit(r, 7);
            expect(r.pushed).toBe("");
          }
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

    // A TRUNCATED thread
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
              // Human-started: the leave-open
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

    // The fix for the accepted/moot crash-before-HOLD window does not cover
    // the separate merit-outcome crash-before-RESOLVE window.
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

    // The
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

    // A
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

    // A qualifying reply exempts a thread only while it is still current: an
    // earlier round's accepted reply must not keep exempting the thread once a
    // fresh, unaddressed comment lands on it afterward, so the offending filter
    // has to reach `isThreadHoldCurrent` (which DOES check staleness) rather
    // than short-circuit on the FIRST trusted qualifying reply a backward scan
    // finds.
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
  });
});

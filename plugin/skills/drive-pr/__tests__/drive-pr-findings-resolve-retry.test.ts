import { scopedStateDir, linkedScratchTree } from "./scoped-state-dir.ts";
/**
 * drive-pr suite: answer-summary-finding.ts, assert-post-allowed.ts, resolve-held-thread.ts, finish-round.ts and list-unresolved-threads.ts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { describe, expect, it } from "bun:test";

import { mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";

import { join } from "node:path";

import {
  PREV,
  scratchClean,
  scratchSibling,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { createFindingsResolveHeldFixtures } from "./drive-pr-findings-resolve-held-fixtures.ts";

useDrivePrSuite();
describe("resolve-held-thread.ts", () => {
  const findingsResolveHeldFixtures = createFindingsResolveHeldFixtures();
  const {
    seed,
    seedDone,
    readState,
    resolveHeld,
    acceptedReplyThread,
    ACCEPTED_COMMENT_URL,
  } = findingsResolveHeldFixtures;

  it("restores a claimed item to `held` when the resolve mutation itself fails", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-mutation-fails-")),
      scratchClean.dir,
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
    const seedTree = scratchSibling.dir;
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
    // and downgrades a hold that was never actually invalidated.
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-stale-")),
      scratchClean.dir,
    );
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-missing-")),
      scratchClean.dir,
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
    // permanent refusal.
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("no held item with key 'PRRT_ghost'");
  });

  it("refuses a held FINDING — the wrong kind for this script", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-kind-")),
      scratchClean.dir,
    );
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-apihead-")),
      scratchClean.dir,
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-localhead-")),
      scratchClean.dir,
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
      { head: scratchClean.head, cwd: scratchSibling.dir },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("worktree's HEAD");
  });

  it("refuses while the working tree is dirty", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-dirty-")),
      scratchClean.dir,
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
      "https://example.invalid/seed-comment-9",
    ]);
    const dirty = linkedScratchTree(
      scratchClean.dir,
      join(scratchClean.dir, "..", "scratch-held-thread-dirty"),
    );
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
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-nokey-")),
      scratchClean.dir,
    );
    const r = await resolveHeld(stateDir, ["--pushed-sha", scratchClean.head]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--key is required");
  });

  it("requires --pushed-sha", async () => {
    const stateDir = scopedStateDir(
      mkdtempSync(join(tmpdir(), "resolve-held-thread-nosha-")),
      scratchClean.dir,
    );
    const r = await resolveHeld(stateDir, ["--key", "PRRT_a"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--pushed-sha is required");
  });
});

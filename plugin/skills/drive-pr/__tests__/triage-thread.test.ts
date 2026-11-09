import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { writeState } from "./state-rows.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  held,
  heldKeys,
  holdDirectly,
  postReplyDirectly,
  postedBody,
  postedCount,
  resolvedCount,
  runTriage,
  writeFixtureDir,
  writeNode,
} from "./triage-thread-fixtures.ts";

describe("triage-thread.ts", () => {
  it("posts and holds a fresh accepted reply, in one invocation", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const body = "**accepted** — fixed the missing guard in abc1234.";

    const r = runTriage(["PRRT_fresh", "999"], body, dir, stateDir);
    expectSpawnExit(r, 0);
    expect(postedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("PRRT_fresh");
    const [item] = held(stateDir);
    expect(item).toMatchObject({
      key: "PRRT_fresh",
      kind: "thread",
      outcome: "accepted",
      commentUrl: "https://example.invalid/pull/1#discussion_r1",
    });
  });

  it("posts and resolves a fresh rejected reply — no hold", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const body = "**rejected** — the finding does not apply here.";

    const r = runTriage(["PRRT_merit", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("recovers from a crash between reply and hold: a reply already on the thread is not re-posted, and the hold still completes", () => {
    const { dir, stateDir } = writeFixtureDir();
    const body = "**accepted** — fixed the race in xyz789.";

    // Model the crash: the reply landed, but the process died before ever
    // calling drive-state.ts hold.
    const url = postReplyDirectly("PRRT_crash", body, dir, stateDir);
    expect(postedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("");

    // GitHub now shows that reply as the thread's real state — exactly what
    // a fresh triage-thread.ts invocation reads on its own, unprompted.
    writeNode(dir, {
      comments: [
        { author: "example-user", authorAssociation: "MEMBER", body, url },
      ],
    });

    const r = runTriage(["PRRT_crash", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    // No SECOND reply — the crash-recovery reconciliation, not a fresh post.
    expect(postedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("PRRT_crash");
    const [item] = held(stateDir);
    expect(item).toMatchObject({
      key: "PRRT_crash",
      outcome: "accepted",
      commentUrl: url,
    });
  });

  it("invoking it twice end-to-end produces exactly one reply and a correct durable record", () => {
    const { dir, stateDir } = writeFixtureDir();
    // --moot-pending-push: exercises the HOLD path with an outcome other than
    // accepted — see the dedicated moot-default-resolves tests below for the
    // no-flag case.
    const body = "**moot** — the branch this anchored to was deleted.";
    writeNode(dir, { comments: [] });

    const first = runTriage(
      ["PRRT_twice", "999", "--moot-pending-push"],
      body,
      dir,
      stateDir,
    );
    expect(first.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);

    // Reflect what the first call actually did before calling again — a
    // second invocation reads GitHub's live state, not a cached one. The
    // stub's mutation url is deterministic per posted-file index (fixture-seq
    // scoped), and this is the first and only reply posted in this fixture
    // dir, so it is discussion_r1 — matching the same literal the "posts and
    // holds" test above asserts on.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body,
          url: "https://example.invalid/pull/1#discussion_r1",
        },
      ],
    });

    const second = runTriage(
      ["PRRT_twice", "999", "--moot-pending-push"],
      body,
      dir,
      stateDir,
    );
    expect(second.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("PRRT_twice");
    const [item] = held(stateDir);
    expect(item).toMatchObject({ key: "PRRT_twice", outcome: "moot" });
  });

  it("a moot outcome resolves immediately BY DEFAULT — it is not fix-dependent unless the caller says so", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const body = "**moot** — the anchored code was already removed.";

    const r = runTriage(["PRRT_moot_default", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--moot-pending-push holds a moot outcome instead of resolving it", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const body =
      "**moot** — the finding's premise fails once this round's own unpushed fix lands.";

    const r = runTriage(
      ["PRRT_moot_held", "999", "--moot-pending-push"],
      body,
      dir,
      stateDir,
    );
    expectSpawnExit(r, 0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_moot_held");
  });

  it("a RECONCILED moot is ALWAYS held, even when the retry omits --moot-pending-push", () => {
    const { dir, stateDir } = writeFixtureDir();
    const body =
      "**moot** — the finding's premise fails once this round's own unpushed fix lands.";

    // Model the crash the reconciliation rule exists for: a pass posted this
    // moot reply INTENDING --moot-pending-push (it knew the premise depends
    // on this round's own unpushed fix), then died before ever calling
    // drive-state.ts hold. `--moot-pending-push` itself carries no state
    // between invocations — nothing records that intent anywhere durable.
    const url = postReplyDirectly("PRRT_moot_crash", body, dir, stateDir);
    writeNode(dir, {
      comments: [
        { author: "example-user", authorAssociation: "MEMBER", body, url },
      ],
    });

    // A flagless retry — a fresh agent with no memory of the original
    // invocation's flag — must still HOLD this, not resolve it: resolving a
    // thread whose fix is not actually pushed yet is the unrecoverable
    // failure this whole PR exists to prevent. Reconciling a `moot` always
    // assumes fix-dependent, regardless of the CURRENT call's own flag.
    const r = runTriage(["PRRT_moot_crash", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1); // no second post
    expect(resolvedCount(dir)).toBe(0); // NOT resolved
    expect(heldKeys(stateDir)).toBe("PRRT_moot_crash");
    const [item] = held(stateDir);
    expect(item).toMatchObject({ key: "PRRT_moot_crash", outcome: "moot" });
  });

  it("EXCEPT a RECONCILED moot carrying the --leave-open marker: trusted as the merit outcome it was, not force-held", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });
    // First invocation: fresh **moot** + --leave-open, no --moot-pending-push
    // — the marker is embedded because this outcome is genuinely non-hold.
    const r1 = runTriage(
      ["PRRT_moot_leaveopen_retry", "999", "--leave-open"],
      "**moot** — the anchored code was already removed; leaving this human thread for its author to close.",
      dir,
      stateDir,
    );
    expect(r1.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe(""); // not held — correctly merit
    expect(postedBody(dir, 1)).toContain("<!-- triage-thread:leave-open -->");

    // Reflect GitHub's live state, then retry with NO flags at all — a fresh
    // agent with no memory of the original invocation's --leave-open choice,
    // the exact case the marker exists to recover.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: postedBody(dir, 1),
        },
      ],
    });
    const r2 = runTriage(
      ["PRRT_moot_leaveopen_retry", "999"],
      "**moot** — the anchored code was already removed; leaving this human thread for its author to close.",
      dir,
      stateDir,
    );
    expect(r2.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1); // no second post
    expect(resolvedCount(dir)).toBe(0); // still not resolved — left open
    // Without this fix: held at round -1, with no unpushed fix ever to
    // confirm it — a permanently stranded hold.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--moot-pending-push has no effect on a non-moot outcome", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });

    const r = runTriage(
      ["PRRT_flag_noop", "999", "--moot-pending-push"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_flag_noop");
    const [item] = held(stateDir);
    expect(item).toMatchObject({ outcome: "accepted" });
  });

  it("the RECONCILIATION RULE: a qualifying reply with a DIFFERENT outcome than this call intended still wins — never posted over", () => {
    const { dir, stateDir } = writeFixtureDir();
    // A prior pass (or an interrupted retry landing on a different word this
    // time) already posted **accepted**; THIS invocation's own body would
    // have said **rejected** had it been the one to post. The existing reply
    // is the answer regardless — mirrors the ORIGINAL SKILL.md § 3 rule
    // exactly ("the outcome the qualifying reply already committed to
    // decides which"), which is what stops a retrying agent with no memory
    // of the earlier decision from putting a second outcome token on the
    // same triage decision.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed in an earlier round.",
          url: "https://example.invalid/pull/1#discussion_existing",
        },
      ],
    });
    const body = "**rejected** — actually a false positive on reflection.";

    const r = runTriage(["PRRT_reconcile", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    // No post at all — the existing reply is used as-is.
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_reconcile");
    const [item] = held(stateDir);
    expect(item).toMatchObject({
      key: "PRRT_reconcile",
      outcome: "accepted",
      commentUrl: "https://example.invalid/pull/1#discussion_existing",
      round: -1, // --unconfirmed: this pass never confirmed the fix in the tree
    });
  });

  it("a deliberate supersession still works: post the new verdict via reply-to-thread.ts directly, then triage-thread.ts reconciles to it (the LAST qualifying reply)", () => {
    const { dir, stateDir } = writeFixtureDir();
    // Round 1: held accepted.
    writeNode(dir, { comments: [] });
    const r1 = runTriage(
      ["PRRT_supersede", "999"],
      "**accepted** — fixed in round 1.",
      dir,
      stateDir,
    );
    expect(r1.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_supersede");

    // A human/agent decides, with new information, that the earlier verdict
    // was wrong — posts the superseding reply DIRECTLY (bypassing
    // triage-thread.ts's own post branch, exactly as SKILL.md documents).
    const url2 = postReplyDirectly(
      "PRRT_supersede",
      "**rejected** — actually a false positive on reflection.",
      dir,
      stateDir,
    );
    expect(postedCount(dir)).toBe(2);

    // GitHub now shows BOTH replies, with the rejected one last.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed in round 1.",
          url: "https://example.invalid/pull/1#discussion_r1",
        },
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**rejected** — actually a false positive on reflection.",
          url: url2,
        },
      ],
    });

    // A later call reconciles: it must NOT post a third reply, must resolve
    // (the LAST qualifying reply is now the merit one), and must release the
    // stale round-1 hold rather than stranding it.
    const r2 = runTriage(
      ["PRRT_supersede", "999"],
      "**rejected** — does not matter what this body says; the last qualifying reply already on the thread wins.",
      dir,
      stateDir,
    );
    expect(r2.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(2); // still just the two real replies
    expect(resolvedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe(""); // the stale accepted hold is gone
  });

  it("an explicit --leave-open on a RECONCILING call whose existing reply has no marker FAILS CLOSED — the choice cannot be made durable, since reconciliation posts nothing to persist it onto", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });
    // Posted DIRECTLY via reply-to-thread.ts, exactly as the deliberate-
    // supersession path documents — never through triage-thread.ts, so no
    // LEAVE_OPEN_MARKER was ever appended.
    const url = postReplyDirectly(
      "PRRT_supersede_leaveopen",
      "**wont-fix** — valid but declined; leaving this human thread for its author to close.",
      dir,
      stateDir,
    );
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — valid but declined; leaving this human thread for its author to close.",
          url,
        },
      ],
    });

    // Reconciles to the direct post above; --leave-open is this call's own,
    // live, explicit choice, but with no marker on the existing reply there
    // is nowhere durable to record it — a later retry or standalone sweep
    // would resolve the thread anyway, reversing a choice that looked
    // honored. Refuse rather than silently proceed on an unpersistable
    // promise.
    const r = runTriage(
      ["PRRT_supersede_leaveopen", "999", "--leave-open"],
      "**wont-fix** — does not matter what this body says.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(1); // no second reply — refused before any post
    expect(resolvedCount(dir)).toBe(0); // and not resolved either
  });

  it('the same fail-closed refusal STILL releases a stale hold on this key before exiting — the refusal means the thread cannot be made durable, not "skip cleanup too" (Architect Agent review 2026-08-21, closing PRRT_kwDOO7knac6a05qG/07oD)', () => {
    const { dir, stateDir } = writeFixtureDir();
    // The hold's own commentUrl identifies the EARLIER accepted comment — NOT
    // the later superseding reply. Seeding both with distinct URLs (and holding
    // the accepted one's) is what makes this fixture actually exercise
    // `seenUrls` being built from ALL current comments, not just the reconciled
    // reply's own URL — a fixture that reused one URL for both would stay green
    // even if production stopped considering the rest of the thread (the
    // original single-URL version of this fixture had exactly that gap).
    const acceptedUrl =
      "https://example.invalid/pull/1#discussion_stale_leaveopen_accepted";
    const wontFixUrl =
      "https://example.invalid/pull/1#discussion_stale_leaveopen_wontfix";
    // A wont-fix reply, posted directly (no marker), superseding an earlier
    // accepted hold on this same key.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed it, will push shortly.",
          url: acceptedUrl,
        },
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — valid but declined; leaving this human thread for its author to close.",
          url: wontFixUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_stale_then_refuse", "accepted", acceptedUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_stale_then_refuse");

    const r = runTriage(
      ["PRRT_stale_then_refuse", "999", "--leave-open"],
      "**wont-fix** — does not matter what this body says.",
      dir,
      stateDir,
    );
    // Still refuses — --leave-open cannot be made durable here, unchanged
    // from the test above.
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    // But the stale hold is gone — a regression to the old early-`fail()`
    // ordering would leave it stranded forever, since nothing else ever
    // revisits this key once the refusal keeps the thread open with no
    // durable marker to recover the choice from on a later pass.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--cleanup-only releases a stale hold this key's direct-post supersession left behind, posting and resolving nothing (the direct-post-fallback variant of the same gap)", () => {
    const { dir, stateDir } = writeFixtureDir();
    // The hold's own commentUrl identifies the EARLIER accepted comment, not
    // the later superseding reply — see the identical fixture note on the test
    // above (the original version of this fixture reused one URL for both, so
    // it stayed green even against a production change that stopped considering
    // the rest of the thread).
    const acceptedUrl =
      "https://example.invalid/pull/1#discussion_cleanup_only_accepted";
    const wontFixUrl =
      "https://example.invalid/pull/1#discussion_cleanup_only_wontfix";
    // The documented fallback: a wont-fix reply posted DIRECTLY (bypassing
    // this script's own post branch entirely), superseding an earlier
    // accepted hold — and per SKILL.md, the operator never invokes this
    // script's resolve step for a human thread meant to stay open, which
    // means the stale hold below has no other path back except --cleanup-only.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed it, will push shortly.",
          url: acceptedUrl,
        },
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — valid but declined; leaving this human thread for its author to close.",
          url: wontFixUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_cleanup_only", "accepted", acceptedUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_cleanup_only");

    const r = runTriage(
      ["PRRT_cleanup_only", "999", "--cleanup-only"],
      "",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--cleanup-only is a clean no-op (exit 0) when there is no stale hold to release", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });

    const r = runTriage(
      ["PRRT_cleanup_only_noop", "999", "--cleanup-only"],
      "",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--cleanup-only does NOT release a genuinely ACTIVE hold whose only reply is the original accepted post — no confirmed merit supersession exists, so nothing is released (the first cut of this flag vouched for every comment URL unconditionally and matched the hold's own accepted reply)", () => {
    const { dir, stateDir } = writeFixtureDir();
    const acceptedUrl =
      "https://example.invalid/pull/1#discussion_active_accepted";
    // The thread's ONLY reply is the accepted post that created this hold —
    // nothing has superseded it. `--cleanup-only` must not treat "the hold's
    // own comment is still visible" as proof of a merit supersession; that
    // is true of every fresh, still-live hold by construction.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed it, will push shortly.",
          url: acceptedUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_active_hold", "accepted", acceptedUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_active_hold");

    const r = runTriage(
      ["PRRT_active_hold", "999", "--cleanup-only"],
      "",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    // The hold must SURVIVE — this is the whole point of the guard.
    expect(heldKeys(stateDir)).toBe("PRRT_active_hold");
  });

  it("--cleanup-only refuses (exit 2) combined with --leave-open or --moot-pending-push — it posts nothing, so flags governing HOW a reply posts do not apply", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r1 = runTriage(
      ["PRRT_x", "999", "--cleanup-only", "--leave-open"],
      "",
      dir,
      stateDir,
    );
    expect(r1.exitCode).toBe(2);
    expect(postedCount(dir)).toBe(0);

    const r2 = runTriage(
      ["PRRT_x", "999", "--cleanup-only", "--moot-pending-push"],
      "",
      dir,
      stateDir,
    );
    expect(r2.exitCode).toBe(2);
    expect(postedCount(dir)).toBe(0);
  });

  it("--cleanup-only on a truncated thread refuses to guess rather than releasing blind (exit 1)", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { truncated: true, comments: [] });

    const r = runTriage(
      ["PRRT_cleanup_only_truncated", "999", "--cleanup-only"],
      "",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
  });

  it("an explicit --leave-open on a RECONCILING call whose existing reply ALREADY has the marker still works — the marker alone is durable, so no --leave-open is even required to recover it", () => {
    const { dir, stateDir } = writeFixtureDir();
    const body =
      "**wont-fix** — valid but declined; leaving this human thread for its author to close.\n\n<!-- triage-thread:leave-open -->";
    const url = postReplyDirectly(
      "PRRT_supersede_marked",
      body,
      dir,
      stateDir,
      true,
    );
    writeNode(dir, {
      comments: [
        { author: "example-user", authorAssociation: "MEMBER", body, url },
      ],
    });

    const r = runTriage(
      ["PRRT_supersede_marked", "999", "--leave-open"],
      "**wont-fix** — does not matter what this body says.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
  });

  it("refuses a truncated thread outright (exit 3) rather than guessing from a partial view", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      truncated: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — visible reply, but more may follow past the cap.",
        },
      ],
    });
    const body = "**accepted** — fixed it.";

    const r = runTriage(["PRRT_truncated", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(3);
    expect(postedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("an already-resolved AND truncated thread cannot confirm its stale-hold check, so it fails (exit 1) rather than silently reporting success over a possibly-stranded hold", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      isResolved: true,
      truncated: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — visible reply, but more may follow past the cap.",
        },
      ],
    });
    const body = "**accepted** — fixed it.";

    const r = runTriage(
      ["PRRT_resolved_truncated", "999"],
      body,
      dir,
      stateDir,
    );
    // Not exit 0: a merit dispatch interrupted between resolving the thread
    // and releasing its prior hold, retried once past the truncation cap,
    // must not report success without ever checking whether that hold
    // remains — nothing else ever revisits a resolved thread.
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
  });

  it("an already-resolved thread is a no-op — nothing posted, nothing held", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      isResolved: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — declined and already resolved out of band.",
        },
      ],
    });
    const body = "**accepted** — fixed it.";

    const r = runTriage(["PRRT_resolved", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("an already-resolved thread STILL releases a stale hold whose commentUrl this pass can see", () => {
    const { dir, stateDir } = writeFixtureDir();
    const existingUrl = "https://example.invalid/pull/1#discussion_stale";
    writeNode(dir, {
      isResolved: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**wont-fix** — declined and already resolved out of band.",
          url: existingUrl,
        },
      ],
    });
    // A stale hold left over from an earlier round — its commentUrl matches
    // the comment above, so this pass's own read of the thread accounts for
    // it (the identity check releaseStaleHold requires).
    holdDirectly(stateDir, "PRRT_resolved_stale", "accepted", existingUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_stale");

    const r = runTriage(
      ["PRRT_resolved_stale", "999"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    // A plain early return (the regression this pins) would never reach
    // attemptStaleHoldCleanup, leaving the stale hold stranded forever —
    // nothing else ever revisits a resolved thread.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("an already-resolved thread ALSO releases a stale hold when the last qualifying reply is a MARKED moot — the marker is positive proof of a merit supersession the outcome word alone cannot give", () => {
    const { dir, stateDir } = writeFixtureDir();
    const existingUrl = "https://example.invalid/pull/1#discussion_stale_moot";
    writeNode(dir, {
      isResolved: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**moot** — the anchored code was already removed; leaving this human thread for its author to close.\n\n<!-- triage-thread:leave-open -->",
          url: existingUrl,
        },
      ],
    });
    // The stale accepted hold this marked-moot reply superseded — thread was
    // resolved out of band (a concurrent driver, or a human) before this
    // pass's own cleanup ever ran.
    holdDirectly(stateDir, "PRRT_resolved_stale_moot", "accepted", existingUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_stale_moot");

    const r = runTriage(
      ["PRRT_resolved_stale_moot", "999"],
      "**moot** — does not matter what this body says.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    // Without this fix: excluded from confirmedMeritSupersession, so the
    // stale accepted hold would be stranded forever.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("an already-resolved thread does NOT release a stale hold when the last qualifying reply is a PLAIN moot with no marker — the outcome word alone is still ambiguous", () => {
    const { dir, stateDir } = writeFixtureDir();
    const existingUrl =
      "https://example.invalid/pull/1#discussion_stale_plainmoot";
    writeNode(dir, {
      isResolved: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**moot** — the finding was acted on out of band.",
          url: existingUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_resolved_plainmoot", "accepted", existingUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_plainmoot");

    const r = runTriage(
      ["PRRT_resolved_plainmoot", "999"],
      "**moot** — does not matter what this body says.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    // Left untouched — no marker means no proof this moot wasn't itself
    // meant to be held.
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_plainmoot");
  });

  it("a non-qualifying-grammar body is refused before any network call", () => {
    const { dir, stateDir } = writeFixtureDir();
    // No node.json written — this proves the network is never reached.
    const r = runTriage(
      ["PRRT_badgrammar", "999"],
      "accepted, sounds good",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(2);
    expect(existsSync(join(dir, "posted-1.json"))).toBe(false);
  });

  it("an untrusted qualifying comment is not evidence of a prior triage — posts fresh", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "random-participant",
          authorAssociation: "NONE",
          body: "**accepted** — spoofed by an outside commenter.",
        },
      ],
    });
    const body = "**accepted** — the real fix, from a trusted author.";

    const r = runTriage(["PRRT_untrusted", "999"], body, dir, stateDir);
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(heldKeys(stateDir)).toBe("PRRT_untrusted");
  });

  it("an accepted outcome with no resolvable PR refuses BEFORE posting", () => {
    const { dir, stateDir } = writeFixtureDir();
    // Nothing qualifying exists yet, so this WOULD post fresh — but the PR
    // check runs first (no PR arg, and `gh pr view` is unstubbed so
    // resolvePr('') comes back empty), and must refuse before that post ever
    // happens: an accepted/moot reply landed on GitHub with no PR to hold it
    // against is unrecoverable by this script.
    writeNode(dir, { comments: [] });
    const r = runTriage(
      ["PRRT_nopr"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
  });

  it("a rejected outcome's own reply/resolve does not need a PR — but an unresolvable PR still fails the stale-hold check", () => {
    // `resolvePr('')` conflates "genuinely no PR for this thread's context"
    // with "gh pr view failed transiently", and this fixture's `gh` stub has
    // no `pr view` case at all — so this cannot be told apart from a real
    // failure, and the stale-hold check must fail closed (see
    // attemptStaleHoldCleanup's own header). The merit reply and resolve
    // still land regardless — only the exit code reports the unconfirmed
    // cleanup.
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const r = runTriage(
      ["PRRT_meritnopr"],
      "**rejected** — does not apply, no PR needed for this path.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(1);
  });

  it("propagates a stale-hold cleanup FAILURE as a nonzero exit — a resolved thread has no other retry path", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    // The database itself stays valid (so its identity still resolves for
    // the drive-lease fence reply-to-thread.ts's post goes through) — only
    // the per-PR state row `drive-state.ts` reads is broken, by storing text
    // that is not drive state. `held` then fails deterministically ("exists
    // but is not usable drive state"), simulating the "could not read held
    // state" cleanup failure. The merit dispatch itself (resolve-thread.ts)
    // still succeeds first.
    writeState(stateDir, "999", "not json");

    const r = runTriage(
      ["PRRT_cleanupfail", "999"],
      "**rejected** — does not apply.",
      dir,
      stateDir,
    );

    expect(r.exitCode).toBe(1);
    // The resolve itself still landed — only the cleanup check failed.
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(1);
  });

  it("refuses an unknown starter before granting leave-open", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    const r = runTriage(
      ["PRRT_unknown", "999", "--leave-open"],
      "**wont-fix** — declined.",
      dir,
      stateDir,
    );
    expectSpawnExit(r, 2);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
  });

  it("settles a bot's recovered invalid leave-open marker", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorType: "Bot",
          authorAssociation: "NONE",
          body: "Finding",
        },
        {
          author: "maintainer",
          authorAssociation: "OWNER",
          body: "**wont-fix** — declined.\n\n<!-- triage-thread:leave-open -->",
        },
      ],
    });
    const r = runTriage(
      ["PRRT_invalid_marker", "999"],
      "**wont-fix** — declined.",
      dir,
      stateDir,
    );
    expectSpawnExit(r, 0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(1);
  });

  it("--leave-open refuses a bot-started thread before posting or resolving", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer[bot]",
          authorType: "Bot",
          authorAssociation: "NONE",
          body: "Please check this finding.",
        },
      ],
    });
    const r = runTriage(
      ["PRRT_bot_leaveopen", "999", "--leave-open"],
      "**wont-fix** — the tradeoff is accepted.",
      dir,
      stateDir,
    );
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("--leave-open refuses a bot-started thread");
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--leave-open posts a merit reply but does not resolve — the human-thread exception", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_leaveopen", "999", "--leave-open"],
      "**wont-fix** — valid but declined; leaving this human thread for its author to close.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
    // The durable marker a later reconciliation recovers this choice from —
    // see the reconciliation test below.
    expect(postedBody(dir, 1)).toContain("<!-- triage-thread:leave-open -->");
  });

  it("a RECONCILED --leave-open reply stays open even when the retry omits the flag — recovered from the durable marker, not this invocation's own argv", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });
    const body =
      "**wont-fix** — valid but declined; leaving this human thread for its author to close.";

    // First invocation: --leave-open posts and embeds the marker, same as
    // the test above.
    const first = runTriage(
      ["PRRT_reconopen", "999", "--leave-open"],
      body,
      dir,
      stateDir,
    );
    expect(first.exitCode).toBe(0);
    expect(resolvedCount(dir)).toBe(0);

    // Reflect what GitHub now actually shows: the reply, marker included.
    writeNode(dir, {
      comments: [
        {
          author: "the-agent",
          authorAssociation: "MEMBER",
          body: postedBody(dir, 1),
        },
      ],
    });

    // A LATER invocation — a subsequent round re-enumerating the thread
    // because it is still unresolved by design, not a crash retry — omits
    // --leave-open entirely, exactly as an agent with no memory of the
    // earlier choice would.
    const second = runTriage(["PRRT_reconopen", "999"], body, dir, stateDir);
    expect(second.exitCode).toBe(0);
    // No SECOND post — this is reconciliation, not a fresh reply.
    expect(postedCount(dir)).toBe(1);
    // And critically: still not resolved. Without the marker-recovery fix,
    // this would be 1 — the retry's own leaveOpen=false would have closed a
    // thread its author deliberately left open.
    expect(resolvedCount(dir)).toBe(0);
  });

  it("--leave-open has no effect on an accepted (hold) outcome", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_leaveopen_hold", "999", "--leave-open"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_leaveopen_hold");
  });

  it('--leave-open has no effect on a HELD moot (--moot-pending-push) outcome, and does NOT mark the reply — the marker means "left open", which a held reply is not', () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_leaveopen_heldmoot", "999", "--moot-pending-push", "--leave-open"],
      "**moot** — the finding's premise fails once this round's own unpushed fix lands.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_leaveopen_heldmoot");
    // Not marked: reconcile-replied-threads.ts's own standalone sweep has no
    // --moot-pending-push equivalent and would otherwise have no way to tell
    // this HELD moot apart from a marked plain one if it carried the marker
    // too.
    expect(postedBody(dir, 1)).not.toContain(
      "<!-- triage-thread:leave-open -->",
    );
  });

  it("refuses (exit 2) a HELD moot (--moot-pending-push) whose own body already ends in the marker — reconcile-replied-threads.ts trusts a marked moot as left-open regardless of --moot-pending-push, so it would release this not-yet-verified hold before the promised push ever lands", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });

    const r = runTriage(
      ["PRRT_heldmoot_selfmarked", "999", "--moot-pending-push"],
      "**moot** — the finding's premise fails once this round's own unpushed fix lands.\n\n<!-- triage-thread:leave-open -->",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(2);
    expect(postedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("--leave-open DOES apply to a fresh PLAIN moot (no --moot-pending-push) — it is a merit outcome, and DOES mark the reply", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_leaveopen_plainmoot", "999", "--leave-open"],
      "**moot** — the anchored code was already removed; leaving this human thread for its author to close.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
    expect(postedBody(dir, 1)).toContain("<!-- triage-thread:leave-open -->");
  });

  it("refuses (exit 2) a fresh merit body whose own trailing line already matches LEAVE_OPEN_MARKER without --leave-open — posting it unchanged would be indistinguishable from a deliberate leave-open", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_selfmarked", "999"],
      "**wont-fix** — declined; this reply happens to end with the exact marker line while explaining it.\n\n<!-- triage-thread:leave-open -->",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(2);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("the same self-marked body posts fine WITH --leave-open — the flag is what makes the marker legitimate", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "reviewer",
          authorAssociation: "MEMBER",
          body: "Please check this finding.",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_selfmarked_flagged", "999", "--leave-open"],
      "**wont-fix** — declined; this reply happens to end with the exact marker line while explaining it.\n\n<!-- triage-thread:leave-open -->",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
    // Not doubled: the body already ends in the marker, so the append is
    // skipped and the posted body is the caller's own body verbatim — asserted
    // by exact equality, not `.toContain` (which would also pass on a doubled
    // marker).
    expect(postedBody(dir, 1)).toBe(
      "**wont-fix** — declined; this reply happens to end with the exact marker line while explaining it.\n\n<!-- triage-thread:leave-open -->",
    );
  });

  it("DOES refuse (exit 2) a self-marked body on an accepted (hold) outcome — this script never consults the marker for hold outcomes, but reconcile-replied-threads.ts's standalone sweep does, regardless of outcome word", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });

    const r = runTriage(
      ["PRRT_selfmarked_hold", "999"],
      "**accepted** — fixed it; this explanation happens to end with the marker line.\n\n<!-- triage-thread:leave-open -->",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(2);
    expect(postedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("fails closed (exit 1) when the thread state cannot be read — the single most important guard", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    writeFileSync(join(dir, "node-fail"), "");

    const r = runTriage(
      ["PRRT_fetchfail", "999"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("propagates reply-to-thread.ts's failure verbatim, with no hold/resolve side effect", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    writeFileSync(join(dir, "post-fail"), "");

    const r = runTriage(
      ["PRRT_postfail", "999"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("refuses (exit 1) when reply-to-thread.ts exits 0 but prints no comment url — doesn't hold/resolve on an unknown reply", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });
    writeFileSync(join(dir, "post-empty"), "");

    const r = runTriage(
      ["PRRT_postempty", "999"],
      "**rejected** — does not apply.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(resolvedCount(dir)).toBe(0);
  });

  it("a qualifying reply with no readable url fails closed instead of posting a second outcome token", () => {
    const { dir, stateDir } = writeFixtureDir();
    // The existing reply qualifies (right grammar, trusted author) but its url
    // came back unreadable — the exact gap this pins: falling through to "post"
    // here would put a second **accepted** token on this one triage decision.
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**accepted** — fixed the missing guard in abc1234.",
          url: "",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_nourl", "999"],
      "**accepted** — fixed the missing guard in abc1234.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(1);
    expect(postedCount(dir)).toBe(0);
    expect(heldKeys(stateDir)).toBe("");
  });

  it("a reconciled MERIT outcome with no readable url still resolves — a url is only needed to hold", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, {
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "**rejected** — does not apply.",
          url: "",
        },
      ],
    });

    const r = runTriage(
      ["PRRT_meritnourl", "999"],
      "**rejected** — does not apply.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    expect(resolvedCount(dir)).toBe(1);
  });

  it("an already-resolved thread does NOT release a stale hold when the last qualifying reply is itself accepted — not a confirmed merit supersession", () => {
    const { dir, stateDir } = writeFixtureDir();
    const existingUrl = "https://example.invalid/pull/1#discussion_stale2";
    writeNode(dir, {
      isResolved: true,
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          // Resolved externally (e.g. a human clicking "Resolve conversation"
          // in the GitHub UI) with NO merit reply ever posted — the last
          // qualifying comment is still the original accepted verdict, not a
          // supersession. The promised fix may never have passed gates or
          // been pushed; deleting this hold would let the drive believe it
          // converged over an unverified obligation.
          body: "**accepted** — fixed the missing guard in abc1234.",
          url: existingUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_resolved_unsafe", "accepted", existingUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_unsafe");

    const r = runTriage(
      ["PRRT_resolved_unsafe", "999"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(postedCount(dir)).toBe(0);
    // The hold SURVIVES — not released, because there is no confirmed merit
    // supersession to act on.
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_unsafe");
  });

  it("an already-resolved thread does NOT release a stale hold when NO qualifying reply exists at all", () => {
    const { dir, stateDir } = writeFixtureDir();
    const existingUrl = "https://example.invalid/pull/1#discussion_stale3";
    writeNode(dir, {
      isResolved: true,
      // Resolved with no trusted qualifying comment at all (e.g. a bare
      // "Resolve conversation" click, or a comment that doesn't open with the
      // outcome grammar) — nothing here proves a merit supersession happened.
      comments: [
        {
          author: "example-user",
          authorAssociation: "MEMBER",
          body: "looks good to me, resolving",
          url: existingUrl,
        },
      ],
    });
    holdDirectly(stateDir, "PRRT_resolved_bare", "accepted", existingUrl);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_bare");

    const r = runTriage(
      ["PRRT_resolved_bare", "999"],
      "**accepted** — fixed it.",
      dir,
      stateDir,
    );
    expect(r.exitCode).toBe(0);
    expect(heldKeys(stateDir)).toBe("PRRT_resolved_bare");
  });
});

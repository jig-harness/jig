import { scopedStateDir } from "./scoped-state-dir.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
/**
 * triage-thread.test.ts
 *
 * `triage-thread.ts` folds a thread's outcome reply and its durable
 * disposition (hold or resolve) into one invocation. A crash between the
 * two — previously separate commands — can be repaired by the next
 * invocation without reposting; this is self-reconciling, not
 * transactionally atomic (see the script's own header). These are subprocess
 * integration tests against a stubbed `gh`, mirroring
 * reconcile-replied-threads.test.ts's own convention (the real script,
 * spawned for real, against fixture files).
 *
 * The crash-recovery property is pinned by literally invoking the script
 * TWICE on the same thread with an identical body, updating the thread
 * fixture between calls to reflect what GitHub would actually show after the
 * first call posted its reply (self-reconciliation reads GitHub's live state,
 * never a cached snapshot) — and asserting exactly one reply lands across
 * both invocations.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SCRIPT = join(SCRIPTS, "triage-thread.ts");
const DRIVE_STATE = join(SCRIPTS, "drive-state.ts");
const REPLY_TO_THREAD = join(
  SCRIPTS,
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "reply-to-thread.ts",
);

let tmpRoot: string;
let binDir: string;
let scratchWorktree: string;

/**
 * Same GIT_* scrub as reconcile-replied-threads.test.ts's own — see its
 * comment — plus an explicit `$DRIVE_PR_SESSION`, pinned to THIS test
 * process's own pid rather than left to whatever the ambient environment
 * happens to carry (the `current-round.test.ts` pattern, same reasoning).
 *
 * Several tests here run TWO separate subprocess calls against the SAME
 * `stateDir` in sequence — e.g. a fresh `runTriage` accepted+hold, then a later
 * `postReplyDirectly` simulating a direct supersession — and every
 * state-mutating `drive-state.ts` call (including `hold`) claims a sessionless
 * tree-wide presence record when no session identity is set. Left unpinned,
 * that reads as an IDENTIFIED session locally (a Claude Code harness always
 * sets `$CLAUDE_PID`, which the ladder falls back to) and as ladder tier 3 —
 * sessionless — on a clean CI/gates shell that does not: on tier 3, the second
 * subprocess call sees the first one's own presence record and refuses it as
 * "another live resolver," a false collision with nothing to do with what these
 * tests actually check (outcome/reconciliation logic, not multi-session lease
 * semantics).
 * Verified: this exact test file passes locally (ambient `$CLAUDE_PID` masks
 * it) but failed reproducibly on remote gates before this pin. Pinning an
 * explicit session — every subprocess this file spawns sees the SAME pid, so
 * they self-recognize — avoids the tier entirely, deterministically, regardless
 * of which shell runs the suite.
 */
function scrubbedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  env.DRIVE_PR_SESSION = String(process.pid);
  return env;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "triage-thread-"));
  binDir = join(tmpRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  scratchWorktree = join(tmpRoot, "worktree");
  mkdirSync(scratchWorktree, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: scratchWorktree,
    env: scrubbedGitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0) {
    throw new Error(`git init failed: ${init.stderr.toString()}`);
  }

  // A `gh` stub serving fixtures from $TRT_FIXTURES. These shapes reach it:
  //   - reply-to-thread.ts's addPullRequestReviewThreadReply, via `--input -`
  //   - resolve-thread.ts's resolveReviewThread mutation
  //   - triage-thread.ts's own single-thread `node(id:...)` read
  // matched the same way reconcile-replied-threads.test.ts's stub already
  // discriminates a mutation from an ordinary query: by literal substring in
  // the joined argv, since both arrive as `gh api graphql ...`.
  const stub = `#!/usr/bin/env bash
set -euo pipefail
(
  [[ "$1 $2" == 'api graphql' ]] || { echo "unexpected fake gh command: $*" >&2; exit 2; }
  shift 2
  needs_value=0
  for argument in "$@"; do
    if [[ "$needs_value" -eq 1 ]]; then
      [[ -n "$argument" ]] || { echo "gh: missing flag value" >&2; exit 2; }
      case "$argument" in --*) echo "gh: missing flag value" >&2; exit 2 ;; esac
      needs_value=0; continue
    fi
    case "$argument" in
      --input|-f|-F|-q|--jq) needs_value=1 ;;
      -*) echo "gh: unknown flag: $argument" >&2; exit 2 ;;
    esac
  done
  [[ "$needs_value" -eq 0 ]] || { echo 'gh: missing flag value' >&2; exit 2; }
) || exit $?
F="\${TRT_FIXTURES:?fixture dir not set}"
case "$*" in
  *"pullRequest { number state }"*)
    # The review skill reads the owning PR's liveness immediately before
    # every thread mutation; the fixture PR is open.
    tid=""
    for b in "$@"; do case "$b" in threadId=*) tid="\${b#threadId=}" ;; esac; done
    printf '{"data":{"node":{"__typename":"PullRequestReviewThread","id":"%s","pullRequest":{"number":1,"state":"OPEN"}}}}' "$tid"
    exit 0 ;;
  *"--input -"*)
    body=$(cat)
    if [ -f "$F/post-fail" ]; then
      echo "gh-stub: simulated addPullRequestReviewThreadReply failure" >&2
      exit 1
    fi
    n=0
    while [ -e "$F/posted-$((n + 1)).json" ]; do n=$((n + 1)); done
    n=$((n + 1))
    printf '%s' "$body" > "$F/posted-$n.json"
    [ -f "$F/post-empty" ] && exit 0
    echo "https://example.invalid/pull/1#discussion_r$n"
    exit 0 ;;
  *"resolveReviewThread"*)
    n=0
    while [ -e "$F/resolved-$((n + 1))" ]; do n=$((n + 1)); done
    : > "$F/resolved-$((n + 1))"
    echo "true"
    exit 0 ;;
  *"node(id:"*)
    [ -f "$F/node-fail" ] && { echo "gh-stub: simulated node read failure" >&2; exit 1; }
    cat "$F/node.json"
    exit 0 ;;
esac
echo "gh-stub: unhandled: $*" >&2
exit 1
`;
  const ghPath = join(binDir, "gh");
  writeFakeProgram(ghPath, stub);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface CommentFixture {
  author: string;
  authorAssociation: string;
  body: string;
  url?: string;
}

let fixtureSeq = 0;

function nodePayload(opts: {
  isResolved?: boolean;
  truncated?: boolean;
  comments: CommentFixture[];
}) {
  return JSON.stringify({
    data: {
      node: {
        isResolved: opts.isResolved ?? false,
        comments: {
          pageInfo: { hasNextPage: opts.truncated ?? false },
          nodes: opts.comments.map((c, i) => ({
            url: c.url ?? `https://example.invalid/pull/1#discussion_seed${i}`,
            author: { login: c.author, __typename: "User" },
            authorAssociation: c.authorAssociation,
            body: c.body,
          })),
        },
      },
    },
  });
}

function writeFixtureDir(): { dir: string; stateDir: string } {
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  const stateDir = scopedStateDir(join(dir, "state"), scratchWorktree);
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { dir, stateDir };
}

function writeNode(
  dir: string,
  opts: {
    isResolved?: boolean;
    truncated?: boolean;
    comments: CommentFixture[];
  },
) {
  writeFileSync(join(dir, "node.json"), nodePayload(opts));
}

/**
 * `$DRIVE_PR_STATE_DIR_IDENTITY` must accompany `$DRIVE_PR_STATE_DIR` for
 * reply-to-thread.ts's drive-lease fence (assert-post-allowed.ts), which
 * triage-thread.ts spawns on the posting path — the same derivation
 * `/resolve-review-comments`'s own scripts.test.ts uses, see its comment on
 * why an override without an identity refuses.
 */
function withStateDirIdentity(
  env: Record<string, string>,
): Record<string, string> {
  if (env.DRIVE_PR_STATE_DIR === undefined) return env;
  const identity = stateDirIdentityToken(env.DRIVE_PR_STATE_DIR);
  return {
    ...env,
    DRIVE_PR_STATE_DIR_IDENTITY: identity,
  };
}

function runTriage(
  args: string[],
  body: string,
  fixtureDir: string,
  stateDir: string,
): { stdout: string; stderr: string; exitCode: number } {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: scratchWorktree,
    env: withStateDirIdentity({
      ...scrubbedGitEnv(),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      TRT_FIXTURES: fixtureDir,
      DRIVE_PR_STATE_DIR: stateDir,
      GH_CALL_TIMEOUT: "20",
      DRIVE_PR_HELPER_TIMEOUT: "20",
    }),
    input: body,
    encoding: "utf8",
  });
  if (process.env.TRT_DEBUG === "1") {
    console.error(
      `[TRT_DEBUG] argv=${JSON.stringify(args)} status=${proc.status} signal=${proc.signal} error=${proc.error ? String(proc.error) : "none"} stdout=${JSON.stringify(proc.stdout)} stderr=${JSON.stringify(proc.stderr)}`,
    );
  }
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    exitCode: proc.status ?? 1,
  };
}

/** Post a reply directly, bypassing triage-thread.ts entirely — models a
 * pass that posted the reply and then died before ever reaching the hold
 * call, the literal crash class triage-thread.ts's reconciliation rule exists
 * to survive.
 *
 * `allowLeaveOpenMarker` mirrors setting `DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER`
 * the way `triage-thread.ts` itself would — for a fixture whose whole POINT
 * is simulating a reply that legitimately carries the marker regardless of
 * which script posted it (e.g. a downstream-reconciliation test seeding an
 * earlier round's own marked reply), not for testing Fix A's own refusal
 * (that gets its own dedicated test, unset). */
function postReplyDirectly(
  threadId: string,
  body: string,
  fixtureDir: string,
  stateDir: string,
  allowLeaveOpenMarker = false,
): string {
  const proc = spawnSync(process.execPath, [REPLY_TO_THREAD, threadId], {
    cwd: scratchWorktree,
    env: withStateDirIdentity({
      ...scrubbedGitEnv(),
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      TRT_FIXTURES: fixtureDir,
      DRIVE_PR_STATE_DIR: stateDir,
      GH_CALL_TIMEOUT: "20",
      ...(allowLeaveOpenMarker
        ? { DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER: "1" }
        : {}),
    }),
    input: body,
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error(
      `postReplyDirectly failed (${proc.status}): ${proc.stderr ?? ""}`,
    );
  }
  return (proc.stdout ?? "").trim();
}

function postedCount(fixtureDir: string): number {
  return existsSync(fixtureDir)
    ? readdirSync(fixtureDir).filter((f) => f.startsWith("posted-")).length
    : 0;
}

function resolvedCount(fixtureDir: string): number {
  return existsSync(fixtureDir)
    ? readdirSync(fixtureDir).filter((f) => f.startsWith("resolved-")).length
    : 0;
}

/** The `variables.body` GraphQL sent for the Nth post the gh stub recorded. */
function postedBody(fixtureDir: string, n: number): string {
  const raw = readFileSync(join(fixtureDir, `posted-${n}.json`), "utf8");
  return (JSON.parse(raw) as { variables: { body: string } }).variables.body;
}

function heldKeys(stateDir: string): string {
  return Bun.spawnSync([process.execPath, DRIVE_STATE, "held-keys", "999"], {
    cwd: scratchWorktree,
    env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
  })
    .stdout.toString()
    .trim();
}

function held(stateDir: string): Array<Record<string, unknown>> {
  const out = Bun.spawnSync([process.execPath, DRIVE_STATE, "held", "999"], {
    cwd: scratchWorktree,
    env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
  }).stdout.toString();
  return JSON.parse(out);
}

/** Seed a held entry directly, bypassing triage-thread.ts entirely — for
 * setting up a pre-existing stale hold a fix under test must clean up. */
function holdDirectly(
  stateDir: string,
  key: string,
  outcome: string,
  commentUrl: string,
): void {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      DRIVE_STATE,
      "hold",
      "999",
      "--key",
      key,
      "--kind",
      "thread",
      "--outcome",
      outcome,
      "--comment-url",
      commentUrl,
    ],
    {
      cwd: scratchWorktree,
      env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `holdDirectly failed (${proc.exitCode}): ${proc.stderr.toString()}`,
    );
  }
}

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
    writeNode(dir, { comments: [] });
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
    writeNode(dir, { comments: [] });
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
    writeNode(dir, { comments: [] });

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
    // The state DIRECTORY itself stays valid (so its identity still resolves
    // for the drive-lease fence reply-to-thread.ts's post goes through) —
    // only the per-PR state FILE `drive-state.ts` reads is broken, by
    // pre-creating its exact path as a directory instead of a file. `held`
    // then fails deterministically ("exists but is not usable drive state"),
    // simulating the "could not read held state" cleanup failure. The merit
    // dispatch itself (resolve-thread.ts) still succeeds first.
    mkdirSync(join(stateDir, "drive-pr-999.json"), { recursive: true });

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

  it("--leave-open posts a merit reply but does not resolve — the human-thread exception", () => {
    const { dir, stateDir } = writeFixtureDir();
    writeNode(dir, { comments: [] });

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
    writeNode(dir, { comments: [] });
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
    writeNode(dir, { comments: [] });

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
    writeNode(dir, { comments: [] });

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
    writeNode(dir, { comments: [] });

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
    writeNode(dir, { comments: [] });

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
    writeNode(dir, { comments: [] });

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

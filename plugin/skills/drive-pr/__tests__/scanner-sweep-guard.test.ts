/**
 * A declined code-scanning finding closes only over a dismissed alert, on
 * every path that resolves a merit reply: the replied-thread sweep and
 * `triage-thread.ts`, fresh post or reconciled retry. The scripts run for
 * real against a stubbed `gh` serving fixture files, as in
 * reconcile-replied-threads.test.ts and triage-thread.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { mayResolveDeclinedAlert } from "../scripts/lib/scanner-sweep-guard.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SWEEP = join(SCRIPTS, "reconcile-replied-threads.ts");
const TRIAGE = join(SCRIPTS, "triage-thread.ts");
const DRIVE_STATE = join(SCRIPTS, "drive-state.ts");

describe("declined code scanning findings", () => {
  it("resolves only when the alert is confirmed dismissed", () => {
    expect(mayResolveDeclinedAlert(undefined)).toBe(true);
    expect(mayResolveDeclinedAlert({ state: "dismissed" })).toBe(true);
    for (const alert of [
      { state: "open" },
      { state: null },
      { state: "fixed" },
      { state: "dismissed", unreadable: "denied" },
      null,
      {},
    ]) {
      expect(mayResolveDeclinedAlert(alert)).toBe(false);
    }
  });

  it("resolves a plain moot once the alert is fixed, closed or dismissed", () => {
    expect(mayResolveDeclinedAlert(undefined, "moot")).toBe(true);
    for (const state of ["fixed", "closed", "dismissed"]) {
      expect(mayResolveDeclinedAlert({ state }, "moot")).toBe(true);
    }
    for (const alert of [
      { state: "open" },
      { state: null, stateUnknown: "scan running" },
      { state: "fixed", unreadable: "denied" },
      null,
      {},
    ]) {
      expect(mayResolveDeclinedAlert(alert, "moot")).toBe(false);
    }
  });

  it("keeps a code-scanning thread open when its alert cannot be identified", () => {
    expect(mayResolveDeclinedAlert(undefined, "declined", true)).toBe(false);
    expect(mayResolveDeclinedAlert(undefined, "moot", true)).toBe(false);
  });
});

let tmpRoot: string;
let binDir: string;
let worktree: string;
let fixtureSeq = 0;

/** No ambient Git or drive variables; one pinned session for every child. */
function childEnv(fixtures: string, stateDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_") || k.startsWith("DRIVE_PR_"))
      continue;
    env[k] = v;
  }
  return {
    ...env,
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    SSG_FIXTURES: fixtures,
    DRIVE_PR_SESSION: String(process.pid),
    DRIVE_PR_STATE_DIR: stateDir,
    DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
    GH_CALL_TIMEOUT: "20",
    DRIVE_PR_HELPER_TIMEOUT: "20",
  };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "scanner-sweep-guard-"));
  binDir = join(tmpRoot, "bin");
  worktree = join(tmpRoot, "worktree");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: worktree,
    env: childEnv(tmpRoot, tmpRoot),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(init, 0, "git init");

  // Every request is told apart by a literal substring of its arguments, the
  // way the other drive-pr stubs do; `-q` filters run through jq.
  writeFakeProgram(
    join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
F="\${SSG_FIXTURES:?fixture dir not set}"
filter=""; prev=""
for a in "$@"; do case "$prev" in -q|--jq) filter="$a" ;; esac; prev="$a"; done
out() { if [ -n "$filter" ]; then printf '%s' "$1" | jq -r "$filter"; else printf '%s' "$1"; fi; }
tid=""
for a in "$@"; do case "$a" in threadId=*) tid="\${a#threadId=}" ;; esac; done
case "$*" in
  *resolveReviewThread*)
    printf '%s\\n' "$tid" >> "$F/resolved.txt"
    out '{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'; exit 0 ;;
  *"pullRequest { number state }"*)
    out "{\\"data\\":{\\"node\\":{\\"__typename\\":\\"PullRequestReviewThread\\",\\"id\\":\\"$tid\\",\\"pullRequest\\":{\\"number\\":999,\\"state\\":\\"OPEN\\"}}}}"; exit 0 ;;
  *"pullRequest { number repository"*)
    out '{"data":{"node":{"pullRequest":{"number":999,"repository":{"owner":{"login":"example-org"},"name":"example-repo"}}}}}'; exit 0 ;;
  *"--input -"*)
    cat > "$F/posted.json"; echo "https://example.invalid/posted"; exit 0 ;;
  *"node(id:"*) cat "$F/node.json"; exit 0 ;;
  "api graphql"*) out "$(cat "$F/threads.json")"; exit 0 ;;
  "repo view"*) out '{"owner":{"login":"example-org"},"name":"example-repo"}'; exit 0 ;;
  "pr view"*) out '{"number":999}'; exit 0 ;;
  "api repos/"*/code-scanning/alerts/*/instances*) ;;
  "api repos/"*/code-scanning/alerts/*)
    n="\${2##*/}"
    if [ -f "$F/alert-$n.json" ]; then out "$(cat "$F/alert-$n.json")"; exit 0; fi ;;
esac
echo "gh-stub: unreadable: $*" >&2
exit 1
`,
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

interface Comment {
  author: string;
  authorAssociation: string;
  body: string;
  url: string;
}

/** Alert `alert`'s own comment, then each reply from a trusted member. */
function scanningComments(
  id: string,
  alert: number,
  replies: string[],
): Comment[] {
  return [
    {
      author: "github-advanced-security",
      authorAssociation: "NONE",
      body: `Unsafe path.\n\n[Show more details](https://github.com/example-org/example-repo/security/code-scanning/${alert})`,
      url: `https://example.invalid/${id}/comment-0`,
    },
    ...replies.map((body, i) => ({
      author: "example-user",
      authorAssociation: "MEMBER",
      body,
      url: `https://example.invalid/${id}/comment-${i + 1}`,
    })),
  ];
}

/** `scanningComments` whose alert comment carries no details link. */
function unlinkedComments(id: string, replies: string[]): Comment[] {
  return scanningComments(id, 0, replies).map((c, i) =>
    i === 0 ? { ...c, body: "Unsafe path." } : c,
  );
}

function graphqlComments(comments: Comment[]) {
  return {
    pageInfo: { hasNextPage: false },
    nodes: comments.map((c) => ({
      url: c.url,
      author: { login: c.author, __typename: "User" },
      authorAssociation: c.authorAssociation,
      body: c.body,
    })),
  };
}

/** A fixture directory whose alerts are given as `{ number: state }`. */
function fixture(alerts: Record<number, string>): {
  dir: string;
  stateDir: string;
} {
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  const stateDir = scopedStateDir(join(dir, "state"), worktree);
  mkdirSync(stateDir, { recursive: true });
  for (const [number, state] of Object.entries(alerts)) {
    writeFileSync(
      join(dir, `alert-${number}.json`),
      JSON.stringify({
        number: Number(number),
        state,
        rule: { id: "js/path-injection", severity: "error" },
        tool: { name: "CodeQL" },
      }),
    );
  }
  return { dir, stateDir };
}

function writeThreads(
  dir: string,
  threads: { id: string; comments: Comment[] }[],
): void {
  const nodes = threads.map((t) => ({
    id: t.id,
    isResolved: false,
    isOutdated: false,
    path: "a.ts",
    line: 1,
    comments: graphqlComments(t.comments),
  }));
  writeFileSync(
    join(dir, "threads.json"),
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes,
            },
          },
        },
      },
    }),
  );
}

function writeNode(dir: string, comments: Comment[], isResolved = false): void {
  writeFileSync(
    join(dir, "node.json"),
    JSON.stringify({
      data: {
        node: { isResolved, comments: graphqlComments(comments) },
      },
    }),
  );
}

function run(
  script: string,
  args: string[],
  dir: string,
  stateDir: string,
  input = "",
) {
  const proc = Bun.spawnSync([process.execPath, script, ...args], {
    cwd: worktree,
    env: childEnv(dir, stateDir),
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function resolved(dir: string): string[] {
  const file = join(dir, "resolved.txt");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").sort()
    : [];
}

function heldKeys(dir: string, stateDir: string): string {
  return run(DRIVE_STATE, ["held-keys", "999"], dir, stateDir).stdout.trim();
}

function holdAccepted(dir: string, stateDir: string, key: string, url: string) {
  const r = run(
    DRIVE_STATE,
    [
      "hold",
      "999",
      "--key",
      key,
      "--kind",
      "thread",
      "--outcome",
      "accepted",
      "--comment-url",
      url,
    ],
    dir,
    stateDir,
  );
  expectSpawnExit(r, 0, "drive-state.ts hold");
}

/** Three declined code-scanning threads, on alerts 7, 8 and 9, and a plain one. */
function sweepThreads(): { id: string; comments: Comment[] }[] {
  const declined = (id: string, alert: number, reply: string) => ({
    id,
    comments: scanningComments(id, alert, [reply]),
  });
  const plain = scanningComments("T_plain", 0, [
    "**rejected** — handled upstream.",
  ]).map((c, i) =>
    i === 0 ? { ...c, author: "codex", body: "some finding" } : c,
  );
  return [
    declined("T_open", 7, "**wont-fix** — accepted risk."),
    declined("T_unreadable", 8, "**rejected** — not reachable."),
    declined("T_dismissed", 9, "**deferred** — tracked."),
    { id: "T_plain", comments: plain },
  ];
}

describe("the replied-thread sweep on a declined code scanning thread", () => {
  it("leaves it open while the alert is open or unreadable, and resolves it once dismissed", () => {
    // Alert 7 reads as open but its pull-request instances are unreadable,
    // so its state there is unknown; alert 8 has no fixture at all.
    const { dir, stateDir } = fixture({ 7: "open", 9: "dismissed" });
    writeThreads(dir, sweepThreads());

    const r = run(SWEEP, ["999"], dir, stateDir);
    expectSpawnExit(r, 0, "reconcile-replied-threads.ts");
    const actions = Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { threadId: string; action: string })
        .map((l) => [l.threadId, l.action]),
    );
    expect(actions).toEqual({
      T_open: "left-open",
      T_unreadable: "left-open",
      T_dismissed: "resolved",
      T_plain: "resolved",
    });
    expect(resolved(dir)).toEqual(["T_dismissed", "T_plain"]);
  });

  it("left open, still releases the hold its decline superseded", () => {
    const { dir, stateDir } = fixture({ 7: "open" });
    const comments = scanningComments("T_superseded", 7, [
      "**accepted** — will fix.",
      "**wont-fix** — accepted risk after all.",
    ]);
    writeThreads(dir, [{ id: "T_superseded", comments }]);
    holdAccepted(dir, stateDir, "T_superseded", comments[1]?.url ?? "");
    expect(heldKeys(dir, stateDir)).toBe("T_superseded");

    const r = run(SWEEP, ["999"], dir, stateDir);
    expectSpawnExit(r, 0, "reconcile-replied-threads.ts");
    expect(JSON.parse(r.stdout.trim())).toMatchObject({
      outcome: "wont-fix",
      action: "left-open",
    });
    expect(resolved(dir)).toEqual([]);
    expect(heldKeys(dir, stateDir)).toBe("");
  });
});

describe("the replied-thread sweep on a code-scanning moot or unidentified alert", () => {
  it("judges a code-scanning moot on its alert, never holding it, and keeps an unlinked one open", () => {
    const { dir, stateDir } = fixture({ 7: "open", 9: "dismissed" });
    writeThreads(dir, [
      {
        id: "T_moot_open",
        comments: scanningComments("T_moot_open", 7, ["**moot** — gone."]),
      },
      {
        id: "T_moot_dismissed",
        comments: scanningComments("T_moot_dismissed", 9, [
          "**moot** — dismissed already.",
        ]),
      },
      {
        id: "T_unlinked",
        comments: unlinkedComments("T_unlinked", [
          "**rejected** — not reachable.",
        ]),
      },
    ]);

    const r = run(SWEEP, ["999"], dir, stateDir);
    expectSpawnExit(r, 0, "reconcile-replied-threads.ts");
    const actions = Object.fromEntries(
      r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { threadId: string; action: string })
        .map((l) => [l.threadId, l.action]),
    );
    expect(actions).toEqual({
      T_moot_open: "left-open",
      T_moot_dismissed: "resolved",
      T_unlinked: "left-open",
    });
    expect(resolved(dir)).toEqual(["T_moot_dismissed"]);
    expect(heldKeys(dir, stateDir)).toBe("");
  });
});

describe("triage-thread.ts on a declined code scanning thread", () => {
  it("a retry reconciling a declined reply leaves it open while the alert is not confirmed dismissed (exit 4)", () => {
    for (const alerts of [{ 7: "open" }, {}]) {
      const { dir, stateDir } = fixture(alerts);
      writeNode(
        dir,
        scanningComments("T_retry", 7, ["**wont-fix** — accepted risk."]),
      );

      const r = run(
        TRIAGE,
        ["T_retry", "999"],
        dir,
        stateDir,
        "**wont-fix** — accepted risk.",
      );
      expectSpawnExit(r, 4, "triage-thread.ts");
      expect(r.stderr).toContain("not confirmed dismissed");
      expect(existsSync(join(dir, "posted.json"))).toBe(false);
      expect(resolved(dir)).toEqual([]);
    }
  });

  it("a fresh declined reply is posted, but the thread stays open over an open alert", () => {
    const { dir, stateDir } = fixture({ 7: "open" });
    writeNode(dir, scanningComments("T_fresh", 7, []));

    const r = run(
      TRIAGE,
      ["T_fresh", "999"],
      dir,
      stateDir,
      "**rejected** — the path is the repository's own.",
    );
    expectSpawnExit(r, 4, "triage-thread.ts");
    expect(existsSync(join(dir, "posted.json"))).toBe(true);
    expect(resolved(dir)).toEqual([]);
  });

  it("resolves once the alert is dismissed", () => {
    const { dir, stateDir } = fixture({ 7: "dismissed" });
    writeNode(dir, scanningComments("T_done", 7, ["**deferred** — tracked."]));

    const r = run(
      TRIAGE,
      ["T_done", "999"],
      dir,
      stateDir,
      "**deferred** — tracked.",
    );
    expectSpawnExit(r, 0, "triage-thread.ts");
    expect(resolved(dir)).toEqual(["T_done"]);
  });
});

describe("triage-thread.ts on a code-scanning moot or unidentified alert", () => {
  it("keeps a code-scanning thread with no details link open", () => {
    const { dir, stateDir } = fixture({});
    writeNode(
      dir,
      unlinkedComments("T_unlinked", ["**wont-fix** — accepted risk."]),
    );

    const r = run(
      TRIAGE,
      ["T_unlinked", "999"],
      dir,
      stateDir,
      "**wont-fix** — accepted risk.",
    );
    expectSpawnExit(r, 4, "triage-thread.ts");
    expect(resolved(dir)).toEqual([]);
  });
});

describe("triage-thread.ts retrying a code-scanning moot", () => {
  it("a moot blocked by an open alert is never held on retry, and resolves once the alert settles", () => {
    const { dir, stateDir } = fixture({ 7: "open" });
    writeNode(dir, scanningComments("T_moot", 7, []));
    const fresh = run(
      TRIAGE,
      ["T_moot", "999"],
      dir,
      stateDir,
      "**moot** — the code is gone.",
    );
    expectSpawnExit(fresh, 4, "triage-thread.ts (fresh moot)");
    expect(existsSync(join(dir, "posted.json"))).toBe(true);

    // The retry reconciles the posted reply instead of posting again.
    writeNode(
      dir,
      scanningComments("T_moot", 7, ["**moot** — the code is gone."]),
    );
    const blocked = run(
      TRIAGE,
      ["T_moot", "999"],
      dir,
      stateDir,
      "**moot** — x",
    );
    expectSpawnExit(blocked, 4, "triage-thread.ts (retry, open alert)");
    expect(heldKeys(dir, stateDir)).toBe("");
    expect(resolved(dir)).toEqual([]);

    const settled = fixture({ 7: "dismissed" }).dir;
    writeNode(
      settled,
      scanningComments("T_moot", 7, ["**moot** — the code is gone."]),
    );
    const done = run(
      TRIAGE,
      ["T_moot", "999"],
      settled,
      stateDir,
      "**moot** — x",
    );
    expectSpawnExit(done, 0, "triage-thread.ts (retry, dismissed alert)");
    expect(heldKeys(settled, stateDir)).toBe("");
    expect(resolved(settled)).toEqual(["T_moot"]);
  });

  it("releases the accepted hold an unmarked code-scanning moot superseded, once the thread is resolved", () => {
    // The moot resolved the thread, then cleanup was interrupted: the retry
    // (and --cleanup-only) must still release the superseded hold.
    for (const args of [
      ["T_cleanup", "999"],
      ["T_cleanup", "999", "--cleanup-only"],
    ]) {
      const { dir, stateDir } = fixture({ 7: "fixed" });
      const comments = scanningComments("T_cleanup", 7, [
        "**accepted** — will fix.",
        "**moot** — the code is gone.",
      ]);
      writeNode(dir, comments, true);
      holdAccepted(dir, stateDir, "T_cleanup", comments[1]?.url ?? "");
      expect(heldKeys(dir, stateDir)).toBe("T_cleanup");

      const r = run(
        TRIAGE,
        args,
        dir,
        stateDir,
        "**moot** — the code is gone.",
      );
      expectSpawnExit(r, 0, `triage-thread.ts ${args.join(" ")}`);
      expect(heldKeys(dir, stateDir)).toBe("");
      expect(existsSync(join(dir, "posted.json"))).toBe(false);
    }
  });
});

describe("heldThreadMayResolve on an opening comment without a readable author", () => {
  const GUARD = join(SCRIPTS, "lib", "scanner-sweep-guard.ts");

  function judge(opening: unknown): string {
    const { dir, stateDir } = fixture({});
    writeFileSync(
      join(dir, "node.json"),
      JSON.stringify({ data: { node: { comments: { nodes: [opening] } } } }),
    );
    const r = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { heldThreadMayResolve } = await import(${JSON.stringify(GUARD)});
console.log(JSON.stringify(await heldThreadMayResolve("T_held", "moot", 20)));`,
      ],
      {
        cwd: worktree,
        env: childEnv(dir, stateDir),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(r, 0, "heldThreadMayResolve");
    return r.stdout.toString().trim();
  }

  it("is indeterminate when the author is absent or has no login", () => {
    expect(judge({ body: "Unsafe path." })).toBe("null");
    expect(judge({ author: {}, body: "Unsafe path." })).toBe("null");
  });

  it("resolves a deleted author's or a person's thread without an alert read", () => {
    expect(judge({ author: null, body: "Unsafe path." })).toBe("true");
    expect(judge({ author: { login: "example-user" }, body: "x" })).toBe(
      "true",
    );
  });
});

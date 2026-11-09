import { seedAcceptedLadder } from "./ladder-verdict-fixture.ts";
import { createThreadWorktree } from "./thread-worktree-fixture.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
/** Integration tests for reply disposition and crash recovery against a fake forge. */

import { afterAll, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, delimiter } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
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

/** Strip Git overrides and pin subprocesses to the same live session. */
function scrubbedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "DRIVE_PR_WORKTREE" || v === undefined)
      continue;
    env[k] = v;
  }
  env.DRIVE_PR_SESSION = String(process.pid);
  return env;
}

beforeAll(() => {
  ({ tmpRoot, binDir, scratchWorktree } = createThreadWorktree(
    "triage-thread-",
    scrubbedGitEnv(),
  ));

  // A fake forge serving the thread read and mutation fixtures.
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
  *'viewer { login }'*'comments(first:100'*)
    tid=""
    for b in "$@"; do case "$b" in threadId=*) tid="\${b#threadId=}" ;; esac; done
    printf '{"data":{"viewer":{"login":"operator"},"node":{"id":"%s","comments":{"nodes":[{"author":{"login":"reviewer"},"createdAt":"2026-01-01T00:00:00Z"},{"author":{"login":"operator"},"createdAt":"2026-01-01T00:01:00Z"}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}' "$tid"
    exit 0 ;;
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
  authorType?: "User" | "Bot";
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
            author: { login: c.author, __typename: c.authorType ?? "User" },
            authorAssociation: c.authorAssociation,
            body: c.body,
          })),
        },
      },
    },
  });
}

export function writeFixtureDir(): { dir: string; stateDir: string } {
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  const stateDir = scopedStateDir(join(dir, "state"), scratchWorktree);
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { dir, stateDir };
}

export function writeNode(
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

export function runTriage(
  args: string[],
  body: string,
  fixtureDir: string,
  stateDir: string,
): { stdout: string; stderr: string; exitCode: number } {
  // This fixture models triage already completed before posting accepted replies.
  if (body.startsWith("**accepted**"))
    seedAcceptedLadder(stateDir, args[0] ?? "");
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

/** Simulate a pass that posted before recording a hold. The marker override
 * models a legitimately marked prior reply, separate from marker refusal tests. */
export function postReplyDirectly(
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

export function postedCount(fixtureDir: string): number {
  return existsSync(fixtureDir)
    ? readdirSync(fixtureDir).filter((f) => f.startsWith("posted-")).length
    : 0;
}

export function resolvedCount(fixtureDir: string): number {
  return existsSync(fixtureDir)
    ? readdirSync(fixtureDir).filter((f) => f.startsWith("resolved-")).length
    : 0;
}

/** The `variables.body` GraphQL sent for the Nth post the gh stub recorded. */
export function postedBody(fixtureDir: string, n: number): string {
  const raw = readFileSync(join(fixtureDir, `posted-${n}.json`), "utf8");
  return (JSON.parse(raw) as { variables: { body: string } }).variables.body;
}

export function heldKeys(stateDir: string): string {
  return Bun.spawnSync([process.execPath, DRIVE_STATE, "held-keys", "999"], {
    cwd: scratchWorktree,
    env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
  })
    .stdout.toString()
    .trim();
}

export function held(stateDir: string): Array<Record<string, unknown>> {
  const out = Bun.spawnSync([process.execPath, DRIVE_STATE, "held", "999"], {
    cwd: scratchWorktree,
    env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
  }).stdout.toString();
  return JSON.parse(out);
}

/** Seed a held entry directly, bypassing triage-thread.ts entirely — for
 * setting up a pre-existing stale hold a fix under test must clean up. */
export function holdDirectly(
  stateDir: string,
  key: string,
  outcome: string,
  commentUrl: string,
): void {
  if (outcome === "accepted") seedAcceptedLadder(stateDir, key);
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

/** Seed the human starter used by leave-open disposition cases. */
export function writeHumanFinding(dir: string): void {
  writeNode(dir, {
    comments: [
      {
        author: "reviewer",
        authorAssociation: "MEMBER",
        body: "Please check this finding.",
      },
    ],
  });
}

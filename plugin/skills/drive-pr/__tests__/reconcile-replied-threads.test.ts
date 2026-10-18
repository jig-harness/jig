/**
 * reconcile-replied-threads.test.ts
 *
 * `reconcile-replied-threads.ts` extracts SKILL.md § 3's crash-recovery
 * reconciliation — "a thread already carrying a trusted outcome-token reply is
 * not live work, settle it" — into a script that runs WITHOUT passing
 * `drive-status.ts`'s round-readiness gate. That gate answers "is there new
 * reviewer work"; reconciling an already-posted reply is a different question,
 * and coupling the two is what let a reply sit unresolved indefinitely on a PR
 * that never gets a reviewer check-run at all (a CONFLICTING PR, as measured on
 * a live drive).
 *
 * These are subprocess integration tests against a stubbed `gh`, mirroring
 * drive-pr.test.ts's own convention (the real script, spawned for real,
 * against fixture files rather than a paraphrase of the GraphQL shape).
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
import { join, delimiter } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SCRIPT = join(SCRIPTS, "reconcile-replied-threads.ts");
const DRIVE_STATE = join(SCRIPTS, "drive-state.ts");

let tmpRoot: string;
let binDir: string;
let scratchWorktree: string; // git-init'd cwd for every spawned script — see beforeAll

/**
 * `process.env` minus every git-repo-location variable, for EVERY spawn in
 * this file — the `git init` below, `runTs`, `heldKeys`, and the direct
 * `drive-state.ts hold` calls.
 *
 * Scrubbing only the `git init` call was the gap: this suite runs under the
 * `drive-pr-selftest` pre-commit hook, which EXPORTS GIT_DIR/GIT_WORK_TREE
 * pointing at the real repository, and those override `cwd`. The scripts
 * under test resolve their actor identity with `git rev-parse
 * --show-toplevel` (lib/state/actor.ts), so an unscrubbed spawn resolves the
 * ENCLOSING worktree instead of `scratchWorktree` — and actor identity is
 * exactly what decides whether a hold is this driver's to release, which
 * several tests here assert on. The hook-env-leak class.
 *
 * Prefix-matched, not an enumerated list: an enumeration is one
 * counterexample behind permanently (this file's own carried four of the
 * seven location vars). `GIT_` is what drive-pr.test.ts, drives.test.ts and
 * resolve-review-comments/__tests__/scripts.test.ts already use, and nothing
 * here needs a GIT_* var preserved.
 */
function scrubbedGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  return env;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "reconcile-replied-"));
  binDir = join(tmpRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  // The scripts under test resolve their actor identity from the git
  // worktree they are spawned in (lib/state/actor.ts, `git rev-parse
  // --show-toplevel`). Spawning them in this test process's own cwd would make
  // that an ambient dependency on the ENCLOSING checkout being a git
  // worktree — false on the remote gates host and on a Blacksmith Testbox,
  // where the synced checkout has no `.git` at all. A bare
  // `git init` scratch dir is all identity resolution needs (no history is
  // read); the git-repo-location env vars are scrubbed so a hook-inherited
  // GIT_DIR cannot repoint the init at a real repo (the hook-env-leak
  // class). `scrubbedGitEnv()` is used at EVERY spawn below,
  // not just this one — see its own comment.
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

  // A `gh` stub that serves fixture files from $RRT_FIXTURES. Honours the one
  // `-q`/`--jq` filter form the scripts under test actually use, and detects
  // the `resolveReviewThread` mutation by its literal presence in argv — the
  // same discrimination drive-pr.test.ts's own stub uses, since the mutation
  // and an ordinary thread-list query both arrive as `gh api graphql ...`.
  const stub = `#!/usr/bin/env bash
set -euo pipefail
(
  # This fixture models ambient PR/repository lookup, so none of its commands
  # accepts an extra selector after the two-word subcommand. Check positionals
  # explicitly, not just recognized flags —
  # a flag that lost its leading dashes (\`--limit 1000\` → \`limit 1000\`)
  # would otherwise arrive as bare words this loop never looked at, still
  # bypassing the guard into a canned fixture response.
  expected_json=''
  case "$1 $2" in
    'pr list') allowed=' --state --json --limit ' ; max_positional=0 ; is_pr_list=1 ; expected_json='number' ;;
    'pr view') allowed=' --json --jq -q ' ; max_positional=0 ; expected_json='number' ;;
    'repo view') allowed=' --json --jq -q ' ; max_positional=0 ; expected_json='owner,name' ;;
    'api graphql') allowed=' -f -F --input --jq -q --paginate --slurp ' ; max_positional=0 ;;
    *) echo "unexpected fake gh command: $*" >&2; exit 2 ;;
  esac
  shift 2
  needs_value=0
  has_positional=0
  seen_limit=0
  seen_state=0
  json_fields=''
  jq_filter=''
  value_flag=''
  for argument in "$@"; do
    if [[ "$needs_value" -eq 1 ]]; then
      [[ -n "$argument" && "$argument" != --* ]] || { echo "gh: missing flag value" >&2; exit 2; }
      if [[ "$value_flag" == --limit ]]; then
        [[ "$argument" == 1000 ]] || { echo "gh: unsupported --limit value: $argument" >&2; exit 2; }
        seen_limit=1
      fi
      if [[ "$value_flag" == --state ]]; then
        [[ "$argument" == open ]] || { echo "gh: unsupported --state value: $argument" >&2; exit 2; }
        seen_state=1
      fi
      if [[ "$value_flag" == --json ]]; then json_fields="$argument"; fi
      if [[ "$value_flag" == -q || "$value_flag" == --jq ]]; then jq_filter="$argument"; fi
      needs_value=0; continue
    fi
    case "$argument" in
      -*)
        case "$allowed" in
          *" $argument "*)
            case "$argument" in --paginate|--slurp) ;; *) needs_value=1; value_flag="$argument" ;; esac ;;
          *) echo "gh: unknown flag: $argument" >&2; exit 2 ;;
        esac ;;
      *)
        [[ -n "$argument" ]] || { echo 'gh: empty positional argument' >&2; exit 2; }
        has_positional=$(( has_positional + 1 )) ;;
    esac
  done
  [[ "$needs_value" -eq 0 ]] || { echo 'gh: missing flag value' >&2; exit 2; }
  [[ "$json_fields" == "$expected_json" ]] || { echo "gh: expected --json $expected_json" >&2; exit 2; }
  if [[ "$has_positional" -gt "$max_positional" ]]; then
    echo "gh: accepts at most $max_positional arg(s), received $has_positional" >&2; exit 2
  fi
  if [[ "\${is_pr_list:-0}" -eq 1 && "$seen_limit" -ne 1 ]]; then
    echo 'gh: pr list requires --limit 1000' >&2; exit 2
  fi
  if [[ "\${is_pr_list:-0}" -eq 1 && "$seen_state" -ne 1 ]]; then
    echo 'gh: pr list requires --state open' >&2; exit 2
  fi
  if [[ "$expected_json" == number && "\${is_pr_list:-0}" -eq 0 && "$jq_filter" != .number ]] ||
     [[ "$expected_json" == owner,name && "$jq_filter" != '.owner.login + " " + .name' ]]; then
    echo "gh: unexpected jq filter: $jq_filter" >&2; exit 2
  fi
) || exit $?
F="\${RRT_FIXTURES:?fixture dir not set}"

filter=""
prev=""
for a in "$@"; do
  case "$prev" in -q|--jq) filter="$a" ;; esac
  prev="$a"
done

emit() {
  local body
  body=$(cat "$1")
  if [ -n "$filter" ]; then printf '%s' "$body" | jq -r "$filter"; else printf '%s' "$body"; fi
}

for a in "$@"; do
  case "$a" in
    *"pullRequest { number state }"*)
      # The review skill reads the owning PR's liveness immediately before
      # every thread mutation; every fixture PR here is open.
      tid=""
      for b in "$@"; do
        case "$b" in threadId=*) tid="\${b#threadId=}" ;; esac
      done
      printf '{"data":{"node":{"__typename":"PullRequestReviewThread","id":"%s","pullRequest":{"number":999,"state":"OPEN"}}}}' "$tid"
      exit 0 ;;
    *resolveReviewThread*)
      failing=0
      for b in "$@"; do
        case "$b" in
          # PRRT_fail_resolve simulates an API/timeout failure on the
          # resolveReviewThread mutation, without touching this stub's
          # otherwise-uniform success path for every other thread.
          threadId=PRRT_fail_resolve) failing=1 ;;
          threadId=*) printf '%s\\n' "\${b#threadId=}" >> "$F/resolved-threads.jsonl" ;;
        esac
      done
      if [ "$failing" -eq 1 ]; then
        echo "gh-stub: simulated resolveReviewThread failure" >&2
        exit 1
      fi
      out='{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}'
      if [ -n "$filter" ]; then printf '%s' "$out" | jq -r "$filter"; else printf '%s' "$out"; fi
      exit 0 ;;
  esac
done

case "\${1:-}" in
  pr)
    case "\${2:-}" in
      list) emit "$F/pr-list.json" ;;
      view) emit "$F/pr-view.json" ;;
      *) echo "gh-stub: unhandled pr subcommand: $*" >&2; exit 1 ;;
    esac
    exit 0 ;;
  repo) emit "$F/repo-view.json"; exit 0 ;;
  api)
    is_graphql=0
    for a in "$@"; do
      case "$a" in graphql) is_graphql=1 ;; esac
    done
    if [ "$is_graphql" -eq 1 ]; then
      # list-unresolved-threads.ts passes the PR number as \`-F pr=$pr\` — route
      # to a per-PR fixture when one exists (\`threads-<pr>.json\`), so a
      # regression that queries the wrong PR number is distinguishable from
      # one that queries the right one, instead of every PR silently getting
      # the same canned response.
      prnum=""
      for a in "$@"; do
        case "$a" in pr=*) prnum="\${a#pr=}" ;; esac
      done
      if [ -n "$prnum" ] && [ -f "$F/threads-$prnum.json" ]; then
        emit "$F/threads-$prnum.json"
      else
        emit "$F/threads.json"
      fi
      exit 0
    fi ;;
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
  bot?: boolean;
}

interface ThreadFixture {
  id: string;
  path?: string;
  line?: number;
  isOutdated?: boolean;
  commentsTruncated?: boolean;
  comments: CommentFixture[];
}

let fixtureSeq = 0;

function threadsPayload(threads: ThreadFixture[]) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads.map((t) => ({
              id: t.id,
              isResolved: false,
              isOutdated: t.isOutdated ?? false,
              path: t.path ?? "a.ts",
              line: t.line ?? 1,
              comments: {
                pageInfo: { hasNextPage: t.commentsTruncated ?? false },
                // Each comment gets its OWN url (thread id + index), not one
                // shared per thread — reconcile-replied-threads.ts keys its
                // provenance tracking on the INDIVIDUAL qualifying comment's
                // permalink, so a fixture
                // where every comment shared one url couldn't distinguish
                // "the same reply" from "a different one" any better than the
                // bug it exists to catch.
                nodes: t.comments.map((c, i) => ({
                  url: `https://example.invalid/${t.id}/comment-${i}`,
                  author: {
                    login: c.author,
                    __typename: c.bot ? "Bot" : "User",
                  },
                  authorAssociation: c.authorAssociation,
                  body: c.body,
                })),
              },
            })),
          },
        },
      },
    },
  });
}

function writeFixture(threads: ThreadFixture[]): {
  dir: string;
  stateDir: string;
} {
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  const stateDir = join(dir, "state");
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(join(dir, "pr-view.json"), JSON.stringify({ number: 999 }));
  // The REAL shape `gh repo view --json owner,name` returns, not a
  // pre-flattened string: list-unresolved-threads.ts asks for it through
  // `-q '.owner.login + " " + .name'`, and its `ghOrExit` exits on a nonzero
  // `gh`, so a fixture the filter cannot index kills the enumeration outright
  // rather than being silently absorbed the way the bash predecessor's
  // `read -r owner repo <<<"$(...)"` absorbed it.
  writeFileSync(
    join(dir, "repo-view.json"),
    JSON.stringify({ owner: { login: "example-org" }, name: "example-repo" }),
  );
  writeFileSync(join(dir, "pr-list.json"), JSON.stringify([{ number: 999 }]));
  writeFileSync(join(dir, "threads.json"), threadsPayload(threads));

  return { dir, stateDir };
}

// Gives a specific PR number its OWN thread payload inside an already-written
// fixture dir — the gh stub routes `threads-<pr>.json` ahead of the default
// `threads.json` when it exists (keyed off the `-F pr=<pr>` GraphQL variable
// list-unresolved-threads.ts sends). Without this, every PR the script
// enumerates gets the identical fixture regardless of which PR number was
// actually passed downstream, so a regression that always queried the wrong
// PR would still pass.
function writeThreadsFileForPr(
  dir: string,
  pr: number,
  threads: ThreadFixture[],
) {
  writeFileSync(join(dir, `threads-${pr}.json`), threadsPayload(threads));
}

// Every script under test is TypeScript now, so it is spawned under THIS
// process's runtime (`process.execPath`) rather than relying on a shebang —
// the same `tsArgv` convention the scripts themselves use to spawn each other,
// and what makes the suite runnable where a `#!/usr/bin/env bun` line is not
// honoured at all.
function runTs(
  script: string,
  args: string[],
  fixtureDir: string,
  stateDir: string,
  ghDir = binDir,
): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync([process.execPath, script, ...args], {
    // The scratch git worktree, never this process's own cwd — see beforeAll.
    cwd: scratchWorktree,
    env: {
      ...scrubbedGitEnv(),
      PATH: `${ghDir}${delimiter}${process.env.PATH}`,
      RRT_FIXTURES: fixtureDir,
      DRIVE_PR_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 1,
  };
}

function run(
  args: string[],
  fixtureDir: string,
  stateDir: string,
  ghDir = binDir,
): { stdout: string; stderr: string; exitCode: number } {
  return runTs(SCRIPT, args, fixtureDir, stateDir, ghDir);
}

/**
 * A regression class no text scan over this script's source can rule out:
 * a consumer that builds its OWN Set
 * with the same initial members as `TRUSTED_ASSOCIATIONS` — `const trusted =
 * new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])` — passes every import check,
 * every "no local const TRUSTED_ASSOCIATIONS" check, and every call-site
 * regex, because the decoy's members happen to match today. It only reveals
 * itself once the two sets DIVERGE.
 *
 * This forces that divergence at runtime instead of reading source text: it
 * mutates the actually-exported `TRUSTED_ASSOCIATIONS` object before
 * `reconcile-replied-threads.ts` ever loads, then dynamically imports the
 * script (its `runMain(...)` call at module top level fires unconditionally
 * on import — no `import.meta.main` guard — so a plain `import()` runs it
 * exactly as a direct `bun reconcile-replied-threads.ts` invocation would).
 * Module resolution is cached by absolute path within one process, so the
 * script's own `import { TRUSTED_ASSOCIATIONS } from './summary-findings.ts'`
 * resolves to the SAME mutated object — there is no other way for it to
 * observe the deletion. A consumer holding a structurally separate copy
 * would not: it would keep trusting the removed association, and this test
 * would fail to see the outcome flip.
 */
function writeMutationWrapper(dir: string, deleteAssociation: string): string {
  const wrapperPath = join(dir, "mutation-wrapper.ts");
  writeFileSync(
    wrapperPath,
    [
      `import { TRUSTED_ASSOCIATIONS } from ${JSON.stringify(join(SCRIPTS, "summary-findings.ts"))};`,
      `TRUSTED_ASSOCIATIONS.delete(${JSON.stringify(deleteAssociation)});`,
      `await import(${JSON.stringify(SCRIPT)});`,
      "",
    ].join("\n"),
  );
  return wrapperPath;
}

function heldKeys(stateDir: string): string {
  return Bun.spawnSync([process.execPath, DRIVE_STATE, "held-keys", "999"], {
    cwd: scratchWorktree, // same reasoning as runTs — see beforeAll
    env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
  })
    .stdout.toString()
    .trim();
}

function lines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("reconcile-replied-threads.ts", () => {
  it("the fake gh rejects selectors that change the fixture population", () => {
    const ghPath = join(binDir, "gh");
    const { dir } = writeFixture([]);
    const env = { ...process.env, RRT_FIXTURES: dir };
    for (const [args, diagnostic] of [
      [
        [
          "pr",
          "list",
          "--state",
          "closed",
          "--limit",
          "1000",
          "--json",
          "number",
        ],
        "unsupported --state value",
      ],
      [
        ["pr", "list", "--limit", "1000", "--json", "number"],
        "requires --state open",
      ],
      [
        ["pr", "view", "999", "--json", "number", "-q", ".number"],
        "accepts at most 0 arg(s)",
      ],
      [
        [
          "repo",
          "view",
          "wrong/repo",
          "--json",
          "owner,name",
          "-q",
          '.owner.login + " " + .name',
        ],
        "accepts at most 0 arg(s)",
      ],
    ] as const) {
      const result = Bun.spawnSync([ghPath, ...args], { env });
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(diagnostic);
    }
  });

  it("the fake gh requires the JSON projections for listing and repository lookup", () => {
    const ghPath = join(binDir, "gh");
    const { dir } = writeFixture([]);
    for (const args of [
      ["pr", "list", "--state", "open", "--limit", "1000"],
      ["pr", "list", "--state", "open", "--limit", "1000", "--json", "state"],
      ["repo", "view", "--json", "name"],
    ]) {
      const result = Bun.spawnSync([ghPath, ...args], {
        env: { ...process.env, RRT_FIXTURES: dir },
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("expected --json");
    }
    const listed = Bun.spawnSync(
      [
        ghPath,
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number",
      ],
      { env: { ...process.env, RRT_FIXTURES: dir } },
    );
    expect(listed.exitCode).toBe(0);
  });

  it("the fake gh guard rejects a stray positional argument — a flag that lost its dashes", () => {
    // The guard's flag loop only ever inspects arguments starting with `-`;
    // a production call whose `--limit` lost its dashes (`limit 1000`) would
    // otherwise arrive as two bare words this loop never looked at, still
    // reaching `pr-list.json`'s canned response. `pr list` never legitimately
    // takes a positional argument, so any is now rejected outright.
    const ghPath = join(binDir, "gh");
    const { dir } = writeFixture([]);
    const result = Bun.spawnSync(
      [
        ghPath,
        "pr",
        "list",
        "--state",
        "open",
        "limit",
        "1000",
        "--json",
        "number",
      ],
      { env: { ...process.env, RRT_FIXTURES: dir } },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("accepts at most 0 arg(s)");

    // Sanity: the well-formed call against the same fixture dir is still
    // accepted, so the tightened guard is not merely rejecting everything.
    const ok = Bun.spawnSync(
      [
        ghPath,
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number",
      ],
      { env: { ...process.env, RRT_FIXTURES: dir } },
    );
    expect(ok.exitCode).toBe(0);
  });

  it("the fake gh guard rejects an empty value for a required flag", () => {
    const result = Bun.spawnSync([
      join(binDir, "gh"),
      "pr",
      "list",
      "--limit",
      "",
      "--json",
      "number",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("missing flag value");
  });

  it("the fake gh requires the all-open listing limit", () => {
    const result = Bun.spawnSync([
      join(binDir, "gh"),
      "pr",
      "list",
      "--json",
      "number",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("requires --limit 1000");
  });

  it("resolves a thread whose last trusted comment opens with **rejected** — a merit claim, not fix-dependent", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_rejected",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — already handled upstream.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_rejected",
      outcome: "rejected",
      action: "resolved",
    });
    const resolved = readFileSync(
      join(dir, "resolved-threads.jsonl"),
      "utf8",
    ).trim();
    expect(resolved).toBe("PRRT_rejected");
  });

  it("skips a merit reply carrying the --leave-open marker instead of resolving it — the other reader of the same durable choice", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_leaveopen_marked",
        comments: [
          {
            author: "a-human-reviewer",
            authorAssociation: "MEMBER",
            body: "some finding",
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**wont-fix** — declined, leaving this human thread for its author to close.\n\n<!-- triage-thread:leave-open -->",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_leaveopen_marked",
      outcome: "wont-fix",
      action: "left-open",
    });
    // Nothing resolved — the whole point of the marker.
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
  });

  it("a marked reply whose outcome is `moot` is ALSO left open, not re-held — this file has no --moot-pending-push equivalent, so the marker alone must decide", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_leaveopen_marked_moot",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**moot** — the anchored code was already removed; leaving this human thread for its author to close.\n\n<!-- triage-thread:leave-open -->",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_leaveopen_marked_moot",
      outcome: "moot",
      action: "left-open",
    });
    // Not re-held either — a held entry here would let step 6 resolve the
    // very thread the marker deliberately left open.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("an ACCEPTED reply that happens to contain the marker text is NOT treated as left-open, and its own hold is NOT released — the marker only means something for a merit outcome or moot", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_accepted_with_marker_text",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            // The documented supersession path lets a trusted author post
            // ANY reply directly, bypassing triage-thread.ts's own
            // marker-gating entirely — this models a confused or malicious
            // accepted reply that happens to end with the marker's exact
            // text.
            body: "**accepted** — fixed it.\n\n<!-- triage-thread:leave-open -->",
          },
        ],
      },
    ]);
    const existingUrl =
      "https://example.invalid/PRRT_accepted_with_marker_text/comment-0";
    Bun.spawnSync(
      [
        process.execPath,
        DRIVE_STATE,
        "hold",
        "999",
        "--key",
        "PRRT_accepted_with_marker_text",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        existingUrl,
      ],
      {
        cwd: scratchWorktree,
        env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
      },
    );
    expect(heldKeys(stateDir)).toBe("PRRT_accepted_with_marker_text");

    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_accepted_with_marker_text",
      outcome: "accepted",
      action: "held",
    });
    // Without this fix: 'left-open', and releaseStaleHoldIfSeen would have
    // deleted this accepted hold for a fix nothing ever verified.
    expect(heldKeys(stateDir)).toBe("PRRT_accepted_with_marker_text");
  });

  it("a marked left-open reply STILL releases a stale prior hold on the same key — leaving a thread open is orthogonal to an earlier hold going stale", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_leaveopen_stale_hold",
        comments: [
          // The earlier accepted reply the pre-seeded hold below represents.
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** — will fix in a follow-up commit.",
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**wont-fix** — actually, declined on reflection; leaving this human thread for its author to close.\n\n<!-- triage-thread:leave-open -->",
          },
        ],
      },
    ]);
    Bun.spawnSync(
      [
        process.execPath,
        DRIVE_STATE,
        "hold",
        "999",
        "--key",
        "PRRT_leaveopen_stale_hold",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/PRRT_leaveopen_stale_hold/comment-0",
      ],
      {
        cwd: scratchWorktree,
        env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
      },
    );
    expect(heldKeys(stateDir)).toBe("PRRT_leaveopen_stale_hold");

    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_leaveopen_stale_hold",
      outcome: "wont-fix",
      action: "left-open",
    });
    // The thread stays unresolved (left-open)...
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
    // ...but the stale accepted hold is gone, not left for step 6 to
    // resolve-held-thread.ts the very thread this marker left open.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("continues past a failed resolve-thread.ts mutation instead of aborting the whole sweep", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_fail_resolve",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — the gh stub simulates a failure resolving this one.",
          },
        ],
      },
      {
        id: "PRRT_after_failure",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**wont-fix** — should still be reached and resolved.",
          },
        ],
      },
    ]);
    const { stdout, stderr, exitCode } = run(["999"], dir, stateDir);
    // Nonzero — a failed mutation must not read as a clean sweep.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("resolve-thread.ts failed");
    const out = lines(stdout);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_fail_resolve",
      outcome: "rejected",
      action: "failed-resolve",
    });
    // The thread AFTER the failure was still processed — a failed mutation did
    // not abort the script — and genuinely resolved (not merely attempted).
    expect(out[1]).toMatchObject({
      threadId: "PRRT_after_failure",
      outcome: "wont-fix",
      action: "resolved",
    });
    const resolved = readFileSync(
      join(dir, "resolved-threads.jsonl"),
      "utf8",
    ).trim();
    expect(resolved).toBe("PRRT_after_failure");
  });

  it("holds — never resolves — a thread whose last trusted comment opens with **accepted**, because the fix is unverified", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_accepted",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** — fixed the missing guard in abc1234.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_accepted",
      outcome: "accepted",
      action: "held",
    });
    // Never resolved.
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
    // But durably held, so a real /drive-pr round's step 6 can finish it later.
    expect(heldKeys(stateDir)).toBe("PRRT_accepted");
  });

  it("never mutates anything under --dry-run, but still reports the outcome it would take", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_moot",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**moot** — the anchored code was removed in a later round.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999", "--dry-run"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_moot",
      action: "would-hold",
    });
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
    // Dry-run holds nothing either.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("reports a truncated thread as needs-human and takes no action, even with a qualifying reply visible", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_truncated",
        commentsTruncated: true,
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** — visible in the prefix, but a later reply past the cap could supersede this.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      threadId: "PRRT_truncated",
      action: "needs-human",
    });
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
  });

  it("ignores a qualifying-grammar reply from an untrusted author — a thread is world-commentable", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_spoofed",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "random-visitor",
            authorAssociation: "NONE",
            body: "**accepted** — I am not a maintainer, this reply should not count.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    expect(lines(stdout)).toHaveLength(0);
  });

  it("genuinely depends on the LIVE TRUSTED_ASSOCIATIONS object, not a same-valued copy", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_member_mutated",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — already handled upstream.",
          },
        ],
      },
    ]);
    // Baseline, unmutated: a MEMBER reply qualifies today (mirrors the plain
    // **rejected** test above) — the control for the comparison below.
    const baseline = run(["999"], dir, stateDir);
    expect(baseline.exitCode).toBe(0);
    expect(lines(baseline.stdout)).toHaveLength(1);

    // Same fixture, but with 'MEMBER' deleted from the object
    // reconcile-replied-threads.ts actually imports, before it loads. If the
    // script reads that live object, MEMBER is no longer trusted and the
    // identical reply is ignored — same as the NONE case above. If it instead
    // holds a structurally separate copy that happened to start with the same
    // three members, the mutation is invisible to it and this would still
    // report one qualifying reply, exactly like the baseline.
    const wrapper = writeMutationWrapper(dir, "MEMBER");
    const mutated = runTs(wrapper, ["999"], dir, stateDir);
    expect(mutated.exitCode).toBe(0);
    expect(lines(mutated.stdout)).toHaveLength(0);
  });

  it("ignores a trusted comment that does not open with the outcome-token grammar", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_prose",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "Looking into this, will follow up.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    expect(lines(stdout)).toHaveLength(0);
  });

  it("takes the LAST qualifying trusted reply, not the first, when a thread has more than one", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_superseded",
        comments: [
          {
            author: "codex",
            authorAssociation: "NONE",
            body: "some finding",
            bot: true,
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — thought this was a false positive.",
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** — actually real, fixed in a follow-up commit.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({ outcome: "accepted", action: "held" });
    expect(existsSync(join(dir, "resolved-threads.jsonl"))).toBe(false);
  });

  it("releases a STALE prior held entry when a superseding reply merit-resolves the thread", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_flip_to_rejected",
        comments: [
          // The EARLIER accepted reply the hold below represents. A real,
          // non-truncated GraphQL thread listing returns the FULL comment
          // history, not just the latest reply — so this pass's own
          // `thread.comments` genuinely includes it (identity, not read timing,
          // is what makes a held entry safe to delete — its commentUrl must be
          // one of the comments THIS listing actually read).
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** — will fix in a follow-up commit.",
          },
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — actually a false positive after all.",
          },
        ],
      },
    ]);
    // Simulate a PRIOR round having already held this same thread as
    // `accepted` — the reply a later, superseding `rejected` (in the fixture
    // above) has since overtaken. Left standing, step 6 would later try to
    // resolve-held-thread.ts an already-resolved thread. The comment-url
    // matches the fixture's own generated url for comment index 0 (the
    // accepted reply above) — the exact identity this pass's cleanup must
    // recognise as accounted-for.
    Bun.spawnSync(
      [
        process.execPath,
        DRIVE_STATE,
        "hold",
        "999",
        "--key",
        "PRRT_flip_to_rejected",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/PRRT_flip_to_rejected/comment-0",
      ],
      // Same scratch cwd as every other spawn here: the hold's recorded
      // actor derives from the git worktree it runs in, and a hold taken
      // from a DIFFERENT worktree than the reconcile pass would (correctly)
      // not be this pass's to release — which is not what this test models.
      {
        cwd: scratchWorktree,
        env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
      },
    );
    expect(heldKeys(stateDir)).toBe("PRRT_flip_to_rejected");

    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({ outcome: "rejected", action: "resolved" });

    // The stale accepted hold must be gone, not left for step 6 to choke on.
    expect(heldKeys(stateDir)).toBe("");
  });

  it("does NOT delete a held entry whose commentUrl is not among the comments this pass read", () => {
    // Models a concurrent driver's hold for a reply that is genuinely NOT
    // part of what this pass's own listing saw — a URL this fixture never
    // generates for this thread at all. Three straight rounds (16-18) tried
    // to distinguish "stale" from "not yet accounted for" by WHEN a snapshot
    // was taken relative to the comment listing; each attempt only moved the
    // race to the other side of that timing boundary. Identity is what
    // actually settles it: a held commentUrl absent from `thread.comments`
    // must never be deleted, no matter when it was read.
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_unaccounted_hold",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**rejected** — actually a false positive after all.",
          },
        ],
      },
    ]);
    Bun.spawnSync(
      [
        process.execPath,
        DRIVE_STATE,
        "hold",
        "999",
        "--key",
        "PRRT_unaccounted_hold",
        "--kind",
        "thread",
        "--outcome",
        "accepted",
        "--comment-url",
        "https://example.invalid/a-reply-this-pass-never-saw",
      ],
      // Scratch cwd for actor-identity consistency — see the flip-to-rejected
      // test above. This test's point is URL identity, not actor identity.
      {
        cwd: scratchWorktree,
        env: { ...scrubbedGitEnv(), DRIVE_PR_STATE_DIR: stateDir },
      },
    );
    expect(heldKeys(stateDir)).toBe("PRRT_unaccounted_hold");

    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out[0]).toMatchObject({ outcome: "rejected", action: "resolved" });

    // The thread resolved, but the unaccounted-for hold must survive —
    // deleting it would silently discard a promise this pass never saw.
    expect(heldKeys(stateDir)).toBe("PRRT_unaccounted_hold");
  });

  it("sweeps every PR named on argv independently", () => {
    // Distinct threads per PR — via threads-<pr>.json — so a regression that
    // queries every PR with the same (wrong) number would fail this test:
    // it would surface PR 999's thread/outcome twice instead of each PR's
    // own.
    const fx1 = writeFixture([
      {
        id: "PRRT_a",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**wont-fix** — declined per the triage rubric.",
          },
        ],
      },
    ]);
    writeThreadsFileForPr(fx1.dir, 998, [
      {
        id: "PRRT_c",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**deferred** — real but out of scope; ENG-9999 tracks it.",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999", "998"], fx1.dir, fx1.stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.pr)).toEqual([999, 998]);
    expect(out[0]).toMatchObject({
      pr: 999,
      threadId: "PRRT_a",
      outcome: "wont-fix",
    });
    expect(out[1]).toMatchObject({
      pr: 998,
      threadId: "PRRT_c",
      outcome: "deferred",
    });
  });

  it("refuses --all-open combined with an explicit PR number", () => {
    const { dir, stateDir } = writeFixture([]);
    const { exitCode, stderr } = run(["999", "--all-open"], dir, stateDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("mutually exclusive");
  });

  it("recognizes all five outcome tokens as qualifying", () => {
    const tokens = ["accepted", "rejected", "wont-fix", "deferred", "moot"];
    const { dir, stateDir } = writeFixture(
      tokens.map((t) => ({
        id: `PRRT_tok_${t}`,
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: `**${t}** — reason.`,
          },
        ],
      })),
    );
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out.map((o) => o.outcome)).toEqual(tokens);
  });

  // qualifyingOutcome() duplicates reply-to-thread.ts's own posting grammar
  // by design (SKILL.md § 3: self-contained scripts, not a shared source) —
  // exactly the kind of duplication that drifts silently. Each row is a body
  // that must NOT qualify; a thread with none of its comments qualifying
  // produces no output line at all (see the "ignores a trusted comment that
  // does not open with the outcome-token grammar" case above for the
  // single-case form this generalizes).
  it("rejects every malformed or boundary-violating body, matching reply-to-thread.ts exactly", () => {
    const nonQualifying: Array<[string, string]> = [
      ["bare token, no boundary or reason", "**accepted**"],
      ["punctuation-only reason", "**accepted** —"],
      ["missing space/tab boundary", "**accepted**oops"],
      ["wrong case", "**ACCEPTED** reason"],
      ["misspelled token", "**wontfix** reason"],
      [
        // U+2003 EM SPACE, written as an ESCAPE rather than the literal
        // character: a bare one is indistinguishable from an ASCII space on
        // sight, so an editor, a formatter or a copy-paste that normalises it
        // turns this row into a body that legitimately qualifies — the probe
        // then asserts the opposite of what it reads as, and passes for the
        // wrong reason.
        "unicode whitespace boundary (not ASCII space/tab)",
        "**accepted**\u2003reason",
      ],
      ["reason only on a later line", "**accepted**\nreason"],
      ["prefix text before the token", "prefix **accepted** reason"],
      ["token on a later line, not the first", "intro\n**accepted** reason"],
      ["empty body", ""],
    ];
    const { dir, stateDir } = writeFixture(
      nonQualifying.map(([, body], i) => ({
        id: `PRRT_bad_${i}`,
        comments: [
          { author: "example-user", authorAssociation: "MEMBER", body },
        ],
      })),
    );
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    expect(lines(stdout)).toHaveLength(0);
  });

  it("accepts multiple spaces/tabs as the boundary and an ASCII-digit-only reason", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_spaces",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted**   reason",
          },
        ],
      },
      {
        id: "PRRT_tabs",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted**\t\treason",
          },
        ],
      },
      {
        id: "PRRT_digits",
        comments: [
          {
            author: "example-user",
            authorAssociation: "MEMBER",
            body: "**accepted** 123",
          },
        ],
      },
    ]);
    const { stdout, exitCode } = run(["999"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out.map((o) => o.threadId)).toEqual([
      "PRRT_spaces",
      "PRRT_tabs",
      "PRRT_digits",
    ]);
    expect(out.every((o) => o.outcome === "accepted")).toBe(true);
  });

  it("--all-open sweeps every PR gh pr list returns, with no explicit PR on argv", () => {
    const { dir, stateDir } = writeFixture([
      {
        id: "PRRT_b",
        comments: [
          {
            author: "example-user",
            authorAssociation: "OWNER",
            body: "**deferred** — real but out of scope; ENG-9999 tracks it.",
          },
        ],
      },
    ]);
    // pr-list.json (written by writeFixture) names PR 999 — the same one
    // threads.json answers for, so the sweep should resolve it exactly once.
    const { stdout, exitCode } = run(["--all-open"], dir, stateDir);
    expect(exitCode).toBe(0);
    const out = lines(stdout);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      pr: 999,
      outcome: "deferred",
      action: "resolved",
    });
  });

  it("--all-open exits nonzero and warns when gh pr list returns exactly 1000 PRs — indistinguishable from truncation", () => {
    const { dir, stateDir } = writeFixture([]);
    // Overwrite writeFixture's single-PR list with exactly 1000 — the count
    // this script's own `--limit 1000` cap can never exceed, so 1000 is the
    // one value that means "maybe there were more", not "there just happen
    // to be 1000". threads.json (empty) answers every one of them.
    writeFileSync(
      join(dir, "pr-list.json"),
      JSON.stringify(
        Array.from({ length: 1000 }, (_, i) => ({ number: i + 1 })),
      ),
    );
    // The sweep spawns list-unresolved-threads.ts once per PR, and each of
    // those calls `gh` twice, so this test's cost is ~3000 process starts.
    // The per-PR calls go through a lean `gh` that answers the two
    // enumeration calls without the full stub's argument validation and jq
    // (the other tests here cover those argument shapes); everything else,
    // the `pr list` call included, still reaches the full stub.
    const leanDir = join(dir, "lean-bin");
    mkdirSync(leanDir);
    const lean = join(leanDir, "gh");
    writeFakeProgram(
      lean,
      `#!/bin/sh
case "$1 $2" in
  'repo view') printf 'example-org example-repo\\n' ;;
  'api graphql') exec cat "$RRT_FIXTURES/threads.json" ;;
  *) exec "${join(binDir, "gh")}" "$@" ;;
esac
`,
    );
    const { stderr, exitCode } = run(["--all-open"], dir, stateDir, leanDir);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("exactly 1000 open PRs");
    expect(stderr).toContain("may be truncated");
    // Every one of the 1000 was still swept, and none failed, so the nonzero
    // exit is the truncation warning's alone.
    expect(stderr.match(/^#\d+: 0 unresolved threads$/gm)).toHaveLength(1000);
    expect(stderr).not.toContain("could not enumerate");
  }, 480000); // ~1000 sequential TS-script spawns: about 30s idle, several minutes on a loaded machine.
});

/**
 * scripts.test.ts — the resolve-review-comments script surface after its
 * TypeScript port (from await-round.sh / converge.sh / reply-to-thread.sh /
 * lib/gh-deadline.sh).
 *
 * Two halves, mirroring drive-pr's own suite:
 *
 *   - Unit tests over `reply-to-thread.ts`'s outcome grammar — the exact
 *     predicate `qualifyingOutcome()` in drive-pr's reconcile mirrors, so a
 *     drift here corrupts the harvested reviewer-scoring sample.
 *   - Scripted probes that run the entry scripts against a STUBBED `gh` and
 *     assert the exit code they reach. One probe per loop-contract exit code,
 *     because the loop contract is the one decision an unattended resolve
 *     loop cannot get wrong — when it may STOP (exit 3), and when it must
 *     not.
 *
 * The probes are subprocess integration tests. Each spawns a script that
 * itself spawns the stub `gh` (and await-round.ts spawns its sibling
 * list-unresolved-threads.ts), which can exceed bun's 5s default per-test
 * budget on a loaded machine — run this file with `--timeout 30000`
 * (`pnpm skill-scripts:test` does).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "../../../../lib/guarded-git-spawn.ts";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { run } from "../scripts/lib/proc.ts";
import {
  skillsParentIsIntact,
  validateOutcomeBody,
} from "../scripts/reply-to-thread.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const HEAD_A = "aaaa19d8a22488d233ac3f5081020f081d4388f1";
const HEAD_B = "bbbb19d8a22488d233ac3f5081020f081d4388f1";

/** Synchronous fixture setup with guarded, explicit environment isolation. */
function checkedSpawn(
  command: string,
  args: string[],
  options: Parameters<typeof spawnSync>[2],
) {
  const result = spawnSync(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} fixture setup exited ${result.status}: ${result.stderr || result.error?.message || ""}`,
    );
  }
  return result.stdout;
}

// ── Outcome grammar (unit) ──────────────────────────────────────────────────

describe("reply-to-thread.ts outcome grammar", () => {
  const VALID: ReadonlyArray<readonly [string, string]> = [
    ["the house style", "**accepted** — added the guard in abc1234."],
    [
      "a rejected outcome",
      "**rejected** — the table is not soft-deletable (ADR-0053).",
    ],
    ["the hyphenated token", "**wont-fix** — declined per the triage rubric."],
    ["a deferred outcome", "**deferred** — filed TASK."],
    ["a moot outcome", "**moot** — the branch was deleted in abc1234."],
    ["a tab boundary", "**accepted**\tfixed in abc1234."],
    ["multiple spaces", "**accepted**   fixed."],
    ["a bare-word reason", "**accepted** x"],
    ["a digits-only reason", "**deferred** 4031"],
    ["free-form later lines", "**accepted** — fixed.\n\n```diff\n+ x\n```\n"],
    // A terminal \r is a line terminator, not content — routine when a reply
    // is read from a CRLF file on Windows, which this script now runs on.
    ["a CRLF first line", "**accepted** — fixed.\r\nmore.\r\n"],
    ["a CRLF-terminated single line", "**accepted** — fixed.\r\n"],
  ];
  for (const [label, body] of VALID) {
    it(`accepts ${label}`, () => {
      expect({ body, ok: validateOutcomeBody(body) }).toEqual({
        body,
        ok: true,
      });
    });
  }

  const INVALID: ReadonlyArray<readonly [string, string]> = [
    // A bare token classifies the thread while explaining nothing.
    ["a bare token", "**accepted**"],
    // No token boundary: a parser reads the token as `accepted**oops`.
    ["a missing boundary", "**accepted**oops"],
    // An em dash alone is a separator, not a reason (TASK).
    ["a separator-only reason", "**accepted** — "],
    ["an em-dash-only reason", "**accepted** —"],
    // U+2003 EM SPACE: the boundary is ASCII space/tab exactly — the bash
    // original's `[[:space:]]` matched this under a UTF-8 locale and not
    // under C, so the SAME body passed on one host and failed on another
    //. The port keeps the strict reading.
    ["a Unicode-space boundary", "**accepted** fixed."],
    ["an uppercase token", "**Accepted** — fixed."],
    ["a synonym", "**fixed** — done."],
    ["an unhyphenated wont-fix", "**wontfix** — declined."],
    ["a leading greeting", "Thanks! **accepted** — fixed."],
    ["leading whitespace", " **accepted** — fixed."],
    ["a second-line token", "context first\n**accepted** — fixed."],
    ["an unbolded token", "accepted — fixed."],
  ];
  for (const [label, body] of INVALID) {
    it(`rejects ${label}`, () => {
      expect({ body, ok: validateOutcomeBody(body) }).toEqual({
        body,
        ok: false,
      });
    });
  }
});

// ── Stub forge ──────────────────────────────────────────────────────────────

let tmpRoot: string;
let binDir: string;
let repoDir: string;

/**
 * `process.env` minus every `GIT_*` pointer — the same scrub as drive-pr's
 * suite, and NOT optional. Git hooks export `GIT_DIR`, `GIT_WORK_TREE` and
 * `GIT_INDEX_FILE` into their children, so under `lefthook`'s pre-commit the
 * `git init` below reinitialises the REAL repository (measured on this very
 * suite's first hook run: it flipped the main checkout's `core.bare` to true,
 * breaking every Conductor worktree at once), and the scripts under test —
 * which run `git rev-parse --git-dir` themselves — write their round counters
 * into the real .git instead of the scratch repo. Every spawn in this file
 * goes through this env, including the scripts under test, not just the git
 * calls.
 */
function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // `DRIVE_PR_*` is scrubbed for the same reason `GIT_*` is: this suite runs
    // INSIDE a drive as often as not (drive.ts spawns a pass, the pass runs the
    // gates), and `drive.ts` exports `DRIVE_PR_TARGET` / `DRIVE_PR_SESSION` /
    // `DRIVE_PR_SESSION_STARTED` into everything beneath it. Inheriting those
    // makes the probes' verdicts depend on who launched the suite — measured:
    // once `assertNoDriveContext` landed, the standalone-install case ("skips
    // the fence only when /drive-pr is wholly ABSENT") passed from a plain
    // shell and FAILED under `DRIVE_PR_TARGET=999`, i.e. it would have failed
    // in exactly the drive-spawned run that matters.
    //
    // Scrubbed here rather than in the one fixture that broke, so no future
    // probe inherits an ambient drive either. Every test that wants one of
    // these sets it EXPLICITLY in its own `env`, which still wins — the point
    // is that the baseline carries nothing.
    if (
      k.toUpperCase().startsWith("GIT_") ||
      k.toUpperCase().startsWith("DRIVE_PR_") ||
      v === undefined
    ) {
      continue;
    }
    env[k] = v;
  }
  return env;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "rrc-scripts-"));
  binDir = join(tmpRoot, "bin");
  mkdirSync(binDir);

  // The probes run from a THROWAWAY git repo, never the real one:
  // await-round.ts keeps its round counter in `git rev-parse --git-dir`, and a
  // probe that ran from the repo root would write counters into — and delete
  // them from — the actual .git of whoever runs the suite.
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
  checkedSpawn("git", ["init", "-q", repoDir], {
    encoding: "utf8",
    env: gitCleanEnv(),
  });
  // A real checkout always has a remote. `lib/gh-conditional.ts` derives its
  // cache scope from the remotes and refuses to cache without one, so a repo
  // that lacks one would silently exercise the uncached path everywhere.
  checkedSpawn(
    "git",
    [
      "-C",
      repoDir,
      "remote",
      "add",
      "origin",
      "git@github.com:acme/widgets.git",
    ],
    { encoding: "utf8", env: gitCleanEnv() },
  );

  // Fixture-driven `gh`. Answers only what the scripts actually ask; anything
  // else is a loud failure so a new call site cannot silently ride an
  // unrelated fixture. (Bash, like drive-pr's own stub: the harness runs on
  // POSIX CI/dev machines even though the scripts under test do not need it.)
  const stub = `#!/usr/bin/env bash
(
  command="$1 $2"
  case "$1 $2" in
    'pr view') allowed=' --json -q --jq ' ;;
    'pr checks') allowed=' --json ' ;;
    'api -i') allowed=' -H ' ;;
    'repo view') allowed=' --json -q --jq ' ;;
    'api graphql') allowed=' --input -f -F -q --jq --paginate --slurp ' ;;
    'api --paginate') allowed=' --slurp ' ;;
    *) echo "gh-stub: unhandled command: $*" >&2; exit 2 ;;
  esac
  shift 2
  needs_value=0
  checks_json=0
  value_flag=''
  for argument in "$@"; do
    if [ "$needs_value" -eq 1 ]; then
      [ -n "$argument" ] || { echo "gh: missing flag value" >&2; exit 2; }
      case "$argument" in --*) echo "gh: missing flag value" >&2; exit 2 ;; esac
      if [ "$command" = 'pr checks' ] && [ "$value_flag" = --json ]; then
        [ "$argument" = 'name,bucket,state' ] || { echo "gh: unsupported checks JSON fields: $argument" >&2; exit 2; }
        checks_json=1
      fi
      needs_value=0; continue
    fi
    case "$argument" in
      -*)
        case "$allowed" in
          *" $argument "*)
            case "$argument" in --paginate|--slurp) ;; *) needs_value=1; value_flag="$argument" ;; esac ;;
          *) echo "gh: unknown flag: $argument" >&2; exit 2 ;;
        esac ;;
    esac
  done
  [ "$needs_value" -eq 0 ] || { echo 'gh: missing flag value' >&2; exit 2; }
  if [ "$command" = 'pr checks' ] && [ "$checks_json" -ne 1 ]; then
    echo 'gh: pr checks requires --json name,bucket,state' >&2; exit 2
  fi
) || exit $?
FIX="\${RRC_FIX:?RRC_FIX not set}"
case "$1 $2" in
  "pr view")
    echo x >> "$FIX/pr-view-calls.log"
    case "$*" in
      *"--json number"*) cat "$FIX/number" ;;
      *"--json state"*)
        [ -f "$FIX/state-unreadable" ] && { echo "gh-stub: simulated unreadable state" >&2; exit 1; }
        cat "$FIX/state" ;;
      *"--json headRefOid"*)
        [ -f "$FIX/head" ] || { echo "gh-stub: no head fixture" >&2; exit 1; }
        cat "$FIX/head" ;;
      *) echo "gh-stub: unhandled pr view: $*" >&2; exit 1 ;;
    esac ;;
  "pr checks")
    echo x >> "$FIX/pr-checks-calls.log"
    [ -f "$FIX/checks.json" ] && cat "$FIX/checks.json"
    [ -f "$FIX/checks-exit" ] && exit "$(cat "$FIX/checks-exit")"
    exit 0 ;;
  "api -i")
    # TASK: the conditional REST reads lib/gh-conditional.ts makes. Serves
    # the SAME fixtures the GraphQL-backed 'pr view' / 'pr checks' branches do,
    # reshaped as GitHub's REST documents, with the ETag behaviour of the real
    # API: a request whose If-None-Match equals the current ETag gets 304 and
    # exit 1 (as \`gh api\` does — "gh: HTTP 304"). Every request is logged so
    # a probe can read off what was asked rather than infer it.
    shift 2
    inm=''
    while [ "$#" -gt 1 ]; do
      if [ "$1" = '-H' ]; then inm="\${2#If-None-Match: }"; shift 2; else shift; fi
    done
    path="$1"
    echo "$path" >> "$FIX/rest-calls.log"
    [ -n "$inm" ] && echo "$path" >> "$FIX/rest-conditional.log"
    case "$path" in
      repos/*/pulls/*)
        [ -f "$FIX/state-unreadable" ] && { echo "gh-stub: simulated unreadable state" >&2; exit 1; }
        st=$(cat "$FIX/state")
        merged=false; ghstate=open
        case "$st" in OPEN) ;; MERGED) ghstate=closed; merged=true ;; *) ghstate=closed ;; esac
        if [ -f "$FIX/head" ]; then
          body="{\\"state\\":\\"$ghstate\\",\\"merged\\":$merged,\\"head\\":{\\"sha\\":\\"$(cat "$FIX/head")\\"}}"
        else
          body="{\\"state\\":\\"$ghstate\\",\\"merged\\":$merged}"
        fi ;;
      repos/*/commits/*/check-runs*)
        if [ -f "$FIX/checks.json" ]; then body=$(cat "$FIX/checks.json"); else body="exit-$(cat "$FIX/checks-exit" 2>/dev/null)"; fi ;;
      repos/*/commits/*/status)
        if [ -f "$FIX/statuses.json" ]; then body=$(cat "$FIX/statuses.json"); else body='{"state":"pending"}'; fi ;;
      *) echo "gh-stub: unhandled api -i: $path" >&2; exit 2 ;;
    esac
    etag=$(printf '%s' "$body" | cksum | tr ' ' '-')
    if [ -n "$inm" ] && [ "$inm" = "$etag" ]; then
      printf 'HTTP/2.0 304 Not Modified\r\nEtag: %s\r\n\r\n' "$etag"
      echo 'gh: HTTP 304' >&2
      exit 1
    fi
    printf 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nEtag: %s\r\n\r\n' "$etag"
    printf '%s' "$body" ;;
  "repo view")
    echo "acme widgets" ;;
  "api --paginate")
    # /drive-pr's summary-findings.ts, which await-round.ts spawns before
    # reporting convergence (TASK), reads the PR's issue comments (absent
    # fixture: none, so no reviewer summary and nothing outstanding) and, once
    # a summary exists, its inline review comments (always none here).
    case "$*" in
      *"/issues/"*"/comments"*)
        if [ -f "$FIX/issue-comments.json" ]; then cat "$FIX/issue-comments.json"
        else echo '[[]]'; fi ;;
      *"/pulls/"*"/comments"*)
        echo '[[]]' ;;
      *) echo "gh-stub: unhandled api --paginate: $*" >&2; exit 1 ;;
    esac ;;
  "api graphql")
    case "$*" in
      *"query=query("*"threadId:ID!)"*)
        echo liveness >> "$FIX/thread-events.log"
        echo "$*" >> "$FIX/liveness-calls.log"
        [ -f "$FIX/state-unreadable" ] && { echo "gh-stub: simulated unreadable state" >&2; exit 1; }
        if [ -f "$FIX/liveness-response.json" ]; then cat "$FIX/liveness-response.json"
        else
          tid=''
          for arg in "$@"; do case "$arg" in threadId=*) tid="\${arg#threadId=}" ;; esac; done
          printf '{"data":{"node":{"__typename":"PullRequestReviewThread","id":"%s","pullRequest":{"number":%s,"state":"%s"}}}}' "$tid" "$(cat "$FIX/number")" "$(cat "$FIX/state")"
        fi ;;
      *"--input -"*)
        echo reply >> "$FIX/thread-events.log"
        n=0
        while [ -e "$FIX/graphql-input-$((n + 1)).json" ]; do n=$((n + 1)); done
        # A mutation that is IN FLIGHT rather than instantaneous, so a probe can
        # cancel one mid-post (TASK). The body is drained first so the
        # caller's write never blocks, and the file — the thing "the mutation
        # landed" is read off — is written only on the far side of the delay.
        if [ -f "$FIX/graphql-slow" ]; then
          body=$(cat)
          : > "$FIX/graphql-started"
          sleep 3
          printf '%s' "$body" > "$FIX/graphql-input-$((n + 1)).json"
        else
          cat > "$FIX/graphql-input-$((n + 1)).json"
        fi
        echo "https://github.com/acme/widgets/pull/1#discussion_r1" ;;
      *"resolveReviewThread"*|*"unresolveReviewThread"*)
        echo resolution >> "$FIX/thread-events.log"
        # resolve-thread.ts / unresolve-thread.ts pass the mutation through
        # -f query=... rather than --input -, so they need their own slow
        # branch (TASK) — same shape as the one above, minus a body to
        # drain since the id travels as a separate -f argument. A DISTINCT
        # marker prefix (graphql-mutation-, not graphql-input-): the latter is
        # what postedBodies() (reply-to-thread.ts's describe block) JSON.parses
        # wholesale from the fixture dir, and this marker is deliberately an
        # empty file, not a JSON document.
        n=0
        while [ -e "$FIX/graphql-mutation-$((n + 1))" ]; do n=$((n + 1)); done
        if [ -f "$FIX/graphql-slow" ]; then
          : > "$FIX/graphql-started"
          sleep 3
        fi
        : > "$FIX/graphql-mutation-$((n + 1))"
        echo "true" ;;
      *)
        # Deletes a path mid-run, during the thread listing — the window
        # after a copied install's scripts have loaded and before
        # await-round.ts probes for its /drive-pr sibling (TASK).
        if [ -f "$FIX/rm-on-threads" ]; then rm -rf "$(cat "$FIX/rm-on-threads")"; fi
        echo enumeration >> "$FIX/thread-events.log"
        cat "$FIX/threads.json" ;;
    esac ;;
  *) echo "gh-stub: unhandled command: $*" >&2; exit 1 ;;
esac
`;
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, stub);
  chmodSync(ghPath, 0o755);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let fixtureSeq = 0;
let prSeq = 100;

interface Fixture {
  /** PR number; unique per probe so round counters never cross-contaminate. */
  pr: string;
  dir: string;
}

function check(name: string, bucket: string, state: string) {
  return { name, bucket, state };
}

function thread(
  id: string,
  opts: {
    resolved?: boolean;
    bot?: boolean;
    replies?: { association: string; body: string }[];
    diffSide?: string | null;
    startDiffSide?: string | null;
  } = {},
) {
  return {
    id,
    isResolved: opts.resolved ?? false,
    isOutdated: false,
    diffSide: opts.diffSide ?? null,
    startDiffSide: opts.startDiffSide ?? null,
    path: "a.ts",
    line: 1,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          url: `https://github.com/acme/widgets/pull/1#discussion_${id}`,
          author: {
            login: opts.bot === false ? "a-human" : "somebot[bot]",
            __typename: opts.bot === false ? "User" : "Bot",
          },
          authorAssociation: "NONE",
          body: "a finding",
        },
        ...(opts.replies ?? []).map((r, i) => ({
          url: `https://github.com/acme/widgets/pull/1#discussion_${id}_r${i}`,
          author: { login: `replier-${i}`, __typename: "User" },
          authorAssociation: r.association,
          body: r.body,
        })),
      ],
    },
  };
}

function writeFixture(opts: {
  state?: string;
  checks?: unknown[] | { exit: number; body?: unknown[] };
  threads?: unknown[];
  head?: string;
  stateUnreadable?: boolean;
}): Fixture {
  const pr = String(++prSeq);
  const dir = join(tmpRoot, `fx-${++fixtureSeq}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "number"), `${pr}\n`);
  writeFileSync(join(dir, "state"), `${opts.state ?? "OPEN"}\n`);
  if (opts.stateUnreadable) writeFileSync(join(dir, "state-unreadable"), "");
  writeFileSync(join(dir, "head"), `${opts.head ?? HEAD_A}\n`);
  const checks = opts.checks ?? [
    check("AI review (shadow)", "pass", "COMPLETED"),
  ];
  if (Array.isArray(checks)) {
    writeFileSync(join(dir, "checks.json"), JSON.stringify(checks));
  } else {
    writeFileSync(join(dir, "checks-exit"), String(checks.exit));
    if (checks.body)
      writeFileSync(join(dir, "checks.json"), JSON.stringify(checks.body));
  }
  // gh --paginate --slurp returns an ARRAY of page documents.
  writeFileSync(
    join(dir, "threads.json"),
    JSON.stringify([
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: opts.threads ?? [],
              },
            },
          },
        },
      },
    ]),
  );
  return { pr, dir };
}

function runScript(
  script: string,
  args: string[],
  fix: Fixture,
  opts: {
    stdin?: string;
    env?: Record<string, string>;
    scriptsRoot?: string;
    /** Defaults to the shared `repoDir`; a caller that needs an ISOLATED
     * `--git-common-dir` (one no other test's writes have touched) passes
     * its own throwaway repo instead. */
    cwd?: string;
  } = {},
) {
  const env: Record<string, string> = {
    ...gitCleanEnv(),
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    RRC_FIX: fix.dir,
    GH_CALL_TIMEOUT: "20",
    ...opts.env,
  };
  // The state-dir OVERRIDE requires its on-disk identity beside it:
  // `$DRIVE_PR_STATE_DIR` without `$DRIVE_PR_STATE_DIR_IDENTITY` can only come
  // from a driver predating that change, and the fence refuses it rather than
  // keeping a compatibility path alive. Derived here, once, from whatever state
  // dir the caller passed — rather than at each of the call sites — so a test
  // that sets an override cannot forget it and then fail for a reason it is not
  // about. A caller that wants a STALE or ABSENT identity sets one explicitly
  // and wins, since `opts.env` is spread above.
  //
  // Computed inline from `statSync` rather than imported from `/drive-pr`'s
  // `lease.ts`: this suite covers the skill in its STANDALONE shape, and a
  // test-time import would make it depend on the sibling skill being
  // installed — the very coupling the fence's own skip logic exists to
  // tolerate. `statSync`, following symlinks, matching the producer.
  if (env.DRIVE_PR_STATE_DIR && env.DRIVE_PR_STATE_DIR_IDENTITY === undefined) {
    try {
      const st = statSync(env.DRIVE_PR_STATE_DIR);
      env.DRIVE_PR_STATE_DIR_IDENTITY = `${st.dev}:${st.ino}`;
    } catch {
      // Unreadable: leave it unset and let the script decide, which is what a
      // test staging that condition is asking for.
    }
  }
  const r = spawnSync(
    process.execPath,
    [join(opts.scriptsRoot ?? SCRIPTS, script), ...args],
    {
      encoding: "utf8",
      cwd: opts.cwd ?? repoDir,
      input: opts.stdin,
      env,
    },
  );
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

const roundsFile = (pr: string) =>
  join(repoDir, ".git", `resolve-review-rounds-${pr}`);

// ── await-round.ts: the loop contract ───────────────────────────────────────

it.skipIf(process.platform === "win32")(
  "fake gh requires structured fields for pr checks",
  () => {
    const result = spawnSync(join(binDir, "gh"), ["pr", "checks", "42"], {
      env: gitCleanEnv(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "pr checks requires --json name,bucket,state",
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "await-round.ts loop contract",
  () => {
    it("exit 5: a PR that is not OPEN abandons the loop before anything else", () => {
      const fix = writeFixture({ state: "MERGED" });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect({ code: r.code, stderr: r.stderr }).toEqual({
        code: 5,
        stderr: expect.stringContaining("abandoning the loop"),
      });
    });

    it("exit 1: an unreadable PR state is never settled", () => {
      const fix = writeFixture({ stateUnreadable: true });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`cannot read state of PR #${fix.pr}`);
    });

    it("exit 4 under --once: a pending check is not settled", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "pending", "IN_PROGRESS")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("--once given, not waiting");
    });

    it("exit 4 under --once: `gh pr checks` exit 8 is authoritative pending", () => {
      const fix = writeFixture({ checks: { exit: 8 } });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
    });

    it("exit 1 under --once: an unreadable check set is never settled", () => {
      const fix = writeFixture({ checks: { exit: 1 } });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing to guess");
    });

    it("exit 7: a failed reviewer check may never have posted its findings", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "fail", "COMPLETED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(7);
      expect(r.stderr).toContain("FAILED");
    });

    it("exit 2: an explicit --job-pattern needs declared required coverage", () => {
      const fix = writeFixture({
        checks: [check("build", "pass", "COMPLETED")],
      });
      const r = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--job-pattern", "no-such-check"],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("requires review.required_checks");
    });

    for (const scenario of [
      {
        label: "mixed success/skip",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "SKIPPED"),
        ],
        code: 7,
      },
      {
        label: "missing required member",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "pass", "SUCCESS")],
        code: 4,
      },
      {
        label: "all required checks absent despite --no-ci",
        required: ["AI review", "CodeRabbit"],
        checks: [],
        code: 4,
      },
      {
        label: "all required members complete",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 3,
      },
      {
        label: "required member pending",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "pending", "IN_PROGRESS"),
        ],
        code: 4,
      },
      {
        label: "required member neutral",
        required: ["AI review", "CodeRabbit"],
        checks: [
          check("AI review", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "NEUTRAL"),
        ],
        code: 3,
      },
      {
        label: "retired optional arm skipped",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "skipping", "SKIPPED"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 3,
      },
      {
        label: "retired optional arm absent",
        required: ["CodeRabbit"],
        checks: [check("CodeRabbit", "pass", "SUCCESS")],
        code: 3,
      },
      {
        label: "optional arm still running",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "pending", "IN_PROGRESS"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 4,
      },
      {
        label: "duplicate name cannot hide skipped required check",
        required: ["CodeRabbit"],
        checks: [
          check("CodeRabbit", "pass", "SUCCESS"),
          check("CodeRabbit", "skipping", "SKIPPED"),
        ],
        code: 7,
      },
    ]) {
      it(`explicit coverage: ${scenario.label}`, () => {
        const fix = writeFixture({ checks: scenario.checks });
        const overlay = join(fix.dir, "overlay.json");
        writeFileSync(
          overlay,
          JSON.stringify({ review: { required_checks: scenario.required } }),
        );
        const result = runScript(
          "await-round.ts",
          [
            fix.pr,
            "--once",
            "--no-ci",
            "--job-pattern",
            "AI review|CodeRabbit",
          ],
          fix,
          { env: { GROUNDWORK_OVERLAY: overlay } },
        );
        expect({ code: result.code, stderr: result.stderr }).toEqual({
          code: scenario.code,
          stderr: expect.any(String),
        });
        if (scenario.code !== 3)
          expect(result.stderr).not.toContain("converged:");
      });
    }

    // Required coverage must not switch off failure detection elsewhere, and
    // an observed terminal failure outranks missing coverage and a pending exit.
    for (const scenario of [
      {
        label: "failed optional reviewer beside satisfied required one",
        required: ["CodeRabbit"],
        checks: [
          check("AI review", "fail", "FAILURE"),
          check("CodeRabbit", "pass", "SUCCESS"),
        ],
        code: 7,
      },
      {
        label: "failed required member while another is missing",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "fail", "FAILURE")],
        code: 7,
      },
      {
        label: "cancelled required member while another is missing",
        required: ["AI review", "CodeRabbit"],
        checks: [check("AI review", "cancel", "CANCELLED")],
        code: 7,
      },
    ]) {
      it(`required coverage keeps failure detection: ${scenario.label}`, () => {
        const fix = writeFixture({ checks: scenario.checks });
        const overlay = join(fix.dir, "overlay.json");
        writeFileSync(
          overlay,
          JSON.stringify({ review: { required_checks: scenario.required } }),
        );
        const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
          env: { GROUNDWORK_OVERLAY: overlay },
        });
        expect(r.code).toBe(scenario.code);
        expect(r.stderr).not.toContain("converged:");
      });
    }

    it("exit 7: a skipped required reviewer outranks a gh exit-8 pending answer", () => {
      const fix = writeFixture({
        checks: {
          exit: 8,
          body: [
            check("CodeRabbit", "skipping", "SKIPPED"),
            check("build", "pending", "IN_PROGRESS"),
          ],
        },
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["CodeRabbit"] } }),
      );
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { GROUNDWORK_OVERLAY: overlay },
      });
      expect(r.code).toBe(7);
    });

    it("the missing-coverage diagnostic names only the absent checks", () => {
      const fix = writeFixture({
        checks: [check("AI review", "pass", "SUCCESS")],
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({
          review: { required_checks: ["AI review", "CodeRabbit"] },
        }),
      );
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { GROUNDWORK_OVERLAY: overlay },
      });
      expect(r.code).toBe(4);
      expect(r.stderr).toMatch(/waiting for: CodeRabbit$/m);
    });

    it("required custom check names work without a job pattern", () => {
      const fix = writeFixture({
        checks: [check("custom-check", "pass", "SUCCESS")],
      });
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["custom-check"] } }),
      );
      const result = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { GROUNDWORK_OVERLAY: overlay },
      });
      expect(result.code).toBe(3);
    });

    it("a job pattern cannot exclude a required member", () => {
      const fix = writeFixture({});
      const overlay = join(fix.dir, "overlay.json");
      writeFileSync(
        overlay,
        JSON.stringify({ review: { required_checks: ["CodeRabbit"] } }),
      );
      const result = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--job-pattern", "AI review"],
        fix,
        { env: { GROUNDWORK_OVERLAY: overlay } },
      );
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("excluded by --job-pattern");
    });

    it("exit 4 under --once: checks exist but none is reviewer-shaped — not settled", () => {
      const fix = writeFixture({
        checks: [check("build", "pass", "COMPLETED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("no reviewer-shaped check");
    });

    it("exit 4 under --once: a permanently-SKIPPED reviewer arm attests nothing", () => {
      // The CI-fallback "AI review" arm is gated off (vars.AI_REVIEW_CI_ARM
      // unset); counting it as a veto would report `failed` forever, counting it
      // as settled would converge over an unreviewed round. It is neither.
      const fix = writeFixture({
        checks: [check("AI review", "skipping", "SKIPPED")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(4);
      expect(r.stderr).toContain("no reviewer-shaped check");
    });

    it("a NEUTRAL reviewer conclusion is a completion state, not a failure to report", () => {
      const fix = writeFixture({
        checks: [check("AI review (shadow)", "fail", "NEUTRAL")],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
    });

    it("exit 0: settled with unresolved threads is a ready round", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("round ready: 1 unresolved thread(s)");
    });

    it("exit 3: settled with zero unresolved threads is converged", () => {
      const fix = writeFixture({
        threads: [thread("PRRT_a", { resolved: true })],
      });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("converged: 0 unresolved thread(s)");
    });

    // TASK: zero threads is not zero findings. await-round.ts asks
    // /drive-pr's own summary-findings.ts (an optional sibling) before it
    // reports convergence, and exits 8 on anything unaddressed.
    describe("summary-only findings (TASK)", () => {
      function convergedFixture(): Fixture {
        return writeFixture({
          threads: [thread("PRRT_a", { resolved: true })],
        });
      }

      describe("--once-budget-sec", () => {
        it("usage error: not digits-only", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "abc"],
            fix,
          );
          expect(r.code).toBe(2);
          expect(r.stderr).toContain("--once-budget-sec");
        });

        for (const zero of ["0", "00"]) {
          it(`usage error: rejects the zero spelling '${zero}'`, () => {
            const fix = convergedFixture();
            const r = runScript(
              "await-round.ts",
              [fix.pr, "--once", "--once-budget-sec", zero],
              fix,
            );
            expect(r.code).toBe(2);
          });
        }

        it("usage error: rejects a value whose *1000 overflows setTimeout", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "999999999999"],
            fix,
          );
          expect(r.code).toBe(2);
        });

        it("converges normally when the declared budget comfortably covers the call", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "1000"],
            fix,
          );
          expect(r.code).toBe(3);
        });

        it("refuses (exit 1) when too little of the declared budget remains", () => {
          const fix = convergedFixture();
          // SUMMARY_ONCE_MARGIN_SEC + SUMMARY_ONCE_MIN_TIMEOUT_SEC is 20s, so a
          // 10s declared budget refuses regardless of how little time this
          // fast, fake-`gh`-backed run actually takes.
          const r = runWithSibling(
            "await-round.ts",
            [fix.pr, "--once", "--once-budget-sec", "10"],
            fix,
            { "summary-findings.ts": 'console.log("[]");' },
          );
          expect(r.code).toBe(1);
          expect(r.stderr).toContain(
            "too little of the declared --once-budget-sec",
          );
          expect(r.stderr).not.toContain("converged:");
        });

        it("is inert without --once, even declared with an unmeetable value", () => {
          const fix = convergedFixture();
          const r = runScript(
            "await-round.ts",
            [fix.pr, "--once-budget-sec", "10"],
            fix,
          );
          expect(r.code).toBe(3);
        });
      });

      /** await-round.ts run from a copied install whose `/drive-pr` sibling is
       * shaped by `sibling`. */
      function runFromInstall(
        name: string,
        sibling:
          | { kind: "absent" }
          | { kind: "script"; source: string }
          | { kind: "broken-symlink" }
          | { kind: "scripts-dir-only" }
          | { kind: "root-only" }
          | { kind: "skills-removed-mid-run" }
          | { kind: "drive-pr-is-a-file" },
      ) {
        const fix = convergedFixture();
        const skills = join(tmpRoot, `skills-summary-${name}`);
        const rrc = join(skills, "resolve-review-comments", "scripts");
        mkdirSync(join(skills, "resolve-review-comments"), { recursive: true });
        cpSync(SCRIPTS, rrc, { recursive: true });
        const dp = join(skills, "drive-pr");
        if (sibling.kind === "script") {
          mkdirSync(join(dp, "scripts"), { recursive: true });
          writeFileSync(
            join(dp, "scripts", "summary-findings.ts"),
            sibling.source,
          );
        } else if (sibling.kind === "skills-removed-mid-run") {
          writeFileSync(join(fix.dir, "rm-on-threads"), skills);
        } else if (sibling.kind === "root-only") {
          mkdirSync(dp, { recursive: true });
        } else if (sibling.kind === "scripts-dir-only") {
          mkdirSync(join(dp, "scripts"), { recursive: true });
        } else if (sibling.kind === "drive-pr-is-a-file") {
          // A corrupted install: `lstat(drive-pr/scripts)` fails ENOTDIR, not
          // ENOENT — not proof that /drive-pr is absent.
          writeFileSync(dp, "not a directory\n");
        } else if (sibling.kind === "broken-symlink") {
          mkdirSync(dp, { recursive: true });
          symlinkSync(join(dp, "scripts-does-not-exist"), join(dp, "scripts"));
        }
        const r = spawnSync(
          process.execPath,
          [join(rrc, "await-round.ts"), fix.pr, "--once"],
          {
            encoding: "utf8",
            cwd: repoDir,
            env: {
              ...gitCleanEnv(),
              PATH: `${binDir}${delimiter}${process.env.PATH}`,
              RRC_FIX: fix.dir,
              GH_CALL_TIMEOUT: "20",
            },
          },
        );
        return { code: r.status, stderr: r.stderr };
      }

      const report = (unaddressed: unknown[]) =>
        `process.stdout.write(${JSON.stringify(JSON.stringify({ total: unaddressed.length, unaddressed }))});`;

      it("exit 8 when the sibling reports an unaddressed finding, naming its fingerprint", () => {
        const r = runFromInstall("outstanding", {
          kind: "script",
          source: report([{ fingerprint: "abc123", path: "a.ts" }]),
        });
        expect(r.code).toBe(8);
        expect(r.stderr).toContain("abc123");
      });

      it("exit 3 when the sibling reports none unaddressed", () => {
        const r = runFromInstall("clean", {
          kind: "script",
          source: report([]),
        });
        expect(r.code).toBe(3);
      });

      it("exit 3 in a STANDALONE install, saying the check was skipped", () => {
        const r = runFromInstall("standalone", { kind: "absent" });
        expect(r.code).toBe(3);
        expect(r.stderr).toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1 when the sibling fails", () => {
        const r = runFromInstall("fails", {
          kind: "script",
          source: "process.exit(1);",
        });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("refusing to report converged");
      });

      it("exit 1 when the sibling prints a clean report but still exits non-zero", () => {
        const r = runFromInstall("clean-but-fails", {
          kind: "script",
          source: `${report([])} process.exitCode = 1;`,
        });
        expect(r.code).toBe(1);
      });

      it("exit 1, never the standalone skip, when the probe fails with anything but ENOENT", () => {
        const r = runFromInstall("enotdir", { kind: "drive-pr-is-a-file" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1 when the sibling answers in an unusable shape", () => {
        const r = runFromInstall("malformed", {
          kind: "script",
          source: report([{ path: "a.ts" }]),
        });
        expect(r.code).toBe(1);
      });

      it("exit 1, never the standalone skip, on a dangling /drive-pr scripts symlink", () => {
        const r = runFromInstall("dangling", { kind: "broken-symlink" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, when the skills directory disappears mid-run", () => {
        const r = runFromInstall("gone", { kind: "skills-removed-mid-run" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, on a /drive-pr root with no scripts/ directory", () => {
        const r = runFromInstall("root-only", { kind: "root-only" });
        expect(r.code).toBe(1);
        expect(r.stderr).not.toContain(
          "no drive-pr skill was found for this repository",
        );
      });

      it("exit 1, never the standalone skip, on a partial install missing the script", () => {
        const r = runFromInstall("partial", { kind: "scripts-dir-only" });
        expect(r.code).toBe(1);
      });
    });

    it("--bots-only scopes the count to bot-authored threads", () => {
      const fix = writeFixture({
        threads: [thread("PRRT_h", { bot: false })],
      });
      // The human thread holds the unscoped count above zero…
      expect(runScript("await-round.ts", [fix.pr, "--once"], fix).code).toBe(0);
      // …and the scoped count converges past it.
      expect(
        runScript("await-round.ts", [fix.pr, "--once", "--bots-only"], fix)
          .code,
      ).toBe(3);
    });

    it("counts a round per distinct head, not per invocation", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      // A retry on the same head is a driver retry, not a reviewer round.
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      // A new push IS a new round.
      writeFileSync(join(fix.dir, "head"), `${HEAD_B}\n`);
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("2");
    });

    // The counter and its head key are two separate writes, so the ORDER decides
    // which way an interruption between them falls. Head first: the round is
    // lost, which only delays the decline-only cutoff. Count first — the
    // previous order — left a valid count paired with a stale head, so the next
    // call re-counted the SAME round and could arm the cutoff early.
    //
    // Reproducing the intermediate state by hand proves nothing: the script
    // behaves identically given either state, and the fix changes which state is
    // REACHABLE. So make the second write fail instead — a directory where the
    // counter file belongs — and read which file exists afterwards. Under the
    // old order the counter write is first and throws, leaving no `.head`;
    // under this one the head is already on disk when it throws.
    it("writes the head key before the count, so an interrupted bump cannot strand one", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      mkdirSync(roundsFile(fix.pr));
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(existsSync(`${roundsFile(fix.pr)}.head`)).toBe(true);
      expect(readFileSync(`${roundsFile(fix.pr)}.head`, "utf8").trim()).toBe(
        HEAD_A,
      );
    });

    // An unresolved head used to increment anyway AND leave `.head` unwritten,
    // so the dedup above could not fire and every retry counted again — a
    // retried round 3 arriving as round 4. Harmless for the advisory nudge,
    // not harmless now that the ordinal decides disposition.
    it("does not count a round when the head cannot be resolved", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      // One real round first, so the probe distinguishes "refused to bump" from
      // "never bumped at all".
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
      rmSync(join(fix.dir, "head"), { force: true });
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("1");
    });

    it("--no-count inspects without counting", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      runScript("await-round.ts", [fix.pr, "--once", "--no-count"], fix);
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("nudges structural escalation on every counted round past the threshold", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { REFLECT_THRESHOLD: "0" },
      });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("stop patching variants");
    });

    it("an empty REFLECT_THRESHOLD takes the documented default", () => {
      // `?? '3'` keeps `''`, which isDigits rejects — so a variable exported
      // empty by optional templating turned a documented default into a usage
      // exit 2 in both entry points.
      // Default 3 means one counted round must NOT nudge; '0' above proves the
      // nudge still fires when the threshold really is 0, so this is not merely
      // asserting silence.
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { REFLECT_THRESHOLD: "" },
      });
      expect({
        code: r.code,
        nudged: r.stderr.includes("stop patching variants"),
      }).toEqual({ code: 0, nudged: false });

      // converge.ts validates the same variable up front, and regressed the same
      // way. Empty must reach the round loop rather than fail as a usage error.
      const cfix = writeFixture({ threads: [] });
      const c = runScript(
        "converge.ts",
        [cfix.pr, "--", process.execPath, "-e", "process.exit(0)", cfix.pr],
        cfix,
        { env: { REFLECT_THRESHOLD: "" } },
      );
      expect(c.code).toBe(0);

      // A genuine typo still refuses, in both.
      expect(
        runScript("await-round.ts", [fix.pr, "--once"], fix, {
          env: { REFLECT_THRESHOLD: "x" },
        }).code,
      ).toBe(2);
      expect(
        runScript(
          "converge.ts",
          [cfix.pr, "--", process.execPath, "-e", "process.exit(0)", cfix.pr],
          cfix,
          { env: { REFLECT_THRESHOLD: "x" } },
        ).code,
      ).toBe(2);
    });

    it("prompts /reflect at wind-down when the session exceeded the threshold, and resets the counter", () => {
      const fix = writeFixture({ threads: [] });
      writeFileSync(roundsFile(fix.pr), "5\n");
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain("converged after 5 rounds");
      expect(r.stderr).toContain("/reflect");
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("a converged --no-count probe neither erases the counter nor fires the prompt", () => {
      const fix = writeFixture({ threads: [] });
      writeFileSync(roundsFile(fix.pr), "5\n");
      const r = runScript(
        "await-round.ts",
        [fix.pr, "--once", "--no-count"],
        fix,
      );
      expect(r.code).toBe(3);
      expect(r.stderr).not.toContain("/reflect");
      expect(readFileSync(roundsFile(fix.pr), "utf8").trim()).toBe("5");
      rmSync(roundsFile(fix.pr), { force: true });
      rmSync(`${roundsFile(fix.pr)}.head`, { force: true });
    });

    it("exit 2: usage errors are usage errors", () => {
      const fix = writeFixture({});
      for (const args of [
        ["--interval", "2"],
        ["--interval"],
        ["--interval", "2147484", "--timeout", "2147484"],
        ["--interval", "9".repeat(400), "--timeout", "9".repeat(400)],
        ["--timeout", "x"],
        ["--frobnicate"],
        ["--timeout", "5", "--interval", "30"],
        ["--job-pattern", "("],
      ]) {
        const r = runScript("await-round.ts", [fix.pr, ...args], fix);
        expect({ args, code: r.code }).toEqual({ args, code: 2 });
      }
    });
  },
);

// ── converge.ts: loop control over await-round.ts ───────────────────────────

describe.skipIf(process.platform === "win32")(
  "converge.ts loop control",
  () => {
    it("exit 0 with no pass run on an already-converged PR", () => {
      const fix = writeFixture({ threads: [] });
      const marker = join(fix.dir, "pass-ran");
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
          fix.pr,
        ],
        fix,
      );
      expect({ code: r.code, passRan: existsSync(marker) }).toEqual({
        code: 0,
        passRan: false,
      });
      expect(r.stderr).toContain("converged after 0 round(s)");
    });

    it("runs the pass argv directly (no shell) and converges when its fix empties the thread list", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      // The pass "resolves the thread" by rewriting the fixture — the next
      // await-round evaluation then reads zero unresolved threads.
      const emptied = JSON.stringify([
        {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        },
      ]);
      const passJs = `require('node:fs').writeFileSync(require('node:path').join(process.env.RRC_FIX, 'threads.json'), ${JSON.stringify(emptied)})`;
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", passJs, fix.pr],
        fix,
      );
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("--- round 1/10");
      expect(r.stderr).toContain("converged after 1 round(s)");
    });

    it("exit 1 when the pass fails, without resolving further", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", "process.exit(3)", fix.pr],
        fix,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("pass failed on round 1");
    });

    it("exit 6 at --max-rounds when the pass never converges the PR", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--max-rounds",
          "2",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
          fix.pr,
        ],
        fix,
      );
      expect(r.code).toBe(6);
      expect(r.stderr).toContain("hit --max-rounds (2)");
    });

    it("exit 5 propagated verbatim: a PR that merges mid-loop stops the loop", () => {
      const fix = writeFixture({
        state: "MERGED",
        threads: [thread("PRRT_a")],
      });
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", process.execPath, "-e", "process.exit(0)", fix.pr],
        fix,
      );
      expect(r.code).toBe(5);
    });

    it("refuses a pass command that does not name the explicit PR (exact token, not substring)", () => {
      const fix = writeFixture({});
      // '12' must not satisfy a driver waiting on '123…' — the probe PR number
      // appears only as a substring of a longer number in the pass argv.
      const r = runScript(
        "converge.ts",
        [fix.pr, "--", "codex", "exec", `/resolve-review-comments ${fix.pr}9`],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("names no PR");
    });

    it("refuses --bots-only when the pass command is not also scoped", () => {
      const fix = writeFixture({});
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--bots-only",
          "--",
          "codex",
          "exec",
          `/resolve-review-comments ${fix.pr}`,
        ],
        fix,
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--bots-only");
    });

    it("--dry-run inspects a ready round without invoking the pass or counting it", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const marker = join(fix.dir, "pass-ran");
      const r = runScript(
        "converge.ts",
        [
          fix.pr,
          "--dry-run",
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
          fix.pr,
        ],
        fix,
      );
      expect({ code: r.code, passRan: existsSync(marker) }).toEqual({
        code: 0,
        passRan: false,
      });
      expect(r.stderr).toContain("(dry-run) would run:");
      expect(existsSync(roundsFile(fix.pr))).toBe(false);
    });

    it("exports the target PR and bot scope out-of-band to the pass", () => {
      // The two argv tests above are typo-catchers: they inspect an opaque pass
      // command, where `... "/resolve-review-comments 999" --label 123` names
      // 123 while targeting 999, and `... do not use --bots-only` names the flag
      // while asking for the opposite. $RRC_TARGET_PR / $RRC_BOTS_ONLY are the
      // channel list-unresolved-threads.ts actually enforces, so a pass that
      // does not receive them has no guarantee at all.
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const seen = join(fix.dir, "env.json");
      const passJs = `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ target: process.env.RRC_TARGET_PR, bots: process.env.RRC_BOTS_ONLY }))`;
      runScript(
        "converge.ts",
        [
          fix.pr,
          "--bots-only",
          "--max-rounds",
          "1",
          "--",
          process.execPath,
          "-e",
          passJs,
          `${fix.pr} --bots-only`,
        ],
        fix,
      );
      expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
        target: fix.pr,
        bots: "1",
      });
    });

    it("rejects unsafe --max-rounds before running a pass or querying GitHub", () => {
      for (const maxRounds of [
        "9".repeat(400),
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        const fix = writeFixture({ threads: [thread("PRRT_bounded")] });
        const marker = join(fix.dir, "pass-ran");
        const r = runScript(
          "converge.ts",
          [
            fix.pr,
            "--max-rounds",
            maxRounds,
            "--",
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
            fix.pr,
          ],
          fix,
        );
        expect(r.code).toBe(2);
        expect(r.stderr).toContain(
          "--max-rounds takes a whole number within the safe integer range",
        );
        expect(existsSync(marker)).toBe(false);
        for (const log of [
          "pr-view-calls.log",
          "pr-checks-calls.log",
          "rest-calls.log",
        ])
          expect(existsSync(join(fix.dir, log))).toBe(false);
      }
    });

    it("accepts small and maximum-safe --max-rounds values", () => {
      for (const maxRounds of ["1", String(Number.MAX_SAFE_INTEGER)]) {
        const fix = writeFixture({ threads: [] });
        const r = runScript(
          "converge.ts",
          [fix.pr, "--max-rounds", maxRounds, "--", "unused-pass", fix.pr],
          fix,
        );
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("converged after 0 round(s)");
      }
    });

    it("exit 2: a missing pass command is a usage error", () => {
      const fix = writeFixture({});
      expect(runScript("converge.ts", [fix.pr], fix).code).toBe(2);
      expect(
        runScript("converge.ts", [fix.pr, "--max-rounds", "x", "--", "x"], fix)
          .code,
      ).toBe(2);
    });
  },
);

// ── run(): a failed SPAWN is not an exit code (TASK) ────────────────────

describe("run() distinguishes a failed spawn from a child that exits 127", () => {
  // `run()` never rejects — a spawn error resolves as 127 with the error text
  // on stderr, because every bash call site read a missing command and a failed
  // one the same way. That conflation is load-bearing for exit-status callers
  // and wrong for the one caller that must know whether ANYTHING RAN:
  // converge.ts releases /drive-pr's tier-3 lease only when a pass could have
  // taken a claim, and keyed on `code` it released on a `codex` binary missing
  // from PATH — stripping a live sibling resolver's record.
  //
  // The pair below is the whole point: a `code === 127` test passes the first
  // probe and FAILS the second, so it cannot stand in for the field.

  it("reports spawnFailed when the binary does not exist", async () => {
    const r = await run([join(tmpRoot, "no-such-binary-doc6893"), "arg"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: true,
    });
  });

  it("does NOT report spawnFailed when a real child exits 127 itself", async () => {
    const r = await run([process.execPath, "-e", "process.exit(127)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: false,
    });
  });

  it("reports spawnFailed false for an ordinary successful child", async () => {
    const r = await run([process.execPath, "-e", "process.exit(0)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 0,
      spawnFailed: false,
    });
  });
});

// ── converge.ts: the sessionless-lease release on loop exit (TASK) ──────

// ── list-unresolved-threads.ts: the enumeration chokepoint ──────────────────

describe.skipIf(process.platform === "win32")(
  "list-unresolved-threads.ts enforces converge.ts out-of-band scope",
  () => {
    const ids = (stdout: string): string[] =>
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { threadId: string }).threadId);

    it("refuses to enumerate a PR other than $RRC_TARGET_PR", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("list-unresolved-threads.ts", [], fix, {
        env: { RRC_TARGET_PR: `${fix.pr}9` },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`the run is working PR #${fix.pr}9`);
    });

    it("$RRC_BOTS_ONLY scopes the enumeration even when argv does not", () => {
      // The whole point: converge.ts cannot prove an opaque pass passes
      // --bots-only, so the pass is never handed a human thread's id in the
      // first place. reply-to-thread.ts and resolve-thread.ts both need one, and
      // this is the only script that produces them.
      const fix = writeFixture({
        threads: [thread("PRRT_bot"), thread("PRRT_human", { bot: false })],
      });
      expect(
        ids(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["PRRT_bot", "PRRT_human"]);
      const scoped = runScript("list-unresolved-threads.ts", [], fix, {
        env: { RRC_BOTS_ONLY: "1" },
      });
      expect({ code: scoped.code, ids: ids(scoped.stdout) }).toEqual({
        code: 0,
        ids: ["PRRT_bot"],
      });
    });

    // `self-inflicted.ts` reads `diffSide` off this stream to tell a LEFT-side
    // anchor (numbering the pre-image, not HEAD) from a RIGHT-side one — see
    // that script's own header. Propagated
    // through verbatim, same as `startLine`/`isOutdated`.
    it("propagates diffSide verbatim, including the null default", () => {
      const sides = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { diffSide: string | null }).diffSide);
      const fix = writeFixture({
        threads: [
          thread("PRRT_left", { diffSide: "LEFT" }),
          thread("PRRT_right", { diffSide: "RIGHT" }),
          thread("PRRT_none"),
        ],
      });
      expect(
        sides(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["LEFT", "RIGHT", null]);
    });

    // `self-inflicted.ts`'s `labelRecord` reads `startDiffSide` off this stream
    // to tell a genuinely multi-line range whose start straddles a hunk
    // boundary (`startDiffSide` differing from `diffSide`) from one that does
    // not — GitHub allows the two to differ, and `diffSide` alone describes
    // only the range's END. Propagated through
    // verbatim, same as `diffSide` itself.
    it("propagates startDiffSide verbatim, including the null default", () => {
      const startSides = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (l) =>
              (JSON.parse(l) as { startDiffSide: string | null }).startDiffSide,
          );
      const fix = writeFixture({
        threads: [
          thread("PRRT_straddle", { diffSide: "RIGHT", startDiffSide: "LEFT" }),
          thread("PRRT_wholly_right", {
            diffSide: "RIGHT",
            startDiffSide: "RIGHT",
          }),
          thread("PRRT_none"),
        ],
      });
      expect(
        startSides(runScript("list-unresolved-threads.ts", [], fix).stdout),
      ).toEqual(["LEFT", "RIGHT", null]);
    });

    it("an agreeing $RRC_TARGET_PR, and an empty one, both pass through", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      for (const env of [{ RRC_TARGET_PR: fix.pr }, {}] as Record<
        string,
        string
      >[]) {
        const r = runScript("list-unresolved-threads.ts", [], fix, { env });
        expect({ env, code: r.code, ids: ids(r.stdout) }).toEqual({
          env,
          code: 0,
          ids: ["PRRT_a"],
        });
      }
    });

    // The reversal check (triage rubric § Contradictory findings) needs the
    // prior round's outcome, which survives ONLY on the resolved thread — the
    // held batch is cleared the moment the thread resolves. Default output must
    // stay unresolved-only, because await-round.ts/converge.ts read open work
    // off this stream's line count.
    it("--include-resolved widens to resolved threads; default does not", () => {
      const lines = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const t = JSON.parse(l) as {
              threadId: string;
              isResolved: boolean;
            };
            return { threadId: t.threadId, isResolved: t.isResolved };
          });
      const fix = writeFixture({
        threads: [thread("PRRT_open"), thread("PRRT_done", { resolved: true })],
      });

      const dflt = runScript("list-unresolved-threads.ts", [], fix);
      expect({ code: dflt.code, lines: lines(dflt.stdout) }).toEqual({
        code: 0,
        lines: [{ threadId: "PRRT_open", isResolved: false }],
      });

      const wide = runScript(
        "list-unresolved-threads.ts",
        ["--include-resolved"],
        fix,
      );
      expect({ code: wide.code, lines: lines(wide.stdout) }).toEqual({
        code: 0,
        lines: [
          { threadId: "PRRT_open", isResolved: false },
          { threadId: "PRRT_done", isResolved: true },
        ],
      });
    });

    // A bot finding can reverse an accepted HUMAN outcome, and under the
    // continuous --bots-only flow the reversal check would never see it: the
    // bots-only filter dropped the resolved human thread entirely. History must
    // pass through; the id must not, since --bots-only exists so a pass is never
    // handed an actionable human thread id.
    it("--bots-only keeps resolved human threads as id-redacted history", () => {
      // The OUTCOME reply is what the reversal check reads, and it is never the
      // thread's first comment — asserting comments[0] alone would pass while a
      // regression emitted only the finding and dropped the outcome
      //. So the fixture carries a trusted outcome and
      // the shape asserts EVERY body, plus every reply-capable handle.
      const OUTCOME = "**accepted** — prior human decision on this construct";
      // The OPEN human thread carries a trusted outcome too, and the assertions
      // below check EVERY one of its bodies. Without it the fixture held only
      // the initial finding, so a regression emitting `comments.slice(0, 1)`
      // for unresolved history alone would drop the outcome the reversal check
      // reads and still leave this test green.
      const OPEN_OUTCOME = "**wont-fix** — human decision, thread left open";
      const shape = (stdout: string) =>
        stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const t = JSON.parse(l) as {
              threadId: string | null;
              redacted?: boolean;
              isResolved: boolean;
              url: string | null;
              comments: { body: string | null; url: string | null }[];
            };
            return {
              threadId: t.threadId,
              redacted: t.redacted ?? false,
              isResolved: t.isResolved,
              url: t.url,
              bodies: t.comments.map((c) => c.body),
              commentUrls: t.comments.map((c) => c.url),
            };
          });
      const fix = writeFixture({
        threads: [
          thread("PRRT_bot_open"),
          thread("PRRT_human_open", {
            bot: false,
            replies: [{ association: "MEMBER", body: OPEN_OUTCOME }],
          }),
          thread("PRRT_human_done", {
            bot: false,
            resolved: true,
            replies: [
              { association: "MEMBER", body: OUTCOME },
              {
                association: "MEMBER",
                // a cross-link: the id here is a REST reply handle and must not
                // survive redaction, or the record is still postable
                body: "see https://github.com/acme/widgets/pull/1#discussion_r999",
              },
            ],
          }),
          thread("PRRT_bot_done", { resolved: true }),
        ],
      });

      // Without --include-resolved, --bots-only is unchanged: bots, unresolved.
      const narrow = runScript(
        "list-unresolved-threads.ts",
        ["--bots-only"],
        fix,
      );
      expect(shape(narrow.stdout).map((t) => t.threadId)).toEqual([
        "PRRT_bot_open",
      ]);

      const history = runScript(
        "list-unresolved-threads.ts",
        ["--bots-only", "--include-resolved"],
        fix,
      );
      const botOpenUrl =
        "https://github.com/acme/widgets/pull/1#discussion_PRRT_bot_open";
      const botDoneUrl =
        "https://github.com/acme/widgets/pull/1#discussion_PRRT_bot_done";
      expect({ code: history.code, lines: shape(history.stdout) }).toEqual({
        code: 0,
        lines: [
          {
            threadId: "PRRT_bot_open",
            redacted: false,
            isResolved: false,
            url: botOpenUrl,
            bodies: ["a finding"],
            commentUrls: [botOpenUrl],
          },
          // an OPEN human thread is history too — a human may deliberately leave
          // an acted-on thread open, and its outcome is what a later bot finding
          // could reverse. Redacted, so it is never actionable; but ALL of its
          // bodies survive, the outcome reply included.
          {
            threadId: null,
            redacted: true,
            isResolved: false,
            url: null,
            bodies: ["a finding", OPEN_OUTCOME],
            commentUrls: [null, null],
          },
          // the resolved human thread's OUTCOME is visible; nothing postable
          // survives —
          // not the GraphQL id, not the thread url, not a comment permalink
          // (whose #discussion_r fragment is a REST reply id).
          {
            threadId: null,
            redacted: true,
            isResolved: true,
            url: null,
            bodies: [
              "a finding",
              OUTCOME,
              "see https://github.com/acme/widgets/pull/1#discussion_r[redacted]",
            ],
            commentUrls: [null, null, null],
          },
          {
            threadId: "PRRT_bot_done",
            redacted: false,
            isResolved: true,
            url: botDoneUrl,
            bodies: ["a finding"],
            commentUrls: [botDoneUrl],
          },
        ],
      });
      // …and the open human thread is history too — redacted, never actionable.
      // A human may deliberately leave an acted-on thread open, and its outcome
      // is exactly what a later bot finding might reverse.
      const openHuman = shape(history.stdout).filter(
        (t) => t.threadId === null && !t.isResolved,
      );
      expect(openHuman).toEqual([
        {
          threadId: null,
          redacted: true,
          isResolved: false,
          url: null,
          bodies: ["a finding", OPEN_OUTCOME],
          commentUrls: [null, null],
        },
      ]);
      expect(history.stdout).not.toContain("PRRT_human_open");
    });

    // The reversal check reads outcome tokens out of this stream, and a thread
    // is world-commentable — so every comment must carry the server-computed
    // `authorAssociation` the rubric gates on. Without it per comment, a
    // spoofed `**accepted**` from an outside author is indistinguishable from a
    // real prior outcome.
    it("carries authorAssociation on every comment of a resolved thread", () => {
      const fix = writeFixture({
        threads: [
          thread("PRRT_hist", {
            resolved: true,
            replies: [
              {
                association: "NONE",
                body: "**accepted** — spoofed by an outsider",
              },
              {
                association: "MEMBER",
                body: "**rejected** — the real outcome",
              },
            ],
          }),
        ],
      });
      const r = runScript(
        "list-unresolved-threads.ts",
        ["--include-resolved"],
        fix,
      );
      const rec = JSON.parse(r.stdout.trim()) as {
        comments: { authorAssociation: string | null; body: string | null }[];
      };
      expect(
        rec.comments.map((c) => [c.authorAssociation, c.body?.slice(0, 12)]),
      ).toEqual([
        ["NONE", "a finding"],
        ["NONE", "**accepted**"],
        ["MEMBER", "**rejected**"],
      ]);
    });
  },
);

// Every thread write reads its own PR, even after an open round was enumerated.
describe.skipIf(process.platform === "win32")(
  "thread mutation liveness",
  () => {
    const writers = [
      "reply-to-thread.ts",
      "resolve-thread.ts",
      "unresolve-thread.ts",
    ];
    const body = "**accepted** — fixed the guard.\n";
    const events = (fix: Fixture) =>
      readFileSync(join(fix.dir, "thread-events.log"), "utf8")
        .trim()
        .split("\n");

    for (const script of writers) {
      const write = (fix: Fixture) =>
        runScript(script, ["PRRT_x"], fix, {
          stdin: body,
          // A caller's driver target is never evidence of thread ownership.
          env: { DRIVE_PR_TARGET: "99999" },
        });

      // Without a sibling drive, reply-to-thread correctly refuses drive context;
      // these standalone tests therefore keep the ordinary no-drive environment.
      const standaloneWrite = (fix: Fixture) =>
        runScript(script, ["PRRT_x"], fix, { stdin: body });

      it(`${script}: an open PR is read immediately before the write`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_x")] });
        expect(
          runScript("list-unresolved-threads.ts", [fix.pr], fix).code,
        ).toBe(0);
        const r = standaloneWrite(fix);
        expect({ code: r.code, stderr: r.stderr }).toEqual({
          code: 0,
          stderr: "",
        });
        expect(events(fix)).toEqual([
          "enumeration",
          "liveness",
          script === "reply-to-thread.ts" ? "reply" : "resolution",
        ]);
        const query = readFileSync(join(fix.dir, "liveness-calls.log"), "utf8");
        expect(query).toContain("node(id:$threadId)");
        expect(query).toContain("pullRequest { number state }");
        expect(query).toContain("threadId=PRRT_x");
        expect(query).not.toContain("--cache");
      });

      for (const state of ["MERGED", "CLOSED"]) {
        it(`${script}: refuses ${state} after open enumeration`, () => {
          const fix = writeFixture({ threads: [thread("PRRT_x")] });
          expect(
            runScript("await-round.ts", [fix.pr, "--once"], fix).code,
          ).toBe(0);
          expect(
            runScript("list-unresolved-threads.ts", [fix.pr], fix).code,
          ).toBe(0);
          writeFileSync(join(fix.dir, "state"), state);
          const r = standaloneWrite(fix);
          expect(r.code).toBe(5);
          expect(r.stderr).toContain(`owning PR #${fix.pr} is ${state}`);
          expect(r.stderr).toContain("stop the review pass");
          expect(events(fix).at(-1)).toBe("liveness");
          expect(events(fix)).not.toContain("reply");
          expect(events(fix)).not.toContain("resolution");
        });
      }

      it(`${script}: refuses a failed liveness read`, () => {
        const fix = writeFixture({ stateUnreadable: true });
        const r = standaloneWrite(fix);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("cannot read owning PR liveness");
        expect(events(fix)).toEqual(["liveness"]);
      });

      const openNode = {
        __typename: "PullRequestReviewThread",
        id: "PRRT_x",
        pullRequest: { number: 42, state: "OPEN" },
      };
      const invalidResponses = {
        "malformed JSON": "{",
        "null node": JSON.stringify({ data: { node: null } }),
        "wrong node type": JSON.stringify({
          data: { node: { ...openNode, __typename: "Issue" } },
        }),
        "wrong thread": JSON.stringify({
          data: { node: { ...openNode, id: "PRRT_other" } },
        }),
        "missing PR": JSON.stringify({
          data: { node: { ...openNode, pullRequest: null } },
        }),
        "unknown state": JSON.stringify({
          data: {
            node: {
              ...openNode,
              pullRequest: { number: 42, state: "UNKNOWN" },
            },
          },
        }),
        "partial GraphQL error": JSON.stringify({
          data: { node: openNode },
          errors: [{ message: "unreadable" }],
        }),
      };
      for (const [name, response] of Object.entries(invalidResponses)) {
        it(`${script}: refuses ${name}`, () => {
          const fix = writeFixture({});
          writeFileSync(join(fix.dir, "liveness-response.json"), response);
          const r = standaloneWrite(fix);
          expect(r.code).toBe(1);
          expect(r.stderr).toContain("cannot read owning PR liveness");
          expect(events(fix)).toEqual(["liveness"]);
        });
      }

      // Resolution has no optional lease integration; a conflicting driver target
      // must not redirect the owning-PR lookup or permit an otherwise closed PR.
      if (script !== "reply-to-thread.ts") {
        it(`${script}: ignores a different driver's target`, () => {
          const fix = writeFixture({ state: "MERGED" });
          expect(write(fix).code).toBe(5);
          expect(events(fix)).toEqual(["liveness"]);
        });
      }
    }

    for (const script of writers) {
      it(`converge stops after a mid-pass merge refuses ${script}, before follow-up work`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_x")] });
        const passFile = join(fix.dir, "merge-pass.ts");
        const followup = join(fix.dir, "followup-push-would-run");
        writeFileSync(
          passFile,
          `
        import { writeFileSync, appendFileSync } from "node:fs";
        import { spawnSync } from "node:child_process";
        appendFileSync(${JSON.stringify(join(fix.dir, "passes.log"))}, "pass\\n");
        const listed = spawnSync(process.execPath, [${JSON.stringify(join(SCRIPTS, "list-unresolved-threads.ts"))}, process.argv[2]], { encoding: "utf8" });
        if (listed.status !== 0) process.exit(1);
        writeFileSync(${JSON.stringify(join(fix.dir, "state"))}, "MERGED");
        const wrote = spawnSync(process.execPath, [${JSON.stringify(join(SCRIPTS, script))}, "PRRT_x"], { input: ${JSON.stringify(body)}, encoding: "utf8" });
        process.stderr.write(wrote.stderr);
        if (wrote.status !== 0) process.exit(wrote.status ?? 1);
        writeFileSync(${JSON.stringify(followup)}, "unexpected follow-up");
      `,
        );
        const r = runScript(
          "converge.ts",
          [
            fix.pr,
            "--max-rounds",
            "2",
            "--",
            process.execPath,
            passFile,
            fix.pr,
          ],
          fix,
        );
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("is MERGED; refusing mutation");
        expect(r.stderr).toContain("pass failed on round 1");
        expect(readFileSync(join(fix.dir, "passes.log"), "utf8")).toBe(
          "pass\n",
        );
        expect(existsSync(followup)).toBe(false);
        expect(events(fix).at(-1)).toBe("liveness");
        expect(events(fix)).not.toContain("reply");
        expect(events(fix)).not.toContain("resolution");
      });
    }

    it("checks again when the PR merges between reply and resolution", () => {
      const fix = writeFixture({});
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x"], fix, { stdin: body }).code,
      ).toBe(0);
      writeFileSync(join(fix.dir, "state"), "MERGED");
      expect(runScript("resolve-thread.ts", ["PRRT_x"], fix).code).toBe(5);
      expect(events(fix)).toEqual(["liveness", "reply", "liveness"]);
    });
  },
);

// ── reply-to-thread.ts: the posting chokepoint ──────────────────────────────

describe.skipIf(process.platform === "win32")(
  "reply-to-thread.ts posting",
  () => {
    function postedBodies(fix: Fixture): string[] {
      return readdirSync(fix.dir)
        .filter((f) => f.startsWith("graphql-input-"))
        .sort()
        .map((f) => {
          const doc = JSON.parse(readFileSync(join(fix.dir, f), "utf8")) as {
            query: string;
            variables: { threadId: string; body: string };
          };
          expect(doc.query).toContain("addPullRequestReviewThreadReply");
          return doc.variables.body;
        });
    }

    it("delivers the body VERBATIM — shell metacharacters, backticks, trailing blank line", () => {
      const fix = writeFixture({});
      // Every character class the TASK corruption ate: expansion syntax,
      // backticks, quotes — plus a deliberate trailing blank line, which the
      // bash port needed a sentinel dance to keep alive through $(cat).
      const body =
        "**accepted** — handled `$(rm -rf /)` and $VAR and `backticks` in abc1234.\n\n";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect({ code: r.code, stdout: r.stdout.trim() }).toEqual({
        code: 0,
        stdout: "https://github.com/acme/widgets/pull/1#discussion_r1",
      });
      expect(postedBodies(fix)).toEqual([body]);
    });

    it("refuses a non-outcome body before anything reaches the API", () => {
      const fix = writeFixture({});
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: "looks fine to me",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("must begin with an outcome token");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("--no-outcome is the explicit escape hatch for a clarifying question, and appends NO_OUTCOME_MARKER — the durable evidence isLeftOpenThread requires", () => {
      const fix = writeFixture({});
      const body = "Which schema version is this rule pinned to?";
      const r = runScript(
        "reply-to-thread.ts",
        ["PRRT_x", "--no-outcome"],
        fix,
        {
          stdin: body,
        },
      );
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([
        `${body}\n\n<!-- reply-to-thread:no-outcome -->`,
      ]);
    });

    it("refuses a body whose own trailing line already matches NO_OUTCOME_MARKER — this script is the sole producer, so nothing legitimately supplies it", () => {
      const fix = writeFixture({});
      const body =
        "Which schema version is this rule pinned to?\n\n<!-- reply-to-thread:no-outcome -->";
      const r = runScript(
        "reply-to-thread.ts",
        ["PRRT_x", "--no-outcome"],
        fix,
        {
          stdin: body,
        },
      );
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("NO_OUTCOME_MARKER");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("exit 2: no thread id, an empty stdin body, or a stale body-as-argument call", () => {
      const fix = writeFixture({});
      expect(
        runScript("reply-to-thread.ts", [], fix, { stdin: "x" }).code,
      ).toBe(2);
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x"], fix, { stdin: "" }).code,
      ).toBe(2);
      // Arity, not emptiness: an explicitly empty second argument is the same
      // stale two-argument form.
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x", ""], fix, { stdin: "x" })
          .code,
      ).toBe(2);
      expect(
        runScript("reply-to-thread.ts", ["PRRT_x", "**accepted** — b."], fix, {
          stdin: "x",
        }).code,
      ).toBe(2);
      expect(postedBodies(fix)).toEqual([]);
    });

    it("refuses a body whose own trailing line already matches LEAVE_OPEN_MARKER, without the internal producer flag", () => {
      const fix = writeFixture({});
      const body =
        "**wont-fix** — declined; this reply happens to end with the exact marker line.\n\n<!-- triage-thread:leave-open -->";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("LEAVE_OPEN_MARKER");
      expect(postedBodies(fix)).toEqual([]);
    });

    it("posts the same marker-ending body fine WITH DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER=1 — the flag triage-thread.ts sets on its own single call site", () => {
      const fix = writeFixture({});
      const body =
        "**wont-fix** — declined; this reply happens to end with the exact marker line.\n\n<!-- triage-thread:leave-open -->";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
        env: { DRIVE_PR_INTERNAL_LEAVE_OPEN_MARKER: "1" },
      });
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([body]);
    });

    it("does not refuse an ordinary body that never mentions the marker, regardless of the flag", () => {
      const fix = writeFixture({});
      const body = "**wont-fix** — declined, plain and simple.";
      const r = runScript("reply-to-thread.ts", ["PRRT_x"], fix, {
        stdin: body,
      });
      expect(r.code).toBe(0);
      expect(postedBodies(fix)).toEqual([body]);
    });
  },
);

// ── The drive lease fences the POST, not only the state write (TASK) ────

describe("no script mutates anything at import time", () => {
  // `unresolve-thread.ts` ran its GraphQL mutation at module scope, so merely
  // IMPORTING it posted — and the sweep below, which spawns every script with
  // `--help`, was safe only because it stubs `gh`.
  // The whole family gates side effects behind isEntryPoint; this asserts it
  // rather than trusting the harness.
  const entries = readdirSync(SCRIPTS).filter((f) => f.endsWith(".ts"));

  it("sweeps a non-empty script set", () => {
    expect(entries).toContain("unresolve-thread.ts");
    expect(entries).toContain("resolve-thread.ts");
  });

  for (const rel of entries) {
    it(`importing ${rel} spawns no gh`, () => {
      // A `gh` on PATH that RECORDS its invocation rather than one that fails:
      // an import-time call must be visible as a file, not inferred from an
      // exit code the import may swallow.
      const probeDir = mkdtempSync(join(tmpdir(), "rrc-import-"));
      const marker = join(probeDir, "gh-was-called");
      writeFileSync(
        join(probeDir, process.platform === "win32" ? "gh.cmd" : "gh"),
        process.platform === "win32"
          ? `@echo called > "${marker}"\r\n@exit /b 1\r\n`
          : `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
        { mode: 0o755 },
      );
      const r = spawnSync(
        process.execPath,
        ["-e", `import(${JSON.stringify(join(SCRIPTS, rel))})`],
        {
          encoding: "utf8",
          cwd: repoDir,
          input: "",
          env: {
            ...gitCleanEnv(),
            PATH: `${probeDir}${delimiter}${process.env.PATH}`,
            GH_CALL_TIMEOUT: "1",
          },
        },
      );
      expect({ rel, ghCalled: existsSync(marker) }).toEqual({
        rel,
        ghCalled: false,
      });
      // An import that throws would satisfy the assertion vacuously.
      expect({ rel, stderr: r.stderr.slice(0, 400) }).toEqual({
        rel,
        stderr: "",
      });
      rmSync(probeDir, { recursive: true, force: true });
    });
  }
});

describe("every script loads under node as well as bun", () => {
  // Same claim, same probe as drive-pr's suite: SKILL.md § interop advertises
  // these scripts to non-bun harnesses, and Node's strip-only TypeScript
  // refuses sugar bun accepts — an extensionless import or a parameter
  // property is a load failure only node ever sees. A usage error is a pass;
  // a module-resolution or syntax error is not.
  const nodeBin = process.execPath.includes("/bun") ? "node" : process.execPath;
  const entries = [...new Bun.Glob("**/*.ts").scanSync(SCRIPTS)].sort();

  // A `--help` argv makes most scripts fail fast as a usage error, but the
  // one-argument scripts (resolve-thread.ts, unresolve-thread.ts) read it as
  // a thread id and would spawn the REAL `gh` — a mutation attempt leaving
  // the test suite, flaky at best. The probe only asks whether the module
  // graph LOADS, so `gh` is a stub that fails instantly.
  let sweepBin: string;
  beforeAll(() => {
    sweepBin = mkdtempSync(join(tmpdir(), "rrc-sweep-gh-"));
    writeFileSync(
      join(sweepBin, process.platform === "win32" ? "gh.cmd" : "gh"),
      process.platform === "win32" ? "@exit /b 1\r\n" : "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
  });
  afterAll(() => {
    rmSync(sweepBin, { recursive: true, force: true });
  });

  it("sweeps a non-empty script set", () => {
    expect(entries).toContain("await-round.ts");
    expect(entries).toContain("converge.ts");
    expect(entries).toContain("reply-to-thread.ts");
  });

  for (const rel of entries) {
    it(`${rel} loads under node`, () => {
      const r = spawnSync(nodeBin, [join(SCRIPTS, rel), "--help"], {
        encoding: "utf8",
        // Same isolation `runScript` pins, and for the same reason (see the
        // gitCleanEnv comment): a probe inheriting the suite's cwd runs from
        // the REAL checkout, and these scripts resolve their round counters
        // through `git rev-parse --git-dir`. `--help` happening to fail fast
        // is a behavioural accident of each script, not a guard.
        cwd: repoDir,
        input: "",
        env: {
          ...gitCleanEnv(),
          PATH: `${sweepBin}${delimiter}${process.env.PATH}`,
          GH_CALL_TIMEOUT: "1",
        },
      });
      expect({
        rel,
        loadFailure:
          /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION|Bun is not defined/.test(
            r.stderr ?? "",
          ),
      }).toEqual({ rel, loadFailure: false });
    });
  }
});

// ── Cancellation forwarding (TASK) ──────────────────────────────────────

/**
 * A deadlined child is DETACHED into its own process group so the deadline can
 * kill the whole tree. That isolation also puts it beyond the reach of a signal
 * delivered to this process, or to its group — so without `lib/proc.ts`'s
 * source-time forwarding, terminating `await-round.ts` / `converge.ts` /
 * `reply-to-thread.ts` leaves the in-flight `gh` running to completion and the
 * GraphQL mutation lands after the operator believes the operation was
 * cancelled.
 *
 * These are the only probes in this file that assert on a signal, so they are
 * end-to-end by necessity: the claim is about what a SEPARATE process does when
 * the kernel delivers it a TERM, which no in-process assertion can reach. Each
 * spawns a fixture that starts a deadlined grandchild, waits for that
 * grandchild to prove itself live, TERMs the fixture, and asserts on what the
 * grandchild did NOT go on to do.
 */
describe.skipIf(process.platform === "win32")(
  "cancellation reaches a deadlined child (TASK)",
  () => {
    const PROC = join(SCRIPTS, "lib", "proc.ts");

    interface Probe {
      /** Did the grandchild run to completion after the fixture was killed? */
      completed: boolean;
      /** Did the fixture's OWN handler run? */
      ownHandlerRan: boolean;
      /** Signal the fixture died from, if any. */
      signal: string | null;
      code: number | null;
    }

    /**
     * Run one probe. `ownHandler` installs a caller handler in the fixture, so a
     * single fixture covers both the forwarding claim and the guarantee that
     * a caller's own handlers survive.
     */
    async function probe(opts: { ownHandler: boolean }): Promise<Probe> {
      const dir = mkdtempSync(join(tmpdir(), "rrc-cancel-"));
      const live = join(dir, "live");
      const completed = join(dir, "completed");
      const ownRan = join(dir, "own-handler-ran");
      // The grandchild announces itself LIVE before sleeping, so the probe never
      // races the spawn: a TERM delivered before the child existed would leave
      // nothing to forward to and pass vacuously.
      const script = `: > ${JSON.stringify(live)}; sleep 3; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(PROC)};`,
          `import { writeFileSync } from 'node:fs';`,
          opts.ownHandler
            ? `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(ownRan)}, ''); process.exit(9); });`
            : "",
          `await run(['bash', '-c', ${JSON.stringify(script)}], { timeoutSec: 60 });`,
        ].join("\n"),
      );

      const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        stdio: "ignore",
      });
      const ended = new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );

      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(live); i++) await sleep(25);
      const wasLive = existsSync(live);
      child.kill("SIGTERM");
      const exit = await ended;
      // Outlive the grandchild's own `sleep 3`: the assertion is that it never
      // completes, which is only meaningful once it would have.
      await sleep(4000);

      const result: Probe = {
        completed: existsSync(completed),
        ownHandlerRan: existsSync(ownRan),
        signal: exit.signal,
        code: exit.code,
      };
      rmSync(dir, { recursive: true, force: true });
      // Folded into the returned shape rather than asserted here, so a fixture
      // that never got its child running fails the caller's expectation loudly
      // instead of silently satisfying `completed: false`.
      if (!wasLive) throw new Error("probe grandchild never became live");
      return result;
    }

    it("kills the in-flight child instead of letting it complete", async () => {
      const r = await probe({ ownHandler: false });
      expect({ completed: r.completed, signal: r.signal }).toEqual({
        completed: false,
        // Re-raised: with no caller handler the forwarding removes itself and
        // signals this process again, so it dies from the TERM exactly as it
        // would have with no handler installed. That is what keeps a
        // cancellation unmaskable by a caller that swallowed the RunResult.
        signal: "SIGTERM",
      });
    });

    it("preserves the caller's own handler while still killing the child", async () => {
      const r = await probe({ ownHandler: true });
      expect({
        completed: r.completed,
        ownHandlerRan: r.ownHandlerRan,
        code: r.code,
      }).toEqual({
        completed: false,
        ownHandlerRan: true,
        // The caller's handler owns the outcome once it exists — no re-raise, and
        // its own exit code, not the signal's.
        code: 9,
      });
    });

    it("keeps forwarding a second signal when the caller handler does not exit", async () => {
      // Regression for the bug this TASK hardening fixed: `forward` used to
      // remove itself unconditionally after the FIRST occurrence of a signal,
      // regardless of whether other listeners were still present. A caller that
      // handles or debounces a signal without exiting — modelled here by an own
      // handler that never calls `process.exit()` — silently regained the
      // original unforwarded-cancellation bug for every signal after the first.
      // Two deadlined children run in sequence so the SECOND SIGTERM has a live
      // tracked group to prove was (or was not) forwarded.
      const dir = mkdtempSync(join(tmpdir(), "rrc-cancel-repeat-"));
      const liveA = join(dir, "liveA");
      const completedA = join(dir, "completedA");
      const liveB = join(dir, "liveB");
      const completedB = join(dir, "completedB");
      const phase2 = join(dir, "phase2-ready");
      const scriptA = `: > ${JSON.stringify(liveA)}; sleep 3; : > ${JSON.stringify(completedA)}`;
      const scriptB = `: > ${JSON.stringify(liveB)}; sleep 3; : > ${JSON.stringify(completedB)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(PROC)};`,
          `import { writeFileSync } from 'node:fs';`,
          `process.on('SIGTERM', () => {});`,
          `async function main() {`,
          `  await run(['bash', '-c', ${JSON.stringify(scriptA)}], { timeoutSec: 60 });`,
          `  writeFileSync(${JSON.stringify(phase2)}, '');`,
          `  await run(['bash', '-c', ${JSON.stringify(scriptB)}], { timeoutSec: 60 });`,
          `}`,
          `main();`,
        ].join("\n"),
      );

      const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        stdio: "ignore",
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      try {
        for (let i = 0; i < 200 && !existsSync(liveA); i++) await sleep(25);
        if (!existsSync(liveA))
          throw new Error("fixture child A never became live");
        child.kill("SIGTERM");

        for (let i = 0; i < 200 && !existsSync(phase2); i++) await sleep(25);
        if (!existsSync(phase2)) {
          throw new Error("fixture did not resume after the first SIGTERM");
        }

        for (let i = 0; i < 200 && !existsSync(liveB); i++) await sleep(25);
        if (!existsSync(liveB))
          throw new Error("fixture child B never became live");
        child.kill("SIGTERM");

        // Outlive child B's own `sleep 3`: the assertion is that it never
        // completes, which is only meaningful once it would have.
        await sleep(4000);

        expect(existsSync(completedA)).toBe(false);
        expect(existsSync(completedB)).toBe(false);
      } finally {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // The consequential case, asserted at its own emission site rather than only
    // through the library: a reply that posts after the operator cancelled is a
    // thread classified — and a reviewer-scoring sample corrupted — on an
    // operation they believe never ran.
    it("does not let reply-to-thread.ts's mutation land after cancellation", async () => {
      const fix = writeFixture({ threads: [thread("PRRT_x")] });
      writeFileSync(join(fix.dir, "graphql-slow"), "");
      const started = join(fix.dir, "graphql-started");

      const child = spawn(
        process.execPath,
        [join(SCRIPTS, "reply-to-thread.ts"), "PRRT_x"],
        {
          cwd: repoDir,
          stdio: ["pipe", "ignore", "ignore"],
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            RRC_FIX: fix.dir,
            GH_CALL_TIMEOUT: "60",
          },
        },
      );
      child.stdin?.end("**accepted** — fixed in abc1234.\n");
      const ended = new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(started); i++) await nap(25);
      // Non-vacuous: the mutation must actually be IN FLIGHT when the TERM lands,
      // or "it never posted" would be true for the wrong reason.
      expect(existsSync(started)).toBe(true);

      child.kill("SIGTERM");
      await ended;
      // Outlive the stub's own delay: the claim is that the post never happens,
      // which is only meaningful once it otherwise would have.
      await nap(4000);

      // Read straight off the stub's own record rather than through
      // `postedBodies` (which is scoped to the reply-to-thread describe): the
      // claim here is that NO document was posted at all, so the absence of the
      // file is the whole assertion.
      expect(
        readdirSync(fix.dir).filter((f) => f.startsWith("graphql-input-")),
      ).toEqual([]);
    });
  },
);

// ── Cancellation forwarding — the gh.ts sibling path (TASK) ─────────────

/**
 * `ghOrExit()` used to spawn `gh` with `spawnSync`: the child was not
 * detached, and the parent could not run a JS signal handler while blocked in
 * the syscall, so a SIGTERM delivered to `resolve-thread.ts` /
 * `unresolve-thread.ts` directly (not through drive-pr's `run()`, which
 * detaches and forwards — see the TASK block above) killed the parent at
 * kernel level and left the `gh` mutation running to completion. Same shape
 * as the TASK probe: start a deadlined mutation, wait for it to be
 * IN FLIGHT, TERM the script, and assert the mutation never landed.
 */
describe.skipIf(process.platform === "win32")(
  "cancellation reaches gh.ts mutations directly (TASK)",
  () => {
    async function probeMutationCancelled(
      script: "resolve-thread.ts" | "unresolve-thread.ts",
    ): Promise<void> {
      const fix = writeFixture({ threads: [thread("PRRT_x")] });
      writeFileSync(join(fix.dir, "graphql-slow"), "");
      const started = join(fix.dir, "graphql-started");

      const child = spawn(process.execPath, [join(SCRIPTS, script), "PRRT_x"], {
        cwd: repoDir,
        stdio: ["ignore", "ignore", "ignore"],
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          RRC_FIX: fix.dir,
          GH_CALL_TIMEOUT: "60",
        },
      });
      const ended = new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 200 && !existsSync(started); i++) await nap(25);
      // Non-vacuous: the mutation must actually be IN FLIGHT when the TERM
      // lands, or "it never landed" would be true for the wrong reason.
      expect(existsSync(started)).toBe(true);

      child.kill("SIGTERM");
      await ended;
      // Outlive the stub's own delay: the claim is that the mutation never
      // lands, which is only meaningful once it otherwise would have.
      await nap(4000);

      expect(
        readdirSync(fix.dir).filter((f) => f.startsWith("graphql-mutation-")),
      ).toEqual([]);
    }

    it("does not let resolve-thread.ts's mutation land after a direct TERM", async () => {
      await probeMutationCancelled("resolve-thread.ts");
    });

    it("does not let unresolve-thread.ts's mutation land after a direct TERM", async () => {
      await probeMutationCancelled("unresolve-thread.ts");
    });
  },
);

// ── Buffer cap ──────────────────────────────────────────────────────────────

/**
 * `run()`'s `data` handlers used to accumulate stdout/stderr with no bound at
 * all once `ghOrExit` moved off `spawnSync`'s own `maxBuffer`. A child that
 * keeps writing is killed on a byte trigger the same way a hung one is killed
 * on a clock — this proves the trigger actually fires and actually stops the
 * child, with a `maxBufferBytes` override small enough to hit in-test rather
 * than the real 64 MiB default.
 *
 * "Later chunks are excluded" is asserted directly off `onChunk`'s per-chunk
 * captured/discarded record, not inferred from a captured byte-count bound —
 * a real OS pipe's read chunking varies enough in practice (a single burst
 * measured ~250 KiB here) that any fixed bound is either loose enough to miss
 * a partial regression or tight enough to flake on legitimate variance.
 * Counting discarded chunks sidesteps both.
 */
describe.skipIf(process.platform === "win32")(
  "run()'s output cap kills a runaway child (TASK)",
  () => {
    const MAX_BUFFER_BYTES_TEST = 8192;
    // A sanity ceiling only — not the primary proof (see `discardedChunks`
    // below) — wide enough that legitimate OS pipe chunking variance across
    // machines never trips it, while still ruling out the catastrophic
    // regression class: an UNGUARDED child left running for the same
    // two-second SIGKILL grace this probe exercises captures on the order of a
    // HUNDRED MEGABYTES (measured), thousands of times past this ceiling.
    const SANITY_CEILING = MAX_BUFFER_BYTES_TEST + 4 * 1024 * 1024;

    /**
     * @param ignoreTerm When true, the child traps and swallows SIGTERM so only
     *   the escalation's SIGKILL two seconds later actually ends it — the exact
     *   window in which unguarded capture used to keep growing.
     */
    async function probeBufferCap(opts: {
      ignoreTerm: boolean;
    }): Promise<{ result: Record<string, unknown>; completed: boolean }> {
      const dir = mkdtempSync(join(tmpdir(), "rrc-buffer-"));
      const completed = join(dir, "completed");
      // Writes 1 KiB chunks forever until killed; `completed` only appears if
      // the loop is allowed to finish on its own, which the cap must prevent.
      // A `while` counter at a count high enough that a fast CI runner cannot
      // finish it naturally within the ~2s SIGKILL grace, not `for i in
      // $(seq 1 1000000)`: nothing throttles a discarded-past-the-cap child's
      // write rate (the pipe is drained continuously, just not captured), so a
      // sufficiently fast machine completed 1,000,000 tight-loop iterations —
      // `completed` existed — inside the grace window, failing the assertion
      // that `ignoreTerm: true` is never allowed to finish on its own
      // (measured in CI, not locally). A count also high enough that
      // `$(seq ...)` would materialise the whole number list before the loop's
      // first write, which the `while` form avoids.
      const trap = opts.ignoreTerm ? "trap '' TERM; " : "";
      const script = `${trap}i=0; while [ "$i" -lt 100000000 ]; do printf '%01024d' 0; i=$((i + 1)); done; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(join(SCRIPTS, "lib", "proc.ts"))};`,
          `let discardedChunks = 0;`,
          `let discardedBytes = 0;`,
          `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
          `  timeoutSec: 60,`,
          `  maxBufferBytes: ${MAX_BUFFER_BYTES_TEST},`,
          `  onChunk: (_stream, bytes, captured) => {`,
          `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
          `  },`,
          `});`,
          `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
        ].join("\n"),
      );

      const out = checkedSpawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        encoding: "utf8",
        timeout: 15_000,
      });
      const result = JSON.parse(out);
      const stillCompleted = existsSync(completed);
      rmSync(dir, { recursive: true, force: true });
      return { result, completed: stillCompleted };
    }

    it("kills the child and reports bufferExceeded once captured output crosses the cap", async () => {
      const { result, completed } = await probeBufferCap({ ignoreTerm: false });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed,
      }).toEqual({
        code: 1,
        timedOut: false,
        bufferExceeded: true,
        completed: false,
      });
      expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
    });

    it("discards every chunk offered after the cap trips, even when the child ignores SIGTERM through the SIGKILL grace", async () => {
      const { result, completed } = await probeBufferCap({ ignoreTerm: true });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed,
      }).toEqual({
        code: 1,
        timedOut: false,
        bufferExceeded: true,
        completed: false,
      });
      // The child kept writing for the whole two-second grace before SIGKILL
      // landed, so `onChunk` must have SEEN further chunks arrive — and this is
      // the direct proof they were rejected rather than captured: not "capture
      // happened to stay small", but "chunks offered past the cap were counted
      // and discarded".
      expect(result.discardedChunks as number).toBeGreaterThan(0);
      expect(result.discardedBytes as number).toBeGreaterThan(0);
      expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
    });

    it("also stops capturing once the DEADLINE (not the buffer cap) trips, through its own SIGKILL grace", async () => {
      // The capture guard used to key only on `bufferExceeded`, so a child that
      // hits the DEADLINE first kept being captured for the whole two-second
      // deadline escalation — an 8 KiB cap stayed unenforced against a
      // multi-megabyte post-timeout flood.
      //
      // A THROTTLED writer, not the tight loop the buffer-cap probes above use:
      // an earlier version of this probe let that tight loop run unthrottled
      // under a 1 GiB `maxBufferBytes` so only the deadline (never 1 GiB) could
      // trigger — but the loop's own measured ~100+ MB/s rate meant `r.stdout`
      // legitimately retained tens to hundreds of megabytes for the whole test,
      // real memory pressure this suite doesn't need, and on a fast enough or
      // memory-constrained runner it could OOM, or cross even 1 GiB before the
      // 1-second deadline and flip `bufferExceeded` instead of `timedOut`,
      // failing the very assertion below it. A small, slow, bounded write
      // rate proves the exact same thing — chunks arriving during the
      // deadline's escalation are discarded — without either risk: total
      // captured output here is on the order of kilobytes, several orders of
      // magnitude under any buffer cap this test would plausibly configure.
      const dir = mkdtempSync(join(tmpdir(), "rrc-buffer-"));
      const completed = join(dir, "completed");
      // ~50 writes/sec of 64 bytes each — keeps going (SIGTERM trapped) through
      // the full 1s deadline + 2s grace, but never accumulates more than a few
      // hundred bytes before the deadline and a similar amount discarded after.
      const script = `trap '' TERM; while true; do printf '%064d' 0; sleep 0.02; done; : > ${JSON.stringify(completed)}`;
      writeFileSync(
        join(dir, "fixture.ts"),
        [
          `import { run } from ${JSON.stringify(join(SCRIPTS, "lib", "proc.ts"))};`,
          `let discardedChunks = 0;`,
          `let discardedBytes = 0;`,
          `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
          `  timeoutSec: 1,`,
          `  onChunk: (_stream, bytes, captured) => {`,
          `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
          `  },`,
          `});`,
          `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
        ].join("\n"),
      );

      const out = checkedSpawn(process.execPath, [join(dir, "fixture.ts")], {
        cwd: repoDir,
        env: gitCleanEnv(),
        encoding: "utf8",
        timeout: 15_000,
      });
      const result = JSON.parse(out);
      const stillCompleted = existsSync(completed);
      rmSync(dir, { recursive: true, force: true });

      expect({
        code: result.code,
        timedOut: result.timedOut,
        bufferExceeded: result.bufferExceeded,
        completed: stillCompleted,
      }).toEqual({
        code: 124,
        timedOut: true,
        bufferExceeded: false,
        completed: false,
      });
      // The child kept writing through the deadline's own two-second grace, so
      // `onChunk` must have seen — and discarded — further chunks.
      expect(result.discardedChunks as number).toBeGreaterThan(0);
      expect(result.discardedBytes as number).toBeGreaterThan(0);
      // Sanity, not the primary proof: at ~50 writes/sec this stays a few
      // hundred bytes even over 3 real seconds, nowhere near a real cap.
      expect(result.stdoutLength as number).toBeLessThan(64 * 1024);
    });
  },
);

// ── await-round.ts: polling cost (TASK) ─────────────────────────────────
//
// Every `gh pr view` / `gh pr checks` is a GraphQL call against a per-token
// hourly bucket. These probes read what the loop actually asked of `gh` — the
// stub logs each call — rather than trusting the loop's own description of
// itself. They spawn the real loop asynchronously at the 5s minimum interval
// and change the fixtures under it.

describe.skipIf(process.platform === "win32")(
  "await-round.ts polling cost (TASK)",
  () => {
    const lines = (fix: Fixture, name: string): number => {
      try {
        return readFileSync(join(fix.dir, name), "utf8")
          .split("\n")
          .filter(Boolean).length;
      } catch {
        return 0;
      }
    };

    const checkRunReads = (fix: Fixture): number => {
      try {
        return readFileSync(join(fix.dir, "rest-calls.log"), "utf8")
          .split("\n")
          .filter((l) => l.includes("/check-runs")).length;
      } catch {
        return 0;
      }
    };

    async function until(
      what: string,
      cond: () => boolean,
      timeoutMs = 60_000,
    ): Promise<void> {
      const end = Date.now() + timeoutMs;
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    /** The real loop, running, with its own throwaway ETag cache. */
    function spawnLoop(
      fix: Fixture,
      args: string[],
      env: Record<string, string> = {},
    ): { done: Promise<{ code: number; stderr: string }>; kill: () => void } {
      const child = spawn(
        process.execPath,
        [join(SCRIPTS, "await-round.ts"), fix.pr, ...args],
        {
          cwd: repoDir,
          env: {
            ...gitCleanEnv(),
            PATH: `${binDir}${delimiter}${process.env.PATH}`,
            RRC_FIX: fix.dir,
            GH_CALL_TIMEOUT: "20",
            GROUNDWORK_GH_CACHE_DIR: join(fix.dir, "etag-cache"),
            ...env,
          },
        },
      );
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += String(d);
      });
      const done = new Promise<{ code: number; stderr: string }>((resolve) => {
        child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
      });
      return { done, kill: () => child.kill("SIGKILL") };
    }

    const PENDING = [check("AI review (shadow)", "pending", "IN_PROGRESS")];
    const SETTLED = [check("AI review (shadow)", "pass", "COMPLETED")];

    it("polls a numeric PR without a single `gh pr view` (state and head come over REST)", () => {
      const fix = writeFixture({ threads: [thread("PRRT_a")] });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(0);
      expect(lines(fix, "pr-view-calls.log")).toBe(0);
      expect(lines(fix, "rest-calls.log")).toBeGreaterThan(0);
    });

    it("refuses a PR that is not a number up front, before any gh call", () => {
      for (const bad of [
        "https://github.com/acme/widgets/pull/101",
        "feature/some-branch",
      ]) {
        const fix = writeFixture({ threads: [thread("PRRT_a")] });
        const r = runScript("await-round.ts", [bad, "--once"], fix);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain("PR must be a number");
        expect(lines(fix, "pr-view-calls.log")).toBe(0);
        expect(lines(fix, "rest-calls.log")).toBe(0);
      }
    });

    it("does not re-ask `gh pr checks` while a pending verdict is confirmed unchanged, and re-reads the moment a check moves", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"]);
      try {
        // Tick 1 reads (and primes the detector); ticks 2 and 3 are gated.
        await until("two gated polls", () => checkRunReads(fix) >= 3);
        expect(lines(fix, "pr-checks-calls.log")).toBe(1);
        expect(lines(fix, "rest-conditional.log")).toBeGreaterThanOrEqual(2);

        writeFileSync(join(fix.dir, "checks.json"), JSON.stringify(SETTLED));
        const { code, stderr } = await loop.done;
        // The change was detected, `gh pr checks` was asked again, and its
        // verdict — not the stale cached one — decided the exit.
        expect(code).toBe(3);
        expect(stderr).toContain("converged");
        expect(lines(fix, "pr-checks-calls.log")).toBe(2);
      } finally {
        loop.kill();
      }
    }, 120_000);

    it("never trusts an unchanged signal for longer than AWAIT_ROUND_CHECKS_MAX_AGE", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"], {
        AWAIT_ROUND_CHECKS_MAX_AGE: "6",
      });
      try {
        // Nothing ever changes, yet the age bound forces a fresh authoritative
        // read after the first reuse.
        await until(
          "a forced re-read",
          () => lines(fix, "pr-checks-calls.log") >= 2,
        );
        expect(lines(fix, "rest-conditional.log")).toBeGreaterThanOrEqual(1);
      } finally {
        loop.kill();
        await loop.done;
      }
    }, 120_000);

    // The fail-closed heart of the gate. The REST signals here are perfectly
    // steady (the stub's check-run body never changes), so a loop that cached an
    // ERROR verdict would see "unchanged" and stop re-asking — burning its retry
    // budget on a frozen answer instead of on fresh reads. Only a keep-waiting
    // verdict may ever be reused.
    it("re-asks `gh pr checks` on every tick while it keeps failing — an unreadable verdict is never reused", async () => {
      const fix = writeFixture({ checks: { exit: 1 } });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"]);
      try {
        const { code, stderr } = await loop.done;
        expect(code).toBe(1);
        expect(stderr).toContain("after 3 attempts");
        expect(lines(fix, "pr-checks-calls.log")).toBe(3);
      } finally {
        loop.kill();
      }
    }, 120_000);

    it("AWAIT_ROUND_CHECKS_MAX_AGE=0 disables the gate: every tick reads, and the detector is never queried", async () => {
      const fix = writeFixture({ checks: PENDING });
      const loop = spawnLoop(fix, ["--interval", "5", "--timeout", "90"], {
        AWAIT_ROUND_CHECKS_MAX_AGE: "0",
      });
      try {
        await until(
          "two full reads",
          () => lines(fix, "pr-checks-calls.log") >= 2,
        );
        expect(checkRunReads(fix)).toBe(0);
      } finally {
        loop.kill();
        await loop.done;
      }
    }, 120_000);

    it("rejects a malformed AWAIT_ROUND_CHECKS_MAX_AGE as a usage error", () => {
      const fix = writeFixture({});
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix, {
        env: { AWAIT_ROUND_CHECKS_MAX_AGE: "soon" },
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("AWAIT_ROUND_CHECKS_MAX_AGE");
    });

    it("names the underlying reason when the PR state cannot be read", () => {
      const fix = writeFixture({ stateUnreadable: true });
      const r = runScript("await-round.ts", [fix.pr, "--once"], fix);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`cannot read state of PR #${fix.pr}`);
      expect(r.stderr).toContain("gh api");
    });
  },
);

// These fixtures implement only sibling CLI responses, never lease state or a
// summary parser. Real producer/consumer tests live in the consumer repository.
function runWithSibling(
  script: string,
  args: string[],
  fix: Fixture,
  siblingScripts: Record<string, string>,
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  const skills = mkdtempSync(join(tmpRoot, "optional-sibling-"));
  const scripts = join(skills, "resolve-review-comments", "scripts");
  cpSync(SCRIPTS, scripts, { recursive: true });
  if (Object.keys(siblingScripts).length) {
    const sibling = join(skills, "drive-pr", "scripts");
    mkdirSync(sibling, { recursive: true });
    for (const [name, source] of Object.entries(siblingScripts)) {
      writeFileSync(join(sibling, name), source);
    }
  }
  return runScript(script, args, fix, { ...opts, scriptsRoot: scripts });
}

const siblingRecorder = (exit: number) => `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.SIBLING_LOG!, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(${exit});
`;

describe.skipIf(process.platform === "win32")(
  "optional sibling CLI boundaries",
  () => {
    const body = "**accepted** — added the guard; not yet pushed.\n";
    function mutations(fix: Fixture) {
      return readdirSync(fix.dir).filter((name) =>
        name.startsWith("graphql-input-"),
      );
    }
    for (const exit of [1, 11]) {
      it(`fence refusal ${exit} prevents the mutation and preserves the verdict`, () => {
        const fix = writeFixture({});
        const log = join(fix.dir, "fence.log");
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence"],
          fix,
          { "assert-post-allowed.ts": siblingRecorder(exit) },
          { stdin: body, env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(exit);
        expect(mutations(fix)).toEqual([]);
        expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual([
          "--what",
          "reply-to-thread.ts (drive lease)",
        ]);
      });
    }
    it("a successful fence is called before posting the exact reply", () => {
      const fix = writeFixture({});
      const log = join(fix.dir, "fence.log");
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_fence"],
        fix,
        { "assert-post-allowed.ts": siblingRecorder(0) },
        { stdin: body, env: { SIBLING_LOG: log } },
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual([
        "--what",
        "reply-to-thread.ts (drive lease)",
      ]);
      expect(mutations(fix)).toHaveLength(1);
      const [mutation] = mutations(fix);
      if (!mutation) throw new Error("expected a recorded mutation");
      expect(readFileSync(join(fix.dir, mutation), "utf8")).toContain(
        body.trim(),
      );
    });
    for (const noOutcome of [false, true]) {
      // The liveness read is a network round trip; the lease fence must be the
      // LAST check before the reply so it cannot go stale during that read.
      it(`runs the harness fence after liveness, immediately before the reply (no-outcome=${noOutcome})`, () => {
        const fix = writeFixture({});
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence", ...(noOutcome ? ["--no-outcome"] : [])],
          fix,
          {
            "assert-post-allowed.ts": `
            import { appendFileSync } from "node:fs";
            appendFileSync(${JSON.stringify(join(fix.dir, "thread-events.log"))}, "fence\\n");
          `,
          },
          { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
        );
        expect(r.code).toBe(0);
        expect(mutations(fix)).toHaveLength(1);
        expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
          "liveness\nfence\nreply\n",
        );
      });
      it(`refuses when the lease is taken over during the liveness read (no-outcome=${noOutcome})`, () => {
        const fix = writeFixture({});
        // A fence that refuses once the liveness read has happened models a
        // replacement driver taking the lease while that read was pending.
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_fence", ...(noOutcome ? ["--no-outcome"] : [])],
          fix,
          {
            "assert-post-allowed.ts": `
            import { readFileSync } from "node:fs";
            const events = readFileSync(${JSON.stringify(join(fix.dir, "thread-events.log"))}, "utf8");
            process.exit(events.includes("liveness") ? 11 : 0);
          `,
          },
          { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
        );
        expect(r.code).toBe(11);
        expect(mutations(fix)).toEqual([]);
        expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
          "liveness\n",
        );
      });
    }
    // Documents the residual race the SKILL.md states: GitHub offers no
    // open-state precondition, so a merge landing after the liveness read —
    // here, during the fence — is NOT prevented. Do not read this as a guarantee.
    it("does not prevent a merge that lands during the fence (documented residual race)", () => {
      const fix = writeFixture({});
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_fence"],
        fix,
        {
          "assert-post-allowed.ts": `
            import { writeFileSync } from "node:fs";
            writeFileSync(${JSON.stringify(join(fix.dir, "state"))}, "MERGED");
          `,
        },
        { stdin: body, env: { DRIVE_PR_TARGET: "99999" } },
      );
      expect(r.code).toBe(0);
      // Proves the fence really ran and merged the PR, so this cannot degrade
      // into an ordinary OPEN-state posting test.
      expect(readFileSync(join(fix.dir, "state"), "utf8")).toBe("MERGED");
      expect(mutations(fix)).toHaveLength(1);
      expect(readFileSync(join(fix.dir, "thread-events.log"), "utf8")).toBe(
        "liveness\nreply\n",
      );
    });
    it("an installed sibling without its fence refuses before posting", () => {
      const fix = writeFixture({});
      const r = runWithSibling(
        "reply-to-thread.ts",
        ["PRRT_missing"],
        fix,
        { "unrelated.ts": "process.exit(0);" },
        { stdin: body },
      );
      expect(r.code).toBe(1);
      expect(mutations(fix)).toEqual([]);
    });
    it("an absent sibling permits standalone posting, but inherited drive context refuses", () => {
      for (const hasContext of [false, true]) {
        const fix = writeFixture({});
        const r = runWithSibling(
          "reply-to-thread.ts",
          ["PRRT_standalone"],
          fix,
          {},
          { stdin: body, env: hasContext ? { DRIVE_PR_TARGET: fix.pr } : {} },
        );
        expect(r.code).toBe(hasContext ? 1 : 0);
        expect(mutations(fix)).toHaveLength(hasContext ? 0 : 1);
      }
    });
    const summary =
      "console.log(JSON.stringify({ total: 0, unaddressed: [] }));";
    const release = siblingRecorder(0);
    for (const code of [0, 127]) {
      it(`releases a sessionless lease after an actual pass exits ${code}`, () => {
        const fix = writeFixture({ threads: [thread("PRRT_release")] });
        const log = join(fix.dir, "release.log");
        const pass = join(fix.dir, "pass.ts");
        writeFileSync(pass, `process.exit(${code});`);
        const r = runWithSibling(
          "converge.ts",
          [fix.pr, "--max-rounds", "1", "--", process.execPath, pass, fix.pr],
          fix,
          {
            "release-sessionless-lease.ts": release,
            "summary-findings.ts": summary,
          },
          { env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(code === 0 ? 6 : 1);
        expect(JSON.parse(readFileSync(log, "utf8").trim())).toContain(fix.pr);
      });
    }
    for (const mode of [
      "converged",
      "dry-run",
      "zero-rounds",
      "failed-spawn",
    ]) {
      it(`does not release when no pass ran: ${mode}`, () => {
        const fix = writeFixture({
          threads: mode === "converged" ? [] : [thread("PRRT_hold")],
        });
        const log = join(fix.dir, "release.log");
        const args = [fix.pr];
        if (mode === "dry-run") args.push("--dry-run");
        else {
          if (mode === "zero-rounds") args.push("--max-rounds", "0");
          args.push("--", join(fix.dir, "missing-executable"), fix.pr);
        }
        const r = runWithSibling(
          "converge.ts",
          args,
          fix,
          {
            "release-sessionless-lease.ts": release,
            "summary-findings.ts": summary,
          },
          { env: { SIBLING_LOG: log } },
        );
        expect(r.code).toBe(
          mode === "converged" || mode === "dry-run"
            ? 0
            : mode === "zero-rounds"
              ? 6
              : 1,
        );
        expect(existsSync(log)).toBe(false);
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "fails CLOSED when the SKILLS PARENT disappears mid-run — the real path, not the predicate",
  async () => {
    // The predicate probes below cover the DECISION; this covers that
    // `assertPostAllowed` actually acts on it. Without this, deleting the
    // `if (!skillsParentIsIntact())` branch outright left every predicate
    // test green while restoring the exact fail-open they exist to guard —
    // a vacuous safety harness.
    //
    // The mid-run mutation is REAL here, not simulated: `main()` reads stdin
    // (line ~464) BEFORE it calls `assertPostAllowed` (~482), so a process
    // spawned with an open stdin pipe is parked with every module already
    // loaded and the fence not yet run. Deleting the skills root in that
    // window is precisely the state the guard is about — a tree changing
    // underneath an already-loaded process — reached without injecting a
    // probe or otherwise altering production code to be testable.
    const fix = writeFixture({});
    const skills = join(tmpRoot, "skills-parent-vanishes");
    const rrc = join(skills, "resolve-review-comments", "scripts");
    mkdirSync(join(skills, "resolve-review-comments"), { recursive: true });
    cpSync(SCRIPTS, rrc, { recursive: true });

    // Readiness is HANDSHAKED, not timed. A fixed `setTimeout` was the first
    // cut and is unsound on a loaded worker: module loading has no upper
    // bound, so an early timer deletes the tree mid-import and the run fails
    // on a module-load error instead of exercising the guard. Acknowledging
    // that in a comment, as the first cut did, is not preventing it.
    //
    // The marker is patched into the COPY, never into production: the copied
    // entrypoint writes it immediately before `readStdinAll()`, which is after
    // every static import has been evaluated and before the fence runs. That
    // is exactly the window this test needs, and it leaves `assertPostAllowed`
    // — the thing under test — untouched.
    const readyFile = join(tmpRoot, "skills-parent-vanishes-ready");
    const entry = join(rrc, "reply-to-thread.ts");
    const READY_ANCHOR = "const body = await readStdinAll();";
    const patched = readFileSync(entry, "utf8").replace(
      READY_ANCHOR,
      `{ const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); }\n  ${READY_ANCHOR}`,
    );
    // Assert the patch LANDED. A silently missed anchor (the string moves,
    // someone reformats the line) would restore the wall-clock race with no
    // signal — the "verify the mutation landed on the intended line" trap.
    expect(patched).toContain(readyFile);
    writeFileSync(entry, patched);

    const child = spawn(
      process.execPath,
      [join(rrc, "reply-to-thread.ts"), "PRRT_x"],
      {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...gitCleanEnv(),
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          RRC_FIX: fix.dir,
          GH_CALL_TIMEOUT: "20",
        },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const exited = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? -1));
    });

    // Wait for the child's own signal that imports are done and it is about to
    // read stdin. The deadline is a FAILURE bound, not a timing assumption:
    // arriving late is fine, never arriving is a real defect.
    const deadline = Date.now() + 20_000;
    while (!existsSync(readyFile)) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(
          `child never signalled readiness (stderr: ${stderr.slice(0, 400)})`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    rmSync(skills, { recursive: true, force: true });
    child.stdin?.end("**accepted** — fixed in abc1234.\n");

    const code = await exited;
    expect({
      code,
      posted: readdirSync(fix.dir).filter((name) =>
        name.startsWith("graphql-input-"),
      ).length,
    }).toEqual({
      code: 1,
      posted: 0,
    });
    // The guard's OWN message, not merely a non-zero exit: a module-load
    // failure from a mistimed delete also exits non-zero, and must not read as
    // this guard firing.
    expect(stderr).toContain("neither does the");
  },
  30_000,
);

describe("skillsParentIsIntact — the other half of an ENOENT (TASK)", () => {
  // An ENOENT on `<skills>/drive-pr` says the path does not resolve; it does
  // NOT say which component failed. The root alone being absent is the
  // standalone install; an ANCESTOR removed or renamed under an
  // already-loaded process is a damaged tree that says nothing about whether
  // a drive exists. The ENOTDIR fix the round before closed only the
  // prefix-is-a-FILE half — ENOENT still carried the prefix-is-GONE half
  // straight through the skip.
  //
  // These cover the DECISION table against real paths. They are deliberately
  // NOT the only coverage: on their own they stay green when the production
  // branch that consults them is deleted, which is a vacuous harness. The
  // end-to-end probe directly above
  // (`fails CLOSED when the SKILLS PARENT disappears mid-run`) is what pins the
  // branch itself, and it reddens under exactly that mutation.
  it("is true for a real directory — the ordinary install", () => {
    expect(skillsParentIsIntact(tmpRoot)).toBe(true);
  });

  it("is FALSE when the parent was removed — the damaged tree that used to skip", () => {
    expect(skillsParentIsIntact(join(tmpRoot, "never-created"))).toBe(false);
  });

  it("is FALSE when the parent is a FILE rather than a directory", () => {
    const notADir = join(tmpRoot, "skills-parent-is-a-file");
    writeFileSync(notADir, "not a directory\n");
    expect(skillsParentIsIntact(notADir)).toBe(false);
  });

  it("follows a symlink to a real directory — an ordinary layout, not damage", () => {
    // `stat`, not `lstat`: the question is whether the directory is there,
    // not how it is named. A repo whose skills/ is reached through a symlink
    // must keep posting, so this pins the choice of call rather than leaving
    // it to be re-litigated as "shouldn't this be lstat like the one above".
    const realDir = join(tmpRoot, "skills-symlink-target");
    const link = join(tmpRoot, "skills-via-symlink");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(
      realDir,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(skillsParentIsIntact(link)).toBe(true);
  });

  it("is FALSE for a DANGLING symlink — unreadable is not intact", () => {
    const link = join(tmpRoot, "skills-dangling-symlink");
    symlinkSync(
      join(tmpRoot, "symlink-target-does-not-exist"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(skillsParentIsIntact(link)).toBe(false);
  });
});

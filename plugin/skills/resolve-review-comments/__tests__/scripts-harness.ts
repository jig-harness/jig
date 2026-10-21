/**
 * scripts-harness.ts — what the resolve-review-comments script-surface suites
 * share: a throwaway git repository to run the entry scripts from, a
 * fixture-driven `gh` stub on `PATH`, and the fixture helpers the probes drive
 * that stub with. A test file calls `useStubForge()` once at top level.
 */

import { afterAll, beforeAll } from "bun:test";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");
const SHARED = join(import.meta.dir, "..", "..", "..", "shared");

/**
 * Copy this skill's scripts into `<skills>/resolve-review-comments/scripts`
 * and the plugin's shared code beside `skills` (`<skills>/../shared`), the
 * layout a plugin cache holds, so the copy's imports resolve. Returns the
 * copied scripts directory.
 */
export function copySkillScripts(skills: string): string {
  const scripts = join(skills, "resolve-review-comments", "scripts");
  cpSync(SCRIPTS, scripts, { recursive: true });
  cpSync(SHARED, join(dirname(skills), "shared"), {
    recursive: true,
    filter: (path) => !path.includes("__tests__"),
  });
  return scripts;
}
export const HEAD_A = "aaaa19d8a22488d233ac3f5081020f081d4388f1";
export const HEAD_B = "bbbb19d8a22488d233ac3f5081020f081d4388f1";

/**
 * How long a cancellation probe's in-flight work (the stub's slow mutation, a
 * deadlined grandchild) runs before it would complete, and how long a probe
 * waits after the cancellation before asserting it never did: long enough
 * that the work would have finished had the cancellation not reached it.
 */
export const IN_FLIGHT_SEC = 1;
export const OUTLIVE_IN_FLIGHT_MS = IN_FLIGHT_SEC * 1000 + 500;

/** Synchronous fixture setup with guarded, explicit environment isolation. */
export function checkedSpawn(
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

// ── Stub forge ──────────────────────────────────────────────────────────────

export let tmpRoot: string;
export let binDir: string;
export let repoDir: string;

/**
 * `process.env` minus every `GIT_*` pointer — the same scrub as drive-pr's
 * suite, and NOT optional. Git hooks export `GIT_DIR`, `GIT_WORK_TREE` and
 * `GIT_INDEX_FILE` into their children, so under `lefthook`'s pre-commit the
 * `git init` below reinitialises the REAL repository (measured on this very
 * suite's first hook run: it flipped the main checkout's `core.bare` to true,
 * breaking every Conductor worktree at once), and the scripts under test —
 * which run `git rev-parse --git-dir` themselves — write their round counters
 * into the real .git instead of the scratch repo. Every spawn in these suites
 * goes through this env, including the scripts under test, not just the git
 * calls.
 */
export function gitCleanEnv(): Record<string, string> {
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

/**
 * Register the suite-wide setup: a throwaway repository and the stub `gh` on
 * `binDir`, created before the file's first test and removed after its last.
 */
export function useStubForge(): void {
  beforeAll(setUpStubForge);
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });
}

function setUpStubForge(): void {
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
  // A real checkout always has a remote. `shared/gh-conditional.ts` derives its
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
    'api -X') allowed=' -f -q ' ;;
    'api repos/'*) allowed=' -q ' ;;
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
    # The conditional REST reads shared/gh-conditional.ts makes. Serves
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
  "api -X")
    # dismiss-alert.ts's PATCH of a code scanning alert: every argument is
    # logged, one per line, so a probe reads off exactly what was sent.
    echo dismissal >> "$FIX/thread-events.log"
    printf '%s\n' "$@" > "$FIX/dismiss-args.log"
    [ -f "$FIX/dismiss-forbidden" ] && { echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; }
    echo dismissed ;;
  'api repos/'*'/pulls/'*)
    # The pull request code-scanning.ts reads its revision from, pull.json in
    # the fixture; absent, a 403.
    echo "pull" >> "$FIX/alert-calls.log"
    [ -f "$FIX/pull.json" ] || { echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; }
    cat "$FIX/pull.json" ;;
  'api repos/'*'/code-scanning/alerts/'*)
    # A code scanning alert, from alert-<n>.json in the fixture; absent, a 403.
    n="\${2##*/}"
    echo "alert $n" >> "$FIX/alert-calls.log"
    [ -f "$FIX/alert-$n.json" ] || { echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; }
    cat "$FIX/alert-$n.json" ;;
  "api --paginate")
    # /drive-pr's summary-findings.ts, which await-round.ts spawns before
    # reporting convergence, reads the PR's issue comments (absent
    # fixture: none, so no reviewer summary and nothing outstanding) and, once
    # a summary exists, its inline review comments (always none here).
    case "$*" in
      *"/code-scanning/alerts/"*"/instances?"*)
        # An alert's instances on one ref, as --slurp hands them over: the
        # pages in instances-<n>-<ref, / as _>.json; absent, one empty page.
        path="\${4:-$3}"
        n="\${path%/instances*}"; n="\${n##*/}"
        ref=$(printf '%s' "\${path##*ref=}" | sed 's#%2F#/#g')
        echo "instances $n $ref" >> "$FIX/alert-calls.log"
        [ -f "$FIX/instances-forbidden" ] && { echo 'gh: Resource not accessible by integration (HTTP 403)' >&2; exit 1; }
        f="$FIX/instances-$n-$(printf '%s' "$ref" | tr / _).json"
        if [ -f "$f" ]; then cat "$f"; else echo '[[]]'; fi ;;
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
      *'query=query($id:ID!)'*)
        # dismiss-alert.ts reading the thread's repository and opening comment.
        cat "$FIX/thread-node.json" ;;
      *"--input -"*)
        echo reply >> "$FIX/thread-events.log"
        n=0
        while [ -e "$FIX/graphql-input-$((n + 1)).json" ]; do n=$((n + 1)); done
        # A mutation that is IN FLIGHT rather than instantaneous, so a probe can
        # cancel one mid-post. The body is drained first so the
        # caller's write never blocks, and the file — the thing "the mutation
        # landed" is read off — is written only on the far side of the delay.
        if [ -f "$FIX/graphql-slow" ]; then
          body=$(cat)
          : > "$FIX/graphql-started"
          sleep ${IN_FLIGHT_SEC}
          printf '%s' "$body" > "$FIX/graphql-input-$((n + 1)).json"
        else
          cat > "$FIX/graphql-input-$((n + 1)).json"
        fi
        echo "https://github.com/acme/widgets/pull/1#discussion_r1" ;;
      *"resolveReviewThread"*|*"unresolveReviewThread"*)
        echo resolution >> "$FIX/thread-events.log"
        # resolve-thread.ts / unresolve-thread.ts pass the mutation through
        # -f query=... rather than --input -, so they need their own slow
        # branch — same shape as the one above, minus a body to
        # drain since the id travels as a separate -f argument. A DISTINCT
        # marker prefix (graphql-mutation-, not graphql-input-): the latter is
        # what postedBodies() (reply-to-thread.ts's describe block) JSON.parses
        # wholesale from the fixture dir, and this marker is deliberately an
        # empty file, not a JSON document.
        n=0
        while [ -e "$FIX/graphql-mutation-$((n + 1))" ]; do n=$((n + 1)); done
        if [ -f "$FIX/graphql-slow" ]; then
          : > "$FIX/graphql-started"
          sleep ${IN_FLIGHT_SEC}
        fi
        : > "$FIX/graphql-mutation-$((n + 1))"
        echo "true" ;;
      *)
        # Deletes a path mid-run, during the thread listing — the window
        # after a copied install's scripts have loaded and before
        # await-round.ts probes for its /drive-pr sibling.
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
}

let fixtureSeq = 0;
let prSeq = 100;

export interface Fixture {
  /** PR number; unique per probe so round counters never cross-contaminate. */
  pr: string;
  dir: string;
}

export function check(name: string, bucket: string, state: string) {
  return { name, bucket, state };
}

export function thread(
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

export function writeFixture(opts: {
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

export function runScript(
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

export const roundsFile = (pr: string) =>
  join(repoDir, ".git", `resolve-review-rounds-${pr}`);

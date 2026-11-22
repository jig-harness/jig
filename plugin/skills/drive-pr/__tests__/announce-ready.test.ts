/**
 * drive-pr suite: announce-merge-ready.ts asks the Ready predicate
 * (`lib/merge-ready.ts`) on top of its own gates. It words approve first as
 * "an approval is still required", and refuses a head the forge does not
 * witness a review of, whatever the drive's ledger says.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease";
import { LISTING_PAGE } from "../scripts/lib/trusted-automation";
import {
  binDir,
  type Fixture,
  announcePolicyEnv,
  gitCleanEnv,
  SCRIPTS,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
  writeVerifiedSha,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

const OPENER = "**Safe to merge from the driver's perspective.**";

/** The board query's answer for PR #999 at `head`. */
function board(
  head: string,
  over: {
    checked?: boolean;
    association?: string;
    bot?: string;
    config?: string;
    baseOid?: string;
  } = {},
): string {
  const contexts =
    over.checked === false
      ? []
      : [
          {
            __typename: "CheckRun",
            name: "AI review",
            status: "COMPLETED",
            conclusion: "SUCCESS",
            startedAt: "2026-11-08T10:00:00Z",
            isRequired: false,
            checkSuite: { app: { slug: "example-review" } },
          },
        ];
  const none = { pageInfo: { hasNextPage: false }, nodes: [] };
  return JSON.stringify({
    data: {
      repository: {
        squashMergeAllowed: true,
        ...(over.config === undefined
          ? {}
          : {
              defaultBranchRef: {
                target: {
                  file: { object: { text: over.config, isTruncated: false } },
                },
              },
            }),
        pr999: {
          number: 999,
          headRefOid: head,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          authorAssociation: over.association ?? "OWNER",
          ...(over.bot === undefined
            ? {}
            : {
                author: { __typename: "Bot", login: over.bot },
                isCrossRepository: false,
                baseRefName: "main",
                baseRefOid: over.baseOid ?? "b".repeat(40),
              }),
          isMergeQueueEnabled: false,
          labels: none,
          reviewThreads: none,
          reviewRequests: none,
          latestReviews: none,
          commits: {
            nodes: [
              {
                commit: {
                  oid: head,
                  statusCheckRollup: {
                    contexts: {
                      pageInfo: { hasNextPage: false },
                      nodes: contexts,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
}

/** Run announce-merge-ready.ts with `--dry-run` over a converged fixture whose board query answers `answer`. */
async function dryRun(
  f: Fixture & { head: string },
  answer: string,
  more: {
    timeline?: unknown[];
    env?: Record<string, string>;
    driverEnv?: Record<string, string>;
    compare?: unknown;
    /** The board's answer from the second query on; the first keeps `answer`. */
    secondBoard?: string;
    /** The files listing from the second files request on; the first keeps `compare.files`. */
    secondFiles?: unknown;
  } = {},
) {
  const { dir, stateDir } = writeFixture(f, scratchClean.dir);
  writeVerifiedSha(stateDir, f.head);
  writeFileSync(join(dir, "board.json"), answer);
  if (more.secondBoard !== undefined)
    writeFileSync(join(dir, "board-second.json"), more.secondBoard);
  if (more.compare !== undefined) {
    const answer = more.compare as { commits: unknown; files: unknown };
    writeFileSync(join(dir, "commits.json"), JSON.stringify(answer.commits));
    writeFileSync(join(dir, "files.json"), JSON.stringify(answer.files));
    writeFileSync(join(dir, "head.txt"), f.head);
  }
  if (more.secondFiles !== undefined)
    writeFileSync(
      join(dir, "files-second.json"),
      JSON.stringify(more.secondFiles),
    );
  if (more.timeline !== undefined)
    writeFileSync(join(dir, "timeline.json"), JSON.stringify(more.timeline));
  const proc = Bun.spawn(
    scriptArgv(join(SCRIPTS, "announce-merge-ready.ts"), "999", "--dry-run"),
    {
      cwd: scratchClean.dir,
      env: {
        ...gitCleanEnv(),
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        DRIVE_PR_FIXTURES: dir,
        DRIVE_PR_STATE_DIR: stateDir,
        DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
        DRIVE_PR_MERGE_MARKER_FIXTURE: `<!-- drive-pr-merge-ready: ${f.head} -->`,
        DRIVE_PR_ANNOUNCE_OPENER_FIXTURE: OPENER,
        ...announcePolicyEnv(scratchClean.dir, more.env),
        ...more.driverEnv,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
    posted: existsSync(join(dir, "posted.jsonl")),
    compared: existsSync(join(dir, "last-compare-path.txt")),
    calls: existsSync(join(dir, "calls.txt"))
      ? readFileSync(join(dir, "calls.txt"), "utf8").trim().split("\n")
      : [],
    boardCalls: existsSync(join(dir, "board-calls.txt"))
      ? readFileSync(join(dir, "board-calls.txt"), "utf8").trim().split("\n")
      : [],
    others: existsSync(join(dir, "other-calls.txt"))
      ? readFileSync(join(dir, "other-calls.txt"), "utf8").trim().split("\n")
      : [],
    commitsPath: existsSync(join(dir, "last-commits-path.txt"))
      ? readFileSync(join(dir, "last-commits-path.txt"), "utf8")
      : null,
    comparedPath: existsSync(join(dir, "last-compare-path.txt"))
      ? readFileSync(join(dir, "last-compare-path.txt"), "utf8")
      : null,
  };
}

describe("announce-merge-ready.ts and the Ready predicate", () => {
  let converged: Fixture & { head: string };
  beforeAll(() => {
    converged = {
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    };
  });

  it("would announce merge now without saying an approval is required", async () => {
    const r = await dryRun(converged, board(converged.head));
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(OPENER);
    expect(r.stdout).not.toContain("An approval is still required");
  });

  it("words approve first as an approval still required", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, { association: "CONTRIBUTOR" }),
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("An approval is still required");
  });

  it("refuses a head the reviewer app never checked, whatever the ledger says", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, { checked: false }),
    );
    expectSpawnExit(r, 4);
    expect(r.posted).toBe(false);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not witnessed on this head");
  });
});

/** A refused read is not kept, so the dry run's two Ready evaluations each make the sequence once, and no more. */
function expectReads(calls: string[], sequence: string[]) {
  expect(calls).toEqual([...sequence, ...sequence]);
}

describe("announce-merge-ready.ts and trusted automation", () => {
  const LISTED =
    'pull_requests:\n  trusted_automation: ["renovate[bot]"]\nreview:\n  reviewer_app: example-review\n';
  let converged: Fixture & { head: string };
  let compare: unknown;
  /** A `gh` before the suite's own that answers the pull request's commit and file listings and keeps the path it was asked for. */
  let wrapper: string;
  beforeAll(() => {
    wrapper = mkdtempSync(join(tmpdir(), "trusted-gh-"));
    const gh = join(wrapper, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */pulls/*/files* ]]; then
  printf '%s' "$2" > "$DRIVE_PR_FIXTURES/last-compare-path.txt"
  seenFiles=$(grep -c '^files$' "$DRIVE_PR_FIXTURES/calls.txt" 2>/dev/null || true)
  echo files >> "$DRIVE_PR_FIXTURES/calls.txt"
  if [ "\${seenFiles:-0}" -ge 1 ] && [ -f "$DRIVE_PR_FIXTURES/files-second.json" ]; then cat "$DRIVE_PR_FIXTURES/files-second.json"; exit $?; fi
  cat "$DRIVE_PR_FIXTURES/files.json"; exit $?
fi
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */pulls/*/commits* ]]; then
  printf '%s' "$2" > "$DRIVE_PR_FIXTURES/last-commits-path.txt"
  echo commits >> "$DRIVE_PR_FIXTURES/calls.txt"
  cat "$DRIVE_PR_FIXTURES/commits.json"; exit $?
fi
if [ "\${1:-}" = "api" ] && [[ "\${2:-}" == */pulls/999 ]]; then
  # A read makes two pull requests (opening, closing); an odd count is the closing one.
  seen=$(grep -c '^pull$' "$DRIVE_PR_FIXTURES/calls.txt" 2>/dev/null || true)
  echo pull >> "$DRIVE_PR_FIXTURES/calls.txt"
  commits="\${DRIVE_PR_FIXTURE_COMMITS:-$(jq length "$DRIVE_PR_FIXTURES/commits.json")}"
  changed="\${DRIVE_PR_FIXTURE_CHANGED_FILES:-$(jq length "$DRIVE_PR_FIXTURES/files.json")}"
  base="\${DRIVE_PR_FIXTURE_BASE:-$(printf 'b%.0s' $(seq 40))}"
  head="\${DRIVE_PR_FIXTURE_HEAD:-$(cat "$DRIVE_PR_FIXTURES/head.txt")}"
  if [ "\${seen:-0}" -ge 2 ]; then base="\${DRIVE_PR_FIXTURE_LATER_BASE:-$base}"; fi
  if [ $(( \${seen:-0} % 2 )) -eq 1 ]; then
    head="\${DRIVE_PR_FIXTURE_CLOSING_HEAD:-$head}"
    commits="\${DRIVE_PR_FIXTURE_CLOSING_COMMITS:-$commits}"
    changed="\${DRIVE_PR_FIXTURE_CLOSING_CHANGED_FILES:-$changed}"
    base="\${DRIVE_PR_FIXTURE_CLOSING_BASE:-$base}"
  fi
  printf '{"head":{"sha":"%s"},"base":{"sha":"%s"},"commits":%s,"changed_files":%s}' "$head" "$base" "$commits" "$changed"; exit 0
fi
case "$*" in *"query DispatchBoard"*)
  seenBoard=$(grep -c '^board$' "$DRIVE_PR_FIXTURES/board-calls.txt" 2>/dev/null || true)
  echo board >> "$DRIVE_PR_FIXTURES/board-calls.txt"
  if [ "\${seenBoard:-0}" -ge 1 ] && [ -f "$DRIVE_PR_FIXTURES/board-second.json" ]; then cat "$DRIVE_PR_FIXTURES/board-second.json"; exit 0; fi;;
esac
echo "$1 $2" >> "$DRIVE_PR_FIXTURES/other-calls.txt"
exec ${JSON.stringify(join(binDir, "gh"))} "$@"
`,
    );
    chmodSync(gh, 0o755);
    converged = {
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    };
    compare = {
      commits: [
        {
          sha: scratchClean.head,
          author: { login: "renovate[bot]" },
          committer: { login: "renovate[bot]" },
          commit: { verification: { verified: true } },
        },
      ],
      files: [{ filename: "pnpm-lock.yaml", status: "modified" }],
    };
  });
  afterAll(() => rmSync(wrapper, { recursive: true, force: true }));
  const viaWrapper = () => ({
    PATH: `${wrapper}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
  });

  it("would announce a listed bot's pull request in merge now when the default branch lists it", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, {
        association: "NONE",
        bot: "renovate",
        config: LISTED,
      }),
      { compare, driverEnv: viaWrapper() },
    );
    expectSpawnExit(r, 0);
    expect(r.compared).toBe(true);
    expect(r.comparedPath).toBe(
      `repos/{owner}/{repo}/pulls/999/files?per_page=${LISTING_PAGE}`,
    );
    // Exactly one sequence: the dry run's second check reuses the first read.
    expect(r.calls).toEqual(["pull", "files", "commits", "pull"]);
    expect(r.commitsPath).toBe(
      `repos/{owner}/{repo}/pulls/999/commits?per_page=${LISTING_PAGE}`,
    );
    // Both Ready observations read the forge: the second reuses the kept
    // automation read, not the Ready facts.
    expect(r.boardCalls).toEqual(["board", "board"]);
    expect(r.stdout).toContain(OPENER);
    expect(r.stdout).not.toContain("An approval is still required");
  });

  it("bases the final check on the second board read, not the first", async () => {
    const listed = { association: "NONE", bot: "renovate", config: LISTED };
    const r = await dryRun(converged, board(converged.head, listed), {
      compare,
      driverEnv: viaWrapper(),
      secondBoard: board(converged.head, { ...listed, checked: false }),
    });
    expectSpawnExit(r, 4);
    expect(r.boardCalls).toEqual(["board", "board"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not witnessed on this head");
  });

  it("refuses when the second read no longer trusts the bot, though the review check still passes", async () => {
    const listed = { association: "NONE", bot: "renovate", config: LISTED };
    const r = await dryRun(converged, board(converged.head, listed), {
      compare,
      driverEnv: viaWrapper(),
      secondBoard: board(converged.head, {
        ...listed,
        config: "review:\n  reviewer_app: example-review\n",
      }),
    });
    expectSpawnExit(r, 4);
    expect(r.boardCalls).toEqual(["board", "board"]);
    // The first observation made the complete evidence read before the list went.
    expect(r.calls).toEqual(["pull", "files", "commits", "pull"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("not witnessed on this head");
  });

  it("refuses, not reuses the kept read, when the base moves between the two board reads", async () => {
    const listed = { association: "NONE", bot: "renovate", config: LISTED };
    const r = await dryRun(converged, board(converged.head, listed), {
      compare,
      driverEnv: viaWrapper(),
      secondBoard: board(converged.head, {
        ...listed,
        baseOid: "c".repeat(40),
      }),
    });
    expectSpawnExit(r, 4);
    expect(r.boardCalls).toEqual(["board", "board"]);
    // The kept read is not reused for the moved base: a fresh opening read
    // is made, finds the old base, and the announcement refuses.
    expect(r.calls).toEqual(["pull", "files", "commits", "pull", "pull"]);
    expect(r.stdout).toBe("");
  });

  it("qualifies on a fresh read when the base moves and the forge agrees with the new base", async () => {
    const listed = { association: "NONE", bot: "renovate", config: LISTED };
    const r = await dryRun(converged, board(converged.head, listed), {
      compare,
      driverEnv: {
        ...viaWrapper(),
        DRIVE_PR_FIXTURE_LATER_BASE: "c".repeat(40),
      },
      secondBoard: board(converged.head, {
        ...listed,
        baseOid: "c".repeat(40),
      }),
    });
    expectSpawnExit(r, 0);
    expect(r.calls).toEqual([
      "pull",
      "files",
      "commits",
      "pull",
      "pull",
      "files",
      "commits",
      "pull",
    ]);
    expect(r.stdout).toContain(OPENER);
    expect(r.stdout).not.toContain("An approval is still required");
  });

  it("refuses the merge-now announcement when the fresh read after a moved base lists a path outside the allowlist", async () => {
    const listed = { association: "NONE", bot: "renovate", config: LISTED };
    const r = await dryRun(converged, board(converged.head, listed), {
      compare,
      driverEnv: {
        ...viaWrapper(),
        DRIVE_PR_FIXTURE_LATER_BASE: "c".repeat(40),
        DRIVE_PR_FIXTURE_CHANGED_FILES: "1",
      },
      secondBoard: board(converged.head, {
        ...listed,
        baseOid: "c".repeat(40),
      }),
      secondFiles: [{ filename: "src/evil.ts", status: "modified" }],
    });
    // The fresh read ran to its end (files, commits, closing pull), and its
    // evidence, not the old one, decided: the announcement is refused.
    expectSpawnExit(r, 4);
    expect(r.calls).toEqual([
      "pull",
      "files",
      "commits",
      "pull",
      "pull",
      "files",
      "commits",
      "pull",
    ]);
    expect(r.stdout).toBe("");
  });

  it("withholds the exception when the pull request's file count differs from the listing", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, {
        association: "NONE",
        bot: "renovate",
        config: LISTED,
      }),
      {
        compare,
        driverEnv: { ...viaWrapper(), DRIVE_PR_FIXTURE_CHANGED_FILES: "2" },
      },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("An approval is still required");
    // The mismatch stops the read after the opening metadata and the files.
    expectReads(r.calls, ["pull", "files"]);
  });

  it.each([
    ["files", "0", "DRIVE_PR_FIXTURE_CHANGED_FILES", ["pull"]],
    ["files", String(LISTING_PAGE), "DRIVE_PR_FIXTURE_CHANGED_FILES", ["pull"]],
    ["commits", "0", "DRIVE_PR_FIXTURE_COMMITS", ["pull"]],
    ["commits", String(LISTING_PAGE), "DRIVE_PR_FIXTURE_COMMITS", ["pull"]],
  ] as const)(
    "reads %s with a count of %s as the page bounds say",
    async (_what, value, name, calls) => {
      const r = await dryRun(
        converged,
        board(converged.head, {
          association: "NONE",
          bot: "renovate",
          config: LISTED,
        }),
        { compare, driverEnv: { ...viaWrapper(), [name]: value } },
      );
      expectSpawnExit(r, 0);
      expect(r.stdout).toContain("An approval is still required");
      expectReads(r.calls, [...calls]);
    },
  );

  it.each([
    ["opening head", { DRIVE_PR_FIXTURE_HEAD: "d".repeat(40) }, ["pull"]],
    ["opening base", { DRIVE_PR_FIXTURE_BASE: "c".repeat(40) }, ["pull"]],
    [
      "closing head",
      { DRIVE_PR_FIXTURE_CLOSING_HEAD: "d".repeat(40) },
      ["pull", "files", "commits", "pull"],
    ],
    [
      "commits",
      { DRIVE_PR_FIXTURE_COMMITS: "2" },
      ["pull", "files", "commits"],
    ],
    [
      "closing commit count",
      { DRIVE_PR_FIXTURE_CLOSING_COMMITS: "2" },
      ["pull", "files", "commits", "pull"],
    ],
    [
      "closing file count",
      { DRIVE_PR_FIXTURE_CLOSING_CHANGED_FILES: "2" },
      ["pull", "files", "commits", "pull"],
    ],
    [
      "closing base",
      { DRIVE_PR_FIXTURE_CLOSING_BASE: "c".repeat(40) },
      ["pull", "files", "commits", "pull"],
    ],
  ] as const)(
    "withholds the exception when the %s differs, after exactly the requests that reach it",
    async (_what, env, calls) => {
      const r = await dryRun(
        converged,
        board(converged.head, {
          association: "NONE",
          bot: "renovate",
          config: LISTED,
        }),
        { compare, driverEnv: { ...viaWrapper(), ...env } },
      );
      expectSpawnExit(r, 0);
      expect(r.stdout).toContain("An approval is still required");
      expectReads(r.calls, [...calls]);
    },
  );

  it("completes the read with last-allowed listings", async () => {
    const n = LISTING_PAGE - 1;
    const wide = {
      commits: Array.from({ length: n }, (_, i) => ({
        sha: i === n - 1 ? scratchClean.head : String(i).padStart(40, "a"),
        author: { login: "renovate[bot]" },
        committer: { login: "renovate[bot]" },
        commit: { verification: { verified: true } },
      })),
      files: Array.from({ length: n }, (_, i) => ({
        filename: `p${i}/pnpm-lock.yaml`,
        status: "modified",
      })),
    };
    const r = await dryRun(
      converged,
      board(converged.head, {
        association: "NONE",
        bot: "renovate",
        config: LISTED,
      }),
      { compare: wide, driverEnv: viaWrapper() },
    );
    expectSpawnExit(r, 0);
    expect(r.calls).toEqual(["pull", "files", "commits", "pull"]);
    expect(r.comparedPath).toBe(
      `repos/{owner}/{repo}/pulls/999/files?per_page=${LISTING_PAGE}`,
    );
    expect(r.commitsPath).toBe(
      `repos/{owner}/{repo}/pulls/999/commits?per_page=${LISTING_PAGE}`,
    );
    expect(r.stdout).toContain(OPENER);
    expect(r.stdout).not.toContain("An approval is still required");
  });

  it("refuses, not crashes, on a reviewer check pattern that does not compile", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, {
        association: "NONE",
        bot: "renovate",
        config: `${LISTED}  reviewer_check_pattern: "["\n`,
      }),
      { compare, driverEnv: viaWrapper() },
    );
    expectSpawnExit(r, 4);
    expect(r.posted).toBe(false);
    expect(r.stderr).not.toContain("SyntaxError");
    expect(r.stderr).toContain("do not read");
  });

  it("does not read where the default branch names no reviewer app, whatever the checkout names", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, {
        association: "NONE",
        bot: "renovate",
        config: 'pull_requests:\n  trusted_automation: ["renovate[bot]"]\n',
      }),
      { compare, driverEnv: viaWrapper() },
    );
    expectSpawnExit(r, 0);
    expect(r.compared).toBe(false);
    expect(r.stdout).toContain("An approval is still required");
  });

  it("does not trust a bot only the pull request's own checkout lists", async () => {
    const own = join(scratchClean.dir, ".config");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "jig.yaml"), LISTED);
    // The checkout's own copy must not make the tree unclean.
    appendFileSync(
      join(scratchClean.dir, ".git", "info", "exclude"),
      "\n.config/\n",
    );
    try {
      const r = await dryRun(
        converged,
        board(converged.head, {
          association: "NONE",
          bot: "renovate",
          config: "pull_requests: {}\n",
        }),
        { compare, driverEnv: viaWrapper() },
      );
      expectSpawnExit(r, 0);
      expect(r.compared).toBe(false);
      expect(r.stdout).toContain("An approval is still required");
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });
});

describe("announce-merge-ready.ts and the reviewers that skip drafts", () => {
  const SKIPPERS = { JIG__REVIEW__DRAFT_SKIPPING_REVIEWERS: "[coderabbitai]" };
  const READY = [
    { event: "ready_for_review", created_at: "2026-11-11T09:24:30Z" },
  ];
  const ownRun = {
    name: "AI review (shadow)",
    status: "completed",
    conclusion: "neutral",
    app: "example-review",
  };
  const rabbit = (started: string, title: string, conclusion = "success") => ({
    name: "CodeRabbit",
    status: "completed",
    conclusion,
    app: "coderabbitai",
    started,
    title,
  });
  let converged: Fixture & { head: string };
  beforeAll(() => {
    converged = {
      threads: [],
      reviewedSha: scratchClean.head,
      head: scratchClean.head,
    };
  });

  it("refuses while the reviewer has no check run on the head since the Ready mark", async () => {
    const r = await dryRun(
      { ...converged, checkRuns: [ownRun] },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 4);
    expect(r.posted).toBe(false);
    expect(r.stderr).toContain("coderabbitai has no check run");
  });

  it("refuses while its newest run is the skip it posted on the draft", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [
          ownRun,
          rabbit("2026-11-11T08:58:54Z", "Review skipped: draft pull request"),
        ],
      },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("draft skip");
  });

  it("refuses a run that started before the Ready mark", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:00:00Z", "Review completed")],
      },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("before the pull request was marked Ready");
  });

  it("announces once the reviewer has run on the Ready pull request", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:25:00Z", "Review completed")],
      },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(OPENER);
  });

  it("does not reuse the policy snapshot inherited for another pull request", async () => {
    // The inherited snapshot names the draft-skipping reviewer, so reusing it
    // would let the run reach the reviewer checks. Resolving its own policy
    // finds no base for the scratch pull request: the run prints why, drops
    // the inherited commit, and refuses to read the reviewer list without one.
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:25:00Z", "Review completed")],
      },
      board(converged.head),
      {
        timeline: READY,
        env: SKIPPERS,
        driverEnv: { DRIVE_PR_TARGET: "1000" },
      },
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("autonomy policy:");
    expect(r.stderr).toContain("the driver named no base-branch commit");
    expect(r.posted).toBe(false);
  });

  it("refuses a fresh run that skipped the head instead of reviewing it", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [
          ownRun,
          rabbit(
            "2026-11-11T09:25:00Z",
            "Review skipped: manual review required for this OSS repository",
          ),
        ],
      },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("did not review it");
  });

  it("refuses a skipped run whose title says nothing", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:25:00Z", "", "skipped")],
      },
      board(converged.head),
      { timeline: READY, env: SKIPPERS },
    );
    expectSpawnExit(r, 4);
    expect(r.stderr).toContain("has not completed successfully");
  });

  it("refuses a timeline entry that is not an event", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:25:00Z", "Review completed")],
      },
      board(converged.head),
      { timeline: [{}], env: SKIPPERS },
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("no readable");
  });

  it("refuses a Ready event with no readable time", async () => {
    const r = await dryRun(
      {
        ...converged,
        checkRuns: [ownRun, rabbit("2026-11-11T09:25:00Z", "Review completed")],
      },
      board(converged.head),
      { timeline: [{ event: "ready_for_review" }], env: SKIPPERS },
    );
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("no readable time");
  });
});

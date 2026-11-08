/**
 * drive-pr suite: announce-merge-ready.ts asks the Ready predicate
 * (`lib/merge-ready.ts`) on top of its own gates. It words approve first as
 * "an approval is still required", and refuses a head the forge does not
 * witness a review of, whatever the drive's ledger says.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease";
import {
  binDir,
  type Fixture,
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
  over: { checked?: boolean; association?: string } = {},
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
        pr999: {
          number: 999,
          headRefOid: head,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          authorAssociation: over.association ?? "OWNER",
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
async function dryRun(f: Fixture & { head: string }, answer: string) {
  const { dir, stateDir } = writeFixture(f, scratchClean.dir);
  writeVerifiedSha(stateDir, f.head);
  writeFileSync(join(dir, "board.json"), answer);
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
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(OPENER);
    expect(r.stdout).not.toContain("An approval is still required");
  });

  it("words approve first as an approval still required", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, { association: "CONTRIBUTOR" }),
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("An approval is still required");
  });

  it("refuses a head the reviewer app never checked, whatever the ledger says", async () => {
    const r = await dryRun(
      converged,
      board(converged.head, { checked: false }),
    );
    expect(r.exitCode).toBe(4);
    expect(r.posted).toBe(false);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not witnessed on this head");
  });
});

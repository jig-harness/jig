/**
 * drive-pr suite: the human answers a re-arm reads. Unparking is one state
 * mutation over every answered item, the answers are kept in the drive's
 * state directory until a pass completes with them, the notice keeps an entry
 * for every item however many there are, and a notice too long for one
 * environment variable reaches the pass through a file.
 * Shared fixtures live in drive-pr-harness.ts and drive-loop-harness.ts.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  park,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDriveIn, state } from "./drive-loop-harness.ts";
import { humanVerdictNotice } from "../scripts/lib/driver/rearm.ts";
import {
  answersFile,
  boundPassNotice,
  noticeFile,
  PASS_NOTICE_ENV_MAX,
} from "../scripts/lib/state/pass-handoff.ts";

useDrivePrSuite();

async function parkedKeys(stateDir: string): Promise<string[]> {
  const got = await state(stateDir, ["get", "999"]);
  return JSON.parse(got.stdout).parked.map((p: { key: string }) => p.key);
}

describe("drive-state.ts unpark takes every key or none", () => {
  it("refuses the whole set when one key is not parked, and leaves the rest parked", async () => {
    const { stateDir } = writeFixture({}, scratchClean.dir);
    await park(stateDir, "PRRT_a", "thread");
    await park(stateDir, "PRRT_b", "thread");
    const refused = await state(stateDir, [
      "unpark",
      "999",
      "--key",
      "PRRT_a",
      "--key",
      "PRRT_gone",
    ]);
    expectSpawnExitNot({ ...refused, stderr: null }, 0);
    expect(await parkedKeys(stateDir)).toEqual(["PRRT_a", "PRRT_b"]);
    const done = await state(stateDir, [
      "unpark",
      "999",
      "--key",
      "PRRT_a",
      "--key",
      "PRRT_b",
    ]);
    expectSpawnExit({ ...done, stderr: null }, 0);
    expect(await parkedKeys(stateDir)).toEqual([]);
  });
});

describe("drive.ts keeps a re-arm's answers until a pass completes with them", () => {
  const PASS = (code: number) => [
    "sh",
    "-c",
    [
      ": pass for 999",
      'echo "pass for 999: PASS_RAN" >&2',
      'printf "%s" "$DRIVE_PR_PASS_NOTICE" | grep -q "option B" && echo "pass for 999: ANSWER_SEEN" >&2',
      `exit ${code}`,
    ].join("\n"),
  ];

  async function answeredPark() {
    const { dir, stateDir } = writeFixture(
      {
        threads: [
          {
            id: "PRRT_p",
            path: "a.ts",
            bot: true,
            comments: [
              { body: "a finding", bot: true },
              {
                author: "maintainer",
                authorAssociation: "OWNER",
                body: "Go with option B.",
                bot: false,
              },
            ],
          },
        ],
      },
      scratchClean.dir,
    );
    await park(stateDir, "PRRT_p", "thread");
    const file = join(dir, "threads.json");
    const threads = JSON.parse(readFileSync(file, "utf8"));
    for (const c of threads.data.repository.pullRequest.reviewThreads.nodes[0]
      .comments.nodes)
      if (c.author.login === "maintainer")
        c.createdAt = new Date(Date.now() + 60_000).toISOString();
    writeFileSync(file, JSON.stringify(threads));
    return { dir, stateDir };
  }

  it("hands the answers to the next arm when the drive stopped before a pass completed", async () => {
    const { dir, stateDir } = await answeredPark();
    // The round bound counts across arms, so each arm raises it by one.
    const args = (rounds: number, code: number) => [
      "--no-head-sync",
      "--max-rounds",
      String(rounds),
      "--",
      ...PASS(code),
    ];
    const kept = () => existsSync(answersFile(stateDir, "999"));
    // The first pass fails, and the drive stops.
    const first = await runDriveIn(dir, stateDir, args(1, 1));
    expect(first.stderr).toContain("every parked item on PR #999 is answered");
    expect(await parkedKeys(stateDir)).toEqual([]);
    expect(kept()).toBe(true);
    // An arm whose round budget is spent stops before any pass.
    const spent = await runDriveIn(dir, stateDir, args(1, 0));
    expect(spent.stderr).toContain("hit --max-rounds (1)");
    expect(kept()).toBe(true);
    // The parks are gone; only the kept answers can tell the next pass.
    const second = await runDriveIn(dir, stateDir, args(2, 0));
    expect(second.stderr).toContain("ANSWER_SEEN");
    expect(kept()).toBe(false);
    // A pass completed with them: a later arm hands them no more.
    const third = await runDriveIn(dir, stateDir, args(3, 0));
    expect(third.stderr).toContain("PASS_RAN");
    expect(third.stderr).not.toContain("ANSWER_SEEN");
  }, 120_000);
});

describe("humanVerdictNotice", () => {
  it("keeps a compact entry for every item and cuts only answer bodies", () => {
    const verdicts = Array.from({ length: 40 }, (_, i) => ({
      kind: "thread" as const,
      key: `PRRT_item${i}`,
      reason: "needs a person",
      answers: [
        {
          author: "maintainer",
          at: "2026-01-01T00:00:00Z",
          url: `https://example.test/pr/999#c${i}`,
          body: "x".repeat(1400),
        },
      ],
    }));
    const notice = humanVerdictNotice(
      verdicts,
      "/state/drive-pr-999.answers.json",
    );
    expect(notice.startsWith("RE-ARMED WITH HUMAN ANSWERS")).toBe(true);
    for (let i = 0; i < 40; i++)
      expect(notice).toContain(
        `- [thread] PRRT_item${i} — https://example.test/pr/999#c${i}`,
      );
    expect(notice).toContain("/state/drive-pr-999.answers.json");
    expect(notice.length).toBeLessThanOrEqual(16_000);
  });
});

describe("boundPassNotice", () => {
  it("passes a short notice through and removes a stale notice file", () => {
    const dir = mkdtempSync(join(tmpRoot, "notice-short-"));
    writeFileSync(noticeFile(dir, "999"), "old");
    expect(boundPassNotice(dir, "999", "STALLED: short")).toBe(
      "STALLED: short",
    );
    expect(existsSync(noticeFile(dir, "999"))).toBe(false);
  });

  it("writes a notice over the bound to a file and names it in a short one", () => {
    const dir = mkdtempSync(join(tmpRoot, "notice-long-"));
    const long = `TAKEN OVER: many holds\n${"- held line\n".repeat(20_000)}`;
    const bounded = boundPassNotice(dir, "999", long);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(PASS_NOTICE_ENV_MAX);
    expect(bounded.startsWith("TAKEN OVER")).toBe(true);
    expect(bounded).toContain(noticeFile(dir, "999"));
    expect(readFileSync(noticeFile(dir, "999"), "utf8")).toBe(long);
  });
});

/**
 * drive-pr suite: a pass that meets Claude Code's weekly limit stops the drive
 * `QUOTA_PARKED` with the reset the notice states, even when the transcript
 * walk is cut short before it reaches the pass's transcript: the pass's own
 * transcript is read by its session id. The reset is the one the drive's
 * quota park records, which the dispatcher walls the account until.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { QUOTA_PARKED_EXIT } from "../scripts/drive";

import {
  scratchClean,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { spawnDriveIn } from "./drive-loop-harness.ts";
import { readState } from "./state-rows.ts";
import { loginEnv } from "./drive-pr-pickup-fixtures.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseMs } from "../../../shared/time.ts";

useDrivePrSuite();

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The weekly notice for a reset three days from now at 11am in Amsterdam, and that reset. */
function weeklyNotice(): { text: string; reset: Temporal.Instant } {
  const at = Temporal.Now.zonedDateTimeISO("Europe/Amsterdam")
    .add({ days: 3 })
    .round({ smallestUnit: "day", roundingMode: "floor" })
    .with({ hour: 11 });
  return {
    text: `You've hit your weekly limit · resets ${MONTHS[at.month - 1]} ${at.day}, 11am (Europe/Amsterdam)`,
    reset: at.toInstant(),
  };
}

describe("drive.ts on a weekly usage limit", () => {
  it("stops QUOTA_PARKED with the notice's reset though the transcript walk is cut short", async () => {
    const { dir, stateDir } = writeFixture(
      { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      scratchClean.dir,
    );
    const projects = join(dir, "claude-projects");
    mkdirSync(join(projects, "proj"), { recursive: true });
    const notice = weeklyNotice();

    // A stand-in `claude` that meets the weekly limit under the session id
    // it was given, as the real CLI writes it, and fails.
    const stub = join(dir, "claude");
    writeFakeProgram(
      stub,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const argv = process.argv.slice(2);",
        "const i = argv.indexOf('--session-id');",
        "if (i < 0 || i + 1 >= argv.length) process.exit(2);",
        "const sid = argv[i + 1];",
        "const record = {",
        "  type: 'assistant',",
        "  cwd: process.cwd(),",
        "  timestamp: new Date().toISOString(),",
        "  error: 'rate_limit',",
        "  isApiErrorMessage: true,",
        "  apiErrorStatus: 429,",
        "  sessionId: sid,",
        `  message: { content: [{ type: 'text', text: ${JSON.stringify(notice.text)} }] },`,
        "};",
        "writeFileSync(",
        "  join(process.env.DRIVE_PR_TEST_PROJ_DIR, sid + '.jsonl'),",
        "  JSON.stringify(record) + '\\n',",
        ");",
        "process.exit(1);",
      ].join("\n"),
    );

    const proc = spawnDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--max-rounds", "2", "--", stub, "--pr-999"],
      scratchClean.dir,
      {
        env: {
          ...loginEnv("billed@example.invalid"),
          DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          DRIVE_PR_CLAUDE_PROJECTS_DIR: projects,
          DRIVE_PR_TEST_PROJ_DIR: join(projects, "proj"),
          // The walk's deadline is spent before it reads one entry, as on
          // a tree too large to walk within its bounds.
          DRIVE_PR_QUOTA_MAX_SCAN_MS: "0",
        },
        stdout: "ignore",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ exitCode, stdout: null, stderr }, QUOTA_PARKED_EXIT);
    expect(stderr).toContain("claude weekly-window quota wall");
    const saved = readState(stateDir, "999") as {
      quotaPark: { window: string; resetAt: string | null };
    };
    expect(saved.quotaPark.window).toBe("weekly");
    expect(parseMs(saved.quotaPark.resetAt ?? "")).toBe(
      notice.reset.epochMilliseconds,
    );
  });
});

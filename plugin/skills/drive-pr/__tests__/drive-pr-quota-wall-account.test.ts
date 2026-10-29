/**
 * drive-pr suite: a quota wall is recorded against the account the pass
 * billed when it was spawned, not the login the credentials name once it
 * has failed.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { QUOTA_PARKED_EXIT } from "../scripts/drive";

import {
  SCRIPTS,
  binDir,
  writeFixture,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { lockDirs } from "./drive-loop-harness.ts";
import { loginAccount, loginEnv } from "./drive-pr-pickup-fixtures.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

useDrivePrSuite();

describe("drive.ts records a quota wall", () => {
  it("against the account the pass billed, though a login changed during it", async () => {
    const { dir, stateDir } = writeFixture({
      threads: [{ id: "PRRT_a", path: "a.ts", bot: true }],
    });
    lockDirs(dir, stateDir);
    const projects = join(dir, "claude-projects");
    mkdirSync(join(projects, "proj"), { recursive: true });
    const login = loginEnv("billed@example.invalid");

    // A stand-in `claude`: logs in as another account while it runs, then
    // meets a wall under the session id it was given.
    const stub = join(dir, "claude");
    writeFakeProgram(
      stub,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { randomUUID } from 'node:crypto';",
        "writeFileSync(",
        "  join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'),",
        "  JSON.stringify({ oauthAccount: { emailAddress: 'later@example.invalid' } }),",
        ");",
        "const argv = process.argv.slice(2);",
        "const i = argv.indexOf('--session-id');",
        "const sid = i >= 0 && i + 1 < argv.length ? argv[i + 1] : randomUUID();",
        "const record = {",
        "  type: 'assistant',",
        "  cwd: process.cwd(),",
        "  timestamp: new Date().toISOString(),",
        "  error: 'rate_limit',",
        "  isApiErrorMessage: true,",
        "  apiErrorStatus: 429,",
        "  sessionId: sid,",
        "  message: { content: [{ type: 'text', text: 'Usage limit reached (test fixture wording).' }] },",
        "};",
        "writeFileSync(",
        "  join(process.env.DRIVE_PR_TEST_PROJ_DIR, sid + '.jsonl'),",
        "  JSON.stringify(record) + '\\n',",
        ");",
        "process.exit(1);",
      ].join("\n"),
    );

    const proc = Bun.spawn(
      scriptArgv(
        join(SCRIPTS, "drive.ts"),
        "999",
        "--no-head-sync",
        "--max-rounds",
        "2",
        "--",
        stub,
        "--pr-999",
      ),
      {
        env: {
          ...process.env,
          ...login,
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
          DRIVE_PR_FIXTURES: dir,
          DRIVE_PR_STATE_DIR: stateDir,
          DRIVE_PR_HANDOFF_DIR: join(dir, "handoff"),
          DRIVE_PR_LOCK_HEARTBEAT_REFRESH_MS: "100",
          DRIVE_PR_CLAUDE_PROJECTS_DIR: projects,
          DRIVE_PR_TEST_PROJ_DIR: join(projects, "proj"),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expectSpawnExit({ exitCode, stdout: null, stderr }, QUOTA_PARKED_EXIT);
    expect(stderr).toContain("The wall belongs to billed@example.invalid");
    const saved = JSON.parse(
      readFileSync(join(stateDir, "drive-pr-999.json"), "utf8"),
    );
    expect(saved.quotaPark.account).toBe(
      loginAccount("billed@example.invalid"),
    );
  });
});

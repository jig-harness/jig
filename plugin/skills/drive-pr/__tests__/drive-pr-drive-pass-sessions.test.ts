import { expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { readRoundSessions } from "../../../dispatch/lib/round-sessions.ts";
import { stateDb, statePath } from "../../../dispatch/lib/state.ts";
import {
  DORMANT_ARM,
  REVIEWER_RUN,
  scratchClean,
  tmpRoot,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { FAILING_RUN, spawnDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();

const LAUNCH = "20261115T080000Z-abcdef02";
const SESSION = "0b8e2f4c-1d2e-4f50-9a1b-2c3d4e5f6a7b";

for (const scenario of [
  "claude-repair",
  "codex-review",
  "codex-no-id",
] as const) {
  it(`records the dispatched pass session for ${scenario}`, async () => {
    const repair = scenario === "claude-repair";
    const home = mkdtempSync(join(tmpRoot, "pass-session-"));
    const root = join(home, ".local", "state", "jig", "dispatch");
    const db = stateDb(root);
    db.query(
      "INSERT INTO launches (id, repo, action, pr, created_at, record) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      LAUNCH,
      "example-org/example-repo",
      "rearm",
      999,
      "2026-11-15T08:00:00.000Z",
      JSON.stringify({ action: "rearm", pr: 999 }),
    );

    const { dir, stateDir } = writeFixture(
      repair
        ? {
            threads: [],
            head: scratchClean.head,
            reviewedSha: scratchClean.head,
            checkRuns: [REVIEWER_RUN, DORMANT_ARM, FAILING_RUN],
          }
        : { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] },
      scratchClean.dir,
    );
    const body = repair
      ? [
          "const i = process.argv.indexOf('--session-id');",
          "console.error('repair id=' + (i === -1 ? '' : process.argv[i + 1]));",
          "console.error('task=' + process.env.DRIVE_PR_ROUND_TASK);",
        ]
      : scenario === "codex-review"
        ? [
            "import { Database } from 'bun:sqlite';",
            `const db = new Database(${JSON.stringify(statePath(root))}, { readonly: true });`,
            "process.stderr.write('session i');",
            `await new Promise((resolve) => process.stderr.write('d: ${SESSION}\\n', resolve));`,
            "const deadline = performance.now() + 3000;",
            `while (performance.now() < deadline && !db.query("SELECT sessions FROM launches").get()?.sessions) await Bun.sleep(20);`,
            "console.log('recorded before pass exit=' + Boolean(db.query('SELECT sessions FROM launches').get()?.sessions));",
          ]
        : ["console.log('no startup session header');"];
    const pass = writeFakeProgram(
      join(dir, repair ? "claude" : "codex"),
      ["#!/usr/bin/env bun", ...body, "process.exit(1);"].join("\n"),
    );
    const child = spawnDriveIn(
      dir,
      stateDir,
      [
        "--keep-draft",
        "--no-head-sync",
        "--max-rounds",
        "1",
        "--",
        pass,
        "--pr-999",
      ],
      undefined,
      {
        env: {
          HOME: home,
          USERPROFILE: home,
          JIG_LAUNCH: LAUNCH,
          JIG_DRIVER_REPORT: join(root, "runs", LAUNCH, "drive-report.json"),
          DRIVE_PR_CI_REPAIR_ROUNDS: "1",
        },
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 1);
    const row = db
      .query<{ sessions: string | null }, []>("SELECT sessions FROM launches")
      .get();
    const sessions = readRoundSessions(row?.sessions);

    if (repair) {
      expect(stderr).toContain("task=ci-repair");
      const id = /^repair id=(.+)$/m.exec(stderr)?.[1] ?? "";
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sessions).toEqual([
        { round: 0, session: id, at: expect.any(String) },
      ]);
    } else if (scenario === "codex-review") {
      expect(stderr).toContain(`session id: ${SESSION}`);
      expect(stdout).toContain("recorded before pass exit=true");
      expect(sessions).toEqual([
        { round: 1, session: SESSION, at: expect.any(String) },
      ]);
    } else {
      expect(stdout).toContain("no startup session header");
      expect(sessions).toEqual([]);
    }
  }, 60_000);
}

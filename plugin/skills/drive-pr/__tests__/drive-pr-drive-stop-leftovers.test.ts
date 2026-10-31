/**
 * drive-pr suite: the stops of a drive that does not restart name what the
 * pass left in the tree, as a failed pass's stop does: the uncommitted paths
 * and the commits on top of the head branch's remote ref, or plainly that
 * there are none. Covered here: the usage-limit stop (exit 16), the usage
 * limit met on the last round (exit 6) and a pass that finds the PR no longer
 * open (exit 5).
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { QUOTA_PARKED_EXIT } from "../scripts/drive";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { useDrivePrSuite, writeFixture } from "./drive-pr-harness.ts";
import { lockDirs, runDriveIn } from "./drive-loop-harness.ts";
import { trackedTree } from "./drive-pr-pickup-fixtures.ts";

useDrivePrSuite();

const work = { threads: [{ id: "PRRT_a", path: "a.ts", bot: true }] };

/** What a pass does to the tree before it stops: edit a file and commit another. */
const LEAVE_WORK =
  "echo stray > stray.txt; echo wip > wip.txt; git add wip.txt; git -c user.email=p@example.invalid -c user.name=p commit -qm 'half-landed fix' --no-verify";

/**
 * A stand-in `claude` that leaves `leave` in the tree (a shell snippet, empty
 * for nothing), then dies on a usage wall written under the session id it was
 * given. `reset` is the wall's reset line: wording the driver cannot read
 * parks it (exit 16); a session limit resetting within the hour is sleepable.
 */
function writeClaude(dir: string, leave: string, session: boolean): string {
  const stub = join(dir, "claude");
  writeFakeProgram(
    stub,
    [
      "#!/usr/bin/env bun",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { randomUUID } from 'node:crypto';",
      `if (${JSON.stringify(leave)} !== '') Bun.spawnSync(['sh', '-c', ${JSON.stringify(leave)}]);`,
      "const argv = process.argv.slice(2);",
      "const i = argv.indexOf('--session-id');",
      "const sid = i >= 0 && i + 1 < argv.length ? argv[i + 1] : randomUUID();",
      `const at = new Date(Date.now() + 3600_000);
const h = at.getUTCHours();
const clock = \`\${h % 12 === 0 ? 12 : h % 12}:\${String(at.getUTCMinutes()).padStart(2, '0')}\${h < 12 ? 'am' : 'pm'}\`;`,
      session
        ? `const text = \`You've hit your session limit · resets \${clock} (UTC)\`;`
        : "const text = 'Usage limit reached (test fixture wording).';",
      "const record = {",
      "  type: 'assistant',",
      "  cwd: process.cwd(),",
      "  timestamp: new Date().toISOString(),",
      "  error: 'rate_limit',",
      "  isApiErrorMessage: true,",
      "  apiErrorStatus: 429,",
      "  sessionId: sid,",
      "  message: { content: [{ type: 'text', text }] },",
      "};",
      "writeFileSync(",
      `  join(process.env.DRIVE_PR_TEST_PROJ_DIR, \`\${sid}.jsonl\`),`,
      `  \`\${JSON.stringify(record)}\\n\`,`,
      ");",
      "process.exit(1);",
    ].join("\n"),
  );
  return stub;
}

const STOPS = [
  {
    name: "the usage-limit stop (exit 16)",
    exit: QUOTA_PARKED_EXIT,
    run: async (leave: string, tree: string) => {
      const { dir, stateDir } = writeFixture(work, tree);
      lockDirs(dir, stateDir);
      const projects = join(dir, "claude-projects");
      mkdirSync(join(projects, "proj"), { recursive: true });
      const stub = writeClaude(dir, leave, false);
      return await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--max-rounds", "2", "--", stub, "--pr-999"],
        tree,
        {
          env: {
            DRIVE_PR_CLAUDE_PROJECTS_DIR: projects,
            DRIVE_PR_TEST_PROJ_DIR: join(projects, "proj"),
          },
        },
      );
    },
  },
  {
    name: "the usage limit met on the last round (exit 6)",
    exit: 6,
    run: async (leave: string, tree: string) => {
      const { dir, stateDir } = writeFixture(work, tree);
      lockDirs(dir, stateDir);
      const projects = join(dir, "claude-projects");
      mkdirSync(join(projects, "proj"), { recursive: true });
      const stub = writeClaude(dir, leave, true);
      return await runDriveIn(
        dir,
        stateDir,
        ["--no-head-sync", "--max-rounds", "1", "--", stub, "--pr-999"],
        tree,
        {
          env: {
            DRIVE_PR_CLAUDE_PROJECTS_DIR: projects,
            DRIVE_PR_TEST_PROJ_DIR: join(projects, "proj"),
          },
        },
      );
    },
  },
  {
    name: "a pass that finds the PR no longer open (exit 5)",
    exit: 5,
    run: async (leave: string, tree: string) => {
      const { dir, stateDir } = writeFixture(work, tree);
      return await runDriveIn(
        dir,
        stateDir,
        [
          "--no-head-sync",
          "--",
          "sh",
          "-c",
          `: pass for 999; ${leave}; exit 5`,
        ],
        tree,
      );
    },
  },
];

describe("drive.ts names what the pass left when it stops", () => {
  for (const stop of STOPS) {
    it(`lists the uncommitted paths and unpushed commits at ${stop.name}`, async () => {
      const tree = trackedTree(`stop-left-${stop.exit}`);
      const r = await stop.run(LEAVE_WORK, tree);
      expectSpawnExit({ ...r, stdout: null }, stop.exit);
      expect(r.stderr).toContain("stray.txt");
      expect(r.stderr).toContain("Unpushed commits: 1");
      expect(r.stderr).toContain("half-landed fix");
    }, 120_000);

    it(`says plainly that nothing is left at ${stop.name}`, async () => {
      const tree = trackedTree(`stop-clean-${stop.exit}`);
      const r = await stop.run(":", tree);
      expectSpawnExit({ ...r, stdout: null }, stop.exit);
      expect(r.stderr).toContain("Uncommitted edits: none.");
      expect(r.stderr).toContain("Unpushed commits: 0");
      expect(r.stderr).not.toContain("git status --short");
    }, 120_000);
  }

  it("names the check to make by hand when a detached tree has no range to count", async () => {
    const tree = trackedTree("stop-detached");
    const { dir, stateDir } = writeFixture(work, tree);
    const r = await runDriveIn(
      dir,
      stateDir,
      [
        "--no-head-sync",
        "--",
        "sh",
        "-c",
        `: pass for 999; git checkout -q --detach; ${LEAVE_WORK}; exit 5`,
      ],
      tree,
      { env: { DRIVE_PR_ATTACH: "off" } },
    );
    expectSpawnExit({ ...r, stdout: null }, 5);
    expect(r.stderr).toContain("git log HEAD --branches --not --remotes");
  }, 120_000);
});

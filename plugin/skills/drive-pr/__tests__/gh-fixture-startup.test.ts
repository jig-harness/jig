import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  binDir,
  HEAD,
  gitCleanEnv,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

it.each([
  {
    name: "projects and filters with one jq startup",
    args: [
      "pr",
      "view",
      "999",
      "--json",
      "state",
      "--jq",
      '[.state + "!", has("headRefOid")] | @json',
    ],
    expected: '["OPEN!",false]',
    queries: 1,
  },
  {
    name: "builds a REST liveness response with two jq startups",
    args: ["api", "repos/test/repo/pulls/999", "-i"],
    expected: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
      {
        state: "open",
        merged: false,
        head: { sha: HEAD },
      },
    )}`,
    queries: 2,
  },
])("the gh fixture $name", async ({ args, expected, queries }) => {
  const { dir, stateDir } = writeFixture({}, scratchClean.dir);
  const tools = mkdtempSync(join(tmpdir(), "fixture-query-count-"));
  const log = join(tools, "queries");
  const jq = Bun.which("jq");
  expect(jq).not.toBeNull();
  writeFakeProgram(
    join(tools, "jq"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(process.env.QUERY_LOG, "query\\n");
const child = Bun.spawnSync([process.env.REAL_JQ, ...process.argv.slice(2)], {
  stdin: "inherit", stdout: "inherit", stderr: "inherit"
});
process.exit(child.exitCode ?? 1);
`,
  );
  const child = Bun.spawn(["gh", ...args], {
    cwd: scratchClean.dir,
    env: {
      ...gitCleanEnv(),
      PATH: `${tools}${delimiter}${binDir}${delimiter}${process.env.PATH}`,
      DRIVE_PR_FIXTURES: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      QUERY_LOG: log,
      REAL_JQ: jq ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
  expect(stdout.trim()).toBe(expected);
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(queries);
});

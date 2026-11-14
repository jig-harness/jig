/** Retirement probes must inspect their own checkout and fit inside the tick. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { run } from "../../shared/proc.ts";
import { type World, world } from "./fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

const CHILD = `
import { retireNotices } from ${JSON.stringify(new URL("../lib/actions/retire-notices.ts", import.meta.url).pathname)};
const [path, root, budget] = process.argv.slice(1);
// Keep setup time out of the simulated tick age; the probe's process timer stays real.
const now = Temporal.Now.instant();
if (budget === "bounded") Temporal.Now.instant = () => now;
const report = { records: [{ ok: true }] };
await retireNotices({
  machine: { runtimeTimeoutMs: 100 },
  startedAt: budget === "bounded" ? now.epochMilliseconds - 750 : undefined,
  runtime: { retire: async () => ({ ok: true, detail: "removed" }) },
}, report, {
  repo: "example/repo", workspace: { id: "w", path, branch: "main", comment: "", unread: false, agents: [], unverifiableTerminals: 0 },
  takesComment: true, written: new Set(), causes: [], records: [], lingerMs: 0, nowMs: Temporal.Now.instant().epochMilliseconds, root,
});
console.log(JSON.stringify(report.noticesWorkspace));
`;

function fixture(): World {
  const w = world();
  current = w;
  withOrigin(w);
  return w;
}

test("inherited Git selectors cannot make a dirty retirement target appear clean", async () => {
  const w = fixture();
  const clean = join(w.root, "clean");
  const cloned = Bun.spawnSync(["git", "clone", "-q", w.repo, clean], {
    env: w.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(cloned, 0);
  writeFileSync(join(w.repo, "personal.md"), "personal work\n");
  const done = await run(
    [process.execPath, "-e", CHILD, w.repo, join(w.root, "state"), "unbounded"],
    {
      env: { ...w.env, GIT_DIR: join(clean, ".git"), GIT_WORK_TREE: clean },
      timeoutSec: 5,
    },
  );
  expectSpawnExit(
    { exitCode: done.code, stdout: done.stdout, stderr: done.stderr },
    0,
  );
  expect(JSON.parse(done.stdout)).toMatchObject({
    outcome: "refused",
    detail: expect.stringContaining("git reports changes"),
  });
});

test("a stuck Git probe is cut to the remaining tick budget and reports its timeout", async () => {
  const w = fixture();
  const bin = join(w.root, "stuck-git");
  mkdirSync(bin);
  const script = join(bin, "git");
  writeFakeProgram(
    script,
    "#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n",
  );
  const done = await run(
    [process.execPath, "-e", CHILD, w.repo, join(w.root, "state"), "bounded"],
    {
      env: {
        ...w.env,
        PATH: `${bin}${delimiter}${w.env.PATH}`,
        JIG_LAUNCHER_DEADLINE_SEC: "1",
      },
      timeoutSec: 2,
    },
  );
  expectSpawnExit(
    { exitCode: done.code, stdout: done.stdout, stderr: done.stderr },
    0,
  );
  expect(JSON.parse(done.stdout)).toMatchObject({
    outcome: "refused",
    detail: expect.stringContaining("deadline exceeded"),
  });
});

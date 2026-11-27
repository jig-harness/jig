import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { closeDatabase } from "../../../shared/records/db.ts";
import { dbPathFor } from "../scripts/lib/state/db.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { SCRIPTS, fakeForge } from "./ledger-forge-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { retainedCiHold, writeState } from "./state-rows.ts";

/** The exit that says the doctor's forge client named no login. */
const NO_LOGIN_EXIT = 4;

/** A clone with `count` drives whose state carries a CI hold nobody released. */
function stage(count: number, login?: string) {
  const forge = fakeForge([], login === undefined ? {} : { login });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  for (let i = 0; i < count; i++) {
    const pr = String(700 + i);
    const state = freshState(Number(pr));
    state.ciHold = retainedCiHold();
    writeState(leaf, pr, state);
  }
  return { forge, leaf };
}

async function run(
  s: ReturnType<typeof stage>,
  script: string,
  args: string[],
) {
  closeDatabase(dbPathFor(s.leaf));
  const proc = Bun.spawn([process.execPath, join(SCRIPTS, script), ...args], {
    cwd: s.forge.repo,
    env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const userCalls = (calls: string[]) =>
  calls.filter((c) => c.startsWith("api user"));

const modes: [string, string, string[]][] = [
  ["--doctor", "drives.ts", ["--doctor", "--json"]],
  ["the read-only reader", "drives-read-only.ts", ["--json"]],
];

describe("a doctor run whose forge client names no login", () => {
  for (const [name, script, args] of modes) {
    it(`${name} over many held drives sends one forge call, says so once and exits with the reason`, async () => {
      const s = stage(6);
      const r = await run(s, script, args);
      expectSpawnExit(r, NO_LOGIN_EXIT);
      const calls = s.forge.calls();
      expect(calls).toHaveLength(1);
      expect(userCalls(calls)).toHaveLength(1);
      expect(r.stdout).toBe("");
      expect(r.stderr.match(/names no login/g)).toHaveLength(1);
    });
  }

  it("asks nothing when no drive needs the forge", async () => {
    const s = stage(0);
    const r = await run(s, "drives.ts", ["--doctor", "--json"]);
    expectSpawnExit(r, 0);
    expect(s.forge.calls()).toHaveLength(0);
  });
});

describe("a doctor run whose forge client has a login", () => {
  for (const [name, script, args] of modes) {
    it(`${name} asks it once for all the held drives`, async () => {
      const s = stage(6, "drive-bot");
      const r = await run(s, script, args);
      expectSpawnExit(r, 0);
      expect(userCalls(s.forge.calls())).toHaveLength(1);
    });
  }
});

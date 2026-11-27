import { describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import {
  markDriverRecordReleased,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import { SCRIPTS, fakeForge } from "./ledger-forge-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";
import { driverRecordRow } from "./state-rows.ts";

/** A pid no process holds: a driver that is gone. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["sh", "-c", ":"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

/** A clone left with `count` released driver records, and a forge client that cannot name a login. */
async function stage(count: number, login?: string) {
  const forge = fakeForge([], login === undefined ? {} : { login });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  const pid = await deadPid();
  const prs = Array.from({ length: count }, (_, i) => String(900 + i));
  for (const pr of prs) {
    const started = new Date(Date.now() - 60_000).toISOString();
    writeDriverRecord(leaf, pr, {
      worktree: forge.repo,
      started,
      pid,
      host: hostname(),
    });
    markDriverRecordReleased(leaf, pr, started);
  }
  return { forge, leaf, prs };
}

async function doctor(s: Awaited<ReturnType<typeof stage>>) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, "drives.ts"), "--doctor"), {
    cwd: s.forge.repo,
    env: { ...s.forge.env, DRIVE_PR_STATE_DIR: s.leaf },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const userCalls = (calls: string[]) =>
  calls.filter((c) => c.startsWith("api user"));
const commentReads = (calls: string[]) =>
  calls.filter((c) => /issues\/\d+\/comments/.test(c));

describe("--doctor's recovery of leftover driver records with a forge client that names no login", () => {
  it("asks for the login once and reads no comment, leaving every record for a later run", async () => {
    const s = await stage(4);
    const r = await doctor(s);
    expectSpawnExit(r, 0);
    const calls = s.forge.calls();
    expect(userCalls(calls)).toHaveLength(1);
    expect(commentReads(calls)).toHaveLength(0);
    for (const pr of s.prs) expect(driverRecordRow(s.leaf, pr)).not.toBeNull();
    expect(r.stderr).toContain("names no login");
  });

  it("asks for the login once for all its records when it has one", async () => {
    const s = await stage(4, "drive-bot");
    const r = await doctor(s);
    expectSpawnExit(r, 0);
    expect(userCalls(s.forge.calls())).toHaveLength(1);
  });
});

// expect: 0
import { expect } from "bun:test";
import {
  expectSpawnExit,
  expectSpawnExited,
  expectSpawnExitNot,
  expectSpawnKilled,
} from "../../../../../lib/test-helpers/expect-spawn-exit.ts";
const r = Bun.spawnSync(["git", "status"], { stdout: "pipe", stderr: "pipe" });
expectSpawnExit(r, 0, "git status");
expectSpawnExitNot(r, 1);
expectSpawnKilled(r);
expect(r.stdout.toString()).toBe("");
expect(r.signalCode).toBeNull();
// Not matched: the member as written is what the rule sees.
const { exitCode } = r;
expect(exitCode).toBe(0);
export const status = { exitCode: 0 };
expect(status).toEqual({ exitCode: 0 });
const p = Bun.spawn(["git", "status"], { stdout: "pipe", stderr: "pipe" });
await expectSpawnExited(p, 0, "git status");
const code = await p.exited;
expect(code).toBe(0);

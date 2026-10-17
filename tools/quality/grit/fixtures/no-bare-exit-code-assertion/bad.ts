// expect: 10
import { expect } from "bun:test";
const run = (args: string[]) =>
  Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
const r = run(["status"]);
expect(r.exitCode).toBe(0);
expect(r.exitCode).not.toBe(0);
expect(r.exitCode).toEqual(1);
expect(r.exitCode).toStrictEqual(1);
expect(r.exitCode).toBeNull();
expect(r.exitCode).toBeGreaterThan(0);
expect(run(["status"]).exitCode).toBe(0);
expect(r.exitCode).toBe(
  2,
);
const p = Bun.spawn(["git", "status"], { stdout: "pipe", stderr: "pipe" });
expect(await p.exited).toBe(0);
expect(await p.exited).not.toBe(1);

/**
 * One resident hub per user: a second `jig hub serve --scheduled` leaves,
 * exit 0 and silent, while one holds the lock, and `jig uninstall hub`
 * stops the one that holds it, or says it could not within its wait.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { currentMs } from "../../../shared/time.ts";
import { stopRunningHub, withServeLock } from "../instance.ts";

const scratch = mkdtempSync(join(tmpdir(), "hub-instance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const HOLDER = join(import.meta.dir, "hold-serve-lock.ts");
const JIG = join(import.meta.dir, "..", "..", "..", "jig.ts");
let homes = 0;
let holders: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const holder of holders) holder.kill("SIGKILL");
  holders = [];
});

function home(): Record<string, string> {
  const root = join(scratch, `home-${++homes}`);
  return { HOME: root, JIG_HOME: join(root, ".jig") };
}

/** Starts a process holding the lock under `env`, once it says it holds it. */
async function holder(
  env: Record<string, string>,
  ...args: string[]
): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn(["bun", HOLDER, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  holders.push(child);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = currentMs() + 20_000;
  let text = "";
  while (!text.includes("held") && currentMs() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(text).toContain("held");
  return child;
}

test("a second start leaves at once while a live process holds the lock", async () => {
  const env = home();
  await holder(env);
  const started = currentMs();
  const second = await withServeLock(async () => "ran", env);
  expect(second).toEqual({ ok: true, value: null });
  expect(currentMs() - started).toBeLessThan(10_000);
});

test("jig hub serve --scheduled exits 0 and says nothing while another holds the lock, and runs when none does", async () => {
  const env = home();
  const alone = Bun.spawnSync(["bun", JIG, "hub", "serve", "--scheduled"], {
    env: { ...process.env, ...env },
  });
  // With nothing holding the lock it runs, and fails on the missing install record.
  expectSpawnExit(alone, 1);
  expect(alone.stderr.toString()).toContain("jig install hub has not run");
  await holder(env);
  const second = Bun.spawnSync(["bun", JIG, "hub", "serve", "--scheduled"], {
    env: { ...process.env, ...env },
  });
  expectSpawnExit(second, 0);
  expect(second.stdout.toString()).toBe("");
  expect(second.stderr.toString()).toBe("");
});

test("stopping the hub signals the lock's holder and waits for it to end", async () => {
  const env = home();
  expect(await stopRunningHub({ env })).toEqual({ ok: true, value: null });
  const child = await holder(env);
  const stopped = await stopRunningHub({ env, waitMs: 20_000 });
  expect(stopped.ok && stopped.value).toContain(String(child.pid));
  await expectSpawnExited(child, 0, "the lock holder");
  // The lock is free again.
  expect(await withServeLock(async () => "ran", env)).toEqual({
    ok: true,
    value: { value: "ran" },
  });
});

test("stopping the hub fails when it is still running at the deadline", async () => {
  const env = home();
  const child = await holder(env, "stubborn");
  const stopped = await stopRunningHub({ env, waitMs: 500 });
  expect(stopped.ok ? null : stopped.failure.reason).toContain("still running");
  // It still runs: a signal check reaches it.
  expect(() => process.kill(child.pid, 0)).not.toThrow();
});

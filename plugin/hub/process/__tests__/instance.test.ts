/**
 * One resident hub per user: a second `jig hub serve --scheduled` leaves,
 * exit 0 and silent, while one holds the lock, and `jig uninstall hub`
 * stops the one that holds it, or says it could not within its wait.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { currentMs } from "../../../shared/time.ts";
import { stopRunningHub, withServeLock } from "../instance.ts";

const scratch = mkdtempSync(join(tmpdir(), "hub-instance-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const HOLDER = join(import.meta.dir, "fixtures", "hold-serve-lock.ts");
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
  expect(await readUntil(child, "held")).toContain("held");
  return child;
}

/** What `child` printed until it printed `needle`, it closed its output, or 20 seconds passed. */
async function readUntil(
  child: ReturnType<typeof Bun.spawn>,
  needle: string,
): Promise<string> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = currentMs() + 20_000;
  let text = "";
  while (!text.includes(needle) && currentMs() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadline - currentMs());
    });
    const chunk = await Promise.race([reader.read(), late]);
    clearTimeout(timer);
    if (chunk === null || chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  return text;
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

test("a foreground jig hub serve stops its listeners and exits 0 on a terminate signal", async () => {
  const env = home();
  const root = join(env.HOME as string, "hub");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const settings = join(root, "settings.yaml");
  writeFileSync(
    settings,
    `user: ${userInfo().username}
database: ${join(root, "data")}
host:
  listen: [127.0.0.1:0]
webhooks:
  listen: 127.0.0.1:0
feed:
  socket: ${join(root, "feed", "feed.sock")}
`,
    { mode: 0o600 },
  );
  const child = Bun.spawn(
    ["bun", JIG, "hub", "serve", "--settings", settings],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  holders.push(child);
  expect(await readUntil(child, "webhook:")).toContain("webhook:");
  child.kill("SIGTERM");
  await expectSpawnExited(child, 0, "jig hub serve");
});

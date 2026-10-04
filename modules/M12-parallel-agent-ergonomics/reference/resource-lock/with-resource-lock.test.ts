import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A lock is a symlink that names a pid, so it dangles: existsSync would follow it.
const existsSync = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const scratch = mkdtempSync(join(tmpdir(), "groundwork-lock-test-")),
  gate = join(import.meta.dir, "with-resource-lock.ts");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const environment = (extra: Record<string, string> = {}) => ({
  ...process.env,
  CI: "",
  RESOURCE_LOCK_BYPASS: "",
  LOCK_ROOT: scratch,
  LOCK_TIMEOUT: "5",
  LOCK_POLL: "0.02",
  ...extra,
});
const spawn = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn([process.execPath, gate, ...args], {
    env: environment(env),
    stdout: "pipe",
    stderr: "pipe",
  });
const run = async (args: string[], env: Record<string, string> = {}) => {
  const proc = spawn(args, env);
  return {
    code: await proc.exited,
    out: await new Response(proc.stdout).text(),
    error: await new Response(proc.stderr).text(),
  };
};
function serialized(log: string): boolean {
  let inside = 0;
  for (const line of log.trim().split("\n")) {
    if (line.startsWith("ENTER")) {
      if (inside) return false;
      inside++;
    }
    if (line.startsWith("EXIT")) inside--;
  }
  return inside === 0;
}
test("actual concurrent critical sections serialize; bypass sensitivity interleaves", async () => {
  const log = join(scratch, "events.log"),
    program =
      "const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER '+process.argv[1]+'\\n');await Bun.sleep(300);fs.appendFileSync(process.env.LOG,'EXIT '+process.argv[1]+'\\n');";
  for (const bypass of ["", "1"]) {
    appendFileSync(log, "");
    const children = ["A", "B"].map((id) =>
      spawn([process.execPath, "-e", program, id], {
        LOCK_NAME: "mutex",
        LOG: log,
        RESOURCE_LOCK_BYPASS: bypass,
      }),
    );
    expect(await Promise.all(children.map((p) => p.exited))).toEqual([0, 0]);
    const text = readFileSync(log, "utf8");
    expect(text.match(/ENTER/g)?.length).toBe(2);
    expect(serialized(text)).toBe(!bypass);
    rmSync(log);
  }
});
test("live holder times out, CI and explicit bypass ignore it", async () => {
  const lock = join(scratch, "groundwork-lock.live");
  if (process.platform === "win32") writeFileSync(lock, String(process.pid));
  else symlinkSync(String(process.pid), lock);
  try {
    expect(
      (
        await run([process.execPath, "-e", "console.log('ran')"], {
          LOCK_NAME: "live",
          CI: "1",
          LOCK_TIMEOUT: "0",
        })
      ).out.trim(),
    ).toBe("ran");
    expect(
      (
        await run([process.execPath, "-e", "console.log('ran')"], {
          LOCK_NAME: "live",
          RESOURCE_LOCK_BYPASS: "1",
          LOCK_TIMEOUT: "0",
        })
      ).code,
    ).toBe(0);
    expect(
      (
        await run([process.execPath, "-e", ""], {
          LOCK_NAME: "live",
          LOCK_TIMEOUT: "0",
        })
      ).code,
    ).toBe(3);
    expect(
      process.platform === "win32"
        ? readFileSync(lock, "utf8")
        : readlinkSync(lock),
    ).toBe(String(process.pid));
  } finally {
    rmSync(lock);
  }
});
test("dead holder and foreign directory are reclaimed", async () => {
  const dead = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  for (const name of ["stale", "foreign"]) {
    const path = join(scratch, `groundwork-lock.${name}`);
    if (name === "stale") {
      if (process.platform === "win32") writeFileSync(path, String(dead.pid));
      else symlinkSync(String(dead.pid), path);
    } else mkdirSync(path);
    expect(
      (
        await run([process.execPath, "-e", "console.log('reclaimed')"], {
          LOCK_NAME: name,
        })
      ).out.trim(),
    ).toBe("reclaimed");
    expect(existsSync(path)).toBe(false);
  }
});
test("command result propagates and lock releases", async () => {
  for (const code of [7, 0])
    expect(
      (
        await run([
          "--lock",
          "exit",
          "--",
          process.execPath,
          "-e",
          `process.exit(${code})`,
        ])
      ).code,
    ).toBe(code);
  expect(existsSync(join(scratch, "groundwork-lock.exit"))).toBe(false);
});
for (const [args, env] of [
  [[], {}],
  [["--lock"], {}],
  [["--unknown"], {}],
  [[process.execPath, "-e", ""], { LOCK_TIMEOUT: "abc" }],
  [[process.execPath, "-e", ""], { LOCK_POLL: "bogus" }],
  [[process.execPath, "-e", ""], { LOCK_POLL: "0" }],
  [[process.execPath, "-e", ""], { LOCK_POLL: "3601" }],
  [[process.execPath, "-e", ""], { LOCK_POLL: "9".repeat(400) }],
  [[process.execPath, "-e", ""], { LOCK_TIMEOUT: "9".repeat(400) }],
  [[process.execPath, "-e", ""], { LOCK_TIMEOUT: "604801" }],
  [[process.execPath, "-e", ""], { LOCK_ROOT: gate }],
] as [string[], Record<string, string>][])
  test(`usage ${JSON.stringify([args, env])}`, async () =>
    expect((await run(args, env)).code).toBe(2));
test("Windows hard-link protocol serializes real processes and reclaims stale files", async () => {
  const log = join(scratch, "hardlink-events.log"),
    program =
      "const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER\\n');await Bun.sleep(200);fs.appendFileSync(process.env.LOG,'EXIT\\n');";
  const wrapper = `import {main} from ${JSON.stringify(gate)};process.exit(await main(process.argv.slice(1),process.env,'win32'));`;
  const launch = (command: string[], extra: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, "-e", wrapper, ...command], {
      env: environment({ LOCK_NAME: "hardlink", LOG: log, ...extra }),
      stdout: "pipe",
      stderr: "pipe",
    });
  const children = [0, 1, 2].map(() =>
    launch([process.execPath, "-e", program]),
  );
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([
    0, 0, 0,
  ]);
  expect(readFileSync(log, "utf8")).toBe(
    "ENTER\nEXIT\nENTER\nEXIT\nENTER\nEXIT\n",
  );
  const lock = join(scratch, "groundwork-lock.hardlink");
  writeFileSync(lock, String(process.pid));
  try {
    expect(
      await launch([process.execPath, "-e", "process.exit(0)"], {
        LOCK_TIMEOUT: "0",
      }).exited,
    ).toBe(3);
  } finally {
    rmSync(lock);
  }
  const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  writeFileSync(lock, String(dead.pid));
  expect(await launch([process.execPath, "-e", "process.exit(0)"]).exited).toBe(
    0,
  );
  expect(existsSync(lock)).toBe(false);
});
const record = (path: string, pid: number | string) => {
  if (process.platform === "win32") writeFileSync(path, String(pid));
  else symlinkSync(String(pid), path);
};
const deadPid = async () => {
  const dead = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  return dead.pid;
};
test("wait is capped at the deadline even with a long poll interval", async () => {
  const lock = join(scratch, "groundwork-lock.capped");
  record(lock, process.pid);
  try {
    const started = performance.now();
    expect(
      (
        await run([process.execPath, "-e", ""], {
          LOCK_NAME: "capped",
          LOCK_TIMEOUT: "1",
          LOCK_POLL: "3600",
        })
      ).code,
    ).toBe(3);
    const elapsed = performance.now() - started;
    // The wait lasts the 1s timeout, not the 3600s poll. The lower bound
    // allows a little timer jitter; the upper bound leaves about 2s for
    // spawning the wrapper on a slow CI runner.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  } finally {
    rmSync(lock);
  }
});
test("claim left by a crashed reclaimer does not block recovery", async () => {
  const lock = join(scratch, "groundwork-lock.orphan-claim"),
    deadHolder = await deadPid(),
    deadReclaimer = await deadPid();
  record(lock, deadHolder);
  record(`${lock}.reclaim.${deadHolder}`, deadReclaimer);
  const result = await run([process.execPath, "-e", "console.log('ok')"], {
    LOCK_NAME: "orphan-claim",
  });
  expect(result.out.trim()).toBe("ok");
  expect(existsSync(lock)).toBe(false);
  expect(existsSync(`${lock}.reclaim.${deadHolder}`)).toBe(false);
  expect(
    existsSync(`${lock}.reclaim.${deadHolder}.reclaim.${deadReclaimer}`),
  ).toBe(false);
});
test("claim held by a live reclaimer is respected and the stale lock stays", async () => {
  const lock = join(scratch, "groundwork-lock.live-claim"),
    deadHolder = await deadPid(),
    claim = `${lock}.reclaim.${deadHolder}`;
  record(lock, deadHolder);
  record(claim, process.pid);
  try {
    expect(
      (
        await run([process.execPath, "-e", ""], {
          LOCK_NAME: "live-claim",
          LOCK_TIMEOUT: "0",
        })
      ).code,
    ).toBe(3);
    expect(existsSync(claim)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  } finally {
    rmSync(claim, { force: true });
    rmSync(lock, { force: true });
  }
});
test("many contenders recovering one dead lock never overlap and leave nothing behind", async () => {
  const log = join(scratch, "recover-events.log"),
    lock = join(scratch, "groundwork-lock.recover"),
    program =
      "const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER\\n');await Bun.sleep(30);fs.appendFileSync(process.env.LOG,'EXIT\\n');";
  for (let round = 0; round < 5; round++) {
    record(lock, await deadPid());
    const children = Array.from({ length: 6 }, () =>
      spawn([process.execPath, "-e", program], {
        LOCK_NAME: "recover",
        LOG: log,
        LOCK_POLL: "0.001",
      }),
    );
    expect(await Promise.all(children.map((p) => p.exited))).toEqual(
      Array(6).fill(0),
    );
  }
  const text = readFileSync(log, "utf8");
  expect(text.match(/ENTER/g)?.length).toBe(30);
  expect(serialized(text)).toBe(true);
  expect(existsSync(lock)).toBe(false);
  expect(readdirSync(scratch).filter((f) => f.includes(".reclaim."))).toEqual(
    [],
  );
});
test("missing executable propagates shell-compatible 127", async () =>
  expect((await run([join(scratch, "missing-executable")])).code).toBe(127));

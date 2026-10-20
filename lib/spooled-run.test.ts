import { afterAll, expect, test } from "bun:test";
import { expectSpawnExit } from "./test-helpers/expect-spawn-exit.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GroupIo,
  lastLinesOf,
  lineCount,
  linesOf,
  MAX_LINE,
  reapGroup,
  signalCommand,
  signalGroup,
} from "./spooled-run.ts";

const scratch = mkdtempSync(join(tmpdir(), "jig-spooled-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
function file(text: string): string {
  const path = join(scratch, `stream-${files++}`);
  writeFileSync(path, text);
  return path;
}

/** Poll until `ready` holds, failing after the deadline. */
async function until(ready: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
/** Whether `pid` still exists. macOS answers EPERM, whoever owns it, for a
 * process that is exiting and not yet reaped: it exists until ESRCH. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
};

/** Run `shell` through spooledRun in a subprocess of its own, so the signal a
 * test sends reaches that process and never the test runner. */
function driver(shell: string, graceMs: number) {
  const script = join(scratch, `driver-${files++}.ts`);
  const ready = join(scratch, `wrapper-ready-${files++}`);
  writeFileSync(
    script,
    `import { spooledRun } from ${JSON.stringify(join(import.meta.dir, "spooled-run.ts"))};
import { writeFileSync } from "node:fs";
const pending = spooledRun(["sh", "-c", ${JSON.stringify(shell)}], { stdin: "ignore", graceMs: ${graceMs} });
writeFileSync(${JSON.stringify(ready)}, "ready");
const run = await pending;
console.log(JSON.stringify({ interrupted: run.interrupted, signal: run.signal }));`,
  );
  return {
    ready,
    run: Bun.spawn([process.execPath, script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    }),
  };
}
const pidIn = (path: string) => () =>
  existsSync(path) && readFileSync(path, "utf8").trim() !== "";

test.skipIf(process.platform === "win32")(
  "a cancellation reaches the processes the command started",
  async () => {
    const pids = join(scratch, "descendant.pid");
    const { run, ready } = driver(`sleep 300 & echo $! > ${pids}; wait`, 5_000);
    const announced = pidIn(pids);
    await until(
      () => announced() && existsSync(ready),
      "the descendant and wrapper to start",
    );
    const descendant = Number(readFileSync(pids, "utf8"));
    run.kill("SIGTERM");
    const exitCode = await run.exited;
    const stdout = await new Response(run.stdout).text();
    expectSpawnExit({ exitCode, stdout, stderr: null }, 0);
    expect(JSON.parse(stdout).interrupted).toBe("SIGTERM");
    await until(() => !alive(descendant), "the descendant to stop");
  },
);

test.skipIf(process.platform === "win32")(
  "a command that ignores the cancellation is killed after the grace period",
  async () => {
    const pids = join(scratch, "stubborn.pid");
    const { run, ready } = driver(
      `trap '' TERM; echo $$ > ${pids}; while :; do sleep 1; done`,
      300,
    );
    const announced = pidIn(pids);
    await until(
      () => announced() && existsSync(ready),
      "the command and wrapper to start",
    );
    const command = Number(readFileSync(pids, "utf8"));
    run.kill("SIGTERM");
    const exitCode = await run.exited;
    const stdout = await new Response(run.stdout).text();
    expectSpawnExit({ exitCode, stdout, stderr: null }, 0);
    const spool = JSON.parse(stdout);
    expect(spool).toEqual({ interrupted: "SIGTERM", signal: "SIGKILL" });
    await until(() => !alive(command), "the command to stop");
  },
);

/** A system whose `kill` answers from `script` in order, its last answer
 * repeating: `ok`, or the error code it throws. Its clock moves only when the
 * code under test sleeps. Records every call with the clock's time, and every
 * warning with the time it was given. */
function scripted(script: string[], reapMs = 200) {
  let clock = 0;
  const calls: [number, NodeJS.Signals | 0][] = [];
  const times: number[] = [];
  const warnings: string[] = [];
  const warnedAt: number[] = [];
  const io: GroupIo = {
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      times.push(clock);
      const answer = script[Math.min(calls.length, script.length) - 1];
      if (answer === "ok") return;
      throw Object.assign(new Error(`kill: ${answer}`), { code: answer });
    },
    warn: (line) => {
      warnings.push(line);
      warnedAt.push(clock);
    },
    reapMs,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { io, calls, times, warnings, warnedAt };
}

test("a group probe answered EPERM is present, not gone, and not an error", () => {
  expect(signalGroup(7, 0, scripted(["EPERM"]).io)).toBe("unsignalable");
  expect(signalGroup(7, 0, scripted(["ESRCH"]).io)).toBe("gone");
  expect(signalGroup(7, 0, scripted(["ok"]).io)).toBe("signalled");
  expect(() => signalGroup(7, 0, scripted(["EINVAL"]).io)).toThrow("EINVAL");
});

test("a group that answers EPERM while exiting is waited for until ESRCH, not killed", async () => {
  const { io, calls, warnings } = scripted(["EPERM", "EPERM", "ESRCH"]);
  await reapGroup(7, 5_000, io);
  expect(calls).toEqual([
    [-7, 0],
    [-7, 0],
    [-7, 0],
  ]);
  expect(warnings).toEqual([]);
});

test("a group still answering EPERM is waited for through the grace period before it is killed", async () => {
  const { io, calls, times } = scripted(["EPERM"]);
  await reapGroup(7, 300, io);
  const killed = calls.findIndex(([, signal]) => signal === "SIGKILL");
  expect(killed).toBeGreaterThan(0);
  expect(times[killed]).toBeGreaterThanOrEqual(300);
});

test("a killed group still answering EPERM is probed through the reap window, then reported", async () => {
  const { io, calls, times, warnings, warnedAt } = scripted(["EPERM"], 400);
  await reapGroup(7, 100, io);
  const killed = calls.findIndex(([, signal]) => signal === "SIGKILL");
  expect(killed).toBeGreaterThan(0);
  const killedAt = times.at(killed) ?? Number.NaN;
  const after = times.slice(killed + 1);
  // Probed repeatedly after the kill, the last probe at the window's end.
  expect(after.length).toBeGreaterThan(1);
  expect(after.at(-1)).toBeGreaterThanOrEqual(killedAt + 400);
  expect(warnings).toEqual([
    "spooled-run: process group 7 still has members after SIGKILL\n",
  ]);
  expect(warnedAt[0]).toBeGreaterThanOrEqual(killedAt + 400);
});

test("a killed group that is reaped inside the reap window is not reported", async () => {
  // EPERM through the grace period and the kill, then three more EPERM
  // probes, then ESRCH: well inside a 400 ms window probed every 50 ms.
  const script = ["EPERM", "EPERM", "EPERM", "ok", "EPERM", "EPERM", "EPERM"];
  const { io, calls, times, warnings } = scripted([...script, "ESRCH"], 400);
  await reapGroup(7, 100, io);
  expect(calls[3]).toEqual([-7, "SIGKILL"]);
  expect(calls.length).toBe(script.length + 1);
  expect(times.at(-1)).toBeLessThan((times.at(3) ?? Number.NaN) + 400);
  expect(warnings).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "a forwarded signal no group member takes goes to the command itself",
  () => {
    for (const [answer, direct] of [
      ["EPERM", ["SIGTERM"]],
      ["ESRCH", ["SIGTERM"]],
      ["ok", []],
    ] as const) {
      const sent: NodeJS.Signals[] = [];
      const { io, calls } = scripted([answer]);
      signalCommand(7, "SIGTERM", (name) => sent.push(name), io);
      expect(calls).toEqual([[-7, "SIGTERM"]]);
      expect(sent).toEqual([...direct]);
    }
  },
);

test("the last lines are read backwards across chunks, whole", () => {
  const lines = Array.from(
    { length: 5001 },
    (_, k) => `line ${k} ${"é".repeat(20)}`,
  );
  const path = file(`${lines.join("\n")}\n`);
  const tail = lastLinesOf(path, 2000);
  expect(tail.split("\n").length - 1).toBe(2000);
  expect(tail).toBe(`${lines.slice(-2000).join("\n")}\n`);
  expect(lastLinesOf(path, 9999)).toBe(`${lines.join("\n")}\n`);
  expect(lastLinesOf(path, 0)).toBe("");
  expect(lastLinesOf(file("a\nb"), 1)).toBe("b\n");
  expect(lastLinesOf(file("a\nb\n"), 1)).toBe("b\n");
  expect(lastLinesOf(file(""), 3)).toBe("");
});

test("a line longer than a chunk is read whole, and one past the limit is refused", () => {
  const long = `${"x".repeat(200 * 1024)}denied`;
  expect([...linesOf(file(`warn: limit\n${long}\nlast`))]).toEqual([
    "warn: limit",
    long,
    "last",
  ]);
  expect(() => [...linesOf(file("y".repeat(MAX_LINE + 1)))]).toThrow(
    "not read",
  );
  // Completed by the chunk that ends it, the line is refused all the same.
  expect(() => [...linesOf(file(`${"y".repeat(MAX_LINE + 1)}\nz`))]).toThrow(
    "not read",
  );
});

test("a tail longer than the bound keeps its whole last lines and names what it drops", () => {
  const big = "b".repeat(MAX_LINE + 10);
  expect(lastLinesOf(file(big), 1)).toBe(
    `[the last line is longer than ${MAX_LINE} bytes and is not shown]\n`,
  );
  // The long line and its break are the bytes not shown.
  expect(lastLinesOf(file(`${big}\nlast\n`), 2)).toBe(
    `[${MAX_LINE + 11} earlier byte(s) not shown: the tail is longer than ${MAX_LINE} bytes]\nlast\n`,
  );
  // A last line that fills the bound exactly, break included, is whole.
  const exact = `${"b".repeat(MAX_LINE - 1)}\n`;
  expect(lastLinesOf(file(`a\n${exact}`), 2)).toBe(
    `[2 earlier byte(s) not shown: the tail is longer than ${MAX_LINE} bytes]\n${exact}`,
  );
  // One byte longer, it is not.
  expect(lastLinesOf(file(`a\nb${exact}`), 2)).toBe(
    `[the last line is longer than ${MAX_LINE} bytes and is not shown]\n`,
  );
});

test("lines are counted without holding them", () => {
  expect(lineCount(file(""))).toBe(0);
  expect(lineCount(file("a\nb\n"))).toBe(2);
  expect(lineCount(file("a\nb"))).toBe(2);
  expect(lineCount(file("z".repeat(MAX_LINE + 1)))).toBe(1);
});

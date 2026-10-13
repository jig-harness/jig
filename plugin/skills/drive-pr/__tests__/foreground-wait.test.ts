import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../scripts/foreground-wait.ts");

// Each case spawns several bun processes; the 5s default is too tight under load.
const T = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers signal 0; it is not running.
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const stat = ps.stdout.toString().trim();
  return stat !== "" && !stat.startsWith("Z");
};

/** `pid` and everything beneath it, from one `ps` snapshot. */
const treeOf = (pid: number): number[] => {
  const rows = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="])
    .stdout.toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const out: number[] = [pid];
  for (let i = 0; i < out.length; i++) {
    for (const [p, pp] of rows)
      if (pp === out[i] && !out.includes(p as number)) out.push(p as number);
  }
  return out;
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The script's own pacing, shortened so a case waits on what it exercises
// rather than on production polls and grace (`wait` re-checks every 2s, the
// tracker records the tree every 2s, the kill grace is 10s). Every ordering a
// case relies on is stated against these values where it is set up.
const PACING = {
  DRIVE_PR_FOREGROUND_WAIT_POLL_MS: "100",
  DRIVE_PR_FOREGROUND_WAIT_TRACK_MS: "200",
  DRIVE_PR_FOREGROUND_WAIT_KILL_GRACE_MS: "1000",
};

describe("foreground-wait.ts", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "fgwait-"));
  });

  const stateRoot = () => join(cwd, ".context", "foreground-wait");
  const latestGen = () => {
    const gens = readdirSync(stateRoot()).filter((n) => /^gen-\d+$/.test(n));
    return join(stateRoot(), gens.sort().at(-1) as string);
  };
  const pidOf = (name: string): number | null => {
    const f = join(latestGen(), name);
    return existsSync(f) ? Number.parseInt(readFileSync(f, "utf8"), 10) : null;
  };
  // Children are stopped before their state directory goes, so a late runner
  // never writes into a deleted directory and a failed assertion leaks nothing.
  afterEach(() => {
    if (existsSync(stateRoot())) {
      // The whole tree, snapshotted before anything dies: killing only the
      // recorded parents would leave their descendants running, re-parented.
      const doomed = ["runner.pid", "cmd.pid"].flatMap((name) => {
        const pid = pidOf(name);
        return pid === null ? [] : treeOf(pid);
      });
      for (const pid of doomed) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  const runWith = (env: Record<string, string>, ...args: string[]) =>
    Bun.spawnSync(["bun", SCRIPT, ...args], {
      cwd,
      stderr: "pipe",
      env: { ...process.env, ...PACING, ...env },
    });
  const run = (...args: string[]) => runWith({}, ...args);
  const out = (r: ReturnType<typeof run>) => r.stdout.toString();

  test(
    "relays the output; a failing command is reported apart from control codes",
    () => {
      expect(run("launch", "--", "sh", "-c", "echo hi; exit 7").exitCode).toBe(
        0,
      );
      const w = run("wait");
      expect(w.exitCode).toBe(30);
      expect(out(w)).toContain("hi");
      expect(out(w)).toContain("command-exit: 7");
    },
    T,
  );

  test(
    "a command exiting 20 or 21 is a finished command, not a control state",
    () => {
      for (const code of [20, 21]) {
        expect(run("launch", "--", "sh", "-c", `exit ${code}`).exitCode).toBe(
          0,
        );
        const w = run("wait");
        expect(w.exitCode).toBe(30);
        expect(out(w)).toContain(`command-exit: ${code}`);
        // Repeating wait still reports the finished command.
        expect(run("wait").exitCode).toBe(30);
      }
    },
    T,
  );

  test(
    "a successful command exits wait with 0",
    () => {
      expect(run("launch", "--", "true").exitCode).toBe(0);
      expect(run("wait").exitCode).toBe(0);
    },
    T,
  );

  test(
    "a launch beside a live one is refused, and wait reports still-running",
    () => {
      expect(run("launch", "--", "sleep", "30").exitCode).toBe(0);
      expect(run("launch", "--", "true").exitCode).toBe(3);
      const w = run("wait", "--max-sec", "1");
      expect(w.exitCode).toBe(20);
      expect(out(w)).toContain("never `launch`");
    },
    T,
  );

  test(
    "concurrent launches: exactly one wins the claim",
    async () => {
      const procs = Array.from({ length: 4 }, () =>
        Bun.spawn(["bun", SCRIPT, "launch", "--", "sleep", "30"], {
          cwd,
          env: { ...process.env, ...PACING },
        }),
      );
      const codes = await Promise.all(procs.map((p) => p.exited));
      expect(codes.filter((c) => c === 0)).toHaveLength(1);
      expect(codes.filter((c) => c === 3)).toHaveLength(3);
      expect(
        readdirSync(stateRoot()).filter((n) => /^gen-\d+$/.test(n)),
      ).toHaveLength(1);
    },
    T,
  );

  test(
    "a failed spawn surfaces its message and status once",
    () => {
      expect(run("launch", "--", "/nonexistent/fgwait-cmd").exitCode).toBe(0);
      const w = run("wait");
      expect(w.exitCode).toBe(30);
      expect(out(w)).toContain("could not start command");
      expect(out(w)).toContain("command-exit: 127");
    },
    T,
  );

  test(
    "repeated waits relay only output not yet shown",
    () => {
      expect(
        run("launch", "--", "sh", "-c", "echo first; sleep 3; echo second")
          .exitCode,
      ).toBe(0);
      const w1 = run("wait", "--max-sec", "1");
      expect(w1.exitCode).toBe(20);
      expect(out(w1)).toContain("first");
      const w2 = run("wait");
      expect(w2.exitCode).toBe(0);
      expect(out(w2)).toContain("second");
      expect(out(w2)).not.toContain("first");
    },
    T,
  );

  test(
    "a runner killed mid-command is not running forever: wait reports 21 once nothing is alive",
    async () => {
      expect(run("launch", "--", "sleep", "30").exitCode).toBe(0);
      for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
        await sleepMs(100);
      }
      // Kill the whole recorded tree, leaving zombies where a parent is gone.
      for (const name of ["runner.pid", "cmd.pid"]) {
        process.kill(pidOf(name) as number, "SIGKILL");
      }
      await sleepMs(300);
      const w = run("wait", "--max-sec", "1");
      expect(w.exitCode).toBe(21);
    },
    T,
  );

  test(
    "runner and command stay in the pass group: cancelling the group stops both",
    async () => {
      // Stand-in for the driver's pass group: its own leader, like drive.ts's pass.
      const pass = Bun.spawn(
        ["bun", SCRIPT, "launch", "--", "sh", "-c", "sleep 30; sleep 30"],
        { cwd, detached: true, env: { ...process.env, ...PACING } },
      );
      await pass.exited;
      const runner = pidOf("runner.pid") as number;
      const command = pidOf("cmd.pid");
      // cmd.pid is published by the runner a moment after launch returns.
      for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
        await sleepMs(100);
      }
      const cmdPid = (command ?? pidOf("cmd.pid")) as number;
      expect(alive(runner)).toBe(true);
      expect(alive(cmdPid)).toBe(true);
      process.kill(-pass.pid, "SIGTERM");
      for (let i = 0; i < 50 && (alive(runner) || alive(cmdPid)); i++) {
        await sleepMs(100);
      }
      expect(alive(runner)).toBe(false);
      expect(alive(cmdPid)).toBe(false);
    },
    T,
  );

  test(
    "a pass that never waits cannot leave the command running past the runner deadline",
    async () => {
      expect(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          "sh",
          "-c",
          "sleep 30 & wait",
        ).exitCode,
      ).toBe(0);
      for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
        await sleepMs(100);
      }
      const cmdPid = pidOf("cmd.pid") as number;
      expect(alive(cmdPid)).toBe(true);
      const w = run("wait", "--max-sec", "30");
      expect(w.exitCode).toBe(30);
      expect(out(w)).toContain("deadline of 2s reached");
      expect(out(w)).toContain("command-exit: 124");
      expect(alive(cmdPid)).toBe(false);
    },
    T,
  );

  test(
    "the deadline also ends a SIGTERM-resistant descendant before a result is published",
    async () => {
      const gate = join(cwd, "witness.gate");
      writeFileSync(gate, "");
      // The shell exits on SIGTERM; its child ignores it and outlives the shell.
      expect(
        runWith(
          {
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2",
            DRIVE_PR_FOREGROUND_WAIT_WITNESS_GATE: gate,
          },
          "launch",
          "--",
          "sh",
          "-c",
          `sh -c 'trap "" TERM; echo $$ > stubborn.pid; exec sleep 30' >/dev/null 2>&1 & wait`,
        ).exitCode,
      ).toBe(0);
      // Hold the termination witness open: while it cannot confirm the tree is
      // dead, no terminal result may exist, however long we look. Removing the
      // gate then lets publication proceed — ordering established by the gate,
      // not by sampling.
      let stubborn: number | null = null;
      for (let i = 0; i < 100 && stubborn === null; i++) {
        if (existsSync(join(cwd, "stubborn.pid"))) {
          const n = Number.parseInt(
            readFileSync(join(cwd, "stubborn.pid"), "utf8"),
            10,
          );
          if (Number.isInteger(n)) stubborn = n;
        }
        await sleepMs(50);
      }
      expect(stubborn).not.toBeNull();
      // Well past the 2s deadline and its 1s kill grace: the runner has
      // signalled but may not publish.
      await sleepMs(4000);
      expect(existsSync(join(latestGen(), "result.json"))).toBe(false);
      const still = run("wait", "--max-sec", "1");
      expect(still.exitCode).toBe(20);
      rmSync(gate);
      const w = run("wait", "--max-sec", "30");
      expect(w.exitCode).toBe(30);
      expect(out(w)).toContain("command-exit: 124");
      expect(alive(stubborn as number)).toBe(false);
    },
    T,
  );

  test(
    "the deadline SIGTERMs a previously tracked descendant, so its cleanup handler runs",
    async () => {
      // The descendant is observed by the periodic tracker (every 200ms) well
      // before the 2s deadline, so termination must signal it although it is
      // not newly seen.
      expect(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          "sh",
          "-c",
          `sh -c 'trap "echo term > termed.marker; exit 0" TERM; while :; do :; done' >/dev/null 2>&1 & wait`,
        ).exitCode,
      ).toBe(0);
      const w = run("wait", "--max-sec", "40");
      expect(w.exitCode).toBe(30);
      expect(existsSync(join(cwd, "termed.marker"))).toBe(true);
    },
    T,
  );

  test(
    "a command that exits on its own leaves no tracked descendant running when the result is published",
    async () => {
      // The periodic tracker (every 200ms) captures the descendant; the
      // command then exits 0 while the descendant, with its output
      // redirected, lives on.
      expect(
        run(
          "launch",
          "--",
          "sh",
          "-c",
          `sleep 600 >/dev/null 2>&1 & echo $! > bg.pid; sleep 1.5; exit 0`,
        ).exitCode,
      ).toBe(0);
      const w = run("wait", "--max-sec", "60");
      expect(w.exitCode).toBe(0);
      expect(out(w)).toContain("descendants still running");
      const bg = Number.parseInt(readFileSync(join(cwd, "bg.pid"), "utf8"), 10);
      expect(Number.isInteger(bg)).toBe(true);
      expect(alive(bg)).toBe(false);
    },
    T,
  );

  test(
    "a descendant recovered after a failed process snapshot still gets SIGTERM before SIGKILL",
    async () => {
      // `ps` fails from before the deadline (3s) until released, so termination
      // cannot snapshot and signals only the command; the descendant was
      // tracked earlier (every 200ms). Once `ps` recovers it must be TERMed,
      // not killed cold.
      const shim = join(cwd, "shim");
      mkdirSync(shim);
      const flag = join(cwd, "psbroken");
      writeFileSync(
        join(shim, "ps"),
        `#!/bin/sh\n[ -e "${flag}" ] && exit 1\nexec /bin/ps "$@"\n`,
        { mode: 0o755 },
      );
      expect(
        runWith(
          {
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "3",
            PATH: `${shim}:${process.env.PATH}`,
          },
          "launch",
          "--",
          "sh",
          "-c",
          `sh -c 'trap "echo term > termed.marker; exit 0" TERM; while :; do :; done' >/dev/null 2>&1 & wait`,
        ).exitCode,
      ).toBe(0);
      await sleepMs(1000); // tracked within 200ms, before the deadline
      writeFileSync(flag, "");
      await sleepMs(3500); // deadline fires with `ps` broken
      rmSync(flag);
      const w = run("wait", "--max-sec", "40");
      expect(w.exitCode).toBe(30);
      expect(existsSync(join(cwd, "termed.marker"))).toBe(true);
    },
    T,
  );

  test(
    "the deadline settles even when a re-parented descendant holds the output pipes open",
    async () => {
      // The shell exits at once; its background child outlives it, inherits the
      // pipes, and is no longer under any pid the runner can discover.
      expect(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          "sh",
          "-c",
          "sleep 600 & echo $! > bg.pid; exit 0",
        ).exitCode,
      ).toBe(0);
      try {
        const w = run("wait", "--max-sec", "40");
        expect(w.exitCode).toBe(30);
        expect(out(w)).toContain("deadline of 2s reached");
        expect(out(w)).toContain("command-exit: 124");
      } finally {
        const bg = Number.parseInt(
          readFileSync(join(cwd, "bg.pid"), "utf8"),
          10,
        );
        if (Number.isInteger(bg)) {
          try {
            process.kill(bg, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
    T,
  );

  // Root ignores mode bits, so chmod 444 cannot make the append fail.
  test.skipIf(process.getuid?.() === 0)(
    "a log that cannot be written ends the command instead of leaving it unsupervised",
    async () => {
      // Replace the log with a read-only file: appends fail (EACCES) while the
      // reader in `wait` can still open it.
      const log = ".context/foreground-wait/gen-1/log";
      expect(
        run(
          "launch",
          "--",
          "sh",
          "-c",
          `rm -f ${log}; touch ${log}; chmod 444 ${log}; echo diagnostic; sleep 600`,
        ).exitCode,
      ).toBe(0);
      const cmdPid = await (async () => {
        for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
          await sleepMs(100);
        }
        return pidOf("cmd.pid") as number;
      })();
      const w = run("wait", "--max-sec", "40");
      expect(w.exitCode).toBe(30);
      expect(out(w)).toContain("could not write the log");
      expect(out(w)).toContain("command-exit: 125");
      expect(alive(cmdPid)).toBe(false);
    },
    T,
  );

  test(
    "an unusable deadline is refused at launch, before any work starts",
    () => {
      for (const bad of ["2oops", "2147484", "0", "-5"]) {
        const r = runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: bad },
          "launch",
          "--",
          "true",
        );
        expect(r.exitCode).toBe(2);
        expect(r.stderr.toString()).toContain("not a usable deadline");
      }
      expect(existsSync(stateRoot())).toBe(false);
    },
    T,
  );

  test(
    "retained output is bounded at the writer and the truncation is reported",
    () => {
      // 20 MiB of output against a 16 MiB retention cap.
      expect(
        run(
          "launch",
          "--",
          "sh",
          "-c",
          'head -c 20971520 /dev/zero | tr "\\0" x',
        ).exitCode,
      ).toBe(0);
      const w = run("wait", "--max-sec", "60");
      expect(w.exitCode).toBe(0);
      // The retained payload is exactly the cap; the only allowance beyond it
      // is the truncation marker, pinned byte for byte.
      const marker = `\nforeground-wait: output exceeded ${16 * 1024 * 1024} bytes; the rest is dropped\n`;
      expect(statSync(join(latestGen(), "log")).size).toBe(
        16 * 1024 * 1024 + Buffer.byteLength(marker),
      );
      // The relayed tail arrives whole and in order: the marker is the last log
      // byte, so the status line follows it directly. An asynchronous stdout
      // write lets the status line overtake the tail and `process.exit` drop
      // the rest.
      // The whole relay is pinned: the omission notice with its exact count,
      // then exactly the final 256 KiB of the log, then the status line.
      const logCap = 256 * 1024;
      const omitted = 16 * 1024 * 1024 + Buffer.byteLength(marker) - logCap;
      const tail = "x".repeat(logCap - Buffer.byteLength(marker)) + marker;
      expect(out(w)).toBe(
        `[foreground-wait: ${omitted} earlier log bytes omitted]\n${tail}command-exit: 0\n`,
      );
    },
    T,
  );

  test(
    "wait with no launch on record is a usage error",
    () => {
      expect(run("wait").exitCode).toBe(2);
    },
    T,
  );
});

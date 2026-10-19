import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
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
import { join, resolve, delimiter } from "node:path";
import { processTable } from "../../../shared/process-table.ts";
import {
  beginProcessRegistration,
  processRegistryRoots,
} from "../../../shared/process-registry.ts";
import {
  captureProcessTree,
  signalIdentityTargets,
  forceIdentityTargetsAndWitness,
} from "../../../shared/process-tree.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  skipsOnWindows,
  exceptOnWindows,
  byPlatform,
} from "../../../../lib/test-helpers/windows-skip.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/foreground-wait.ts");

// This permission fixture needs POSIX mode bits; Windows writes are governed by ACLs.
const NO_MODE_BITS = skipsOnWindows(
  "file-system",
  "chmod 444 does not make a Windows file unwritable; the fixture needs an ACL-aware replacement",
);
const bunCommand = (source: string) => [process.execPath, "-e", source];
const busy = "setInterval(() => {}, 1000)";
const childTree = (source = busy, parent = busy) =>
  `Bun.spawn([process.execPath, '-e', ${JSON.stringify(source)}], {stdout:'ignore',stderr:'ignore'}); ${parent}`;

// Each case spawns several bun processes; the 5s default is too tight under load.
const T = 60_000;

const alive = async (pid: number): Promise<boolean> => {
  const rows = await processTable();
  return (
    rows?.some((row) => row.pid === pid && !row.stat.startsWith("Z")) ?? true
  );
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
  afterEach(async () => {
    if (existsSync(stateRoot())) {
      // The whole tree, snapshotted before anything dies: killing only the
      // recorded parents would leave their descendants running, re-parented.
      for (const name of ["runner.pid", "cmd.pid"]) {
        const pid = pidOf(name);
        const targets = pid === null ? null : await captureProcessTree(pid);
        if (targets) await signalIdentityTargets(targets, "SIGKILL");
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  const runWith = (env: Record<string, string>, ...args: string[]) =>
    Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd,
      stderr: "pipe",
      env: { ...process.env, ...PACING, ...env },
    });
  const run = (...args: string[]) => runWith({}, ...args);
  const out = (r: ReturnType<typeof run>) => r.stdout.toString();

  test(
    "relays the output; a failing command is reported apart from control codes",
    () => {
      expectSpawnExit(
        run(
          "launch",
          "--",
          ...bunCommand("console.log('hi'); process.exit(7)"),
        ),
        0,
      );
      const w = run("wait");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("hi");
      expect(out(w)).toContain("command-exit: 7");
    },
    T,
  );

  test(
    "a command exiting 20 or 21 is a finished command, not a control state",
    () => {
      for (const code of [20, 21]) {
        expectSpawnExit(
          run("launch", "--", ...bunCommand(`process.exit(${code})`)),
          0,
        );
        const w = run("wait");
        expectSpawnExit(w, 30);
        expect(out(w)).toContain(`command-exit: ${code}`);
        // Repeating wait still reports the finished command.
        expectSpawnExit(run("wait"), 30);
      }
    },
    T,
  );

  test(
    "a successful command exits wait with 0",
    () => {
      expectSpawnExit(run("launch", "--", ...bunCommand("")), 0);
      expectSpawnExit(run("wait"), 0);
    },
    T,
  );

  test(
    "a launch beside a live one is refused, and wait reports still-running",
    () => {
      expectSpawnExit(run("launch", "--", ...bunCommand(busy)), 0);
      expectSpawnExit(run("launch", "--", ...bunCommand("")), 3);
      const w = run("wait", "--max-sec", "1");
      expectSpawnExit(w, 20);
      expect(out(w)).toContain("never `launch`");
    },
    T,
  );

  test(
    "concurrent launches: exactly one wins the claim",
    async () => {
      const procs = Array.from({ length: 4 }, () =>
        Bun.spawn(
          [process.execPath, SCRIPT, "launch", "--", ...bunCommand(busy)],
          {
            cwd,
            env: { ...process.env, ...PACING },
          },
        ),
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
      expectSpawnExit(run("launch", "--", "/nonexistent/fgwait-cmd"), 0);
      const w = run("wait");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("could not start command");
      expect(out(w)).toContain("command-exit: 127");
    },
    T,
  );

  test(
    "repeated waits relay only output not yet shown",
    () => {
      expectSpawnExit(
        run(
          "launch",
          "--",
          ...bunCommand(
            "console.log('first'); setTimeout(() => console.log('second'), 3000)",
          ),
        ),
        0,
      );
      const w1 = run("wait", "--max-sec", "1");
      expectSpawnExit(w1, 20);
      expect(out(w1)).toContain("first");
      const w2 = run("wait");
      expectSpawnExit(w2, 0);
      expect(out(w2)).toContain("second");
      expect(out(w2)).not.toContain("first");
    },
    T,
  );

  test(
    "a runner killed mid-command is not running forever: wait reports 21 once nothing is alive",
    async () => {
      expectSpawnExit(run("launch", "--", ...bunCommand(busy)), 0);
      for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
        await sleepMs(100);
      }
      // Kill the whole recorded tree, leaving zombies where a parent is gone.
      for (const name of ["runner.pid", "cmd.pid"]) {
        process.kill(pidOf(name) as number, "SIGKILL");
      }
      await sleepMs(300);
      const w = run("wait", "--max-sec", "1");
      expectSpawnExit(w, 21);
    },
    T,
  );

  test(
    "pass cancellation reaches the runner and command",
    async () => {
      // Stand-in for the driver's pass group: its own leader, like drive.ts's pass.
      const pass = Bun.spawn(
        [process.execPath, SCRIPT, "launch", "--", ...bunCommand(childTree())],
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
      expect(await alive(runner)).toBe(true);
      expect(await alive(cmdPid)).toBe(true);
      const cancellation = byPlatform(
        "Windows cancels a recorded tree; POSIX cancels a process group",
        { windows: "tree", posix: "group" },
      );
      if (cancellation === "group") process.kill(-pass.pid, "SIGTERM");
      else
        await signalIdentityTargets(
          (await captureProcessTree(runner)) ?? [],
          "SIGKILL",
        );
      for (
        let i = 0;
        i < 50 && ((await alive(runner)) || (await alive(cmdPid)));
        i++
      ) {
        await sleepMs(100);
      }
      expect(await alive(runner)).toBe(false);
      expect(await alive(cmdPid)).toBe(false);
    },
    T,
  );

  test(
    "a pass that never waits cannot leave the command running past the runner deadline",
    async () => {
      expectSpawnExit(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          ...bunCommand(childTree()),
        ),
        0,
      );
      for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
        await sleepMs(100);
      }
      const cmdPid = pidOf("cmd.pid") as number;
      expect(await alive(cmdPid)).toBe(true);
      const w = run("wait", "--max-sec", "30");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("deadline of 2s reached");
      expect(out(w)).toContain("command-exit: 124");
      expect(
        JSON.parse(readFileSync(join(latestGen(), "result.json"), "utf8")),
      ).toMatchObject({ treeWitnessed: true });
      expect(await alive(cmdPid)).toBe(false);
    },
    T,
  );

  test(
    "the deadline also ends a SIGTERM-resistant descendant before a result is published",
    async () => {
      const gate = join(cwd, "witness.gate");
      writeFileSync(gate, "");
      // The shell exits on SIGTERM; its child ignores it and outlives the shell.
      expectSpawnExit(
        runWith(
          {
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2",
            DRIVE_PR_FOREGROUND_WAIT_WITNESS_GATE: gate,
          },
          "launch",
          "--",
          ...bunCommand(
            childTree(
              `require("node:fs").writeFileSync("stubborn.pid",String(process.pid)); process.on("SIGTERM",()=>{}); ${busy}`,
            ),
          ),
        ),
        0,
      );
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
      expectSpawnExit(still, 20);
      rmSync(gate);
      const w = run("wait", "--max-sec", "30");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("command-exit: 124");
      expect(await alive(stubborn as number)).toBe(false);
    },
    T,
  );

  test(
    "the deadline SIGTERMs a previously tracked descendant, so its cleanup handler runs",
    async () => {
      // The descendant is observed by the periodic tracker (every 200ms) well
      // before the 2s deadline, so termination must signal it although it is
      // not newly seen.
      expectSpawnExit(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          ...bunCommand(
            childTree(
              `process.on("SIGTERM",()=>{require("node:fs").writeFileSync("termed.marker","term");process.exit(0)}); ${busy}`,
            ),
          ),
        ),
        0,
      );
      const w = run("wait", "--max-sec", "40");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("command-exit: 124");
      exceptOnWindows("Windows has no cooperative POSIX TERM handler", () =>
        expect(existsSync(join(cwd, "termed.marker"))).toBe(true),
      );
    },
    T,
  );

  test(
    "a command that exits on its own leaves no tracked descendant running when the result is published",
    async () => {
      // The periodic tracker (every 200ms) captures the descendant; the
      // command then exits 0 while the descendant, with its output
      // redirected, lives on.
      expectSpawnExit(
        run(
          "launch",
          "--",
          ...bunCommand(
            `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(busy)}],{stdout:"ignore",stderr:"ignore"}); require("node:fs").writeFileSync("bg.pid",String(child.pid)); child.unref(); setTimeout(()=>process.exit(0),1500)`,
          ),
        ),
        0,
      );
      const w = run("wait", "--max-sec", "60");
      expectSpawnExit(w, 0);
      exceptOnWindows(
        "Bun's Windows job reaps the descendant when its command exits",
        () => expect(out(w)).toContain("descendants still running"),
      );
      const bg = Number.parseInt(readFileSync(join(cwd, "bg.pid"), "utf8"), 10);
      expect(Number.isInteger(bg)).toBe(true);
      expect(await alive(bg)).toBe(false);
    },
    T,
  );

  test(
    "a descendant recovered after a failed process snapshot receives its cancellation grace",
    async () => {
      // `ps` fails from before the deadline (3s) until released, so termination
      // cannot snapshot and signals only the command; the descendant was
      // tracked earlier (every 200ms). Once `ps` recovers it must be TERMed,
      // not killed cold.
      const shim = join(cwd, "shim");
      mkdirSync(shim);
      const flag = join(cwd, "psbroken");
      const native = byPlatform(
        "Windows reads CIM through PowerShell; POSIX reads ps",
        { windows: "powershell.exe", posix: "ps" },
      );
      const actual = Bun.which(native);
      expect(actual).not.toBeNull();
      writeFakeProgram(
        join(shim, native),
        `#!/usr/bin/env bun\nif(require("node:fs").existsSync(${JSON.stringify(flag)})) process.exit(1); const result=Bun.spawnSync([${JSON.stringify(actual)},...process.argv.slice(2)], {stdout:"pipe",stderr:"inherit"}); process.stdout.write(result.stdout); process.exit(result.exitCode);`,
      );
      expectSpawnExit(
        runWith(
          {
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "3",
            PATH: `${shim}${delimiter}${process.env.PATH}`,
          },
          "launch",
          "--",
          ...bunCommand(
            childTree(
              `process.on("SIGTERM",()=>{require("node:fs").writeFileSync("termed.marker","term");process.exit(0)}); ${busy}`,
            ),
          ),
        ),
        0,
      );
      await sleepMs(1000); // tracked within 200ms, before the deadline
      writeFileSync(flag, "");
      await sleepMs(3500); // deadline fires with `ps` broken
      rmSync(flag);
      const w = run("wait", "--max-sec", "40");
      expectSpawnExit(w, 30);
      exceptOnWindows("Windows has no cooperative POSIX TERM handler", () =>
        expect(existsSync(join(cwd, "termed.marker"))).toBe(true),
      );
    },
    T,
  );

  test(
    "the deadline settles even when a re-parented descendant holds the output pipes open",
    async () => {
      // The shell exits at once; its background child outlives it, inherits the
      // pipes, and is no longer under any pid the runner can discover.
      expectSpawnExit(
        runWith(
          { DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2" },
          "launch",
          "--",
          ...bunCommand(
            `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(busy)}],{stdout:"inherit",stderr:"inherit"}); require("node:fs").writeFileSync("bg.pid",String(child.pid)); child.unref(); process.exit(0)`,
          ),
        ),
        0,
      );
      try {
        const w = run("wait", "--max-sec", "40");
        const completion = byPlatform(
          "Bun reaps the inherited-pipe child on Windows; POSIX needs the runner deadline",
          { windows: "job-reaped", posix: "deadline" },
        );
        expectSpawnExit(w, completion === "job-reaped" ? 0 : 30);
        expect(out(w)).toContain(
          completion === "job-reaped" ? "command-exit: 0" : "command-exit: 124",
        );
        const bg = Number.parseInt(
          readFileSync(join(cwd, "bg.pid"), "utf8"),
          10,
        );
        expect(Number.isInteger(bg)).toBe(true);
        if (completion === "job-reaped") expect(await alive(bg)).toBe(false);
        exceptOnWindows(
          "POSIX inherited pipes keep the runner waiting until its deadline",
          () => expect(out(w)).toContain("deadline of 2s reached"),
        );
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
  test.skipIf(NO_MODE_BITS || process.getuid?.() === 0)(
    "a log that cannot be written ends the command instead of leaving it unsupervised",
    async () => {
      // Replace the log with a read-only file: appends fail (EACCES) while the
      // reader in `wait` can still open it.
      const log = ".context/foreground-wait/gen-1/log";
      expectSpawnExit(
        run(
          "launch",
          "--",
          "sh",
          "-c",
          `rm -f ${log}; touch ${log}; chmod 444 ${log}; echo diagnostic; sleep 600`,
        ),
        0,
      );
      const cmdPid = await (async () => {
        for (let i = 0; i < 50 && pidOf("cmd.pid") === null; i++) {
          await sleepMs(100);
        }
        return pidOf("cmd.pid") as number;
      })();
      const w = run("wait", "--max-sec", "40");
      expectSpawnExit(w, 30);
      expect(out(w)).toContain("could not write the log");
      expect(out(w)).toContain("command-exit: 125");
      expect(await alive(cmdPid)).toBe(false);
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
        expectSpawnExit(r, 2);
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
      expectSpawnExit(
        run(
          "launch",
          "--",
          ...bunCommand('process.stdout.write("x".repeat(20971520))'),
        ),
        0,
      );
      const w = run("wait", "--max-sec", "60");
      expectSpawnExit(w, 0);
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
    "a launched runner registers an identity so a pass can cancel its tree after the launcher exits",
    async () => {
      const registry = join(cwd, "registry");
      mkdirSync(registry);
      const launched = runWith(
        { JIG_PROCESS_REGISTRY_DIR: registry },
        "launch",
        "--",
        ...bunCommand(childTree()),
      );
      expectSpawnExit(launched, 0);
      const entries = readdirSync(registry);
      expect(entries.some((name) => name.endsWith(".pending"))).toBe(false);
      const recorded = JSON.parse(
        readFileSync(
          join(
            registry,
            entries.find((name) => name.endsWith(".json")) as string,
          ),
          "utf8",
        ),
      ) as { pid: number; start: string };
      expect(pidOf("runner.pid")).toBe(recorded.pid);
      expect(recorded.start).toBeTruthy();
      const readyDeadline = Date.now() + 20_000;
      while (pidOf("cmd.pid") === null && Date.now() < readyDeadline)
        await sleepMs(20);
      expect(pidOf("cmd.pid")).not.toBeNull();
      const commandPid = pidOf("cmd.pid") as number;
      // The runner can concurrently own an enumeration subprocess; only an
      // explicit command identity proves this cancellation fixture is ready.
      let targets = await captureProcessTree(recorded.pid);
      while (
        !targets?.some((target) => target.pid === commandPid) &&
        Date.now() < readyDeadline
      ) {
        await sleepMs(20);
        targets = await captureProcessTree(recorded.pid);
      }
      const command = targets?.find((target) => target.pid === commandPid);
      expect(command?.start).toBeTruthy();
      expect(await forceIdentityTargetsAndWitness(targets ?? [])).toBe(true);
      const deadline = Date.now() + 20_000;
      let remaining = true;
      while (remaining && Date.now() < deadline) {
        const rows = await processTable();
        remaining =
          rows === null ||
          rows.some(
            (row) =>
              !row.stat.startsWith("Z") &&
              ((row.pid === recorded.pid &&
                (!row.start || row.start === recorded.start)) ||
                (row.pid === commandPid &&
                  (!row.start || row.start === command?.start))),
          );
        if (remaining) await sleepMs(20);
      }
      expect(remaining).toBe(false);
      // Children are stopped first. The runner may publish their failure
      // before its own kill arrives, or die before publishing a result.
      const expected = existsSync(join(latestGen(), "result.json")) ? 30 : 21;
      expectSpawnExit(run("wait", "--max-sec", "1"), expected);
    },
    T,
  );

  test(
    "a finished runner clears a still-pending handoff",
    () => {
      const registry = join(cwd, "registry");
      const dir = join(cwd, "runner");
      mkdirSync(registry);
      mkdirSync(dir);
      beginProcessRegistration(registry, "fixture", join(dir, "result.json"));
      expect(processRegistryRoots(registry)).toBeNull();
      const result = runWith(
        { JIG_PROCESS_REGISTRY_DIR: registry },
        "_run",
        dir,
        "fixture",
        "--",
        "/nonexistent/foreground-command",
      );
      expectSpawnExit(result, 0);
      expect(
        JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
      ).toMatchObject({ exitCode: 127, treeWitnessed: true });
      expect(processRegistryRoots(registry)).toEqual([]);
    },
    T,
  );

  test(
    "an unavailable Windows process table still ends the owned child after grace without certifying the tree",
    async () => {
      const shim = join(cwd, "shim");
      const dir = join(cwd, "direct");
      const registry = join(cwd, "registry");
      mkdirSync(shim);
      mkdirSync(dir);
      mkdirSync(registry);
      const snapshotFile = join(cwd, "native-snapshot.json");
      writeFakeProgram(
        join(shim, "powershell.exe"),
        `#!/usr/bin/env bun\nconst fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(snapshotFile)}))process.exit(1);process.stdout.write(fs.readFileSync(${JSON.stringify(snapshotFile)}));\n`,
      );
      beginProcessRegistration(registry, "fixture", join(dir, "result.json"));
      const marker = join(cwd, "owned.pid");
      const command = `require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),30000);`;
      const args = [
        process.execPath,
        SCRIPT,
        "_run",
        dir,
        "fixture",
        "--",
        ...bunCommand(command),
      ];
      // Modeling the platform only in this subprocess exercises the native
      // Windows cancellation branch without changing the test worker's state.
      const runner = Bun.spawn(
        [
          process.execPath,
          "-e",
          `Object.defineProperty(process,"platform",{value:"win32"});process.argv=${JSON.stringify(args)};await import(${JSON.stringify(SCRIPT)});`,
        ],
        {
          cwd,
          env: {
            ...process.env,
            ...PACING,
            PATH: `${shim}${delimiter}${process.env.PATH}`,
            JIG_PROCESS_REGISTRY_DIR: registry,
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "1",
            DRIVE_PR_FOREGROUND_WAIT_KILL_GRACE_MS: "100",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let runnerExited = false;
      void runner.exited.then(() => {
        runnerExited = true;
      });
      try {
        const readyDeadline = Date.now() + 10_000;
        while (!existsSync(marker) && Date.now() < readyDeadline)
          await sleepMs(20);
        expect(existsSync(marker)).toBe(true);
        const pid = Number(readFileSync(marker, "utf8"));
        const deadline = Date.now() + 10_000;
        let childGone = false;
        while (!childGone && Date.now() < deadline) {
          childGone = !(await alive(pid));
          if (!childGone) await sleepMs(20);
        }
        expect(childGone).toBe(true);
        expect(runnerExited).toBe(false);
        expect(existsSync(join(dir, "result.json"))).toBe(false);
        expect(processRegistryRoots(registry)).toBeNull();
        // Recover enumeration only after the owned child was forced. Its
        // absence now cannot establish what happened to unobserved descendants.
        writeFileSync(
          snapshotFile,
          JSON.stringify([
            {
              ProcessId: runner.pid,
              ParentProcessId: process.pid,
              CreationDate: "2026-10-19T00:00:00.0000000Z",
              CommandLine: "foreground runner",
            },
          ]),
        );
        const recoveryDeadline = Date.now() + 10_000;
        while (!runnerExited && Date.now() < recoveryDeadline)
          await sleepMs(20);
        expect(runnerExited).toBe(true);
        expect(
          JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
        ).toMatchObject({ exitCode: 124, treeWitnessed: false });
        expect(processRegistryRoots(registry)).toBeNull();
      } finally {
        const targets = await captureProcessTree(runner.pid);
        if (targets) await forceIdentityTargetsAndWitness(targets);
        runner.kill("SIGKILL");
        await runner.exited;
      }
    },
    T,
  );

  test(
    "wait with no launch on record is a usage error",
    () => {
      expectSpawnExit(run("wait"), 2);
    },
    T,
  );
});

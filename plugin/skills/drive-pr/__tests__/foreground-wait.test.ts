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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { processTable } from "../../../shared/process-table.ts";
import {
  beginProcessRegistration,
  processRegistryRoots,
  processCompletionPath,
} from "../../../shared/process-registry.ts";
import {
  captureProcessTree,
  signalIdentityTargets,
  forceIdentityTargetsAndWitness,
  identityTargetsGone,
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

const afterCapture = (marker: string, source: string, extraPids = "[]") =>
  `(()=>{const fs=require("node:fs");const deadline=Date.now()+20000;const timer=setInterval(()=>{if(Date.now()>deadline)process.exit(99);try{const targets=JSON.parse(fs.readFileSync(${JSON.stringify(marker)},"utf8")).targets;if([process.pid,...${extraPids}].every(pid=>targets.some(target=>target.pid===pid))){clearInterval(timer);${source}}}catch{}},20);})();`;
const captureEnv = (marker: string) => ({
  NODE_ENV: "test",
  DRIVE_PR_FOREGROUND_WAIT_CAPTURE_ACK: marker,
});

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

  for (const code of [20, 21])
    test(
      `a command exiting ${code} is a finished command, not a control state`,
      () => {
        expectSpawnExit(
          run("launch", "--", ...bunCommand(`process.exit(${code})`)),
          0,
        );
        const waited = run("wait");
        expectSpawnExit(waited, 30);
        expect(out(waited)).toContain(`command-exit: ${code}`);
        expectSpawnExit(run("wait"), 30);
      },
      T,
    );

  for (const registered of [false, true])
    test(
      `ordinary fast successful commands can be waited and relaunched without capture acknowledgment (${registered ? "registered" : "standalone"})`,
      () => {
        const registry = join(cwd, "fast-registry");
        if (registered) mkdirSync(registry);
        const runFast = (...args: string[]) =>
          runWith(
            registered ? { JIG_PROCESS_REGISTRY_DIR: registry } : {},
            ...args,
          );
        for (let launch = 0; launch < 2; launch++) {
          expectSpawnExit(
            runFast("launch", "--", process.execPath, "-e", ""),
            0,
          );
          const waited = runFast("wait");
          expectSpawnExit(waited, 0);
          expect(out(waited)).toContain("command-exit: 0");
        }
        if (registered) expect(processRegistryRoots(registry)).toEqual([]);
      },
      T,
    );

  test(
    "an unavailable initial ownership snapshot executes no user command",
    () => {
      const shim = join(cwd, "unavailable-shim");
      const dir = join(cwd, "unbound");
      mkdirSync(shim);
      mkdirSync(dir);
      writeFakeProgram(
        join(shim, "powershell.exe"),
        "#!/usr/bin/env bun\nprocess.exit(1);\n",
      );
      const marker = join(cwd, "must-not-execute");
      const args = [
        process.execPath,
        SCRIPT,
        "_run",
        dir,
        "fixture",
        "--",
        ...bunCommand(
          `require("node:fs").writeFileSync(${JSON.stringify(marker)},"executed");`,
        ),
      ];
      const result = Bun.spawnSync(
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
            DRIVE_PR_FOREGROUND_WAIT_CANCEL_MS: "1000",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10000,
        },
      );
      expectSpawnExit(result, 0);
      expect(existsSync(marker)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
      ).toMatchObject({ exitCode: 125, treeWitnessed: true });
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
            'console.log("first");setTimeout(()=>console.log("second"),3000)',
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

  const capturedCommand = async (marker: string, pids: number[]) => {
    const deadline = Date.now() + 20000;
    let complete = false;
    let captured: { pid: number; start: string }[] = [];
    while (!complete && Date.now() < deadline) {
      try {
        const capture = JSON.parse(readFileSync(marker, "utf8")) as {
          targets: { pid: number; start: string }[];
        };
        captured = capture.targets;
        complete = pids.every((pid) =>
          capture.targets.some((target) => target.pid === pid),
        );
      } catch {
        // The tracker has not published a complete acknowledgment yet.
      }
      if (!complete) await sleepMs(20);
    }
    expect(complete).toBe(true);
    return captured;
  };

  const capturedRunner = async (runner: number, pids: number[]) => {
    const deadline = Date.now() + 20000;
    let targets = await captureProcessTree(runner);
    while (
      !pids.every((pid) => targets?.some((target) => target.pid === pid)) &&
      Date.now() < deadline
    ) {
      await sleepMs(20);
      targets = await captureProcessTree(runner);
    }
    for (const pid of pids)
      expect(targets?.some((target) => target.pid === pid)).toBe(true);
    return targets ?? [];
  };

  test(
    "a runner killed mid-command is not running forever: wait reports 21 once nothing is alive",
    async () => {
      const ack = join(cwd, "killed-capture.json");
      expectSpawnExit(
        runWith(captureEnv(ack), "launch", "--", ...bunCommand(busy)),
        0,
      );
      const ready = Date.now() + 20000;
      while (pidOf("cmd.pid") === null && Date.now() < ready) await sleepMs(20);
      const cmd = pidOf("cmd.pid") as number;
      await capturedCommand(ack, [cmd]);
      const runner = pidOf("runner.pid") as number;
      const targets = await capturedRunner(runner, [cmd]);
      const root = targets?.find((target) => target.pid === runner);
      expect(root?.start).toBeTruthy();
      // End the supervisor before its command so no terminal report can race
      // this lost-supervisor fixture; then witness every captured identity.
      await signalIdentityTargets(root ? [root] : [], "SIGKILL");
      const deadline = Date.now() + 30000;
      while (
        !(await identityTargetsGone(root ? [root] : [])) &&
        Date.now() < deadline
      )
        await sleepMs(20);
      expect(await identityTargetsGone(root ? [root] : [])).toBe(true);
      expect(await forceIdentityTargetsAndWitness(targets ?? [])).toBe(true);
      expectSpawnExit(run("wait", "--max-sec", "30"), 21);
    },
    T,
  );

  test(
    "pass cancellation reaches the runner and command",
    async () => {
      const ack = join(cwd, "pass-capture.json");
      const bg = join(cwd, "pass-bg.pid");
      const pass = Bun.spawn(
        [
          process.execPath,
          SCRIPT,
          "launch",
          "--",
          ...bunCommand(
            childTree(
              `require("node:fs").writeFileSync(${JSON.stringify(bg)},String(process.pid));${busy}`,
            ),
          ),
        ],
        {
          cwd,
          detached: true,
          env: { ...process.env, ...PACING, ...captureEnv(ack) },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(
        {
          exitCode: await pass.exited,
          stdout: await new Response(pass.stdout).text(),
          stderr: await new Response(pass.stderr).text(),
        },
        0,
      );
      const ready = Date.now() + 20000;
      while (
        (pidOf("cmd.pid") === null || !existsSync(bg)) &&
        Date.now() < ready
      )
        await sleepMs(20);
      const runner = pidOf("runner.pid") as number;
      const command = pidOf("cmd.pid") as number;
      const descendant = Number(readFileSync(bg, "utf8"));
      await capturedCommand(ack, [command, descendant]);
      const targets = await capturedRunner(runner, [command, descendant]);
      const cancellation = byPlatform(
        "Windows cancels a recorded tree; POSIX cancels a process group",
        { windows: "tree", posix: "group" },
      );
      if (cancellation === "group") process.kill(-pass.pid, "SIGTERM");
      else
        expect(await forceIdentityTargetsAndWitness(targets ?? [])).toBe(true);
      const deadline = Date.now() + 30000;
      let gone = false;
      while (!gone && Date.now() < deadline) {
        gone = await identityTargetsGone(targets ?? []);
        if (!gone) await sleepMs(20);
      }
      expect(gone).toBe(true);
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
      const capture = join(cwd, "stubborn-capture.json");
      const deadlineGate = join(cwd, "start-deadline");
      writeFileSync(gate, "");
      expectSpawnExit(
        runWith(
          {
            ...captureEnv(capture),
            DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: "2",
            DRIVE_PR_FOREGROUND_WAIT_WITNESS_GATE: gate,
            DRIVE_PR_FOREGROUND_WAIT_DEADLINE_GATE: deadlineGate,
          },
          "launch",
          "--",
          ...bunCommand(
            childTree(
              `require("node:fs").writeFileSync("stubborn.pid",String(process.pid));process.on("SIGTERM",()=>{});${busy}`,
            ),
          ),
        ),
        0,
      );
      const ready = Date.now() + 20000;
      const pidFile = join(cwd, "stubborn.pid");
      while (
        (!existsSync(pidFile) || pidOf("cmd.pid") === null) &&
        Date.now() < ready
      )
        await sleepMs(20);
      expect(existsSync(pidFile)).toBe(true);
      const stubborn = Number(readFileSync(pidFile, "utf8"));
      const command = pidOf("cmd.pid") as number;
      const captured = await capturedCommand(capture, [command, stubborn]);
      const identity = captured.find((target) => target.pid === stubborn);
      expect(identity?.start).toBeTruthy();
      // The real two-second command deadline begins only after this fixture
      // establishes both identities. The publication gate holds their witness.
      writeFileSync(deadlineGate, "");
      const deadline = Date.now() + 25000;
      let gone = false;
      while (!gone && Date.now() < deadline) {
        gone = await identityTargetsGone(identity ? [identity] : []);
        if (!gone) await sleepMs(20);
      }
      expect(gone).toBe(true);
      expect(existsSync(join(latestGen(), "result.json"))).toBe(false);
      expectSpawnExit(run("wait", "--max-sec", "1"), 20);
      rmSync(gate);
      const waited = run("wait", "--max-sec", "30");
      expectSpawnExit(waited, 30);
      expect(out(waited)).toContain("command-exit: 124");
      expect(
        JSON.parse(readFileSync(join(latestGen(), "result.json"), "utf8")),
      ).toMatchObject({ exitCode: 124, treeWitnessed: true });
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
      const capture = join(cwd, "descendant-capture.json");
      // The command exits only after the tracker acknowledges both its own
      // identity and the descendant, whose output is redirected.
      expectSpawnExit(
        runWith(
          captureEnv(capture),
          "launch",
          "--",
          ...bunCommand(
            `const child=Bun.spawn([process.execPath,"-e",${JSON.stringify(busy)}],{stdout:"ignore",stderr:"ignore"}); require("node:fs").writeFileSync("bg.pid",String(child.pid)); child.unref(); ${afterCapture(capture, "process.exit(0);", "[child.pid]")}`,
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
        // A reaped tree is verified only when the runner's tracker saw the
        // child before its parent exited, a race this fixture does not control;
        // the exit must agree with whichever verdict the runner reached.
        const unverified = out(w).includes("process tree remains unverified");
        expectSpawnExit(w, completion === "job-reaped" && !unverified ? 0 : 30);
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
          ...bunCommand('process.stdout.write("x".repeat(20971520));'),
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

  for (const mode of [
    "recovered",
    "permanent outage",
    "unknown live identity",
  ] as const)
    test(
      `an unavailable Windows process table (${mode}) ends the owned child without certifying the tree`,
      async () => {
        const shim = join(cwd, "shim");
        const dir = join(stateRoot(), "gen-1");
        const registry = join(cwd, "registry");
        mkdirSync(shim);
        mkdirSync(dir, { recursive: true });
        mkdirSync(registry);
        const snapshotFile = join(cwd, "native-snapshot.json");
        const runnerFile = join(cwd, "runner-own.pid");
        const marker = join(cwd, "owned.pid");
        writeFakeProgram(
          join(shim, "powershell.exe"),
          `#!/usr/bin/env bun\nconst fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(marker)})){process.stdout.write(JSON.stringify([{ProcessId:Number(fs.readFileSync(${JSON.stringify(runnerFile)},"utf8")),ParentProcessId:0,CreationDate:"2026-10-19T00:00:00.0000000Z",CommandLine:"runner"}]));}else{if(!fs.existsSync(${JSON.stringify(snapshotFile)}))process.exit(1);process.stdout.write(fs.readFileSync(${JSON.stringify(snapshotFile)}));}\n`,
        );
        beginProcessRegistration(registry, "fixture", join(dir, "result.json"));
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
            `Object.defineProperty(process,"platform",{value:"win32"});require("node:fs").writeFileSync(${JSON.stringify(runnerFile)},String(process.pid));process.argv=${JSON.stringify(args)};await import(${JSON.stringify(SCRIPT)});`,
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
              ...(mode === "recovered"
                ? {}
                : { DRIVE_PR_FOREGROUND_WAIT_CANCEL_MS: "2000" }),
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
          if (mode === "unknown live identity")
            writeFileSync(
              snapshotFile,
              JSON.stringify([
                {
                  ProcessId: runner.pid,
                  ParentProcessId: process.pid,
                  CreationDate: "2026-10-19T00:00:00.0000000Z",
                  CommandLine: "runner",
                },
                {
                  ProcessId: pid,
                  ParentProcessId: runner.pid,
                  CreationDate: null,
                  CommandLine: "command",
                },
              ]),
            );

          const deadline = Date.now() + 10_000;
          let childGone = false;
          while (!childGone && Date.now() < deadline) {
            childGone = !(await alive(pid));
            if (!childGone) await sleepMs(20);
          }
          expect(childGone).toBe(true);
          if (mode === "recovered") {
            expect(runnerExited).toBe(false);
            expect(existsSync(join(dir, "result.json"))).toBe(false);
            expect(processRegistryRoots(registry)).toEqual([
              {
                pid: runner.pid,
                start: "2026-10-19T00:00:00.0000000Z",
                resultFile: processCompletionPath(registry, "fixture"),
              },
            ]);
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
          }
          const recoveryDeadline = Date.now() + 10_000;
          while (!runnerExited && Date.now() < recoveryDeadline)
            await sleepMs(20);
          expect(runnerExited).toBe(true);
          expect(
            JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
          ).toMatchObject({ exitCode: 124, treeWitnessed: false });
          expect(processRegistryRoots(registry)).toBeNull();
          if (mode === "permanent outage") {
            // Loss of the public copy cannot erase the registered authority.
            rmSync(join(dir, "result.json"));
            const waited = Bun.spawnSync(
              [process.execPath, SCRIPT, "wait", "--max-sec", "120"],
              {
                cwd,
                env: { ...process.env, ...PACING },
                stdout: "pipe",
                stderr: "pipe",
                timeout: 3000,
              },
            );
            expectSpawnExit(waited, 30);
            expect(waited.stdout.toString()).toContain("command-exit: 124");
            expectSpawnExit(run("launch", "--", ...bunCommand("")), 3);
          }
        } finally {
          const targets = await captureProcessTree(runner.pid);
          if (targets) await forceIdentityTargetsAndWitness(targets);
          runner.kill("SIGKILL");
          await runner.exited;
        }
      },
      T,
    );

  for (const [timeout, exitCode] of [
    ["1", 124],
    ["20", 0],
  ] as const)
    test(
      `blocked natural-exit cancellation preserves command status ${exitCode} and excludes later work`,
      () => {
        const shim = join(cwd, "shim");
        const dir = join(stateRoot(), "gen-1");
        mkdirSync(shim);
        mkdirSync(dir, { recursive: true });
        const runnerFile = join(cwd, "bound-runner.pid");
        const queries = join(cwd, "probe-started");
        writeFakeProgram(
          join(shim, "powershell.exe"),
          `#!/usr/bin/env bun\nconst fs=require("node:fs");if(!fs.existsSync(${JSON.stringify(queries)})){fs.writeFileSync(${JSON.stringify(queries)},"first");process.stdout.write(JSON.stringify([{ProcessId:Number(fs.readFileSync(${JSON.stringify(runnerFile)},"utf8")),ParentProcessId:0,CreationDate:"2026-10-19T00:00:00.0000000Z",CommandLine:"runner"}]));}else{setTimeout(()=>process.exit(1),10000);}\n`,
        );
        const args = [
          process.execPath,
          SCRIPT,
          "_run",
          dir,
          "fixture",
          "--",
          ...bunCommand("process.exit(0)"),
        ];
        const result = Bun.spawnSync(
          [
            process.execPath,
            "-e",
            `Object.defineProperty(process,"platform",{value:"win32"});require("node:fs").writeFileSync(${JSON.stringify(runnerFile)},String(process.pid));process.argv=${JSON.stringify(args)};await import(${JSON.stringify(SCRIPT)});`,
          ],
          {
            cwd,
            env: {
              ...process.env,
              ...PACING,
              PATH: `${shim}${delimiter}${process.env.PATH}`,
              DRIVE_PR_FOREGROUND_WAIT_TIMEOUT: timeout,
              DRIVE_PR_FOREGROUND_WAIT_CANCEL_MS: "2000",
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 10000,
          },
        );
        expectSpawnExit(result, 0);
        expect(
          JSON.parse(readFileSync(join(dir, "result.json"), "utf8")),
        ).toMatchObject({ exitCode, treeWitnessed: false });
        const waited = Bun.spawnSync(
          [process.execPath, SCRIPT, "wait", "--max-sec", "120"],
          {
            cwd,
            env: { ...process.env, ...PACING },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 3000,
          },
        );
        expectSpawnExit(waited, 30);
        expect(waited.stdout.toString()).toContain(`command-exit: ${exitCode}`);
        expectSpawnExit(run("launch", "--", ...bunCommand("")), 3);
        expect(existsSync(join(dir, "result.json"))).toBe(true);
      },
      T,
    );

  for (const result of [
    { exitCode: 0, treeWitnessed: false },
    { exitCode: 0, treeWitnessed: "false" },
    "unreadable",
  ] as const)
    test(
      "an older unresolved generation is retained beside a newer verified result",
      () => {
        const older = join(stateRoot(), "gen-1");
        const latest = join(stateRoot(), "gen-2");
        mkdirSync(older, { recursive: true });
        mkdirSync(latest);
        writeFileSync(
          join(older, "result.json"),
          result === "unreadable" ? "{" : JSON.stringify(result),
        );
        writeFileSync(
          join(latest, "result.json"),
          JSON.stringify({ exitCode: 0, treeWitnessed: true }),
        );
        expectSpawnExit(run("launch", "--", ...bunCommand("")), 3);
        expect(existsSync(join(older, "result.json"))).toBe(true);
        expect(existsSync(join(latest, "result.json"))).toBe(true);
      },
      T,
    );

  test(
    "an older live generation is retained beside a newer verified result",
    async () => {
      const child = Bun.spawn(bunCommand(busy), {
        stdout: "ignore",
        stderr: "ignore",
      });
      const older = join(stateRoot(), "gen-1");
      const latest = join(stateRoot(), "gen-2");
      mkdirSync(older, { recursive: true });
      mkdirSync(latest);
      writeFileSync(join(older, "launcher.pid"), String(child.pid));
      writeFileSync(join(older, "runner.pid"), String(child.pid));
      writeFileSync(
        join(latest, "result.json"),
        JSON.stringify({ exitCode: 0, treeWitnessed: true }),
      );
      try {
        expectSpawnExit(run("launch", "--", ...bunCommand("")), 3);
        expect(existsSync(join(older, "runner.pid"))).toBe(true);
        expect(existsSync(join(latest, "result.json"))).toBe(true);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        rmSync(join(older, "runner.pid"), { force: true });
        rmSync(join(older, "launcher.pid"), { force: true });
      }
    },
    T,
  );

  // A number `running` settled as not this launch's process must not block the
  // synchronous admission that follows. A zombie is the POSIX form: the
  // snapshot reads it as exited while a signal probe still answers for it.
  test.skipIf(
    skipsOnWindows(
      "process-lifecycle",
      "Windows has no zombie processes; its form of this case is a reused number",
    ),
  )(
    "a recorded number the liveness check settled does not block admission",
    async () => {
      const zombieFile = join(cwd, "zombie.pid");
      // `exec` replaces the shell with a process that never reaps its child.
      const parent = Bun.spawn(
        [
          "bash",
          "-c",
          `sleep 0.01 & echo $! > ${JSON.stringify(zombieFile)}; exec sleep 60`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      try {
        const deadline = Date.now() + 10_000;
        let zombie: number | null = null;
        while (zombie === null && Date.now() < deadline) {
          const rows = existsSync(zombieFile) ? await processTable() : null;
          const pid = existsSync(zombieFile)
            ? Number.parseInt(readFileSync(zombieFile, "utf8"), 10)
            : NaN;
          if (rows?.some((r) => r.pid === pid && r.stat.startsWith("Z")))
            zombie = pid;
          else await sleepMs(20);
        }
        expect(zombie).not.toBeNull();
        const older = join(stateRoot(), "gen-1");
        mkdirSync(older, { recursive: true });
        writeFileSync(join(older, "launcher.pid"), String(zombie));
        writeFileSync(join(older, "runner.pid"), String(zombie));
        // Recorded well before the check's snapshot, as a finished launch's are.
        const recordedAt = new Date(Date.now() - 60_000);
        for (const name of ["launcher.pid", "runner.pid"])
          utimesSync(join(older, name), recordedAt, recordedAt);
        expectSpawnExit(run("launch", "--", ...bunCommand("")), 0);
        expect(existsSync(older)).toBe(false);
        expectSpawnExit(run("wait", "--max-sec", "30"), 0);
      } finally {
        parent.kill("SIGKILL");
        await parent.exited;
      }
    },
    T,
  );

  for (const newer of [false, true])
    test(
      `a ${newer ? "new active generation" : "published unresolved result"} during liveness enumeration prevents admission`,
      async () => {
        const older = join(stateRoot(), "gen-1");
        mkdirSync(older, { recursive: true });
        const shim = join(cwd, "admission-shim");
        mkdirSync(shim);
        const queried = join(cwd, "query-open");
        const release = join(cwd, "release-query");
        const finish = join(cwd, "finish-owner");
        const executed = join(cwd, "new-command-executed");
        const resultFile = join(older, "result.json");
        const owner = Bun.spawn(
          bunCommand(
            `const fs=require("node:fs");setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({exitCode:0,treeWitnessed:${JSON.stringify(newer)}}));process.exit(0)}},10);`,
          ),
          { stdout: "pipe", stderr: "pipe" },
        );
        const contender = newer
          ? Bun.spawn(bunCommand(busy), { stdout: "ignore", stderr: "ignore" })
          : null;
        writeFileSync(join(older, "launcher.pid"), String(owner.pid));
        writeFileSync(join(older, "runner.pid"), String(owner.pid));
        writeFakeProgram(
          join(shim, "powershell.exe"),
          `#!/usr/bin/env bun\nconst fs=require("node:fs");fs.writeFileSync(${JSON.stringify(queried)},"ready");const deadline=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<deadline)await Bun.sleep(10);process.stdout.write(JSON.stringify([{ProcessId:90000001,ParentProcessId:0,CreationDate:"2026-10-19T00:00:00.0000000Z",CommandLine:"foreign"}]));\n`,
        );
        const args = [
          process.execPath,
          SCRIPT,
          "launch",
          "--",
          ...bunCommand(
            `require("node:fs").writeFileSync(${JSON.stringify(executed)},"executed");`,
          ),
        ];
        const launcher = Bun.spawn(
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
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        try {
          const deadline = Date.now() + 10000;
          while (!existsSync(queried) && Date.now() < deadline)
            await sleepMs(20);
          expect(existsSync(queried)).toBe(true);
          if (contender) {
            const active = join(stateRoot(), "gen-3");
            mkdirSync(active);
            writeFileSync(join(active, "launcher.pid"), String(contender.pid));
            writeFileSync(join(active, "runner.pid"), String(contender.pid));
          }
          writeFileSync(finish, "");
          expectSpawnExit(
            {
              exitCode: await owner.exited,
              stdout: await new Response(owner.stdout).text(),
              stderr: await new Response(owner.stderr).text(),
            },
            0,
          );
          writeFileSync(release, "");
          expectSpawnExit(
            {
              exitCode: await launcher.exited,
              stdout: await new Response(launcher.stdout).text(),
              stderr: await new Response(launcher.stderr).text(),
            },
            3,
          );
          expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({
            treeWitnessed: newer,
          });
          expect(existsSync(join(stateRoot(), "gen-2"))).toBe(false);
          expect(existsSync(executed)).toBe(false);
        } finally {
          writeFileSync(release, "");
          if (contender) {
            contender.kill("SIGKILL");
            await contender.exited;
          }
          const unexpected = join(stateRoot(), "gen-2", "runner.pid");
          if (existsSync(unexpected)) {
            const targets = await captureProcessTree(
              Number(readFileSync(unexpected, "utf8")),
            );
            if (targets) await forceIdentityTargetsAndWitness(targets);
          }
          owner.kill("SIGKILL");
          launcher.kill("SIGKILL");
          await owner.exited;
          await launcher.exited;
        }
      },
      T,
    );

  for (const witness of ["omitted", "malformed", "false"] as const)
    test(
      `an internal ${witness} witness cannot become legacy success or admit new work`,
      () => {
        const registry = join(cwd, "internal-registry");
        const dir = join(stateRoot(), "gen-1");
        mkdirSync(registry);
        mkdirSync(dir, { recursive: true });
        const authority = processCompletionPath(registry, "unique-entry");
        const terminal =
          witness === "omitted"
            ? { exitCode: 0 }
            : {
                exitCode: 0,
                treeWitnessed: witness === "false" ? false : "false",
              };
        writeFileSync(authority, JSON.stringify(terminal));
        writeFileSync(
          join(dir, "runner.identity.json"),
          JSON.stringify({
            pid: 90000004,
            start: "bound",
            resultFile: authority,
          }),
        );
        writeFileSync(join(dir, "log"), "");
        const waited = Bun.spawnSync(
          [process.execPath, SCRIPT, "wait", "--max-sec", "120"],
          {
            cwd,
            env: { ...process.env, ...PACING },
            stdout: "pipe",
            stderr: "pipe",
            timeout: 3000,
          },
        );
        expectSpawnExit(waited, 30);
        expect(waited.stdout.toString()).toContain(
          witness === "false"
            ? "process tree remains unverified"
            : "result file unreadable",
        );
        const marker = join(cwd, "forbidden-command");
        expectSpawnExit(
          run(
            "launch",
            "--",
            ...bunCommand(
              `require("node:fs").writeFileSync(${JSON.stringify(marker)},"executed");`,
            ),
          ),
          3,
        );
        expect(existsSync(marker)).toBe(false);
        expect(existsSync(authority)).toBe(true);
        expect(existsSync(join(dir, "runner.identity.json"))).toBe(true);
      },
      T,
    );

  test(
    "a legacy public result with an omitted witness remains a successful completion",
    () => {
      const dir = join(stateRoot(), "gen-1");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), JSON.stringify({ exitCode: 0 }));
      writeFileSync(join(dir, "log"), "");
      expectSpawnExit(run("wait"), 0);
      expectSpawnExit(run("launch", "--", ...bunCommand("")), 0);
      expectSpawnExit(run("wait"), 0);
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

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { processTable } from "../../../shared/process-table.ts";
import {
  identityTargetsGone,
  signalIdentityTargets,
} from "../../../shared/process-tree.ts";
import { hostEnv } from "../../../../lib/test-helpers/host-env.ts";

// A launch whose runner cannot be waited on: refused up front under Codex,
// whose tool calls end the processes they start, and reported as lost, with
// the command's last output, when its runner disappears anyway.
const SCRIPT = resolve(import.meta.dir, "../scripts/foreground-wait.ts");
const T = 60_000;
const PACING = {
  DRIVE_PR_FOREGROUND_WAIT_POLL_MS: "100",
  DRIVE_PR_FOREGROUND_WAIT_TRACK_MS: "200",
  DRIVE_PR_FOREGROUND_WAIT_KILL_GRACE_MS: "1000",
};
const bunCommand = (source: string) => [process.execPath, "-e", source];
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "fgwait-lost-"));
  tracked = [];
});

const stateRoot = () => join(cwd, ".context", "foreground-wait");
const generation = () => join(stateRoot(), "gen-1");
const pidOf = (name: string): number | null => {
  const file = join(generation(), name);
  return existsSync(file)
    ? Number.parseInt(readFileSync(file, "utf8"), 10)
    : null;
};

/** Fixture processes by creation identity, so a reused pid is never signalled. */
type Identity = { pid: number; start: string };
let tracked: Identity[] = [];
/** Record the runner's and the command's identities while they are alive. */
const track = async () => {
  const rows = await processTable();
  for (const name of ["runner.pid", "cmd.pid"]) {
    const pid = pidOf(name);
    const row = rows?.find((r) => r.pid === pid);
    if (row && !tracked.some((t) => t.pid === row.pid))
      tracked.push({ pid: row.pid, start: row.start });
  }
};

afterEach(async () => {
  // Only identities captured while the fixture owned them: the pid files
  // outlive their processes, so reading them here could adopt a reused pid.
  await signalIdentityTargets(tracked, "SIGKILL");
  tracked = [];
  rmSync(cwd, { recursive: true, force: true });
});

const spawnScript = (
  env: Record<string, string | undefined>,
  ...args: string[]
) =>
  Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd,
    stderr: "pipe",
    env,
  });
const run = (...args: string[]) =>
  spawnScript({ ...hostEnv, ...PACING }, ...args);
const out = (r: ReturnType<typeof run>) => r.stdout.toString();

/** The environment of a Codex tool call: Codex's variables, no Claude Code. */
const codexEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...hostEnv, ...PACING };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return { ...env, CODEX_THREAD_ID: "thread-under-test", ...extra };
};

test(
  "launch refuses under Codex, names the fallback and starts nothing",
  () => {
    const marker = join(cwd, "ran");
    const refused = spawnScript(
      codexEnv(),
      "launch",
      "--",
      ...bunCommand(
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1")`,
      ),
    );
    expectSpawnExit(refused, 4);
    const said = refused.stderr.toString();
    expect(said).toContain("CODEX_THREAD_ID is set");
    expect(said).toContain("exec_command");
    expect(said).toContain("write_stdin");
    expect(existsSync(stateRoot())).toBe(false);
    expect(existsSync(marker)).toBe(false);
  },
  T,
);

test(
  "CODEX_HOME alone, a configuration directory, does not refuse a launch",
  () => {
    const launched = spawnScript(
      codexEnv({ CODEX_HOME: "/nonexistent/codex-home" }),
      "launch",
      "--",
      ...bunCommand("console.log('ok')"),
    );
    // codexEnv always adds CODEX_THREAD_ID; drop it to leave only CODEX_HOME.
    expectSpawnExit(launched, 4);
    const env: Record<string, string | undefined> = codexEnv({
      CODEX_HOME: "/nonexistent/codex-home",
    });
    delete env.CODEX_THREAD_ID;
    const homeOnly = spawnScript(
      env,
      "launch",
      "--",
      ...bunCommand("console.log('ok')"),
    );
    expectSpawnExit(homeOnly, 0);
    const waited = run("wait");
    expectSpawnExit(waited, 0);
  },
  T,
);

test(
  "a Claude Code session that inherited Codex's variables still launches",
  () => {
    const launched = spawnScript(
      codexEnv({ CLAUDECODE: "1" }),
      "launch",
      "--",
      ...bunCommand("console.log('ok')"),
    );
    expectSpawnExit(launched, 0);
    const waited = run("wait");
    expectSpawnExit(waited, 0);
    expect(out(waited)).toContain("ok");
  },
  T,
);

/** Kill the runner and its command, then wait until both identities are gone; an unreadable table keeps polling. */
const loseRunner = async (deadline: number) => {
  await track();
  // signalIdentityTargets signals last-first: the runner must go before its command.
  await signalIdentityTargets([...tracked].reverse(), "SIGKILL");
  while (!(await identityTargetsGone(tracked))) {
    expect(Date.now()).toBeLessThan(deadline);
    await sleepMs(20);
  }
  tracked = [];
};
const logSize = () => {
  const file = join(generation(), "log");
  return existsSync(file) ? readFileSync(file).length : 0;
};
const untilLogSize = async (size: number, deadline: number) => {
  await track();
  while (logSize() < size) {
    await track();
    expect(Date.now()).toBeLessThan(deadline);
    await sleepMs(20);
  }
};

test(
  "a lost runner is reported lost with the command's last output, even output already relayed",
  async () => {
    expectSpawnExit(
      run(
        "launch",
        "--",
        ...bunCommand('console.log("last words"); setInterval(() => {}, 1000)'),
      ),
      0,
    );
    const log = () => join(generation(), "log");
    const deadline = Date.now() + 20_000;
    while (
      !(existsSync(log()) && readFileSync(log(), "utf8").includes("last words"))
    ) {
      await track();
      expect(Date.now()).toBeLessThan(deadline);
      await sleepMs(20);
    }
    const running = run("wait", "--max-sec", "1");
    expectSpawnExit(running, 20);
    expect(out(running)).toContain("last words");

    // The runner goes first, so it cannot publish a result for its command.
    await loseRunner(deadline);

    const lost = run("wait", "--max-sec", "30");
    expectSpawnExit(lost, 21);
    expect(out(lost)).toContain("runner was lost before it published a result");
    expect(out(lost)).toContain("last words");
  },
  T,
);

test(
  "a lost runner's report shows the final 4 KiB of a log that was already relayed",
  async () => {
    const deadline = Date.now() + 30_000;
    const go = join(cwd, "go");
    expectSpawnExit(
      run(
        "launch",
        "--",
        ...bunCommand(
          `const fs = require("node:fs");
process.stdout.write("a".repeat(6000));
const t = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(go)})) {
    clearInterval(t);
    process.stdout.write("b".repeat(1000));
    setInterval(() => {}, 1000);
  }
}, 20);`,
        ),
      ),
      0,
    );
    await untilLogSize(6000, deadline);
    // Everything so far is relayed, so only the 4 KiB floor can show it again.
    expectSpawnExit(run("wait", "--max-sec", "1"), 20);
    writeFileSync(go, "1");
    await untilLogSize(7000, deadline);
    await loseRunner(deadline);

    const lost = run("wait", "--max-sec", "30");
    expectSpawnExit(lost, 21);
    // Partially unseen: 1000 unseen bytes, so the tail is the final 4096.
    expect(out(lost)).toContain(`${"a".repeat(3096)}${"b".repeat(1000)}`);
    expect(out(lost)).not.toContain("a".repeat(3097));
  },
  T,
);

test(
  "a lost runner's report shows all of an unseen log larger than 4 KiB",
  async () => {
    const deadline = Date.now() + 30_000;
    expectSpawnExit(
      run(
        "launch",
        "--",
        ...bunCommand(
          'process.stdout.write("a".repeat(10000)); setInterval(() => {}, 1000)',
        ),
      ),
      0,
    );
    await untilLogSize(10000, deadline);
    await loseRunner(deadline);

    const lost = run("wait", "--max-sec", "30");
    expectSpawnExit(lost, 21);
    expect(out(lost)).toContain("a".repeat(10000));
  },
  T,
);

test(
  "a lost runner's report keeps exactly 4 KiB of a log wholly relayed",
  async () => {
    const deadline = Date.now() + 30_000;
    expectSpawnExit(
      run(
        "launch",
        "--",
        ...bunCommand(
          'process.stdout.write("a".repeat(5904) + "b".repeat(4096)); setInterval(() => {}, 1000)',
        ),
      ),
      0,
    );
    await untilLogSize(10000, deadline);
    expectSpawnExit(run("wait", "--max-sec", "1"), 20);
    await loseRunner(deadline);

    const lost = run("wait", "--max-sec", "30");
    expectSpawnExit(lost, 21);
    expect(out(lost)).toContain("final 4096 bytes");
    expect(out(lost)).toContain("b".repeat(4096));
    expect(out(lost)).not.toContain("aaaa");
  },
  T,
);

test(
  "a launch lost before its runner wrote a log says so rather than calling the command silent",
  () => {
    // A launcher that recorded itself and is gone, with nothing after it.
    const gone = Bun.spawnSync([process.execPath, "-e", ""]);
    expectSpawnExit(gone, 0);
    mkdirSync(generation(), { recursive: true });
    writeFileSync(join(generation(), "launcher.pid"), `${gone.pid}\n`);
    const lost = run("wait", "--max-sec", "5");
    expectSpawnExit(lost, 21);
    expect(out(lost)).toContain("no log was written");
    expect(out(lost)).not.toContain("the command wrote no output");
  },
  T,
);

test(
  "a lost runner is still reported when the relay cursor cannot be written",
  async () => {
    const deadline = Date.now() + 30_000;
    expectSpawnExit(
      run(
        "launch",
        "--",
        ...bunCommand(
          'process.stdout.write("a".repeat(100)); setInterval(() => {}, 1000)',
        ),
      ),
      0,
    );
    await untilLogSize(100, deadline);
    await loseRunner(deadline);
    // A directory where the cursor file belongs: neither readable nor writable.
    mkdirSync(join(generation(), "log.cursor"));

    const lost = run("wait", "--max-sec", "30");
    expectSpawnExit(lost, 21);
    expect(out(lost)).toContain("a".repeat(100));
    expect(out(lost)).toContain("runner was lost before it published a result");
  },
  T,
);

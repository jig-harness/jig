import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

const root = mkdtempSync(join(tmpdir(), "live-drivers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const scripts = join(import.meta.dir, "../scripts");
const env = {
  ...Object.fromEntries(
    Object.entries(gitIdentityEnv()).filter(
      ([key]) => !key.startsWith("DRIVE_PR_"),
    ),
  ),
  DRIVE_PR_STATE_DIR: join(root, "shared"),
  DRIVE_PR_HANDOFF_DIR: join(root, "handoff"),
};
function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0);
}
function repo(name: string) {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, "init", "-q");
  git(cwd, "config", "core.hooksPath", "/dev/null");
  git(
    cwd,
    "-c",
    "user.name=Probe",
    "-c",
    "user.email=probe@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "seed",
  );
  return cwd;
}
const stderrByChild = new WeakMap<object, Promise<string>>();
function childStderr(child: object): Promise<string> {
  const pending = stderrByChild.get(child);
  if (pending === undefined) throw new Error("missing driver diagnostics");
  return pending;
}
function driver(cwd: string, marker: string, pr = "161") {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    const {openStore, worktreeLockName} = await import(${JSON.stringify(join(scripts, "lib/state/store.ts"))});
    const {resolveActor} = await import(${JSON.stringify(join(scripts, "lib/state/actor.ts"))});
    const {acquire, release} = await import(${JSON.stringify(join(scripts, "lib/driver/locks.ts"))});
    const {runMain} = await import(${JSON.stringify(join(scripts, "lib/cli.ts"))});
    const {join} = await import("node:path");
    await runMain("driver-probe", async () => {
      const s = await openStore(${JSON.stringify(pr)});
      const locks = [ {dir:join(s.stateDir, "pr-drive-${pr}.lock"), what:"PR"}, {dir:join(s.stateDir, await worktreeLockName()),what:"worktree"} ];
      acquire(locks[0], ${JSON.stringify(pr)});
      try {
        acquire(locks[1], ${JSON.stringify(pr)});
        try {
          const actor = await resolveActor();
          await s.update(state => ({...state, rounds: state.rounds+1,
            parked:[{key:${JSON.stringify(cwd)},kind:"finding",reason:"fixture",round:1}],
            held:[{key:${JSON.stringify(cwd)},kind:"finding",outcome:"accepted",reason:"fixture",round:1,actor}],
            ciHold:{phase:"acquiring",previousEventId:${JSON.stringify(cwd)},head:"a".repeat(40),actor:"probe",createdAt:new Date().toISOString(),checkRunWatermark:0}
          }));
          await Bun.write(${JSON.stringify(marker)}, JSON.stringify({dir:s.stateDir, rounds:s.read().state.rounds}));
          await new Response(Bun.stdin.stream()).text();
        } finally { release(locks[1]); }
      } finally { release(locks[0]); }
      return 0;
    });
  `,
    ],
    {
      cwd,
      env: { ...env, DRIVE_PR_HANDOFF_DIR: join(cwd, ".context") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  stderrByChild.set(child, new Response(child.stderr).text());
  return child;
}
async function ready(path: string, child: ReturnType<typeof driver>) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (child.exitCode !== null)
      throw new Error(
        `driver exited before readiness: ${await childStderr(child)}`,
      );
    if (Date.now() > deadline)
      throw new Error("driver readiness deadline expired");
    await Bun.sleep(10);
  }
  return JSON.parse(readFileSync(path, "utf8")) as {
    dir: string;
    rounds: number;
  };
}

test("live drivers in different repositories share a root without sharing state or locks", async () => {
  const a = repo("a");
  const b = repo("b");
  const sibling = join(root, "sibling");
  git(a, "worktree", "add", "-q", "--detach", sibling);
  const markerA = join(root, "a.ready");
  const markerB = join(root, "b.ready");
  const first = driver(a, markerA);
  let second: ReturnType<typeof driver> | undefined;
  try {
    const x = await ready(markerA, first);
    second = driver(b, markerB);
    const y = await ready(markerB, second);
    if (first.exitCode !== null || second.exitCode !== null)
      throw new Error(
        "both drivers must remain alive while their state is inspected",
      );
    expect(x.dir).not.toBe(y.dir);
    expect(x.rounds).toBe(1);
    expect(
      JSON.parse(
        readFileSync(join(x.dir, "drive-pr-161.json"), "utf8"),
      ).parked.map((p: { key: string }) => p.key),
    ).toEqual([a]);
    expect(
      JSON.parse(
        readFileSync(join(y.dir, "drive-pr-161.json"), "utf8"),
      ).parked.map((p: { key: string }) => p.key),
    ).toEqual([b]);
    expect(y.rounds).toBe(1);
    for (const [stateDir, owner] of [
      [x.dir, a],
      [y.dir, b],
    ] as const) {
      const state = JSON.parse(
        readFileSync(join(stateDir, "drive-pr-161.json"), "utf8"),
      );
      expect(state.held.map((item: { key: string }) => item.key)).toEqual([
        owner,
      ]);
      expect(state.ciHold.previousEventId).toBe(owner);
    }
    for (const [cwd, pr] of [
      [sibling, "161"],
      [a, "162"],
    ] as const) {
      const duplicate = driver(cwd, join(root, `duplicate-${pr}`), pr);
      duplicate.stdin.end();
      const stderr = await childStderr(duplicate);
      expectSpawnExit(
        { exitCode: await duplicate.exited, stdout: "", stderr },
        11,
      );
    }
    expect(
      JSON.parse(readFileSync(join(x.dir, "drive-pr-161.json"), "utf8")).rounds,
    ).toBe(1);
    expect(
      JSON.parse(readFileSync(join(y.dir, "drive-pr-161.json"), "utf8")).rounds,
    ).toBe(1);
  } finally {
    first.stdin.end();
    second?.stdin.end();
    expectSpawnExit(
      {
        exitCode: await first.exited,
        stdout: "",
        stderr: await childStderr(first),
      },
      0,
    );
    if (second)
      expectSpawnExit(
        {
          exitCode: await second.exited,
          stdout: "",
          stderr: await childStderr(second),
        },
        0,
      );
  }
});

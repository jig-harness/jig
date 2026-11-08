/**
 * tree-drivers.ts: what keeps a working tree driven, read from the drive's
 * database without writing it. A clone no drive ever ran in has no driver;
 * a live driver holding the tree's lock, and a live lease of the tree's
 * actor, each name a reason; a state directory with no database to say is
 * "cannot tell". Each case runs in a child process with its own state root.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tree-drivers-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const lib = join(import.meta.dir, "../scripts/lib");

const baseEnv = Object.fromEntries(
  Object.entries(gitIdentityEnv()).filter(([k]) => !k.startsWith("DRIVE_PR_")),
);

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: baseEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, `git ${args.join(" ")}`);
}

/** A fresh repository with one commit. */
function repo(name: string): string {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, "init", "-q");
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

/** Run `body` (module source after the imports) in `cwd` under its own state root; what it prints, parsed. */
function run(cwd: string, body: string): unknown {
  const script = `
const { treeDrivers } = await import(${JSON.stringify(join(lib, "state/tree-drivers.ts"))});
const { openStore, worktreeLockName } = await import(${JSON.stringify(join(lib, "state/store.ts"))});
const { resolveActor } = await import(${JSON.stringify(join(lib, "state/actor.ts"))});
const { acquire, release } = await import(${JSON.stringify(join(lib, "driver/locks.ts"))});
const { writeTreeLease } = await import(${JSON.stringify(join(lib, "state/lease-records.ts"))});
const { treeLeaseRef } = await import(${JSON.stringify(join(lib, "state/lease-model.ts"))});
const { lockIdentity } = await import(${JSON.stringify(join(lib, "../../../../shared/liveness.ts"))});
const tree = { path: process.cwd(), commonDir: ${JSON.stringify(join(cwd, ".git"))} };
const out = [];
${body}
console.log(JSON.stringify(out));
`;
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    cwd,
    env: {
      ...baseEnv,
      DRIVE_PR_STATE_DIR: join(cwd, "..", `${cwd.split("/").pop()}-state`),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0, "the tree-drivers probe");
  return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "null");
}

describe("treeDrivers", () => {
  test("a clone no drive ran in has no driver", () => {
    expect(run(repo("fresh"), "out.push(treeDrivers(tree));")).toEqual([[]]);
  });

  test("names a live driver holding the tree's lock, and none once it is released", () => {
    const [none, held, released] = run(
      repo("driven"),
      `const s = await openStore("7");
out.push(treeDrivers(tree));
const lock = { stateDir: s.stateDir, name: await worktreeLockName(), what: "worktree" };
acquire(lock, "7");
out.push(treeDrivers(tree));
release(lock);
out.push(treeDrivers(tree));`,
    ) as string[][];
    expect(none).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held?.[0]).toMatch(/^a live driver holds it \(pid \d+ on /);
    expect(released).toEqual([]);
  });

  test("names a live session lease of the tree", () => {
    const [leased] = run(
      repo("leased"),
      `const s = await openStore("7");
const now = new Date().toISOString();
const later = new Date(Date.now() + 3_600_000).toISOString();
const actor = await resolveActor();
writeTreeLease(treeLeaseRef(s.stateDir, actor), {
  ...lockIdentity(), holder: "session", platform: process.platform, actor,
  worktree: process.cwd(), startedAt: now, lastSeen: now, expiresAt: later,
  command: "probe", generation: 1, sessionStarted: "", pr: "7", revision: "r1",
});
out.push(treeDrivers(tree));`,
    ) as string[][];
    expect(leased).toHaveLength(1);
    expect(leased?.[0]).toMatch(
      /^a live lease of session pid \d+ on .+ holds it$/,
    );
  });

  test("cannot tell for a clone whose state directory has no database", () => {
    const cwd = repo("unread");
    const [answer] = run(
      cwd,
      `const s = await openStore("7");
const { rmSync } = await import("node:fs");
const { dbPathFor } = await import(${JSON.stringify(join(lib, "state/db.ts"))});
rmSync(dbPathFor(s.stateDir), { force: true });
out.push(treeDrivers(tree));`,
    ) as { unreadable: string }[];
    expect(answer?.unreadable).toMatch(
      /^the clone's drive state directory .+ has no database .+state\.sqlite beside it$/,
    );
  });

  test("cannot tell for a clone with a drive identity and no state at this root", () => {
    const cwd = repo("elsewhere");
    const [answer] = run(
      cwd,
      `const s = await openStore("7");
const { rmSync } = await import("node:fs");
const { dbPathFor } = await import(${JSON.stringify(join(lib, "state/db.ts"))});
rmSync(dbPathFor(s.stateDir), { force: true });
rmSync(s.stateDir, { recursive: true, force: true });
out.push(treeDrivers(tree));`,
    ) as { unreadable: string }[];
    expect(answer?.unreadable).toMatch(
      /^the clone has a drive identity but no drive state under /,
    );
  });
});

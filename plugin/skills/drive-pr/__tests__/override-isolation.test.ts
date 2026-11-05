import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { readState } from "./state-rows.ts";

const root = mkdtempSync(join(tmpdir(), "override-isolation-"));
const store = join(import.meta.dir, "../scripts/lib/state/store.ts");
const env = { ...gitIdentityEnv(), DRIVE_PR_STATE_DIR: join(root, "shared") };
afterAll(() => rmSync(root, { recursive: true, force: true }));
function repo(name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  expectSpawnExit(
    Bun.spawnSync(["git", "init", "-q", dir], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    }),
    0,
  );
  return dir;
}
function probe(cwd: string, code: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `const {openStore, resolveStateDir, worktreeLockName} = await import(process.argv[1]); const {runMain} = await import(process.argv[2]); await runMain("probe", async () => { ${code}; return 0; });`,
      store,
      join(import.meta.dir, "../scripts/lib/cli.ts"),
    ],
    { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" },
  );
}

test("same-numbered PR stores and locks are isolated across repositories", () => {
  const a = repo("a");
  const b = repo("b");
  const code = `const s = await openStore("161"); await s.locked(async () => { const {state} = s.read(); state.rounds++; s.write(state); }); console.log(JSON.stringify({dir:s.stateDir, tree:await worktreeLockName(), rounds:s.read().state.rounds}));`;
  const first = probe(a, code);
  const second = probe(b, code);
  expectSpawnExit(first, 0);
  expectSpawnExit(second, 0);
  const x = JSON.parse(first.stdout.toString());
  const y = JSON.parse(second.stdout.toString());
  expect(x.dir).not.toBe(y.dir);
  expect(x.tree).not.toBe(y.tree);
  expect(x.rounds).toBe(1);
  expect(y.rounds).toBe(1);
  expect(readState(x.dir, "161")?.rounds).toBe(1);
  expect(readState(y.dir, "161")?.rounds).toBe(1);
});

test("an existing unbound flat foreign state is refused without alteration", () => {
  const cwd = repo("legacy");
  const flat = join(env.DRIVE_PR_STATE_DIR, "drive-pr-161.json");
  mkdirSync(env.DRIVE_PR_STATE_DIR, { recursive: true });
  const bytes = JSON.stringify({
    ...freshState(161),
    repo: "example/foreign",
    rounds: 8,
  });
  writeFileSync(flat, bytes);
  const result = probe(cwd, '(await openStore("161")).read();');
  expectSpawnExit(result, 2);
  expect(result.stderr.toString()).toContain(flat);
  expect(result.stderr.toString()).toContain("unscoped");
  expect(readFileSync(flat, "utf8")).toBe(bytes);
});

test("the inherited mutation fence accepts its driver's database and refuses another", () => {
  const cwd = repo("fence");
  const setup = probe(cwd, 'console.log((await openStore("161")).stateDir);', {
    DRIVE_PR_STATE_DIR: join(root, "fence-state"),
  });
  expectSpawnExit(setup, 0);
  const dir = setup.stdout.toString().trim();
  const extra = {
    DRIVE_PR_STATE_DIR: dir,
    DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(dir),
    FENCE_MODULE: join(
      import.meta.dir,
      "../scripts/lib/state/lease-context.ts",
    ),
  };
  const code =
    'const {resolveFenceContext} = await import(process.env.FENCE_MODULE); await resolveFenceContext("guard-probe");';
  expectSpawnExit(probe(cwd, code, extra), 0);
  const wrong = probe(cwd, code, {
    ...extra,
    DRIVE_PR_STATE_DIR_IDENTITY: "00000000-0000-4000-8000-000000000000",
  });
  expectSpawnExit(wrong, 1);
  expect(wrong.stderr.toString()).toContain("is not the one this drive opened");
  const absent = probe(cwd, code, {
    ...extra,
    DRIVE_PR_STATE_DIR_IDENTITY: "",
  });
  expectSpawnExit(absent, 1);
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(join(dirname(dir), `state.sqlite${suffix}`), { force: true });
  const replaced = probe(cwd, code, extra);
  expectSpawnExit(replaced, 1);
  expect(replaced.stderr.toString()).toContain(
    "is not the one this drive opened",
  );
});

test("a wandering pass keeps the clone pinned by its driver", () => {
  const a = repo("anchored");
  const b = repo("wandering");
  const rootOverride = join(root, "anchored-state");
  const setup = probe(
    a,
    `const s=await openStore("161"); s.write({...s.read().state,rounds:3}); console.log(s.stateDir);`,
    { DRIVE_PR_STATE_DIR: rootOverride },
  );
  expectSpawnExit(setup, 0);
  const dir = setup.stdout.toString().trim();
  for (const override of [rootOverride, dir]) {
    const read = probe(
      b,
      `const s=await openStore("161"); console.log(JSON.stringify({dir:s.stateDir,rounds:s.read().state.rounds}));`,
      { DRIVE_PR_STATE_DIR: override, DRIVE_PR_WORKTREE: a },
    );
    expectSpawnExit(read, 0);
    expect(JSON.parse(read.stdout.toString())).toEqual({ dir, rounds: 3 });
  }
});

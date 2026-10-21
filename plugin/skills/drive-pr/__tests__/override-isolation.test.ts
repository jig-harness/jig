import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import {
  sameDirIdentity,
  statDirIdentity,
  parseDirIdentityToken,
  captureStateDirIdentityToken,
} from "../scripts/lib/state/lease-files.ts";

const VOLUME = "11111111-2222-3333-4444-555555555555";
const OTHER_VOLUME = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
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
      `const {openStore, resolveStateDir, worktreeLockName} = await import(${JSON.stringify(store)}); const {runMain} = await import(${JSON.stringify(join(import.meta.dir, "../scripts/lib/cli.ts"))}); await runMain("probe", async () => { ${code}; return 0; });`,
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
  expect(
    JSON.parse(readFileSync(join(x.dir, "drive-pr-161.json"), "utf8")).rounds,
  ).toBe(1);
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

test("device drift needs matching inode, birth time, canonical path and volume UUID", async () => {
  const dir = join(root, "identity");
  mkdirSync(dir);
  const original = statDirIdentity(dir);
  if (original === null) throw new Error("cannot stat identity fixture");
  const token = parseDirIdentityToken(
    await captureStateDirIdentityToken(dir, async () => VOLUME),
  );
  expect(token.kind).toBe("ok");
  if (token.kind !== "ok") throw new Error("identity transport failed");
  const drift = { ...original, dev: original.dev + 1n, volumeUUID: VOLUME };
  expect(
    sameDirIdentity(token.id, { ...drift, volumeUUID: OTHER_VOLUME }),
  ).toBe(false);
  expect(
    sameDirIdentity(token.id, { ...original, dev: original.dev + 1n }),
  ).toBe(false);
  expect(sameDirIdentity(token.id, drift)).toBe(true);
  expect(sameDirIdentity(token.id, { ...original, birthtimeNs: 0n })).toBe(
    true,
  );
  expect(
    sameDirIdentity(
      { ...token.id, volumeUUID: "" },
      { ...drift, volumeUUID: "" },
    ),
  ).toBe(false);
  expect(sameDirIdentity(token.id, { ...drift, ino: original.ino + 1n })).toBe(
    false,
  );
  expect(sameDirIdentity(token.id, { ...drift, birthtimeNs: 0n })).toBe(false);
  expect(
    sameDirIdentity(token.id, { ...drift, pathHash: "0".repeat(64) }),
  ).toBe(false);
  expect(sameDirIdentity({ dev: original.dev, ino: original.ino }, drift)).toBe(
    false,
  );
  renameSync(dir, `${dir}-old`);
  mkdirSync(dir);
  expect(sameDirIdentity(token.id, statDirIdentity(dir))).toBe(false);
});

test("the inherited mutation fence accepts proven device drift and refuses replacement", async () => {
  const cwd = repo("fence");
  const setup = probe(cwd, 'console.log((await openStore("161")).stateDir);', {
    DRIVE_PR_STATE_DIR: join(root, "fence-state"),
  });
  expectSpawnExit(setup, 0);
  const dir = setup.stdout.toString().trim();
  const token = await captureStateDirIdentityToken(dir, async () => VOLUME);
  const parts = token.split(":");
  const device = parts[0];
  if (device === undefined) throw new Error("missing device field");
  parts[0] = String(BigInt(device) + 1n);
  const extra = {
    DRIVE_PR_STATE_DIR: dir,
    DRIVE_PR_STATE_DIR_IDENTITY: parts.join(":"),
  };
  const code = `const {resolveFenceContext} = await import(${JSON.stringify(join(import.meta.dir, "../scripts/lib/state/lease-context.ts"))}); await resolveFenceContext("guard-probe", async()=>${JSON.stringify(VOLUME)});`;
  expectSpawnExit(probe(cwd, code.replace(VOLUME, OTHER_VOLUME), extra), 1);
  expectSpawnExit(
    probe(
      cwd,
      code.replace(`async()=>${JSON.stringify(VOLUME)}`, "async()=>null"),
      extra,
    ),
    1,
  );
  expectSpawnExit(probe(cwd, code, extra), 0);
  const racingCode = code.replace(
    `async()=>${JSON.stringify(VOLUME)}`,
    `async()=>{ const fs=await import("node:fs"); fs.renameSync(${JSON.stringify(dir)},${JSON.stringify(`${dir}-during-probe`)}); fs.mkdirSync(${JSON.stringify(dir)}); return ${JSON.stringify(VOLUME)}; }`,
  );
  const raced = probe(cwd, racingCode, extra);
  expectSpawnExit(raced, 1);
  expect(raced.stderr.toString()).toContain(
    "replaced while checking the volume identity",
  );
  renameSync(dir, `${dir}-old`);
  mkdirSync(dir);
  const replaced = probe(cwd, code, extra);
  expectSpawnExit(replaced, 1);
  expect(replaced.stderr.toString()).toContain(
    "not the one this drive resolved",
  );
});

test("arming refuses a replacement during the volume lookup", async () => {
  const dir = join(root, "arm-swap");
  mkdirSync(dir);
  const token = await captureStateDirIdentityToken(dir, async () => {
    renameSync(dir, `${dir}-old`);
    mkdirSync(dir);
    return VOLUME;
  });
  expect(token).toBe("");
});

test("a wandering pass keeps the clone pinned by its driver", () => {
  const a = repo("anchored");
  const b = repo("wandering");
  const rootOverride = join(root, "anchored-state");
  const setup = probe(
    a,
    `const s=await openStore("161"); s.write({...s.read().state,rounds:3}); console.log(s.file);`,
    { DRIVE_PR_STATE_DIR: rootOverride },
  );
  expectSpawnExit(setup, 0);
  const file = setup.stdout.toString().trim();
  for (const override of [rootOverride, join(file, "..")]) {
    const read = probe(
      b,
      `const s=await openStore("161"); console.log(JSON.stringify({file:s.file,rounds:s.read().state.rounds}));`,
      { DRIVE_PR_STATE_DIR: override, DRIVE_PR_WORKTREE: a },
    );
    expectSpawnExit(read, 0);
    expect(JSON.parse(read.stdout.toString())).toEqual({ file, rounds: 3 });
  }
});

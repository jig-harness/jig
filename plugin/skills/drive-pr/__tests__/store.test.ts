/**
 * store.test.ts — `resolveStateDir`'s default: a path outside the repository
 * tree, keyed per clone, and the root refused when it holds a drive's files
 * directly.
 *
 * Verified through a real subprocess and a real git repository, the same way
 * `actor.test.ts` verifies `worktreeRoot` — the function under test IS the
 * `git rev-parse --git-common-dir` call plus the filesystem side effects that
 * follow it, so a stub of either would not be testing this function. `$HOME`
 * is always faked to a scratch directory: this suite must never read or
 * write the real `~/.local/state/jig`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * `process.env` minus every `GIT_*` pointer — a git hook exports `GIT_DIR`/
 * `GIT_WORK_TREE` into its children, and a scratch repo created under that
 * inheritance would operate on the REAL repository instead (see
 * `actor.test.ts`'s identical rule, and `drive-pr.test.ts`'s original copy of
 * it). `DRIVE_PR_STATE_DIR` is stripped too — several tests assert the
 * NO-override default path, and an inherited value from a live `drive.ts`
 * pass this suite happens to be running under would silently short-circuit
 * every one of them.
 */
function gitCleanEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "DRIVE_PR_STATE_DIR" || v === undefined)
      continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
    // Windows' home directory is USERPROFILE, not HOME.
    if (k === "HOME") {
      if (v === undefined) delete env.USERPROFILE;
      else env.USERPROFILE = v;
    }
  }
  return env;
}

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `store-test-${name}-`));
  const env = gitCleanEnv();
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "store-probe@example.invalid");
  git("config", "user.name", "drive-pr store probe");
  writeFileSync(join(dir, "f.txt"), `${name}\n`);
  git("add", "-A");
  git("commit", "-qm", `${name} init`, "--no-verify");
  return dir;
}

const STORE_MODULE = join(
  import.meta.dir,
  "..",
  "scripts",
  "lib",
  "state",
  "store.ts",
);
const probeDir = mkdtempSync(join(tmpdir(), "store-test-probe-"));
const probeScript = join(probeDir, "probe.ts");
writeFileSync(
  probeScript,
  [
    `import { resolveStateDir } from ${JSON.stringify(STORE_MODULE)};`,
    "try {",
    // String concatenation, not a template literal, in the GENERATED source:
    // a plain string containing a literal `${...}` trips biome's
    // noTemplateCurlyInString (it usually means a forgotten backtick), and
    // this one really is a plain string being written into another file.
    '  console.log("OK:" + (await resolveStateDir()));',
    "} catch (e) {",
    "  const code = e && typeof e === 'object' && 'code' in e ? e.code : 1;",
    '  console.log("ERR:" + code);',
    "  process.exitCode = Number(code) || 1;",
    "}",
    "",
  ].join("\n"),
);

function probeResolveStateDir(
  cwd: string,
  extraEnv: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", probeScript], {
    cwd,
    env: gitCleanEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString(),
  };
}

const peekProbeScript = join(probeDir, "peek-probe.ts");
writeFileSync(
  peekProbeScript,
  [
    `import { peekResolvedStateDir } from ${JSON.stringify(STORE_MODULE)};`,
    "try {",
    '  console.log("PEEK:" + (await peekResolvedStateDir()));',
    "} catch (e) {",
    "  const code = e && typeof e === 'object' && 'code' in e ? e.code : 1;",
    '  console.log("ERR:" + code);',
    "  process.exitCode = Number(code) || 1;",
    "}",
    "",
  ].join("\n"),
);

function probePeekStateDir(
  cwd: string,
  extraEnv: Record<string, string | undefined> = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", peekProbeScript], {
    cwd,
    env: gitCleanEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString().trim(),
    stderr: r.stderr.toString(),
  };
}

describe("resolveStateDir", () => {
  const repoA = makeRepo("a");
  const repoB = makeRepo("b");
  const homeA = mkdtempSync(join(tmpdir(), "store-test-home-a-"));
  const homeB = mkdtempSync(join(tmpdir(), "store-test-home-b-"));

  afterAll(() => {
    for (const dir of [repoA, repoB, homeA, homeB]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to a path under $HOME/.local/state/jig/drive-pr, outside the repo tree", () => {
    const r = probeResolveStateDir(repoA, { HOME: homeA });
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith(
      `OK:${join(homeA, ".local", "state", "jig", "drive-pr")}`,
    );
    expect(r.stdout).not.toContain(repoA);
  });

  it("is stable across repeated calls for the same clone", () => {
    const r1 = probeResolveStateDir(repoA, { HOME: homeA });
    const r2 = probeResolveStateDir(repoA, { HOME: homeA });
    expect(r1.stdout).toBe(r2.stdout);
  });

  it("differs between two distinct clones under the same $HOME", () => {
    const rA = probeResolveStateDir(repoA, { HOME: homeA });
    const rB = probeResolveStateDir(repoB, { HOME: homeA });
    expect(rA.stdout).not.toBe(rB.stdout);
  });

  it("preserves the clone key under an override", () => {
    const override = mkdtempSync(join(tmpdir(), "store-test-override-"));
    const homeOverride = mkdtempSync(
      join(tmpdir(), "store-test-home-override-"),
    );
    try {
      const r = probeResolveStateDir(repoA, {
        HOME: homeOverride,
        DRIVE_PR_STATE_DIR: override,
      });
      expect(r.code).toBe(0);
      expect(dirname(r.stdout.slice(3))).toBe(override);
      const plain = probeResolveStateDir(repoA, { HOME: homeA });
      expect(basename(r.stdout)).toBe(basename(plain.stdout));
    } finally {
      rmSync(override, { recursive: true, force: true });
      rmSync(homeOverride, { recursive: true, force: true });
    }
  });

  it("refuses (exit 2) an override root that holds a drive's files directly", () => {
    const override = mkdtempSync(join(tmpdir(), "store-test-flat-"));
    const homeFlat = mkdtempSync(join(tmpdir(), "store-test-home-flat-"));
    try {
      writeFileSync(join(override, "drive-pr-4172.json"), "{}");
      const r = probeResolveStateDir(repoA, {
        HOME: homeFlat,
        DRIVE_PR_STATE_DIR: override,
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("ERR:2");
      expect(r.stderr).toContain("drive-pr-4172.json");
    } finally {
      rmSync(override, { recursive: true, force: true });
      rmSync(homeFlat, { recursive: true, force: true });
    }
  });

  it("ignores state an older layout left in the Git common directory", () => {
    const repoC = makeRepo("legacy-dirty");
    const homeC = mkdtempSync(join(tmpdir(), "store-test-home-c-"));
    try {
      writeFileSync(join(repoC, ".git", "drive-pr-4172.json"), "{}");
      const r = probeResolveStateDir(repoC, { HOME: homeC });
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith(
        `OK:${join(homeC, ".local", "state", "jig", "drive-pr")}`,
      );
    } finally {
      rmSync(repoC, { recursive: true, force: true });
      rmSync(homeC, { recursive: true, force: true });
    }
  });
});

describe("peekResolvedStateDir", () => {
  it("answers null, with NO side effects, when no clone identity has ever been minted", () => {
    // `reap-state.ts`'s dry-run mode and the `drives.ts` listing must be able
    // to ask "where does state live" without minting a clone identity or
    // creating anything: a clone with no identity has no state.
    const repoF = makeRepo("peek-fresh");
    const homeF = mkdtempSync(join(tmpdir(), "store-test-home-f-"));
    try {
      const r = probePeekStateDir(repoF, { HOME: homeF });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("PEEK:null");
      expect(existsSync(join(homeF, ".local"))).toBe(false);
      expect(existsSync(join(repoF, ".git", "drive-pr-clone-id"))).toBe(false);
    } finally {
      rmSync(repoF, { recursive: true, force: true });
      rmSync(homeF, { recursive: true, force: true });
    }
  });

  it("resolves the cwd checkout, not the one a leaked GIT_DIR names, when defaulting the state dir", () => {
    // A hook-launched driver inherits GIT_DIR for ANOTHER checkout, and it
    // outranks the cwd — unscrubbed, the default state dir (and every lock
    // under it) keyed to that checkout.
    const repoOwn = makeRepo("peek-own");
    const repoOther = makeRepo("peek-other");
    const homeH = mkdtempSync(join(tmpdir(), "store-test-home-h-"));
    try {
      const own = probeResolveStateDir(repoOwn, { HOME: homeH });
      probeResolveStateDir(repoOther, { HOME: homeH });
      const r = probePeekStateDir(repoOwn, {
        HOME: homeH,
        GIT_DIR: join(repoOther, ".git"),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`PEEK:${own.stdout.slice("OK:".length)}`);
    } finally {
      rmSync(repoOwn, { recursive: true, force: true });
      rmSync(repoOther, { recursive: true, force: true });
      rmSync(homeH, { recursive: true, force: true });
    }
  });

  it("agrees with resolveStateDir() once a real resolution has minted this clone’s identity", () => {
    const repoG = makeRepo("peek-migrated");
    const homeG = mkdtempSync(join(tmpdir(), "store-test-home-g-"));
    try {
      const real = probeResolveStateDir(repoG, { HOME: homeG });
      expect(real.code).toBe(0);
      const peek = probePeekStateDir(repoG, { HOME: homeG });
      expect(peek.code).toBe(0);
      expect(peek.stdout).toBe(`PEEK:${real.stdout.slice("OK:".length)}`);
    } finally {
      rmSync(repoG, { recursive: true, force: true });
      rmSync(homeG, { recursive: true, force: true });
    }
  });
});

// `probeDir` is a MODULE-level fixture shared by both describe blocks above,
// so its cleanup belongs at module level too: a per-describe `afterAll` is
// only safe for a fixture that describe block alone owns.
afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

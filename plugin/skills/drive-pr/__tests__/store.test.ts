/**
 * store.test.ts — `resolveStateDir`'s an earlier change default: a path outside the
 * repository tree, keyed per clone, gated by the legacy-migration guard.
 *
 * Verified through a real subprocess and a real git repository, the same way
 * `actor.test.ts` verifies `worktreeRoot` — the function under test IS the
 * `git rev-parse --git-common-dir` call plus the filesystem side effects that
 * follow it, so a stub of either would not be testing this function. `$HOME`
 * is always faked to a scratch directory: this suite must never read or
 * write the real `~/.local/state/groundwork`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    `import { peekStateDir, resolveLegacyStateDir } from ${JSON.stringify(STORE_MODULE)};`,
    "try {",
    "  const legacyDir = await resolveLegacyStateDir();",
    '  console.log("PEEK:" + peekStateDir(legacyDir));',
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

  it("defaults to a path under $HOME/.local/state/groundwork/drive-pr, outside the repo tree", () => {
    const r = probeResolveStateDir(repoA, { HOME: homeA });
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith(
      `OK:${join(homeA, ".local", "state", "groundwork", "drive-pr")}`,
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

  it("honours $DRIVE_PR_STATE_DIR verbatim and never runs the legacy guard", () => {
    const override = mkdtempSync(join(tmpdir(), "store-test-override-"));
    // A fresh $HOME, never `homeA`: the tests above already ran a clean
    // `probeResolveStateDir(repoA, { HOME: homeA })` call, which writes
    // `.migrated-from-legacy` for repoA under homeA. If `resolveStateDir`
    // ran `ensureMigratedFromLegacy` BEFORE checking `DRIVE_PR_STATE_DIR`,
    // that marker would make the legacy guard return early on its own —
    // this test would still pass, proving nothing about the override
    // actually short-circuiting it.
    const homeOverride = mkdtempSync(
      join(tmpdir(), "store-test-home-override-"),
    );
    try {
      // Plant an unmigrated legacy footprint in the repo's real git dir —
      // if the override did not short-circuit the guard, this would refuse.
      writeFileSync(join(repoA, ".git", "drive-pr-4172.json"), "{}");
      const r = probeResolveStateDir(repoA, {
        HOME: homeOverride,
        DRIVE_PR_STATE_DIR: override,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`OK:${override}`);
    } finally {
      rmSync(join(repoA, ".git", "drive-pr-4172.json"), { force: true });
      rmSync(override, { recursive: true, force: true });
      rmSync(homeOverride, { recursive: true, force: true });
    }
  });

  it("refuses (exit 2) when the legacy git-common-dir holds an unmigrated footprint", () => {
    const repoC = makeRepo("legacy-dirty");
    const homeC = mkdtempSync(join(tmpdir(), "store-test-home-c-"));
    try {
      writeFileSync(join(repoC, ".git", "drive-pr-4172.json"), "{}");
      const r = probeResolveStateDir(repoC, { HOME: homeC });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("ERR:2");
      expect(r.stderr).toContain("drive-pr-4172.json");
      expect(r.stderr).toContain("migrate-legacy-state.ts");
    } finally {
      rmSync(repoC, { recursive: true, force: true });
      rmSync(homeC, { recursive: true, force: true });
    }
  });

  it("proceeds when the legacy git-common-dir has nothing but ordinary git contents", () => {
    const repoD = makeRepo("legacy-clean");
    const homeD = mkdtempSync(join(tmpdir(), "store-test-home-d-"));
    try {
      const r = probeResolveStateDir(repoD, { HOME: homeD });
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith(
        `OK:${join(homeD, ".local", "state", "groundwork", "drive-pr")}`,
      );
    } finally {
      rmSync(repoD, { recursive: true, force: true });
      rmSync(homeD, { recursive: true, force: true });
    }
  });

  it("does not refuse on a second call once this clone has migrated", () => {
    const repoE = makeRepo("migrate-once");
    const homeE = mkdtempSync(join(tmpdir(), "store-test-home-e-"));
    try {
      // First call with a clean legacy dir writes the per-clone marker.
      const r1 = probeResolveStateDir(repoE, { HOME: homeE });
      expect(r1.code).toBe(0);
      // A legacy write appears afterwards (e.g. a lingering old-code
      // process) — the marker-gated guard does not catch this window (see
      // legacy-state.ts's own doc comment on the residual it accepts), so
      // the second call must still succeed rather than crash.
      writeFileSync(join(repoE, ".git", "drive-pr-4172.json"), "{}");
      const r2 = probeResolveStateDir(repoE, { HOME: homeE });
      expect(r2.code).toBe(0);
      expect(r2.stdout).toBe(r1.stdout);
    } finally {
      rmSync(repoE, { recursive: true, force: true });
      rmSync(homeE, { recursive: true, force: true });
    }
  });
});

describe("peekStateDir", () => {
  it("returns legacyDir, with NO side effects, when no clone identity has ever been minted", () => {
    // `reap-state.ts`'s dry-run mode must be able to ask "where does state
    // live" without itself minting a clone identity, creating the new
    // directory, or writing the migration marker — exactly the three side
    // effects the ordinary `resolveStateDir()` has on a fresh clone.
    const repoF = makeRepo("peek-fresh");
    const homeF = mkdtempSync(join(tmpdir(), "store-test-home-f-"));
    try {
      const r = probePeekStateDir(repoF, { HOME: homeF });
      expect(r.code).toBe(0);
      // `resolveLegacyStateDir()` resolves through `git rev-parse`, which
      // canonicalises the path (e.g. macOS's /var -> /private/var symlink);
      // `repoF` itself is not, so compare against the resolved form.
      expect(r.stdout).toBe(`PEEK:${join(realpathSync(repoF), ".git")}`);
      expect(existsSync(join(homeF, ".local"))).toBe(false);
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
      const r = probePeekStateDir(repoOwn, {
        HOME: homeH,
        GIT_DIR: join(repoOther, ".git"),
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`PEEK:${join(realpathSync(repoOwn), ".git")}`);
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

// `probeDir` is a MODULE-level fixture (created once above, outside any
// describe block) shared by both describe blocks above — its cleanup
// belongs at module level too. It used to live inside `resolveStateDir`'s
// own `afterAll`, which deleted it as soon as that describe block's tests
// finished — before `peekStateDir`'s tests, declared later in this file,
// ever ran (confirmed empirically: "Module not found ... probe.ts"). A
// per-describe `afterAll` is only safe for a fixture that describe block
// alone owns.
afterAll(() => {
  rmSync(probeDir, { recursive: true, force: true });
});

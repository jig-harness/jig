import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
// Every scratch directory is removed after the file's tests, failed ones too.
const scratchDirs: string[] = [];
export function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

export const gate = join(import.meta.dir, "ratchet.ts");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()) &&
      key !== "CI" &&
      key !== "RATCHET_BASE",
  ),
);

export function sh(cwd: string, cmd: string, args: string[], extra = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

export const todoCounter = {
  name: "todo",
  format: "grep",
  files: "\\.ts$",
  patterns: { todo: "TODO" },
};
export const biomeCounter = {
  name: "biome",
  format: "biome-json",
  command: ["biome", "lint", "--reporter=json", "--max-diagnostics=none", "."],
};
export const defaultWiring = {
  counters: [todoCounter],
  configs: [
    { path: "biome.json", kind: "biome" },
    { path: "tsconfig.json", kind: "tsconfig" },
    { path: "tsconfig.ratchet.json", kind: "tsconfig" },
  ],
};
// The scratch repositories have no node_modules; Biome comes from this one.
export const toolPath = `${join(import.meta.dir, "..", "..", "..", "..", "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

/**
 * A scratch repository with `main` at the base and a `work` branch checked
 * out, measured by one grep counter (`TODO` per file) unless `wiring` says
 * otherwise.
 */
export function repo(
  files: Record<string, string>,
  wiring: object = defaultWiring,
): {
  dir: string;
  write: (path: string, text: string) => void;
  commit: (message: string) => void;
  ratchet: (extra?: Record<string, string>) => {
    code: number | null;
    out: string;
  };
} {
  const dir = scratch("ratchet-test-");
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const git = (...args: string[]) => {
    const r = sh(dir, "git", args);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.out, stderr: "" },
      0,
      `git ${args.join(" ")}`,
    );
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ratchet@example.com");
  git("config", "user.name", "ratchet");
  git("config", "commit.gpgsign", "false");
  write("ratchet.json", JSON.stringify(wiring));
  for (const [path, text] of Object.entries(files)) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "work");
  return {
    dir,
    write,
    commit: (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    ratchet: (extra = {}) =>
      sh(
        dir,
        process.execPath,
        [gate, "--config", "ratchet.json", "--base", "main"],
        { PATH: toolPath, ...extra },
      ),
  };
}

/**
 * Commit a trailer for every name the failure in `out` asks for, and expect
 * the gate to pass then: each refusal names the waiver that accepts it.
 */
export function expectApproved(r: ReturnType<typeof repo>, out: string): void {
  const names = new Set(
    [...out.matchAll(/"Ratchet-Loosen: (\S+): <reason>"/g)].map((m) => m[1]),
  );
  expect(names.size).toBeGreaterThan(0);
  const body = [...names].map((n) => `Ratchet-Loosen: ${n}: asked for`);
  const message = `approve\n\n${body.join("\n")}`;
  const c = sh(r.dir, "git", ["commit", "-q", "--allow-empty", "-m", message]);
  expect(c.code).toBe(0);
  const again = r.ratchet();
  expect(again.out).toContain("LOOSENED with a Ratchet-Loosen trailer");
  expect(again.code).toBe(0);
}

export const biome = (level: string) =>
  JSON.stringify({
    linter: {
      rules: { preset: "recommended", suspicious: { noDebugger: level } },
    },
  });
export const tsconfig = (flags: Record<string, boolean>) =>
  JSON.stringify({ compilerOptions: { strict: true, ...flags } });

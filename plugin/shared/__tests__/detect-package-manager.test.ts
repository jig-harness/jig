/**
 * The detector's package manager: which lockfile names it, the one
 * `package.json` declares when several are present, and the install and
 * relock commands each manager takes. Each case builds a scratch directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPackageManager } from "../detect.ts";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "detect-package-manager-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function touch(...files: string[]) {
  for (const file of files) writeFileSync(join(repo, file), "");
}

describe("detectPackageManager", () => {
  const cases: [string, string, string, string][] = [
    ["bun.lock", "bun", "bun install --frozen-lockfile", "bun install"],
    ["bun.lockb", "bun", "bun install --frozen-lockfile", "bun install"],
    [
      "pnpm-lock.yaml",
      "pnpm",
      "pnpm install --frozen-lockfile",
      "pnpm install",
    ],
    ["yarn.lock", "yarn", "yarn install --frozen-lockfile", "yarn install"],
    ["package-lock.json", "npm", "npm ci", "npm install"],
    ["npm-shrinkwrap.json", "npm", "npm ci", "npm install"],
  ];
  for (const [lockfile, name, install, relock] of cases)
    it(`${lockfile} means ${name}`, () => {
      touch(lockfile);
      expect(detectPackageManager(repo)).toEqual({
        found: { lockfile, name, install, relock },
        others: [],
      });
    });

  it("prefers the lockfile of the manager package.json declares", () => {
    touch("bun.lock", "pnpm-lock.yaml");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.30.1" }),
    );
    expect(detectPackageManager(repo)).toMatchObject({
      found: { lockfile: "pnpm-lock.yaml", name: "pnpm" },
      others: ["bun.lock"],
    });
  });

  it("modern Yarn (with .yarnrc.yml) uses --immutable", () => {
    touch("yarn.lock", ".yarnrc.yml");
    expect(detectPackageManager(repo).found?.install).toBe(
      "yarn install --immutable",
    );
  });

  it("several lockfiles: the first wins and the rest are reported", () => {
    touch("package-lock.json", "pnpm-lock.yaml");
    expect(detectPackageManager(repo)).toMatchObject({
      found: { name: "pnpm" },
      others: ["package-lock.json"],
    });
  });

  it("no lockfile: nothing detected", () => {
    expect(detectPackageManager(repo)).toEqual({ found: null, others: [] });
  });
});

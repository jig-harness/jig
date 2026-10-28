/**
 * drive-repository.test.ts — the repository label a drive listing prints is
 * `owner/name` or nothing: no remote URL form may carry a credential into it.
 */

import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { repositoryLabel } from "../scripts/lib/drive-repository.ts";
import { conflictFixCommands } from "../scripts/lib/driver/settings.ts";

const driveRepositoryModule = new URL(
  "../scripts/lib/drive-repository.ts",
  import.meta.url,
).href;

describe("driveRepository", () => {
  it("falls back to the Git common directory when repository.remote cannot be read", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "drive-repository-")));
    const repo = join(home, "repo");
    try {
      mkdirSync(join(repo, ".config"), { recursive: true });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env))
        if (
          value !== undefined &&
          !key.startsWith("GIT_") &&
          !key.startsWith("JIG_") &&
          !key.startsWith("DRIVE_PR_")
        )
          env[key] = value;
      Object.assign(env, {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        JIG_USER_LAYER: "off",
        DRIVE_PR_STATE_DIR: join(home, "state"),
      });
      expectSpawnExit(
        Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env }),
        0,
      );
      writeFileSync(
        join(repo, ".config", "jig.yaml"),
        'repository:\n  remote: "-upstream"\n',
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const {driveRepository}=await import(${JSON.stringify(driveRepositoryModule)});console.log(await driveRepository());`,
        ],
        { cwd: repo, env },
      );
      expectSpawnExit(result, 0);
      expect(result.stdout.toString().trim()).toBe(join(repo, ".git"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("conflictFixCommands", () => {
  it("leaves a plain remote and base bare", () => {
    expect(conflictFixCommands("main", "upstream")).toContain(
      '-- git fetch upstream; after success, bun "<skill-dir>/../../shared/command.ts" -- git merge upstream/main',
    );
  });

  it("quotes a base name the shell would expand", () => {
    expect(conflictFixCommands("rel$(id)", "upstream")).toContain(
      "-- git merge 'upstream/rel$(id)'",
    );
  });

  it("keeps the unreadable-setting placeholder unquoted", () => {
    expect(conflictFixCommands("main", "<remote>")).toContain(
      "-- git fetch <remote>; after success",
    );
  });
});

describe("repositoryLabel", () => {
  it.each([
    ["https://example.invalid/sample/repo.git", "sample/repo"],
    ["https://user:secret@example.invalid/sample/repo.git", "sample/repo"],
    ["git@example.invalid:sample/repo.git", "sample/repo"],
    ["ssh://git@example.invalid:2222/sample/repo", "sample/repo"],
    [
      "https://example.invalid/sample/repo.git?access_token=secret",
      "sample/repo",
    ],
    ["https://example.invalid/sample/repo.git#secret", "sample/repo"],
    ["https://example.invalid/sample/repo?x=1#secret", "sample/repo"],
  ])("labels %s as %s", (url, label) => {
    expect(repositoryLabel(url)).toBe(label);
  });

  it.each([
    "https://example.invalid/token:secret/repo.git",
    "https://example.invalid/sample/re po.git",
    "https://example.invalid/sample/repo;secret",
    "https://example.invalid/sample/..",
    "repo",
    "",
  ])("refuses %s", (url) => {
    expect(repositoryLabel(url)).toBe("");
  });
});

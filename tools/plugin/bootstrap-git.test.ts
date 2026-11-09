/** Verification must inspect the checkout whose installer will execute. */
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../lib/test-helpers/windows-skip.ts";

test.skipIf(
  skipsOnWindows("powershell", "Bash entry verification uses the Unix shell"),
)(
  "real Git refuses dirty source despite inherited configuration and core.worktree",
  () => {
    const root = mkdtempSync(join(tmpdir(), "jig-bootstrap-git-"));
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("GIT_")) delete env[key];
    const git = (args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: root,
        env,
        timeout: 10_000,
      });
      expectSpawnExit(result, 0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(join(root, "tools/plugin"), { recursive: true });
      mkdirSync(join(root, "bin"));
      copyFileSync(
        join(import.meta.dirname, "bootstrap.sh"),
        join(root, "tools/plugin/bootstrap.sh"),
      );
      writeFileSync(join(root, "tools/plugin/bootstrap.ts"), "// reviewed\n");
      for (const name of ["bun", "gh", "codex"])
        writeFileSync(join(root, "bin", name), "#!/bin/sh\nexit 0\n", {
          mode: 0o755,
        });
      git(["init"]);
      git(["add", "."]);
      git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      const revision = git(["rev-parse", "HEAD"]);
      git(["clone", "--local", root, join(root, "clean")]);
      writeFileSync(join(root, "tools/plugin/bootstrap.ts"), "// modified\n");
      for (const override of [
        "count",
        "parameters",
        "local",
        "assume",
        "skip",
      ]) {
        if (override === "local")
          git(["config", "core.worktree", join(root, "clean")]);
        git([
          "update-index",
          "--no-assume-unchanged",
          "--no-skip-worktree",
          "tools/plugin/bootstrap.ts",
        ]);
        if (override === "assume" || override === "skip") {
          git([
            "update-index",
            override === "assume" ? "--assume-unchanged" : "--skip-worktree",
            "tools/plugin/bootstrap.ts",
          ]);
        }
        const result = Bun.spawnSync(
          [
            "/bin/bash",
            join(root, "tools/plugin/bootstrap.sh"),
            "--revision",
            revision,
            "--codex",
          ],
          {
            cwd: root,
            env: {
              ...env,
              PATH: [join(root, "bin"), process.env.PATH].join(delimiter),
              ...(override === "count"
                ? {
                    GIT_CONFIG_COUNT: "1",
                    GIT_CONFIG_KEY_0: "core.worktree",
                    GIT_CONFIG_VALUE_0: join(root, "clean"),
                  }
                : {}),
              ...(override === "parameters"
                ? {
                    GIT_CONFIG_PARAMETERS: `'core.worktree'='${join(root, "clean")}'`,
                  }
                : {}),
            },
            timeout: 10_000,
          },
        );
        expectSpawnExit(result, 1);
        expect(result.stderr.toString()).toContain(
          override === "assume" || override === "skip"
            ? "Index flags hide possible source changes"
            : "Tracked source has local changes",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

/**
 * drive-pr suite: the driver's export of the base-branch commit its autonomy
 * policy is read from (`lib/driver/policy-base.ts`). Each call runs in a
 * child process with a scrubbed environment, so the export never touches
 * this process's own.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  gitCleanEnv,
  REPO_ROOT,
  SCRIPTS,
  tmpRoot,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";
import { addOrigin, prBaseGh } from "./round-plan-fixtures.ts";

useDrivePrSuite();

const STALE = "f".repeat(40);

/**
 * A clone whose pull request #999 targets `develop`: the base commit holds
 * `base` as its `.config/jig.yaml`, and the working tree holds `head`. With
 * `withBase` false, `origin/develop` is missing from the clone.
 */
function clone(base: string, head: string, withBase = true): string {
  const dir = mkdtempSync(join(tmpRoot, "policy-base-"));
  const env = gitCleanEnv();
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      {
        exitCode: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      },
      0,
      `git ${args.join(" ")}`,
    );
    return r.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "drive-pr probe");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  mkdirSync(join(dir, ".config"));
  writeFileSync(join(dir, ".config", "jig.yaml"), base);
  git("add", "-A");
  git("commit", "-qm", "base", "--no-verify");
  if (withBase)
    git("update-ref", "refs/remotes/origin/develop", git("rev-parse", "HEAD"));
  writeFileSync(join(dir, ".config", "jig.yaml"), head);
  git("commit", "-qam", "head", "--no-verify");
  addOrigin(dir);
  return dir;
}

/**
 * `exportPolicyBase("999")` in `dir`, then the autonomy line a driver pass
 * there reads; the exported variable starts out stale.
 */
async function exportIn(dir: string): Promise<{
  exported: string;
  line: string;
  stderr: string;
}> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const p = await import(process.env.PB_MODULE);
       const notice = p.policyBaseNotice(
         await p.exportPolicyBase("999", process.env.PB_DIR),
       );
       if (notice !== null) process.stderr.write(notice + "\\n");
       const a = await import(process.env.PB_AUTONOMY);
       process.stdout.write(JSON.stringify({
         exported: process.env.DRIVE_PR_POLICY_BASE,
         line: a.describeAutonomy(a.currentAutonomy()),
       }));`,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...gitCleanEnv(),
        PATH: `${prBaseGh()}${delimiter}${process.env.PATH}`,
        PB_MODULE: join(SCRIPTS, "lib", "driver", "policy-base.ts"),
        PB_AUTONOMY: join(SCRIPTS, "..", "..", "..", "shared", "autonomy.ts"),
        PB_DIR: dir,
        JIG_CONSUMER_ROOT: dir,
        JIG_USER_LAYER: "off",
        // The suite points JIG_OVERLAY at its fixture; this probe reads the
        // clone's own working tree.
        JIG_OVERLAY: "",
        DRIVE_PR_TARGET: "999",
        DRIVE_PR_POLICY_BASE: STALE,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectSpawnExit({ exitCode, stdout, stderr }, 0);
  return {
    ...(JSON.parse(stdout) as { exported: string; line: string }),
    stderr,
  };
}

describe("policy-base.ts", () => {
  it("exports the base branch's commit, and the drive reads its ceiling there", async () => {
    const dir = clone(
      "autonomy:\n  max_level: attended\n",
      "autonomy:\n  level: wide\n  max_level: wide\n",
    );
    const { exported, line } = await exportIn(dir);
    expect(exported).toMatch(/^[0-9a-f]{40}$/);
    expect(exported).not.toBe(STALE);
    expect(line).toStartWith("autonomy: attended (wide from ");
    expect(line).toContain(
      `policy from the base branch at ${exported.slice(0, 12)}`,
    );
  });

  it("leaves the variable empty when the base is not in the clone, and the drive fails closed", async () => {
    const dir = clone(
      "autonomy:\n  max_level: wide\n",
      "autonomy:\n  level: wide\n  max_level: wide\n",
      false,
    );
    const { exported, line, stderr } = await exportIn(dir);
    expect(exported).toBe("");
    expect(stderr).toContain("the policy fails closed");
    expect(line).toStartWith("autonomy: attended (");
    expect(line).toContain("parked under human-decision");
  });
});

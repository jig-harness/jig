/**
 * Which side may set a pass's permissions: the host, from its user file or
 * one run's environment, and never a repository's own file, which for a drive
 * is the pull request's own checkout. Each case runs `arm-drive.ts` as a
 * child, with its own Jig home and working tree.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import type { ArmReport } from "../scripts/lib/arm.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "arm-drive.ts");
const BYPASS = "[--permission-mode, bypassPermissions]";
const BYPASS_WORDS = ["--permission-mode", "bypassPermissions"];
const CLAUDE = { CLAUDECODE: "1" };
const CODEX = { CODEX_HOME: "/nonexistent-codex-home" };
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The test's environment, without anything that chooses a harness or a layer. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !/^(GIT_|DRIVE_PR_|ORCA_|CONDUCTOR_|CODEX_|JIG_)/.test(key) &&
      !["CLAUDECODE", "HERDR_ENV", "CLAUDE_CODE_ENTRYPOINT"].includes(key)
    )
      env[key] = value;
  return { ...env, ...extra };
}

/** A git working tree whose `.config/jig.yaml` holds `repository`, and a Jig home whose user file holds `host`. */
function sides(
  host?: string,
  repository?: string,
): Record<"home" | "tree", string> {
  const root = mkdtempSync(join(tmpdir(), "pass-args-host-"));
  roots.push(root);
  const home = join(root, "home");
  const tree = join(root, "tree");
  mkdirSync(home);
  mkdirSync(join(tree, ".config"), { recursive: true });
  if (host !== undefined) writeFileSync(join(home, "jig.yaml"), host);
  if (repository !== undefined)
    writeFileSync(join(tree, ".config", "jig.yaml"), repository);
  const init = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
    cwd: tree,
    env: cleanEnv({}),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(
    { exitCode: init.exitCode, stdout: init.stdout, stderr: init.stderr },
    0,
    "git init",
  );
  return { home, tree };
}

async function arm(
  where: Record<"home" | "tree", string>,
  env: Record<string, string> = CLAUDE,
  flags: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    scriptArgv(SCRIPT, "42", "--mode", "print", ...flags),
    {
      cwd: where.tree,
      env: cleanEnv({ JIG_HOME: where.home, ...env }),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const report = (run: { stdout: string }) => JSON.parse(run.stdout) as ArmReport;
const driveField = (key: string, value: string) =>
  `drive:\n  ${key}: ${value}\n`;

describe("drive.pass_args on each side", () => {
  it("a host that opts in with no repository setting: the pass bypasses", async () => {
    const run = await arm(sides(driveField("pass_args", BYPASS)));
    expectSpawnExit(run, 0);
    expect(report(run)).toMatchObject({
      status: "print",
      passArgs: BYPASS_WORDS,
      passArgsSource: "drive.pass_args",
      permissionMode: "bypassPermissions",
    });
  });

  it.each([
    [
      "no host setting, and a repository that asks for bypass",
      undefined,
      BYPASS,
    ],
    ["a host that opted in, and a repository's empty list", BYPASS, "[]"],
    [
      "a host that opted in, and a repository's own mode",
      BYPASS,
      "[--permission-mode, acceptEdits]",
    ],
    ["no host setting, and a repository's empty list", undefined, "[]"],
    ["a repository's null", BYPASS, "null"],
  ])(
    "%s: the file is refused, naming the field",
    async (_, host, repository) => {
      const run = await arm(
        sides(
          host === undefined ? undefined : driveField("pass_args", host),
          driveField("pass_args", repository),
        ),
      );
      expectSpawnExit(run, 1);
      expect(report(run)).toMatchObject({ status: "failed", passArgs: [] });
      expect(report(run).reason).toContain("drive.pass_args");
      expect(report(run).reason).toContain(".config/jig.yaml");
      expect(report(run).command).not.toContain("--permission-mode");
    },
  );

  it.each([
    ["null", "drive: null\n"],
    ["empty", "drive:\n"],
    ["a list", "drive: []\n"],
    ["a word", "drive: off\n"],
  ])(
    "a repository's drive section that is %s cannot cancel the host's choice",
    async (_, repository) => {
      const run = await arm(sides(driveField("pass_args", BYPASS), repository));
      expectSpawnExit(run, 1);
      expect(report(run).reason).toContain("drive.pass_args");
    },
  );

  it("a file JIG_OVERLAY names is the repository's layer, and is refused the same way", async () => {
    const where = sides(driveField("pass_args", BYPASS));
    const overlay = join(where.home, "elsewhere.yaml");
    writeFileSync(overlay, driveField("pass_args", "[]"));
    const run = await arm(where, { ...CLAUDE, JIG_OVERLAY: overlay });
    expectSpawnExit(run, 1);
    expect(report(run).reason).toContain("drive.pass_args");
    expect(report(run).reason).toContain("elsewhere.yaml");
  });

  it("an environment variable is the host's for one run: it overrides the user file and works without one", async () => {
    const variable = { ...CLAUDE, JIG__DRIVE__PASS_ARGS: BYPASS };
    const alone = await arm(sides(), variable);
    expectSpawnExit(alone, 0);
    expect(report(alone).permissionMode).toBe("bypassPermissions");
    const over = await arm(
      sides(driveField("pass_args", "[--permission-mode, acceptEdits]")),
      variable,
    );
    expectSpawnExit(over, 0);
    expect(report(over).permissionMode).toBe("bypassPermissions");
  });

  it("--pass-args stays a host's choice for one drive, whatever the user file says", async () => {
    const run = await arm(
      sides(driveField("pass_args", "[--permission-mode, acceptEdits]")),
      CLAUDE,
      ["--pass-args", BYPASS_WORDS.join(" ")],
    );
    expectSpawnExit(run, 0);
    expect(report(run)).toMatchObject({
      passArgsSource: "--pass-args",
      permissionMode: "bypassPermissions",
    });
  });

  it("a repository's other drive fields merge with the host's choice", async () => {
    const run = await arm(
      sides(driveField("pass_args", BYPASS), "drive:\n  pass_model: opus\n"),
    );
    expectSpawnExit(run, 0);
    expect(report(run)).toMatchObject({
      model: "opus",
      permissionMode: "bypassPermissions",
    });
  });
});

describe("drive.pass_args left without an option's value", () => {
  it("stops an arm naming the field, from the field and from --pass-args, and keeps a list that gives the value", async () => {
    const field = await arm(
      sides(driveField("pass_args", "[--permission-mode]")),
    );
    expectSpawnExit(field, 1);
    expect(report(field).reason).toContain("drive.pass_args");
    expect(report(field).reason).toContain("--permission-mode");

    const flag = await arm(sides(), CLAUDE, [
      "--pass-args",
      "--permission-mode",
    ]);
    expectSpawnExit(flag, 2);
    expect(report(flag).reason).toContain("drive.pass_args");

    const given = await arm(
      sides(driveField("pass_args", "[--permission-mode, default]")),
    );
    expectSpawnExit(given, 0);
    expect(report(given).permissionMode).toBe("default");
  });
});

describe("drive.codex_bypass on each side", () => {
  const passOf = (argv: string[]) => argv.slice(argv.indexOf("--") + 1);

  it("a host without it arms Codex with no bypass, and the report says inherited", async () => {
    const run = await arm(sides(), CODEX);
    expectSpawnExit(run, 0);
    expect(report(run).permissionMode).toBe("inherited");
    expect(passOf(report(run).argv)).not.toContain(CODEX_BYPASS);
    expect(passOf(report(run).argv).slice(0, 2)).toEqual(["codex", "exec"]);
  });

  it("a host with it arms Codex with the bypass", async () => {
    const run = await arm(sides(driveField("codex_bypass", "true")), CODEX);
    expectSpawnExit(run, 0);
    expect(report(run).permissionMode).toBe("no sandbox, no approvals");
    expect(passOf(report(run).argv)).toContain(CODEX_BYPASS);
  });

  it("false and an unset field are the same; a value that is neither stops the arm naming the field", async () => {
    const off = await arm(sides(driveField("codex_bypass", "false")), CODEX);
    expectSpawnExit(off, 0);
    expect(passOf(report(off).argv)).not.toContain(CODEX_BYPASS);
    const bad = await arm(sides(driveField("codex_bypass", "yes")), CODEX);
    expectSpawnExit(bad, 1);
    expect(report(bad).reason).toContain("drive.codex_bypass");
    expect(report(bad).command).not.toContain(CODEX_BYPASS);
  });

  it.each(["true", "false", "null"])(
    "a repository's file that sets it to %s is refused, naming the field",
    async (value) => {
      const run = await arm(
        sides(undefined, driveField("codex_bypass", value)),
        CODEX,
      );
      expectSpawnExit(run, 1);
      expect(report(run).reason).toContain("drive.codex_bypass");
      expect(report(run).command).not.toContain(CODEX_BYPASS);
    },
  );

  it("a Claude Code arm does not read it", async () => {
    const run = await arm(sides(driveField("codex_bypass", "yes")));
    expectSpawnExit(run, 0);
    expect(report(run).permissionMode).toBe("inherited");
  });
});

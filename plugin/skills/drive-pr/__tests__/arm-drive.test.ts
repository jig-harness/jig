/**
 * drive-pr suite: arming a drive from a session (`scripts/arm-drive.ts`,
 * `lib/arm.ts`): the way `do_item.arm_drive` and the session choose, the
 * command that starts the drive and how it is quoted, and the terminal tab
 * Orca opens, with a stand-in for Orca's command line: no test opens a real
 * tab.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { exceptOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import type { OrcaRunner } from "../../../shared/orca.ts";
import {
  arm,
  type ArmInputs,
  type ArmReport,
  type ArmRequest,
  armInTab,
  chooseWay,
  commandLine,
  driveArgv,
  type LiveDrive,
  liveDriveIn,
  DROP_LOGIN_FIELDS,
  quoteWord,
  sessionOverrides,
  type TabDeps,
} from "../scripts/lib/arm.ts";

const SCRIPT = join(import.meta.dir, "..", "scripts", "arm-drive.ts");
const IN_ORCA = { CLAUDECODE: "1", ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const CLAUDE = { CLAUDECODE: "1" };
const TREE = "/work/trees/my tree";
const REQUEST: ArmRequest = { pr: "42", tree: TREE, forward: [] };
/** What opens every tab command's configuration prefix. */
const LOGIN_PREFIX = ["sh", "-c", DROP_LOGIN_FIELDS, "sh", "env"];

/** What a POSIX shell reads `line` back as, one word per line. */
function shellWords(line: string): string[] {
  const done = Bun.spawnSync(["sh", "-c", `printf '%s\\n' ${line}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(
    { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr },
    0,
    "sh",
  );
  return done.stdout.toString().split("\n").slice(0, -1);
}

/** The words a command line hands its program, read back by a shell. */
function readBack(command: string): string[] {
  expect(command.startsWith("bun ")).toBe(true);
  return shellWords(command.slice("bun ".length));
}

describe("the command that starts the drive", () => {
  it("quotes each word so a shell reads it back unchanged", () => {
    const words = [
      "plain",
      "two words",
      "it's",
      'say "hi"',
      "$HOME and `cmd`",
      "back\\slash",
      "bang!",
      "100%",
      "",
    ];
    expect(
      shellWords(words.map((word) => quoteWord(word, "linux")).join(" ")),
    ).toEqual(words);
  });

  it("quotes for PowerShell on a Windows host: single quotes, a quote doubled", () => {
    expect(quoteWord("it's $HOME", "win32")).toBe("'it''s $HOME'");
    expect(quoteWord('say "hi"', "win32")).toBe(`'say "hi"'`);
    expect(quoteWord("two words", "win32")).toBe('"two words"');
  });

  it("keeps the documented double quotes on the pass prompt, so PowerShell and cmd.exe read it too", () => {
    expect(quoteWord("/jig:drive-pr --bots-only 42")).toBe(
      '"/jig:drive-pr --bots-only 42"',
    );
  });

  it("runs drive.ts in the tree, its pass on the model, with the drive's flags before the separator", () => {
    const argv = driveArgv(
      { ...REQUEST, forward: ["--max-rounds", "3", "--keep-draft"] },
      "opus",
    );
    expect(argv.slice(0, 3)).toEqual(["bun", "--cwd", TREE]);
    expect(argv.slice(4)).toEqual([
      "42",
      "--bots-only",
      "--max-rounds",
      "3",
      "--keep-draft",
      "--",
      "claude",
      "--model",
      "opus",
      "-p",
      "/jig:drive-pr --bots-only 42",
    ]);
  });

  it("puts the extra pass arguments before the pass's -p", () => {
    const argv = driveArgv(REQUEST, "sonnet", [
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--permission-mode",
      "bypassPermissions",
      "-p",
      "/jig:drive-pr --bots-only 42",
    ]);
  });

  it("reads back a tree whose path holds spaces and quotes as one word", () => {
    const tree = '/work/my trees/it\'s "here"';
    const argv = driveArgv({ ...REQUEST, tree }, "sonnet");
    expect(readBack(commandLine(argv, "linux"))).toEqual(argv.slice(1));
  });
});

describe("the configuration the tab reads", () => {
  it("carries the field overrides and the layer selectors, a path selector made absolute", () => {
    const env = {
      JIG__DRIVE__PASS_MODEL: "opus",
      JIG_OVERLAY: "scratch/jig.yaml",
      JIG_HOME: "/home/me/.jig-alt",
      JIG_USER_LAYER: "off",
      JIG_OTHER: "ignored",
      HOME: "/home/me",
    };
    expect(sessionOverrides(env, "/work/tree")).toEqual([
      ...LOGIN_PREFIX,
      "JIG__DRIVE__PASS_MODEL=opus",
      `JIG_OVERLAY=${resolve("/work/tree", "scratch/jig.yaml")}`,
      `JIG_HOME=${resolve("/work/tree", "/home/me/.jig-alt")}`,
      "JIG_USER_LAYER=off",
    ]);
  });

  it("carries a blank selector as blank, so the login shell cannot fill it", () => {
    expect(
      sessionOverrides(
        { JIG_OVERLAY: "", JIG_HOME: " ", JIG_USER_LAYER: "", HOME: "/h" },
        "/w",
      ),
    ).toEqual([
      ...LOGIN_PREFIX,
      "JIG_OVERLAY=",
      "JIG_HOME= ",
      "JIG_USER_LAYER=",
    ]);
  });

  it("unsets a selector the session leaves unset", () => {
    expect(sessionOverrides({ HOME: "/h" }, "/w")).toEqual([
      ...LOGIN_PREFIX,
      "-u",
      "JIG_HOME",
      "-u",
      "JIG_OVERLAY",
      "-u",
      "JIG_USER_LAYER",
    ]);
  });

  it("reads back, in a shell whose profile exports configuration, the session's and nothing else", () => {
    const argv = [
      ...sessionOverrides({ JIG__A: "kept", JIG_OVERLAY: "" }, "/w"),
      "sh",
      "-c",
      'echo "$JIG__A|$JIG__B|[$JIG_OVERLAY]|[$JIG_HOME]"',
    ];
    expect(argv).toContain("JIG__A=kept");
    exceptOnWindows("the tab's shell is POSIX", () => {
      const line = commandLine(argv, "linux");
      const done = Bun.spawnSync(["sh", "-c", line], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          JIG__A: "profile",
          JIG__B: "profile",
          JIG_OVERLAY: "/other/jig.yaml",
          JIG_HOME: "/other",
        },
      });
      expectSpawnExit(
        { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr },
        0,
        "sh",
      );
      expect(done.stdout.toString().trim()).toBe("kept||[]|[]");
    });
  });
});

describe("the way a drive is armed", () => {
  it("auto opens a tab in Orca and starts in the background elsewhere", () => {
    expect(chooseWay("auto", IN_ORCA, "linux")).toMatchObject({
      way: "tab",
      orca: "/opt/orca/bin/orca",
    });
    expect(chooseWay("auto", CLAUDE, "linux")).toMatchObject({
      way: "background",
    });
  });

  it("tab outside Orca is refused rather than quietly backgrounded", () => {
    expect(chooseWay("tab", CLAUDE, "linux")).toEqual({
      error:
        "arm_drive is tab, but this session cannot open a terminal tab: it does not run in an Orca terminal",
    });
    expect(chooseWay("background", IN_ORCA, "linux")).toMatchObject({
      way: "background",
    });
  });

  it("opens no tab on a Windows host, whose tab shell the command is not quoted for", () => {
    const auto = chooseWay("auto", IN_ORCA, "win32");
    expect(auto).toMatchObject({ way: "background" });
    expect(JSON.stringify(auto)).toContain(
      "on a Windows host Orca's tab can run cmd.exe or PowerShell",
    );
    expect(chooseWay("tab", IN_ORCA, "win32")).toEqual({
      error:
        "arm_drive is tab, but on a Windows host Orca's tab can run cmd.exe or PowerShell, and the drive's command is quoted for a POSIX shell",
    });
  });

  it("prints the command only for print, and in a session that is not Claude Code's", () => {
    expect(chooseWay("print", IN_ORCA, "linux")).toMatchObject({
      way: "print",
    });
    const codex = chooseWay(
      "auto",
      { CODEX_HOME: "/x", ORCA_CLI_COMMAND: "/opt/orca/bin/orca" },
      "linux",
    );
    expect(codex).toMatchObject({ way: "print" });
    expect(JSON.stringify(codex)).toContain("this session runs codex");
  });
});

/** Orca's stand-in: answers `terminal create` and `terminal read`; records each call. */
function fakeOrca(create: { code: number; stdout: string }) {
  const calls: string[][] = [];
  const runner: OrcaRunner = async (_command, args) => {
    calls.push(args);
    if (args[1] === "read")
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          result: { terminal: { tail: ["$ bun …", "drive.ts: exit 11"] } },
        }),
        stderr: "",
      };
    return { ...create, stderr: "" };
  };
  return { calls, runner };
}

const OPENED = {
  code: 0,
  stdout: JSON.stringify({
    ok: true,
    result: { terminal: { handle: "term_1" } },
  }),
};
const REFUSED = {
  code: 1,
  stdout: JSON.stringify({ ok: false, error: { code: "selector_not_found" } }),
};

/** Deps on a fake clock that advances on each sleep; `listing` answers each look in turn. */
function deps(
  runner: OrcaRunner,
  listing: Array<LiveDrive | null | "unreadable">,
): TabDeps & { looks: () => number } {
  let clock = 1_000_000;
  let looks = 0;
  return {
    orca: runner,
    liveDrive: async () =>
      listing[Math.min(looks++, listing.length - 1)] ?? null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    confirmMs: 5_000,
    pollMs: 1_000,
    looks: () => looks,
  };
}

function drive(startedMs: number): LiveDrive {
  return {
    pid: 7,
    started: new Date(startedMs).toISOString(),
    log: "/state/drive-pr-42.log",
    model: "sonnet",
    permissionMode: "inherited",
    doctor: null,
  };
}

describe("arming in a tab", () => {
  it("opens the tab in the tree's workspace and confirms the drive it started", async () => {
    const orca = fakeOrca(OPENED);
    const d = deps(orca.runner, [null, null, drive(1_000_000)]);
    const outcome = await armInTab("orca", REQUEST, "bun x", d);
    expect(outcome).toEqual({
      status: "armed",
      terminal: "term_1",
      drive: drive(1_000_000),
    });
    expect(orca.calls).toEqual([
      [
        "terminal",
        "create",
        "--worktree",
        `path:${TREE}`,
        "--title",
        "drive #42",
        "--command",
        "bun x",
        "--json",
      ],
    ]);
  });

  it("opens no tab while a drive already holds the PR", async () => {
    const orca = fakeOrca(OPENED);
    const outcome = await armInTab(
      "orca",
      REQUEST,
      "bun x",
      deps(orca.runner, [drive(0)]),
    );
    expect(outcome.status).toBe("already-live");
    expect(orca.calls).toEqual([]);
  });

  it("does not take a drive that started before the tab for the tab's, and reports what the tab printed", async () => {
    const orca = fakeOrca(OPENED);
    const d = deps(orca.runner, [null, drive(0)]);
    const outcome = await armInTab("orca", REQUEST, "bun x", d);
    expect(outcome).toEqual({
      status: "unconfirmed",
      terminal: "term_1",
      tail: ["$ bun …", "drive.ts: exit 11"],
    });
    expect(orca.calls[1]).toEqual([
      "terminal",
      "read",
      "--terminal",
      "term_1",
      "--limit",
      "40",
      "--json",
    ]);
    // One look before the tab, then one per poll until the deadline.
    expect(d.looks()).toBe(1 + 5);
  });

  it("opens no tab when the listing before it cannot be read", async () => {
    const orca = fakeOrca(OPENED);
    const outcome = await armInTab(
      "orca",
      REQUEST,
      "bun x",
      deps(orca.runner, ["unreadable"]),
    );
    expect(outcome.status).toBe("failed");
    expect(orca.calls).toEqual([]);
  });

  it("takes the root handle when the nested terminal has none", async () => {
    const orca = fakeOrca({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        result: { terminal: {}, handle: "term_9" },
      }),
    });
    const outcome = await armInTab(
      "orca",
      REQUEST,
      "bun x",
      deps(orca.runner, [null, drive(2_000_000)]),
    );
    expect(outcome).toMatchObject({ status: "armed", terminal: "term_9" });
  });

  it("makes no probe once the confirmation window is spent", async () => {
    const orca = fakeOrca(OPENED);
    const d = { ...deps(orca.runner, [null]), confirmMs: 0 };
    await armInTab("orca", REQUEST, "bun x", d);
    expect(d.looks()).toBe(1);
  });

  it("reports a tab Orca refused", async () => {
    const outcome = await armInTab(
      "orca",
      REQUEST,
      "bun x",
      deps(fakeOrca(REFUSED).runner, [null]),
    );
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).toContain("selector_not_found");
  });
});

function inputs(
  value: ArmInputs["setting"]["value"],
  env: Record<string, string>,
  platform: NodeJS.Platform = "linux",
): ArmInputs {
  return {
    request: REQUEST,
    setting: { value, source: "do_item.arm_drive" },
    model: { model: "sonnet", source: "the default" },
    passArgs: { words: [], source: "the default" },
    env,
    platform,
  };
}

describe("the arm's answer", () => {
  it("falls back to the background under auto when Orca refuses the tab, and says so", async () => {
    const { report, exit } = await arm(
      inputs("auto", IN_ORCA),
      deps(fakeOrca(REFUSED).runner, [null]),
    );
    expect(exit).toBe(0);
    expect(report).toMatchObject({ way: "background", status: "spawn" });
    expect(report.fallback).toContain("arming in the background instead");
  });

  it("falls back to the background under auto when the tab's drive does not show up, keeping what the tab printed", async () => {
    const { report, exit } = await arm(
      inputs("auto", IN_ORCA),
      deps(fakeOrca(OPENED).runner, [null]),
    );
    expect(exit).toBe(0);
    expect(report).toMatchObject({
      way: "background",
      status: "spawn",
      tab: { title: "drive #42", terminal: "term_1" },
      tail: ["$ bun …", "drive.ts: exit 11"],
    });
    expect(report.fallback).toContain(
      "drives.ts did not list its drive in time",
    );
  });

  it("leaves an unlisted tab's drive unconfirmed under tab, spawning nothing", async () => {
    const { report, exit } = await arm(
      inputs("tab", IN_ORCA),
      deps(fakeOrca(OPENED).runner, [null]),
    );
    expect([exit, report.way, report.status]).toEqual([
      0,
      "tab",
      "unconfirmed",
    ]);
    expect(report.fallback).toBeNull();
  });

  it("on a Windows host falls back under auto without calling Orca, and fails under tab", async () => {
    const orca = fakeOrca(OPENED);
    const auto = await arm(
      inputs("auto", IN_ORCA, "win32"),
      deps(orca.runner, []),
    );
    expect([auto.exit, auto.report.status]).toEqual([0, "spawn"]);
    expect(auto.report.fallback).toContain("arming in the background instead");
    const tab = await arm(
      inputs("tab", IN_ORCA, "win32"),
      deps(orca.runner, []),
    );
    expect([tab.exit, tab.report.status]).toEqual([1, "failed"]);
    expect(orca.calls).toEqual([]);
  });

  it("fails under tab when Orca refuses the tab", async () => {
    const { report, exit } = await arm(
      inputs("tab", IN_ORCA),
      deps(fakeOrca(REFUSED).runner, [null]),
    );
    expect(exit).toBe(1);
    expect(report.status).toBe("failed");
  });

  it("outside Orca leaves the spawn to the session, as before", async () => {
    const orca = fakeOrca(OPENED);
    const { report, exit } = await arm(
      inputs("auto", CLAUDE),
      deps(orca.runner, []),
    );
    expect([exit, report.way, report.status]).toEqual([
      0,
      "background",
      "spawn",
    ]);
    expect(report.command).toContain(
      '-- claude --model sonnet -p "/jig:drive-pr --bots-only 42"',
    );
    expect(report.handles?.stop).toEndWith("--stop 42");
    expect(orca.calls).toEqual([]);
  });
});

describe("liveDriveIn", () => {
  it("finds the PR's live lock row in drives.ts --json", () => {
    const listing = {
      rows: [
        { kind: "worktree", key: "ab12", state: "live" },
        { kind: "pr", key: "41", state: "live", pid: 1, diag: {} },
        { kind: "pr", key: "42", state: "stale", pid: 2, diag: {} },
      ],
    };
    expect(liveDriveIn(listing, "42")).toBeNull();
    listing.rows.push({
      kind: "pr",
      key: "42",
      state: "live",
      pid: 3,
      diag: {
        started: "s",
        log: "l",
        model: "opus",
        permissionMode: "bypassPermissions",
      },
    } as never);
    expect(liveDriveIn(listing, "42")).toEqual({
      pid: 3,
      started: "s",
      log: "l",
      model: "opus",
      permissionMode: "bypassPermissions",
      doctor: null,
    });
  });
});

/** An environment with no harness, wrapper, drive or configuration of the machine this runs on. */
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !/^(GIT_|DRIVE_PR_|ORCA_|CONDUCTOR_|CODEX_|JIG__)/.test(k) &&
      !["CLAUDECODE", "HERDR_ENV", "CLAUDE_CODE_ENTRYPOINT"].includes(k)
    )
      env[k] = v;
  return { ...env, ...extra };
}

/** A git working tree under a directory whose name holds a space. */
function scratchTree(): string {
  const tree = join(mkdtempSync(join(tmpdir(), "arm-drive-")), "my tree");
  mkdirSync(tree);
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], {
      cwd: tree,
      env: cleanEnv({}),
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      { exitCode: done.exitCode, stdout: done.stdout, stderr: done.stderr },
      0,
      `git ${args[0]}`,
    );
  };
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.email=probe@example.invalid",
    "-c",
    "user.name=probe",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return tree;
}

async function runArm(
  tree: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(scriptArgv(SCRIPT, ...args), {
    cwd: tree,
    env: cleanEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function report(run: { stdout: string }): ArmReport {
  return JSON.parse(run.stdout) as ArmReport;
}

describe("arm-drive.ts", () => {
  it("outside Orca prints the background command for the tree it runs in", async () => {
    const tree = scratchTree();
    const run = await runArm(tree, ["42", "--max-rounds", "3"], CLAUDE);
    expectSpawnExit(run, 0);
    const answer = report(run);
    expect(answer).toMatchObject({
      way: "background",
      status: "spawn",
      model: "sonnet",
      armDrive: { value: "auto", source: "the default" },
    });
    expect(readBack(answer.command ?? "")).toEqual(answer.argv.slice(1));
    expect(answer.argv.slice(1, 3)).toEqual(["--cwd", answer.tree ?? ""]);
  });

  it("forwards --pass-model to drive.ts, so the driver log names it, and writes the model it resolves", async () => {
    const tree = scratchTree();
    const run = await runArm(
      tree,
      ["42", "--mode", "print", "--pass-model", "strategic"],
      CLAUDE,
    );
    expectSpawnExit(run, 0);
    const { argv } = report(run);
    const separator = argv.indexOf("--");
    expect(argv.slice(5, separator)).toEqual([
      "--bots-only",
      "--pass-model",
      "strategic",
    ]);
    expect(argv.slice(separator + 1, separator + 4)).toEqual([
      "claude",
      "--model",
      "opus",
    ]);
  });

  it("reads do_item.arm_drive and drive.pass_model from the configuration", async () => {
    const tree = scratchTree();
    const run = await runArm(tree, ["42"], {
      ...CLAUDE,
      JIG__DO_ITEM__ARM_DRIVE: "print",
      JIG__DRIVE__PASS_MODEL: "strategic",
    });
    expectSpawnExit(run, 0);
    expect(report(run)).toMatchObject({
      status: "print",
      armDrive: { value: "print", source: "do_item.arm_drive" },
      model: "opus",
    });
    expect(report(run).command).toContain("claude --model opus -p");
  });

  it("answers a setting outside its values with a failed report, its command on the configured model", async () => {
    const tree = scratchTree();
    const bad = await runArm(tree, ["42"], {
      ...CLAUDE,
      JIG__DO_ITEM__ARM_DRIVE: "window",
    });
    expectSpawnExit(bad, 1);
    expect(report(bad)).toMatchObject({
      status: "failed",
      armDrive: null,
      model: "sonnet",
    });
    expect(report(bad).reason).toContain("do_item.arm_drive");
    expect(report(bad).command).toContain("claude --model sonnet -p");
    const tab = await runArm(tree, ["42", "--mode", "tab"], CLAUDE);
    expectSpawnExit(tab, 1);
    expect(report(tab).status).toBe("failed");
    expectSpawnExit(await runArm(tree, ["042"], CLAUDE), 2);
  });

  it("answers a model it cannot resolve with a failed report on the default model", async () => {
    const tree = scratchTree();
    const tier = await runArm(tree, ["42"], {
      ...CLAUDE,
      JIG__DRIVE__PASS_MODEL: "strategic",
      JIG__ROUTING: "not-a-mapping",
    });
    expectSpawnExit(tier, 1);
    expect(report(tier)).toMatchObject({ status: "failed", model: "sonnet" });
    expect(report(tier).reason).toContain("routing");
    expect(report(tier).command).toContain("claude --model sonnet -p");
    const flag = await runArm(
      tree,
      ["42", "--pass-model", "two words"],
      CLAUDE,
    );
    expectSpawnExit(flag, 2);
    expect(report(flag).reason).toContain("--pass-model");
    expect(report(flag).argv).not.toContain("--pass-model");
  });

  /** The pass command after the separator in an arm's argv. */
  const passOf = (argv: string[]) => argv.slice(argv.indexOf("--") + 1);
  const BYPASS = ["--permission-mode", "bypassPermissions"];

  it("prints the command it always printed when drive.pass_args is not set", async () => {
    const tree = scratchTree();
    const run = await runArm(tree, ["42", "--mode", "print"], CLAUDE);
    expectSpawnExit(run, 0);
    const answer = report(run);
    expect(answer.argv.slice(4)).toEqual([
      "42",
      "--bots-only",
      "--",
      "claude",
      "--model",
      "sonnet",
      "-p",
      "/jig:drive-pr --bots-only 42",
    ]);
    expect(answer.command).toBe(commandLine(answer.argv));
    expect(answer.command).toEndWith(
      ' 42 --bots-only -- claude --model sonnet -p "/jig:drive-pr --bots-only 42"',
    );
    expect(answer).toMatchObject({
      passArgs: [],
      passArgsSource: "the default; drive.pass_args is not set",
      permissionMode: "inherited",
    });
  });

  it("writes drive.pass_args into the printed command before the prompt, and names the permission mode", async () => {
    const tree = scratchTree();
    const run = await runArm(tree, ["42", "--mode", "print"], {
      ...CLAUDE,
      JIG__DRIVE__PASS_ARGS: "[--permission-mode, bypassPermissions]",
    });
    expectSpawnExit(run, 0);
    const answer = report(run);
    expect(passOf(answer.argv)).toEqual([
      "claude",
      "--model",
      "sonnet",
      ...BYPASS,
      "-p",
      "/jig:drive-pr --bots-only 42",
    ]);
    expect(answer.command).toContain(
      'claude --model sonnet --permission-mode bypassPermissions -p "/jig:drive-pr --bots-only 42"',
    );
    expect(answer.argv).not.toContain("--pass-args");
    expect(answer).toMatchObject({
      passArgsSource: "drive.pass_args",
      permissionMode: "bypassPermissions",
    });
    expect(run.stderr).toContain("permission mode bypassPermissions");
  });

  it("takes --pass-args over drive.pass_args for one drive, forwarding it to drive.ts, and an empty one as none", async () => {
    const tree = scratchTree();
    const env = {
      ...CLAUDE,
      JIG__DRIVE__PASS_ARGS: "[--permission-mode, acceptEdits]",
    };
    const flag = await runArm(
      tree,
      ["42", "--mode", "print", "--pass-args", BYPASS.join(" ")],
      env,
    );
    expectSpawnExit(flag, 0);
    const { argv } = report(flag);
    expect(argv.slice(5, argv.indexOf("--"))).toEqual([
      "--bots-only",
      "--pass-args",
      "--permission-mode bypassPermissions",
    ]);
    expect(passOf(argv).slice(3, 5)).toEqual(BYPASS);
    expect(report(flag).passArgsSource).toBe("--pass-args");
    const none = await runArm(
      tree,
      ["42", "--mode", "print", "--pass-args", ""],
      env,
    );
    expectSpawnExit(none, 0);
    expect(passOf(report(none).argv)).toEqual([
      "claude",
      "--model",
      "sonnet",
      "-p",
      "/jig:drive-pr --bots-only 42",
    ]);
  });

  it("stops on a drive.pass_args that is not a list of words, naming the field", async () => {
    const tree = scratchTree();
    for (const value of [
      "--permission-mode bypassPermissions",
      "[--permission-mode bypassPermissions]",
      "[--model, opus]",
    ]) {
      const bad = await runArm(tree, ["42", "--mode", "print"], {
        ...CLAUDE,
        JIG__DRIVE__PASS_ARGS: value,
      });
      expectSpawnExit(bad, 1);
      expect(report(bad)).toMatchObject({ status: "failed", passArgs: [] });
      expect(report(bad).reason).toContain("drive.pass_args");
      expect(report(bad).command).toContain("claude --model sonnet -p");
    }
    const flag = await runArm(
      tree,
      ["42", "--mode", "print", "--pass-args", "--model opus"],
      CLAUDE,
    );
    expectSpawnExit(flag, 2);
    expect(report(flag).reason).toContain("--pass-args cannot hold --model");
    expect(report(flag).argv).not.toContain("--pass-args");
    const end = await runArm(
      tree,
      ["42", "--mode", "print", "--pass-args", "-- x"],
      CLAUDE,
    );
    expectSpawnExit(end, 2);
    expect(report(end).reason).toContain("--pass-args cannot hold --:");
  });

  it("does not take the next flag of its own command line for the value of --pass-args", async () => {
    const tree = scratchTree();
    for (const next of ["--keep-draft", "--mode", "--max-rounds 3", "--"]) {
      const run = await runArm(
        tree,
        ["42", "--pass-args", ...next.split(" ")],
        CLAUDE,
      );
      expectSpawnExit(run, 2);
      expect(run.stderr).toContain("--pass-args requires a value");
    }
  });

  it("answers a directory that is no git working tree with a failed report and no command", async () => {
    const outside = mkdtempSync(join(tmpdir(), "arm-drive-outside-"));
    const run = await runArm(outside, ["42"], {
      ...CLAUDE,
      GIT_CEILING_DIRECTORIES: tmpdir(),
    });
    expectSpawnExit(run, 1);
    expect(report(run)).toMatchObject({
      status: "failed",
      tree: null,
      command: null,
      argv: [],
      handles: null,
    });
    expect(report(run).reason).toContain("not in a git working tree");
  });

  it("in Orca hands the tab's shell the command, quoted, then falls back to the background when its drive does not show up", async () => {
    const tree = scratchTree();
    const bin = mkdtempSync(join(tmpdir(), "arm-drive-orca-"));
    const record = join(bin, "calls.jsonl");
    writeFakeProgram(
      join(bin, "orca"),
      [
        "#!/usr/bin/env bun",
        "import { appendFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + '\\n');`,
        "const result = args[1] === 'read'",
        "  ? { terminal: { tail: ['drive.ts: refused'] } }",
        "  : { terminal: { handle: 'term_9' } };",
        "console.log(JSON.stringify({ ok: true, result }));",
      ].join("\n"),
    );
    writeFileSync(record, "");
    const state = mkdtempSync(join(tmpdir(), "arm-drive-state-"));
    const run = await runArm(tree, ["42"], {
      ...CLAUDE,
      ORCA_CLI_COMMAND: "orca",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      DRIVE_PR_STATE_DIR: state,
      DRIVE_PR_ARM_CONFIRM_SEC: "0",
      JIG__DO_ITEM__ARM_DRIVE: "auto",
      JIG_USER_LAYER: "off",
    });
    expectSpawnExit(run, 0);
    const answer = report(run);
    expect(answer).toMatchObject({ way: "background", status: "spawn" });
    const carried = [
      "JIG__DO_ITEM__ARM_DRIVE=auto",
      "JIG_USER_LAYER=off",
      ...["JIG_HOME", "JIG_OVERLAY"].flatMap((key) => {
        const value = process.env[key];
        if (value === undefined) return [];
        return [`${key}=${value.trim() === "" ? value : resolve(tree, value)}`];
      }),
    ];
    exceptOnWindows("a Windows host opens no Orca tab", () => {
      expect(answer).toMatchObject({
        tab: { title: "drive #42", terminal: "term_9" },
        tail: ["drive.ts: refused"],
      });
      expect(answer.fallback).toContain("did not list its drive in time");
      const calls = readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const create = calls[0] ?? [];
      expect(create.slice(0, 6)).toEqual([
        "terminal",
        "create",
        "--worktree",
        `path:${answer.tree}`,
        "--title",
        "drive #42",
      ]);
      const typed = create[create.indexOf("--command") + 1] ?? "";
      const command = answer.command ?? "";
      expect(typed.endsWith(` ${command}`)).toBe(true);
      const prefix = shellWords(typed.slice(0, -command.length - 1));
      expect(prefix.slice(0, LOGIN_PREFIX.length)).toEqual(LOGIN_PREFIX);
      const rest = prefix.slice(LOGIN_PREFIX.length);
      expect(rest.filter((word) => word.includes("=")).sort()).toEqual(
        carried.sort(),
      );
      expect(rest.filter((word) => word === "-u").length).toBe(
        ["JIG_HOME", "JIG_OVERLAY", "JIG_USER_LAYER"].filter(
          (key) => !carried.some((entry) => entry.startsWith(`${key}=`)),
        ).length,
      );
      expect(readBack(command)).toEqual(answer.argv.slice(1));
    });
  });
});

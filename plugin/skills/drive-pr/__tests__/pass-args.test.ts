/**
 * drive-pr suite: the extra arguments of a drive's pass command
 * (`lib/pass-args.ts`): `--pass-args` over `drive.pass_args`, the setting
 * added only to a pass command without arguments of its own, words already
 * carried kept once, `drive.codex_pass_args` before a Codex pass's prompt by
 * the same rules, a pass command of another tool left alone, and the
 * permission mode read from the command as it runs.
 */

import { describe, expect, it } from "bun:test";
import { diagLines, parseDiagText } from "../scripts/lib/claim.ts";
import { armCommand } from "../scripts/lib/driver/rearm.ts";
import {
  effectivePassArgs,
  type PassArgs,
  PassArgsUsageError,
  parsePassArgsFlag,
  permissionLine,
  permissionMode,
  pinsEmptyPassArgs,
  withCodexPassArgs,
  withPassArgs,
} from "../scripts/lib/pass-args.ts";
import { passCommand } from "../scripts/lib/pass-command.ts";
import { refusedCodexPassArgs } from "../scripts/lib/codex-pass-args.ts";

const BYPASS = ["--permission-mode", "bypassPermissions"];
const PASS = ["claude", "--model", "sonnet", "-p", "/jig:drive-pr 7"];
const configured = (): PassArgs => ({
  words: BYPASS,
  source: "drive.pass_args",
});
const unset = (): PassArgs => ({
  words: [],
  source: "the default; drive.pass_args is not set",
});
const HOOK_TRUST = ["--dangerously-bypass-hook-trust"];
const codexSet = (): PassArgs => ({
  words: HOOK_TRUST,
  source: "drive.codex_pass_args",
});
const codexUnset = (): PassArgs => ({
  words: [],
  source: "the default; drive.codex_pass_args is not set",
});

describe("parsePassArgsFlag", () => {
  it("splits the value on whitespace, an empty one being none", () => {
    expect(parsePassArgsFlag(" --permission-mode\tbypassPermissions ")).toEqual(
      BYPASS,
    );
    expect(parsePassArgsFlag("")).toEqual([]);
  });

  it("refuses the words the drive writes itself", () => {
    for (const value of ["--model opus", "--model=opus", "-p x", "--print"])
      expect(() => parsePassArgsFlag(value)).toThrow(PassArgsUsageError);
  });

  it("refuses a --permission-mode left without its mode", () => {
    expect(() => parsePassArgsFlag("--permission-mode")).toThrow(
      PassArgsUsageError,
    );
    expect(parsePassArgsFlag("--permission-mode auto")).toEqual([
      "--permission-mode",
      "auto",
    ]);
  });

  it.each([
    "--permission-mode",
    "--settings",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--tools",
    "--mcp-config",
    "--add-dir",
    "--plugin-dir",
    "--agents",
    "--system-prompt-file",
    "--max-turns",
    "-n",
  ])("refuses a list ending in %s, naming drive.pass_args", (option) => {
    expect(() => parsePassArgsFlag(`--verbose ${option}`)).toThrow(
      "drive.pass_args",
    );
    expect(parsePassArgsFlag(`${option} value`)).toEqual([option, "value"]);
    expect(parsePassArgsFlag(`${option}=value`)).toEqual([`${option}=value`]);
  });

  it.each(["--dangerously-skip-permissions", "--verbose", "--bare", "-d"])(
    "keeps a list ending in %s, which leaves the drive's -p alone",
    (flag) => {
      expect(parsePassArgsFlag(flag)).toEqual([flag]);
    },
  );
});

describe("withPassArgs", () => {
  it("puts the words before -p, or at the end without one", () => {
    expect(withPassArgs(PASS, BYPASS)).toEqual([
      "claude",
      "--model",
      "sonnet",
      ...BYPASS,
      "-p",
      "/jig:drive-pr 7",
    ]);
    expect(withPassArgs(["claude", "x 7"], ["--verbose"])).toEqual([
      "claude",
      "x 7",
      "--verbose",
    ]);
  });

  it("adds nothing the pass command already carries as one run", () => {
    const armed = withPassArgs(PASS, BYPASS);
    expect(withPassArgs(armed, BYPASS)).toEqual(armed);
  });
});

describe("effectivePassArgs", () => {
  it("adds drive.pass_args to a pass command without arguments of its own", () => {
    const pass = effectivePassArgs(PASS, undefined, configured);
    expect(pass.argv).toEqual(withPassArgs(PASS, BYPASS));
    expect(pass.line).toBe(
      "pass args: --permission-mode bypassPermissions (drive.pass_args)",
    );
    expect(pass.permission.mode).toBe("bypassPermissions");
  });

  it("keeps the words a re-arm or takeover command already carries, once", () => {
    const armed = withPassArgs(PASS, BYPASS);
    const pass = effectivePassArgs(armed, undefined, configured);
    expect(pass.argv).toEqual(armed);
    expect(pass.line).toBe(
      "pass args: --permission-mode bypassPermissions (drive.pass_args, as written in the pass command)",
    );
    // The same command after the setting changed or went: still as written.
    expect(effectivePassArgs(armed, undefined, unset).argv).toEqual(armed);
  });

  it("carries the words into the re-arm and takeover commands built from the pass as it runs", () => {
    const { argv } = effectivePassArgs(PASS, undefined, configured);
    for (const extra of ["", " --take-over"])
      expect(armCommand("drive.ts", "7", false, extra, argv)).toBe(
        `bun drive.ts 7${extra} -- claude --model sonnet --permission-mode bypassPermissions -p '/jig:drive-pr 7'`,
      );
  });

  it("pins an empty choice into a printed command without reading the configuration", () => {
    const { argv } = effectivePassArgs(PASS, "", configured);
    expect(argv).toEqual(PASS);
    for (const extra of ["", " --take-over"])
      expect(armCommand("drive.ts", "7", false, extra, argv)).toBe(
        `bun drive.ts 7${extra} --pass-args '' -- claude --model sonnet -p '/jig:drive-pr 7'`,
      );
  });

  it("keeps a pass command's own arguments as written, saying the setting was not added", () => {
    const own = ["claude", "--permission-mode", "plan", "-p", "x 7"];
    const pass = effectivePassArgs(own, undefined, configured);
    expect(pass.argv).toEqual(own);
    expect(pass.line).toContain("kept as written");
    expect(pass.line).toContain("drive.pass_args");
    expect(pass.permission.mode).toBe("plan");
  });

  it("takes --pass-args over the setting, and an empty one as none", () => {
    const flag = effectivePassArgs(
      PASS,
      "--permission-mode acceptEdits",
      configured,
    );
    expect(flag.argv.slice(3, 5)).toEqual(["--permission-mode", "acceptEdits"]);
    expect(flag.line).toBe(
      "pass args: --permission-mode acceptEdits (--pass-args)",
    );
    const none = effectivePassArgs(PASS, "", configured);
    expect([none.argv, none.permission.mode]).toEqual([PASS, "inherited"]);
  });

  it("names no words and the default mode when nothing sets any", () => {
    const pass = effectivePassArgs(PASS, undefined, unset);
    expect(pass.argv).toEqual(PASS);
    expect(pass.line).toBe(
      "pass args: none (the default; drive.pass_args is not set)",
    );
    expect(permissionLine(pass.permission)).toBe(
      "permission mode: inherited (the pass command sets no --permission-mode; Claude Code's settings decide)",
    );
  });

  it("leaves a pass command of another tool alone, saying both settings are ignored", () => {
    const other = ["other-agent", "run", "/jig:drive-pr 7"];
    const pass = effectivePassArgs(other, undefined, configured, codexUnset);
    expect(pass.argv).toEqual(other);
    expect(pass.line).toBe(
      "pass args: none; drive.pass_args applies to a Claude Code pass command and drive.codex_pass_args to a Codex one, and 'other-agent' ignores both",
    );
    expect(effectivePassArgs(other, undefined, unset, codexSet).line).toBe(
      pass.line,
    );
    expect(effectivePassArgs(other, undefined, unset, codexUnset).line).toBe(
      "pass args: none (the pass command is other-agent)",
    );
    expect(pass.permission.mode).toBeNull();
    expect(() =>
      effectivePassArgs(other, BYPASS.join(" "), configured),
    ).toThrow(PassArgsUsageError);
    expect(effectivePassArgs(other, "", configured).argv).toEqual(other);
  });

  it("reads a Codex pass command's permission from its own words", () => {
    const documented = passCommand("codex", 7, true);
    const pass = effectivePassArgs(
      documented,
      undefined,
      configured,
      codexUnset,
    );
    expect(pass.argv).toEqual(documented);
    expect(pass.permission).toEqual({
      mode: "no sandbox, no approvals",
      source: "the pass command's --dangerously-bypass-approvals-and-sandbox",
    });
    expect(
      effectivePassArgs(
        ["codex", "exec", "--sandbox", "workspace-write", "/jig:drive-pr 7"],
        undefined,
        configured,
      ).permission.mode,
    ).toBe("sandbox workspace-write");
    expect(
      effectivePassArgs(
        ["codex", "exec", "--sandbox=read-only", "/jig:drive-pr 7"],
        undefined,
        configured,
      ).permission.mode,
    ).toBe("sandbox read-only");
    expect(
      effectivePassArgs(
        ["codex", "exec", "-sread-only", "/jig:drive-pr 7"],
        undefined,
        configured,
      ).permission.mode,
    ).toBe("sandbox read-only");
    expect(
      effectivePassArgs(
        ["codex", "exec", "/jig:drive-pr 7"],
        undefined,
        configured,
      ).permission.mode,
    ).toBe("inherited");
  });

  it("stops on a setting it cannot read", () => {
    const unreadable = (): PassArgs => {
      throw new Error("drive.pass_args must be a list of words");
    };
    expect(() => effectivePassArgs(PASS, undefined, unreadable)).toThrow(
      "drive.pass_args",
    );
  });
});

describe("a Codex pass's drive.codex_pass_args", () => {
  const BARE = passCommand("codex", 7, true);
  const WITH = passCommand("codex", 7, true, HOOK_TRUST);

  it("puts the words before the prompt, once", () => {
    expect(withCodexPassArgs(BARE, HOOK_TRUST)).toEqual(WITH);
    expect(withCodexPassArgs(WITH, HOOK_TRUST)).toEqual(WITH);
  });

  it("adds the setting to a command with no arguments of its own, its model and bypass included", () => {
    for (const bare of [
      BARE,
      passCommand("codex", 7),
      ["codex", "exec", "-m", "gpt-x", ...BARE.slice(2)],
    ]) {
      const pass = effectivePassArgs(bare, undefined, unset, codexSet);
      expect(pass.argv).toEqual(withCodexPassArgs(bare, HOOK_TRUST));
      expect(pass.line).toBe(
        "pass args: --dangerously-bypass-hook-trust (drive.codex_pass_args)",
      );
    }
    expect(effectivePassArgs(BARE, undefined, unset, codexUnset).line).toBe(
      "pass args: none (the default; drive.codex_pass_args is not set)",
    );
  });

  it("keeps a command that carries the words, or its own, as written", () => {
    const carried = effectivePassArgs(WITH, undefined, unset, codexSet);
    expect(carried.argv).toEqual(WITH);
    expect(carried.line).toBe(
      "pass args: --dangerously-bypass-hook-trust (drive.codex_pass_args, as written in the pass command)",
    );
    expect(effectivePassArgs(WITH, undefined, unset, codexUnset).argv).toEqual(
      WITH,
    );
    const own = ["codex", "exec", "--sandbox", "workspace-write", "x 7"];
    const kept = effectivePassArgs(own, undefined, unset, codexSet);
    expect(kept.argv).toEqual(own);
    expect(kept.line).toContain("kept as written");
    expect(kept.permission.mode).toBe("sandbox workspace-write");
  });

  it("says drive.pass_args is Claude Code's when it is set", () => {
    expect(effectivePassArgs(BARE, undefined, configured, codexSet).line).toBe(
      "pass args: --dangerously-bypass-hook-trust (drive.codex_pass_args); drive.pass_args applies to a Claude Code pass command",
    );
  });

  it("takes an empty --pass-args as none and refuses its words", () => {
    const none = effectivePassArgs(BARE, "", configured, codexSet);
    expect([none.argv, none.line]).toEqual([
      BARE,
      "pass args: none (--pass-args)",
    ]);
    expect(() =>
      effectivePassArgs(BARE, "--verbose", configured, codexSet),
    ).toThrow(PassArgsUsageError);
  });

  it("pins an empty choice into a printed command only for a command with no arguments of its own", () => {
    expect(pinsEmptyPassArgs(BARE)).toBe(true);
    expect(pinsEmptyPassArgs(WITH)).toBe(false);
    expect(armCommand("drive.ts", "7", false, "", BARE)).toContain(
      "drive.ts 7 --pass-args '' -- codex exec",
    );
    expect(armCommand("drive.ts", "7", false, "", WITH)).not.toContain(
      "--pass-args",
    );
  });

  it("stops on a setting it cannot read", () => {
    const unreadable = (): PassArgs => {
      throw new Error("drive.codex_pass_args must be a list of words");
    };
    expect(() => effectivePassArgs(BARE, undefined, unset, unreadable)).toThrow(
      "drive.codex_pass_args",
    );
  });

  it("keeps a command with its own arguments without reading the setting", () => {
    const unreadable = (): PassArgs => {
      throw new Error("drive.codex_pass_args must be a list of words");
    };
    const own = ["codex", "exec", "--sandbox", "workspace-write", "x 7"];
    expect(effectivePassArgs(own, undefined, unset, unreadable).argv).toEqual(
      own,
    );
  });
});

describe("refusedCodexPassArgs", () => {
  it.each([
    [["--sandbox"], "cannot end with --sandbox"],
    [["-c"], "cannot end with -c"],
    [["-m", "gpt-x"], "cannot hold -m"],
    [["--model=gpt-x"], "cannot hold --model=gpt-x"],
    [["-c", "model=gpt-x"], "cannot hold -c model=gpt-x"],
    [["--config=model=gpt-x"], "routing.models.codex"],
    [["--image", "a.png"], "as images"],
    [["exec"], "cannot hold exec"],
    [["--json", "prompt"], "cannot hold prompt"],
    [["-"], "standard input"],
    [["--"], "cannot hold --"],
    [
      ["--dangerously-bypass-approvals-and-sandbox"],
      "drive.codex_bypass adds it",
    ],
    [["--yolo"], "drive.codex_bypass adds it"],
    [["--sandbox", "--model"], "cannot hold --model"],
  ])("refuses %j", (words, why) => {
    expect(refusedCodexPassArgs(words)).toContain(why);
  });

  it.each([
    [["--dangerously-bypass-hook-trust"]],
    [["--sandbox", "workspace-write", "--json"]],
    [["-c", "model_reasoning_effort=high"]],
    [["--add-dir", "/srv/cache", "--skip-git-repo-check"]],
  ])("keeps %j", (words) => {
    expect(refusedCodexPassArgs(words)).toBeUndefined();
  });
});

describe("permissionMode", () => {
  it("reads either spelling, the last one winning, and the skip flag as bypass", () => {
    expect(
      permissionMode(["claude", "--permission-mode=acceptEdits", "-p", "x"])
        .mode,
    ).toBe("acceptEdits");
    expect(
      permissionMode([
        "claude",
        "--permission-mode",
        "plan",
        ...BYPASS,
        "-p",
        "x",
      ]).mode,
    ).toBe("bypassPermissions");
    expect(
      permissionMode(["claude", "--dangerously-skip-permissions", "-p", "x"]),
    ).toEqual({
      mode: "bypassPermissions",
      source: "the pass command's --dangerously-skip-permissions",
    });
  });
});

describe("the drives listing", () => {
  const diag = {
    pr: "7",
    worktree: "/w",
    log: "/l",
    started: "s",
    account: { account: null, vendor: null, provenance: "p", reason: "r" },
  };

  it("names the permission mode a claim records", () => {
    const recorded = parseDiagText(
      JSON.stringify({ ...diag, permissionMode: "bypassPermissions" }),
    );
    expect(recorded?.permissionMode).toBe("bypassPermissions");
    expect(diagLines(recorded ?? diag)).toContain(
      "    permissions: bypassPermissions",
    );
    expect(diagLines(diag)).toContain(
      "    permissions: unknown (claim predates the permission mode)",
    );
  });
});

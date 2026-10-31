/**
 * drive-pr suite: the extra arguments of a drive's pass command
 * (`lib/pass-args.ts`): `--pass-args` over `drive.pass_args`, the setting
 * added only to a pass command without arguments of its own, words already
 * carried kept once, a pass command that is not Claude Code's left alone,
 * and the permission mode read from the command as it runs.
 */

import { describe, expect, it } from "bun:test";
import {
  diagLines,
  formatClaim,
  parseClaimText,
} from "../scripts/lib/claim.ts";
import { armCommand } from "../scripts/lib/driver/rearm.ts";
import {
  effectivePassArgs,
  type PassArgs,
  PassArgsUsageError,
  parsePassArgsFlag,
  permissionLine,
  permissionMode,
  withPassArgs,
} from "../scripts/lib/pass-args.ts";

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

  it("leaves a pass command that is not Claude Code's alone, saying the setting is ignored", () => {
    const codex = ["codex", "exec", "/jig:drive-pr 7"];
    const pass = effectivePassArgs(codex, undefined, configured);
    expect(pass.argv).toEqual(codex);
    expect(pass.line).toBe(
      "pass args: none; drive.pass_args applies to a Claude Code pass command, and 'codex' ignores it",
    );
    expect(pass.permission.mode).toBeNull();
    expect(() =>
      effectivePassArgs(codex, BYPASS.join(" "), configured),
    ).toThrow(PassArgsUsageError);
    expect(effectivePassArgs(codex, "", configured).argv).toEqual(codex);
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
    const claim = parseClaimText(
      formatClaim(1, "h", { ...diag, permissionMode: "bypassPermissions" }),
    );
    expect(claim?.diag?.permissionMode).toBe("bypassPermissions");
    expect(diagLines(claim?.diag ?? diag)).toContain(
      "    permissions: bypassPermissions",
    );
    expect(diagLines(diag)).toContain(
      "    permissions: unknown (claim predates the permission mode)",
    );
  });
});

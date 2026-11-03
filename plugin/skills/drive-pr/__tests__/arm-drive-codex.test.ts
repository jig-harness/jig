/**
 * drive-pr suite: arming a drive from a Codex session (`lib/arm.ts`). The
 * arm builds Codex's documented pass command, on the model of
 * `routing.models.codex`, opens a terminal tab where Orca can, and requests
 * managed background execution elsewhere. A stand-in replaces Orca's command line: no test opens a tab.
 */

import { describe, expect, it } from "bun:test";
import type { OrcaRunner } from "../../../shared/orca.ts";
import {
  arm,
  type ArmInputs,
  type ArmRequest,
  chooseWay,
  driveArgv,
  type TabDeps,
} from "../scripts/lib/arm.ts";

const REQUEST: ArmRequest = { pr: "42", tree: "/work/tree", forward: [] };
const CODEX = { CODEX_HOME: "/x" };
const CODEX_IN_ORCA = { ...CODEX, ORCA_CLI_COMMAND: "/opt/orca/bin/orca" };
const PROMPT = "Use the jig:drive-pr skill: /jig:drive-pr --bots-only 42";

/** Orca's stand-in, answering every call with `answer`. */
function orca(answer: { ok: boolean }): OrcaRunner {
  return async () => ({
    code: answer.ok ? 0 : 1,
    stdout: JSON.stringify(
      answer.ok
        ? { ok: true, result: { terminal: { handle: "term_1" } } }
        : { ok: false, error: { code: "selector_not_found" } },
    ),
    stderr: "",
  });
}

/** Deps on a fake clock that advances on each sleep, with no drive ever listed. */
function deps(runner: OrcaRunner): TabDeps {
  let clock = 1_000_000;
  return {
    orca: runner,
    liveDrive: async () => null,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    confirmMs: 5_000,
    pollMs: 1_000,
  };
}

function inputs(
  value: ArmInputs["setting"]["value"],
  env: Record<string, string>,
): ArmInputs {
  return {
    request: REQUEST,
    setting: { value, source: "do_item.arm_drive" },
    model: { model: null, source: "Codex's own configuration" },
    passArgs: { words: [], source: "none" },
    env,
    platform: "linux",
  };
}

describe("the way a drive is armed from a Codex session", () => {
  it("opens a tab in Orca, and uses managed background execution elsewhere", () => {
    expect(chooseWay("auto", CODEX_IN_ORCA, "linux")).toMatchObject({
      way: "tab",
      orca: "/opt/orca/bin/orca",
    });
    const away = chooseWay("auto", CODEX, "linux");
    expect(away).toMatchObject({ way: "background" });
    expect(chooseWay("background", CODEX_IN_ORCA, "linux")).toMatchObject({
      way: "background",
    });
    expect(chooseWay("tab", CODEX, "linux")).toMatchObject({
      error: expect.stringContaining("cannot open a terminal tab"),
    });
  });

  it("requests a background spawn when Orca refuses the tab under auto", async () => {
    const { report, exit } = await arm(
      inputs("auto", CODEX_IN_ORCA),
      deps(orca({ ok: false })),
    );
    expect(exit).toBe(0);
    expect(report).toMatchObject({ way: "background", status: "spawn" });
    expect(report.fallback).toContain("arming in the background instead");
  });
  it("falls back on Windows and on an unconfirmed tab, while explicit print stays inert", async () => {
    expect(chooseWay("auto", CODEX_IN_ORCA, "win32")).toMatchObject({
      way: "background",
    });
    expect(chooseWay("print", CODEX_IN_ORCA, "linux")).toMatchObject({
      way: "print",
    });
    const result = await arm(
      inputs("auto", CODEX_IN_ORCA),
      deps(orca({ ok: true })),
    );
    expect(result.report).toMatchObject({ way: "background", status: "spawn" });
    expect(result.report.fallback).toContain("did not list its drive in time");
  });
});

describe("the Codex pass an arm from a Codex session builds", () => {
  it("runs Codex's documented pass command, on routing.models.codex's model after exec", () => {
    const argv = driveArgv(REQUEST, "gpt-example", [], "codex");
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([
      "codex",
      "exec",
      "-m",
      "gpt-example",
      "--dangerously-bypass-approvals-and-sandbox",
      PROMPT,
    ]);
    const unset = driveArgv(REQUEST, null, [], "codex");
    expect(unset.slice(unset.indexOf("--") + 1)).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      PROMPT,
    ]);
  });

  it("reports the Codex command, its model and its permission", async () => {
    const { report, exit } = await arm(
      inputs("print", CODEX),
      deps(orca({ ok: true })),
    );
    expect(exit).toBe(0);
    expect(report).toMatchObject({
      status: "print",
      model: null,
      permissionMode: "no sandbox, no approvals",
    });
    expect(report.argv).toContain("codex");
    expect(report.argv).not.toContain("claude");
  });
});

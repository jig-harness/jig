/**
 * An open that starts no agent runs the create hook in the worktree's
 * `setup` tab and returns at once; an open that starts one waits for it.
 * Against the table in table.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../herdr/__tests__/fake.ts";
import { backgroundSetupCommand } from "../hooks.ts";
import { openArgs, openWorkspace, parseOpen } from "../workspace.ts";
import {
  absent,
  answer,
  CLAIM,
  held,
  HOOK,
  ID,
  inspect,
  isDir,
  isFile,
  launch,
  MARK,
  options,
  testHook,
  workspaceOf,
  WT,
} from "./table.ts";

const { prompt: _prompt, key: _key, ...rest } = options;
const noAgent = { ...rest, noAgent: true };
const tab = `orca terminal create --worktree id:${ID} --title setup --command ${backgroundSetupCommand(CLAIM, MARK, HOOK, WT)} --json`;
const withHook = { ...held, [testHook]: ok() };

describe("with no agent to start", () => {
  test("starts the create hook in a setup tab and returns without running it", () => {
    const ws = workspaceOf({
      ...withHook,
      [inspect(MARK)]: absent,
      [inspect(CLAIM)]: absent,
      [tab]: answer({ terminal: { handle: "t1" } }),
    });
    const opened = openWorkspace(ws, noAgent);
    expect(opened).toMatchObject({ hookRan: true, setupInTab: true });
    expect(ws.ctx.calls).toContain(tab);
    expect(ws.ctx.calls.some((c) => c.startsWith("orca agent launch"))).toBe(
      false,
    );
    expect(ws.ctx.calls.some((c) => c.startsWith("mkdir"))).toBe(false);
  });

  test("starts nothing where the hook's mark says it ran", () => {
    const ws = workspaceOf({ ...withHook, [inspect(MARK)]: isFile });
    expect(openWorkspace(ws, noAgent)).toMatchObject({
      hookRan: false,
      setupInTab: false,
    });
    expect(ws.ctx.calls).not.toContain(tab);
  });

  test("starts no second tab while another open's claim stands", () => {
    const ws = workspaceOf({
      ...withHook,
      [inspect(MARK)]: absent,
      [inspect(CLAIM)]: isDir,
    });
    expect(openWorkspace(ws, noAgent)).toMatchObject({
      hookRan: false,
      setupInTab: true,
    });
    expect(ws.ctx.calls).not.toContain(tab);
  });
});

describe("the setup tab's script", () => {
  test("takes the claim, runs the hook in the worktree, marks success and gives the claim back", () => {
    const command = backgroundSetupCommand(CLAIM, MARK, HOOK, WT);
    expect(command.startsWith("sh -c ")).toBe(true);
    expect(command.endsWith(` sh ${CLAIM} ${MARK} ${HOOK} ${WT}`)).toBe(true);
  });

  test("runs the hook once when two tabs start it, and again after a failure", () => {
    const root = mkdtempSync(join(tmpdir(), "setup-tab-"));
    const wt = join(root, "wt");
    mkdirSync(wt);
    const hook = join(root, "hook.sh");
    const count = join(root, "count");
    writeFileSync(
      hook,
      `#!/bin/sh\necho x >> ${count}\n[ -f ${root}/fail ] && exit 3\nexit 0\n`,
      { mode: 0o755 },
    );
    const claim = join(root, "claim");
    const mark = join(root, "mark");
    const run = () =>
      Bun.spawnSync(["sh", "-c", backgroundSetupCommand(claim, mark, hook, wt)])
        .exitCode;
    writeFileSync(join(root, "fail"), "");
    expect(run()).toBe(3);
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(claim)).toBe(false);
    rmSync(join(root, "fail"));
    expect(run()).toBe(0);
    expect(run()).toBe(0);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
    mkdirSync(claim);
    rmSync(mark);
    expect(run()).toBe(0);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("an agent's model, effort and surface", () => {
  test("are passed to Orca's agent start", () => {
    const launched = `orca agent launch --agent claude --worktree id:${ID} --prompt /jig:do-item ENG-1 --model opus --effort high --surface chat --json`;
    const ws = workspaceOf({
      ...held,
      [launch.replace(
        " --json",
        " --model opus --effort high --surface chat --json",
      )]: answer({}),
    });
    openWorkspace(ws, {
      ...options,
      model: "opus",
      effort: "high",
      surface: "chat",
    });
    expect(ws.ctx.calls).toContain(launched);
  });

  test("read back from the command line, and refused without an agent or a model", () => {
    const flags = {
      ...options,
      model: "m",
      effort: "e",
      surface: "terminal" as const,
    };
    expect(parseOpen(openArgs(flags))).toMatchObject({
      model: "m",
      effort: "e",
      surface: "terminal",
    });
    const base = ["--repo", "app", "--branch", "x"];
    expect(() => parseOpen([...base, "--no-agent", "--model", "m"])).toThrow(
      "drop --no-agent",
    );
    expect(() => parseOpen([...base, "--effort", "high"])).toThrow(
      "--effort needs --model",
    );
    expect(() => parseOpen([...base, "--surface", "web"])).toThrow(
      "--surface is chat or terminal",
    );
  });
});

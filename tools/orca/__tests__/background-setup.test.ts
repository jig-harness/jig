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
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { ok } from "../../herdr/__tests__/fake.ts";
import { shellQuote } from "../../herdr/remote.ts";
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
const setComment = `orca worktree set --worktree id:${ID} --comment ENG-1: Fix --json`;
const withHook = { ...held, [testHook]: ok(), [setComment]: answer({}) };

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

  test("starts no second tab while another open's claim stands, and names the claim", () => {
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
    expect(ws.ctx.lines.join("\n")).toContain(`remove ${CLAIM}`);
  });

  test("refuses a file where the claim goes", () => {
    const ws = workspaceOf({
      ...withHook,
      [inspect(MARK)]: absent,
      [inspect(CLAIM)]: isFile,
    });
    expect(() => openWorkspace(ws, noAgent)).toThrow(
      "not the create hook's claim",
    );
    expect(ws.ctx.calls).not.toContain(tab);
  });

  test("replaces a reattached worktree's comment, which carries the prompt", () => {
    const ws = workspaceOf({ ...withHook, [inspect(MARK)]: isFile });
    openWorkspace(ws, noAgent);
    expect(ws.ctx.calls).toContain(setComment);
  });
});

describe("the setup tab's script", () => {
  test("takes the claim, runs the hook in the worktree, marks success and gives the claim back", () => {
    const command = backgroundSetupCommand(CLAIM, MARK, HOOK, WT);
    expect(command.startsWith("sh -c ")).toBe(true);
    expect(command.endsWith(` sh ${CLAIM} ${MARK} ${HOOK} ${WT}`)).toBe(true);
  });

  /** A worktree, and a hook that counts its runs, fails while `fail` exists and holds while `hold` does. */
  function scene() {
    // A space in every path, as a temporary directory may have.
    const root = mkdtempSync(join(tmpdir(), "setup tab-"));
    const wt = join(root, "wt");
    mkdirSync(wt);
    const hook = join(root, "hook.sh");
    const count = join(root, "count");
    writeFileSync(
      hook,
      `#!/bin/sh\necho x >> ${shellQuote(count)}\nwhile [ -f ${shellQuote(join(root, "hold"))} ]; do sleep 0.05; done\n[ -f ${shellQuote(join(root, "fail"))} ] && exit 3\nexit 0\n`,
      { mode: 0o755 },
    );
    const runs = () =>
      existsSync(count)
        ? readFileSync(count, "utf8").trim().split("\n").length
        : 0;
    const argv = (claim: string, mark: string) => [
      "sh",
      "-c",
      backgroundSetupCommand(claim, mark, hook, wt),
    ];
    const run = (claim = join(root, "claim"), mark = join(root, "mark")) =>
      Bun.spawnSync(argv(claim, mark), { stdout: "pipe", stderr: "pipe" });
    return {
      root,
      runs,
      argv,
      run,
      claim: join(root, "claim"),
      mark: join(root, "mark"),
    };
  }

  test("runs the hook once in sequence, again after a failure, and not while a claim stands", () => {
    const { root, runs, run, claim, mark } = scene();
    writeFileSync(join(root, "fail"), "");
    expectSpawnExit(run(), 3, "failing hook");
    expect(existsSync(mark)).toBe(false);
    expect(existsSync(claim)).toBe(false);
    rmSync(join(root, "fail"));
    expectSpawnExit(run(), 0, "first success");
    expectSpawnExit(run(), 0, "already done");
    expect(runs()).toBe(2);
    mkdirSync(claim);
    rmSync(mark);
    expectSpawnExit(run(), 0, "claim held");
    expect(runs()).toBe(2);
  });

  test("runs the hook once when a second tab starts while the first is running it", async () => {
    const { root, runs, argv, claim, mark } = scene();
    const hold = join(root, "hold");
    writeFileSync(hold, "");
    const first = Bun.spawn(argv(claim, mark), {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const deadline = Date.now() + 10_000;
      while (runs() === 0) {
        if (Date.now() > deadline)
          throw new Error("the first tab never entered the hook");
        await Bun.sleep(20);
      }
      const second = Bun.spawnSync(argv(claim, mark), {
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(second, 0, "second tab");
      expect(second.stdout.toString()).toContain("another open is running it");
    } finally {
      // Releasing the hook lets the first tab end, whatever failed above.
      rmSync(hold, { force: true });
      await first.exited;
    }
    const exitCode = await first.exited;
    expectSpawnExit(
      {
        exitCode,
        stdout: await new Response(first.stdout).text(),
        stderr: await new Response(first.stderr).text(),
      },
      0,
      "first tab",
    );
    expect(runs()).toBe(1);
    expect(existsSync(mark)).toBe(true);
  });

  test("fails, without running the hook, when the claim cannot be taken for any reason but another open's", () => {
    const { root, runs, run, mark } = scene();
    const result = run(join(root, "missing", "claim"), mark);
    expectSpawnExit(result, 1, "unreachable claim");
    expect(result.stdout.toString()).toContain("could not take its claim");
    expect(runs()).toBe(0);
  });

  test("fails, and gives the claim back, when the hook ran but its mark cannot be written", () => {
    const { root, runs, run, claim } = scene();
    const result = run(claim, join(root, "missing", "mark"));
    expectSpawnExit(result, 1, "unwritable mark");
    expect(result.stdout.toString()).toContain("could not be written");
    expect(runs()).toBe(1);
    expect(existsSync(claim)).toBe(false);
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

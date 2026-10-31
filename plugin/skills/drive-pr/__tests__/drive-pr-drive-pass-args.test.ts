/**
 * drive-pr suite: the extra arguments of the pass command `drive.ts` runs —
 * `drive.pass_args` added to a pass command without arguments of its own,
 * `--pass-args` for one run, the words an arm command carries kept as
 * written — named with the permission mode in the driver log, carried by
 * the re-arm command a stop prints, and handed to the pass process itself.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  park,
  scratchClean,
  useDrivePrSuite,
  writeFixture,
} from "./drive-pr-harness.ts";
import { runDrive, runDriveIn } from "./drive-loop-harness.ts";

useDrivePrSuite();

const ROUND_READY = {
  threads: [
    {
      id: "PRRT_args_probe",
      path: "a.ts",
      bot: true,
      comments: [{ author: "example-review[bot]", bot: true, body: "x" }],
    },
  ],
};
const PROMPT = "/jig:drive-pr 999";
const BYPASS = ["--permission-mode", "bypassPermissions"];
const SETTING = {
  JIG__DRIVE__PASS_ARGS: "[--permission-mode, bypassPermissions]",
};
const QUIET = { DRIVE_PR_QUOTA_NO_SPAWN_PREP: "1" };

async function dryRun(pass: string[], flags: string[] = [], env = {}) {
  return runDrive(
    ROUND_READY,
    ["--dry-run", "--no-head-sync", ...flags, "--", ...pass],
    undefined,
    { env: { ...QUIET, ...env } },
  );
}

/** The command the dry run says it would run. */
function wouldRun(stderr: string): string {
  return /\(dry-run\) would run: (.*)/.exec(stderr)?.[1] ?? "";
}

describe("the pass arguments", () => {
  it("adds drive.pass_args before -p and names the permission mode in the driver log", async () => {
    const r = await dryRun(["claude", "-p", PROMPT], [], SETTING);
    expect(wouldRun(r.stderr)).toBe(
      `claude --model sonnet --permission-mode bypassPermissions -p ${PROMPT}`,
    );
    expect(r.stderr).toContain(
      "pass args: --permission-mode bypassPermissions (drive.pass_args)",
    );
    const log = /driver log → (\S+)/.exec(r.stderr)?.[1] ?? "";
    expect(readFileSync(log, "utf8")).toContain(
      "permission mode: bypassPermissions (the pass command's --permission-mode)",
    );
  });

  it("runs an arm command's words once, as written, with or without the forwarded --pass-args", async () => {
    const armed = ["claude", "--model", "sonnet", ...BYPASS, "-p", PROMPT];
    const expected = `claude --model sonnet --permission-mode bypassPermissions -p ${PROMPT}`;
    const setting = await dryRun(armed, [], SETTING);
    expect(wouldRun(setting.stderr)).toBe(expected);
    expect(setting.stderr).toContain(
      "(drive.pass_args, as written in the pass command)",
    );
    const flag = await dryRun(armed, ["--pass-args", BYPASS.join(" ")]);
    expect(wouldRun(flag.stderr)).toBe(expected);
    expect(flag.stderr).toContain(
      "(--pass-args, as written in the pass command)",
    );
  });

  it("names the default permission mode when nothing sets one", async () => {
    const r = await dryRun(["claude", "-p", PROMPT]);
    expect(wouldRun(r.stderr)).toBe(`claude --model sonnet -p ${PROMPT}`);
    expect(r.stderr).toContain(
      "permission mode: default (the pass command sets no --permission-mode)",
    );
  });

  it("ignores drive.pass_args for a pass command that is not Claude Code's, and says so", async () => {
    const r = await dryRun(["sh", "-c", ": pass for 999"], [], SETTING);
    expect(wouldRun(r.stderr)).toBe("sh -c : pass for 999");
    expect(r.stderr).toContain(
      "drive.pass_args applies to a Claude Code pass command, and 'sh' ignores it",
    );
    const flag = await dryRun(
      ["sh", "-c", ": pass for 999"],
      ["--pass-args", BYPASS.join(" ")],
    );
    expectSpawnExit({ ...flag, stdout: null }, 2);
    expect(flag.stderr).toContain("--pass-args applies to a Claude Code pass");
  });

  it("stops on a drive.pass_args that is not a list of words, naming the field", async () => {
    const r = await dryRun(["claude", "-p", PROMPT], [], {
      JIG__DRIVE__PASS_ARGS: "--permission-mode bypassPermissions",
    });
    expectSpawnExit({ ...r, stdout: null }, 1);
    expect(r.stderr).toContain("drive.pass_args must be a list of words");
  });

  it("prints a re-arm command that carries the words, and running it keeps them after the setting is gone", async () => {
    const { dir, stateDir } = writeFixture(
      { threads: [{ id: "PRRT_parked", path: "a.ts", bot: true }] },
      scratchClean.dir,
    );
    await park(stateDir, "PRRT_parked", "thread");
    const parked = await runDriveIn(
      dir,
      stateDir,
      ["--no-head-sync", "--", "claude", "-p", PROMPT],
      undefined,
      { env: { ...QUIET, ...SETTING } },
    );
    expectSpawnExit({ ...parked, stdout: null }, 8);
    const rearm = /^\s+(bun \S+ 999 -- .*)$/m.exec(parked.stderr)?.[1] ?? "";
    expect(rearm).toEndWith(
      `-- claude --model sonnet --permission-mode bypassPermissions -p '${PROMPT}'`,
    );
    const again = await dryRun(
      ["claude", "--model", "sonnet", ...BYPASS, "-p", PROMPT],
      [],
    );
    expect(wouldRun(again.stderr)).toBe(
      `claude --model sonnet --permission-mode bypassPermissions -p ${PROMPT}`,
    );
  });

  it("hands the pass process the permission mode drive.pass_args sets", async () => {
    const bin = mkdtempSync(join(tmpdir(), "drive-pass-args-claude-"));
    const record = join(bin, "argv.json");
    const claude = join(bin, "claude");
    writeFakeProgram(
      claude,
      [
        "#!/usr/bin/env bun",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`,
      ].join("\n"),
    );
    const r = await runDrive(
      ROUND_READY,
      ["--no-head-sync", "--max-rounds", "1", "--", claude, "-p", PROMPT],
      undefined,
      { env: { ...QUIET, ...SETTING } },
    );
    expect(r.stderr).toContain("permission mode: bypassPermissions");
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual([
      "--model",
      "sonnet",
      ...BYPASS,
      "-p",
      PROMPT,
    ]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { resolveWindowsCommand, windowsCommand } from "../windows-command.ts";
import { run } from "../proc.ts";
import { run as driveRun } from "../../skills/drive-pr/scripts/lib/proc.ts";

/** A Node.js npm shim, with the runtime substituted for this test's executable. */
function npmShim(runtime: string, target = "entry.js"): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    `IF EXIST "${runtime}" (`,
    `  SET "_prog=${runtime}"`,
    ") ELSE (",
    `  SET "_prog=${runtime}"`,
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

describe("Windows command launch", () => {
  test("PATH and PATHEXT are case insensitive and preserve search order", () => {
    const files = new Set(["C:\\first\\claude.CMD", "C:\\second\\claude.EXE"]);
    expect(
      resolveWindowsCommand("claude", {
        cwd: "C:\\repo",
        env: { Path: "C:\\first;C:\\second", Pathext: ".EXE;.CMD" },
        isFile: (file) => files.has(file),
      }),
    ).toBe("C:\\first\\claude.CMD");
  });

  test("duplicate environment keys follow Windows spawn's lexicographic selection", () => {
    expect(
      resolveWindowsCommand("agent", {
        cwd: "C:\\repo",
        env: { Path: "C:\\old", PATH: "C:\\new" },
        isFile: (file) => file === "C:\\new\\agent.CMD",
      }),
    ).toBe("C:\\new\\agent.CMD");
  });

  test("an empty PATHEXT uses the Windows executable defaults", () => {
    expect(
      resolveWindowsCommand("agent", {
        cwd: "C:\\repo",
        env: { PATH: "C:\\bin", PATHEXT: "" },
        isFile: (file) => file === "C:\\bin\\agent.CMD",
      }),
    ).toBe("C:\\bin\\agent.CMD");
  });

  test("explicit relative paths resolve extensions without searching PATH", () => {
    expect(
      resolveWindowsCommand(".\\bin\\codex", {
        cwd: "C:\\repo",
        env: { PATH: "C:\\other", PATHEXT: ".BAT;.EXE" },
        isFile: (file) => file === "C:\\repo\\bin\\codex.BAT",
      }),
    ).toBe("C:\\repo\\bin\\codex.BAT");
  });

  test("native executables retain their argument array", () => {
    const result = windowsCommand(["codex", "a & b", '"quoted"'], {
      cwd: "C:\\repo",
      env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      isFile: (file) => file === "C:\\bin\\codex.EXE",
    });
    expect(result).toEqual({
      command: "C:\\bin\\codex.EXE",
      args: ["a & b", '"quoted"'],
    });
  });

  test("batch launches disable autorun and expansion and use verbatim arguments", () => {
    const result = windowsCommand(["C:\\Program Files\\agent.cmd", "a & b"], {
      cwd: "C:\\repo",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      isFile: () => true,
      readBatchSource: () => "@echo off\r\necho %1\r\n",
    });
    expect(result.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(result.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(result.windowsVerbatimArguments).toBe(true);
    expect(result.args[4]).toContain("^&");
    expect(result.args[4]).not.toContain("^^^&");
  });

  test("npm _prog shims receive the extra escape layer and opaque forwarding is refused", () => {
    const options = { cwd: "C:\\repo", env: {}, isFile: () => true };
    const result = windowsCommand(["agent.cmd", "a & b"], {
      ...options,
      readBatchSource: () => npmShim("node"),
    });
    expect(result.args[4]).toContain("^^^&");
    const older = windowsCommand(["agent.cmd", "a & b"], {
      ...options,
      readBatchSource: () =>
        npmShim("node").replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", ""),
    });
    expect(older.args).toEqual(result.args);
    expect(() =>
      windowsCommand(["agent.cmd", "a & b"], {
        ...options,
        readBatchSource: () => npmShim("node") + "echo extra\r\n",
      }),
    ).toThrow(/JavaScript entry point/);
    expect(() =>
      windowsCommand(["agent.cmd", "a & b"], {
        ...options,
        readBatchSource: () =>
          npmShim("node").replace('"%_prog%"  ', 'call "%_prog%"  '),
      }),
    ).toThrow(/JavaScript entry point/);
    expect(() =>
      windowsCommand(["agent.cmd", "a & b"], {
        ...options,
        readBatchSource: () => "node entry.js %*\r\n",
      }),
    ).toThrow(/JavaScript entry point/);
  });

  test("batch line breaks are refused rather than interpreted as commands", () => {
    expect(() =>
      windowsCommand(["agent.cmd", "one\nwhoami"], {
        cwd: "C:\\repo",
        env: {},
        isFile: () => true,
      }),
    ).toThrow(/line break/);
  });

  test.skipIf(process.platform !== "win32")(
    "both process runners preserve batch argument boundaries and shell characters",
    async () => {
      const scratch = mkdtempSync(
        join(tmpdir(), "batch launcher & %PATH% ! caret ^ "),
      );
      try {
        const reader = join(scratch, "reader.js");
        writeFileSync(
          reader,
          "console.log(JSON.stringify(process.argv.slice(2)));\n",
        );
        // npm shims forward arguments with %*, causing a second cmd parse.
        writeFileSync(
          join(scratch, "agent.cmd"),
          npmShim(process.execPath, "reader.js"),
        );
        const values = [
          "",
          "two words",
          'a"quote',
          "trail\\",
          "%PATH%",
          "!PATH!",
          "^",
          "&",
          "|",
          "<",
          ">",
          "(x)",
          "x & echo INJECTED",
          '" & echo INJECTED & "',
        ];
        writeFileSync(join(scratch, "direct.bat"), "@echo off\r\necho %1\r\n");
        const env = {
          ...process.env,
          PATH: `${scratch};${process.env.PATH ?? ""}`,
          PATHEXT: ".EXE;.CMD;.BAT",
        };
        for (const runner of [run, driveRun]) {
          const result = await runner(["agent", ...values], {
            env,
            timeoutSec: 10,
          });
          expectSpawnExit({ ...result, exitCode: result.code }, 0);
          expect(JSON.parse(result.stdout.trim())).toEqual(values);
          const direct = await runner(
            [join(scratch, "direct.bat"), "two words & safe"],
            { env, timeoutSec: 10 },
          );
          expectSpawnExit({ ...direct, exitCode: direct.code }, 0);
          expect(direct.stdout.trim()).toBe('"two words & safe"');
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

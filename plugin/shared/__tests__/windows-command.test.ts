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

/** The shape current npm writes: PATHEXT edited in the ELSE branch, shebang arguments kept. */
function currentNpmShim(runtime: string, interpreterArgs = ""): string {
  return npmShim(runtime)
    .replace(
      `  SET "_prog=${runtime}"\r\n)\r\n\r\n`,
      `  SET "_prog=${runtime}"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n`,
    )
    .replace(
      'set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  ',
      `"%_prog%" ${interpreterArgs} `,
    );
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

  test("bare names search cwd before PATH unless the child disables it", () => {
    const files = new Set(["C:\\repo\\agent.EXE", "C:\\global\\agent.EXE"]);
    const options = {
      cwd: "C:\\repo",
      isFile: (file: string) => files.has(file),
    };
    expect(
      resolveWindowsCommand("agent", {
        ...options,
        env: { PATH: "C:\\global" },
      }),
    ).toBe("C:\\repo\\agent.EXE");
    expect(
      resolveWindowsCommand("agent", {
        ...options,
        env: { PATH: "C:\\global", NoDefaultCurrentDirectoryInExePath: "1" },
      }),
    ).toBe("C:\\global\\agent.EXE");
  });

  test("empty PATH components never search cwd once the child disables it", () => {
    for (const path of [
      undefined,
      "",
      ";C:\\global",
      "C:\\global;",
      '"";C:\\global',
    ]) {
      const probed: string[] = [];
      const env: NodeJS.ProcessEnv = {
        NoDefaultCurrentDirectoryInExePath: "1",
      };
      if (path !== undefined) env.PATH = path;
      resolveWindowsCommand("agent", {
        cwd: "C:\\repo",
        env,
        isFile: (file) => {
          probed.push(file);
          return false;
        },
      });
      expect(probed.filter((file) => file.startsWith("C:\\repo"))).toEqual([]);
    }
  });

  test("PATHEXT types this module cannot launch are skipped", () => {
    const files = new Set(["C:\\first\\agent.JS", "C:\\second\\agent.EXE"]);
    expect(
      resolveWindowsCommand("agent", {
        cwd: "C:\\repo",
        env: { PATH: "C:\\first;C:\\second", PATHEXT: ".JS;.EXE" },
        isFile: (file) => files.has(file),
      }),
    ).toBe("C:\\second\\agent.EXE");
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

  test("current npm shims and their shebang interpreter arguments are recognized", () => {
    const options = { cwd: "C:\\repo", env: {}, isFile: () => true };
    const launch = (source: string) =>
      windowsCommand(["agent.cmd", "a & b"], {
        ...options,
        readBatchSource: () => source,
      });
    const expected = launch(npmShim("node")).args;
    expect(launch(currentNpmShim("node")).args).toEqual(expected);
    expect(
      launch(currentNpmShim("node", "--no-warnings --enable-source-maps")).args,
    ).toEqual(expected);
    // A quote or cmd syntax among the interpreter arguments would change how
    // %* is reparsed; `env -S VAR=value` adds SET lines the grammar refuses.
    expect(() => launch(currentNpmShim("node", '--title="x"'))).toThrow(
      /JavaScript entry point/,
    );
    expect(() => launch(currentNpmShim("node", "--a&b"))).toThrow(
      /JavaScript entry point/,
    );
    expect(() =>
      launch(
        currentNpmShim("node").replace(
          "CALL :find_dp0\r\n",
          "CALL :find_dp0\r\n@SET NODE_OPTIONS=--x\r\n",
        ),
      ),
    ).toThrow(/JavaScript entry point/);
  });

  test("a batch launch longer than cmd.exe's command line is refused before spawning", () => {
    const options = { cwd: "C:\\repo", env: {}, isFile: () => true };
    const direct = (prompt: string) =>
      windowsCommand(["C:\\bin\\direct.bat", prompt], {
        ...options,
        readBatchSource: () => "@echo off\r\necho %1\r\n",
      });
    expect(() => direct("x".repeat(9000))).toThrow(/8191-character/);
    expect(direct("x".repeat(8000)).args[4]?.length).toBeLessThan(8191);
    // The shim's extra escape layer turns 2,040 ampersands into 8,160 characters.
    const shim = (prompt: string) =>
      windowsCommand(["agent.cmd", prompt], {
        ...options,
        readBatchSource: () => npmShim("node"),
      });
    expect(() => shim("&".repeat(2040))).toThrow(/8191-character/);
    expect(shim("&".repeat(2020)).args[4]).toContain("^^^&");
  });

  test("the length guard measures the npm shim after cmd expands its variables", () => {
    const env = { PATHEXT: `.CMD;${".ZZZ;".repeat(199)}` };
    const shim = (prompt: string) =>
      windowsCommand(["C:\\repo\\agent.CMD", prompt], {
        cwd: "C:\\repo",
        env,
        isFile: () => true,
        readBatchSource: () => npmShim("node"),
      });
    // The launch line fits; the shim's final line, PATHEXT expanded, does not.
    expect(() => shim("x".repeat(7400))).toThrow(/8191-character/);
    // Expand the final line by hand: the guard admits exactly what fits.
    const expanded = (length: number) =>
      npmShim("node")
        .trimEnd()
        .split("\r\n")
        .slice(-1)[0]
        ?.replace("%COMSPEC%", "C:\\Windows\\System32\\cmd.exe")
        .replace("%PATHEXT:;.JS;=;%", env.PATHEXT)
        .replace("%_prog%", "node")
        .replace("%dp0%", "C:\\repo\\")
        .replace("%*", `^"${"x".repeat(length)}^"`).length ?? 0;
    let longest = 0;
    while (expanded(longest + 1) <= 8191) longest += 1;
    expect(shim("x".repeat(longest)).args[4]).toContain("agent.CMD");
    expect(() => shim("x".repeat(longest + 1))).toThrow(/8191-character/);
  });

  test("the length guard keeps dollar sequences in the shim directory literal", () => {
    const runtime = "%dp0%\\node.exe";
    const shim = (prompt: string) =>
      windowsCommand(["C:\\repo$$\\agent.CMD", prompt], {
        cwd: "C:\\repo",
        env: { PATHEXT: `.CMD;${".ZZZ;".repeat(199)}` },
        isFile: () => true,
        readBatchSource: () => npmShim(runtime),
      });
    // Expand by hand with split/join, which treats `$$` as two characters.
    const expanded = (length: number) =>
      (npmShim(runtime).trimEnd().split("\r\n").slice(-1)[0] ?? "")
        .split("%COMSPEC%")
        .join("C:\\Windows\\System32\\cmd.exe")
        .split("%PATHEXT:;.JS;=;%")
        .join(`.CMD;${".ZZZ;".repeat(199)}`)
        .split("%_prog%")
        .join(runtime)
        .split("%dp0%")
        .join("C:\\repo$$\\")
        .split("%*")
        .join(`^"${"x".repeat(length)}^"`).length;
    let longest = 0;
    while (expanded(longest + 1) <= 8191) longest += 1;
    expect(shim("x".repeat(longest)).args[4]).toContain("agent.CMD");
    expect(() => shim("x".repeat(longest + 1))).toThrow(/8191-character/);
  });

  test("an npm shim path holding a variable other than %dp0% is refused", () => {
    const launch = (source: string) =>
      windowsCommand(["agent.cmd", "a & b"], {
        cwd: "C:\\repo",
        env: {},
        isFile: () => true,
        readBatchSource: () => source,
      });
    // The estimate cannot bound what an unknown reference expands to.
    expect(() => launch(npmShim("%RUNTIME%"))).toThrow(
      /JavaScript entry point/,
    );
    expect(() => launch(currentNpmShim("%RUNTIME%\\node.exe"))).toThrow(
      /JavaScript entry point/,
    );
    expect(() => launch(npmShim("node", "%TARGET%.js"))).toThrow(
      /JavaScript entry point/,
    );
    expect(launch(npmShim("%dp0%\\node.exe")).args[4]).toContain("agent.cmd");
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

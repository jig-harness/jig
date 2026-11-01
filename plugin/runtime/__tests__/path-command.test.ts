/**
 * The script `jig install` writes for the `jig` command: it passes the
 * caller's arguments to the launcher's command line unchanged, on POSIX and
 * in a Windows batch file.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { commandPath, commandText } from "../path-command.ts";

test("the command is ~/.local/bin/jig, and jig.cmd on Windows", () => {
  expect(commandPath("linux", "/home/me")).toBe(
    join("/home/me", ".local", "bin", "jig"),
  );
  expect(commandPath("win32", "/home/me")).toBe(
    join("/home/me", ".local", "bin", "jig.cmd"),
  );
});

test.skipIf(skipsOnWindows("git-bash", "the POSIX script runs under /bin/sh"))(
  "the POSIX script runs its command with the caller's arguments unchanged",
  () => {
    const root = mkdtempSync(join(tmpdir(), "jig-command-"));
    const echo = join(root, "it's echo.ts");
    writeFileSync(
      echo,
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    const script = join(root, "jig");
    writeFileSync(
      script,
      commandText([process.execPath, echo, "--recorded"], "linux"),
    );
    chmodSync(script, 0o755);
    const args = ["status", "a b", "it's", "$HOME", "*"];
    const result = Bun.spawnSync([script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      "--recorded",
      ...args,
    ]);
  },
);

test("the batch file quotes each value, doubles its percent signs and passes the arguments", () => {
  const text = commandText(
    ["C:\\Program Files\\bun.exe", "C:\\state\\50%\\launcher.ts", "--"],
    "win32",
  );
  expect(text).toContain("rem jig: written by jig install");
  expect(text).toContain(
    '"C:\\Program Files\\bun.exe" "C:\\state\\50%%\\launcher.ts" "--" %*\r\n',
  );
});

test("a value the script cannot carry is refused", () => {
  expect(() => commandText(["/bin/bun\n", "x"], "linux")).toThrow("line break");
  expect(() => commandText(['C:\\a"b\\bun.exe'], "win32")).toThrow(
    "double quote",
  );
});

test("a deadline is carried unless the caller sets one", () => {
  expect(commandText(["bun"], "linux", 21600)).toContain(
    'DEADLINE_SEC:-21600}"',
  );
  expect(commandText(["bun"], "win32", 21600)).toContain(
    "if not defined JIG_LAUNCHER_DEADLINE_SEC set JIG_LAUNCHER_DEADLINE_SEC=21600",
  );
  expect(commandText(["bun"], "linux")).not.toContain("DEADLINE");
});

import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { main } from "../command.ts";

const entry = resolve(import.meta.dir, "../command.ts");

test("unknown wrapper options refuse before running a program", async () => {
  await expect(
    main(["--unknown", "value", "--", "bun", "-e", "console.log('ran')"]),
  ).rejects.toMatchObject({ code: 2 });
});

test("the no-option command form survives Bun consuming a leading separator", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      entry,
      "--",
      "bun",
      "-e",
      "console.log('plain arguments')",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toBe("plain arguments\n");
});

test("file input and output preserve text and argv without shell expansion", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-command-"));
  try {
    const input = join(dir, "input file.json");
    const output = join(dir, "output file.json");
    const child = join(dir, "echo.ts");
    const value = "$(echo injected) | & ; `backticks` 'quotes' \"double\"\n";
    writeFileSync(input, value);
    writeFileSync(
      child,
      "console.log(JSON.stringify({input:await Bun.stdin.text(),argv:process.argv.slice(2),env:process.env.JIG_PORTABLE_TEST,cwd:process.cwd()}))",
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        entry,
        "--stdin-file",
        input,
        "--stdout-file",
        output,
        "--env",
        "JIG_PORTABLE_TEST",
        value,
        "--cwd",
        dir,
        "--",
        "bun",
        child,
        value,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 0);
    const got = JSON.parse(readFileSync(output, "utf8"));
    expect(got).toEqual({
      input: value,
      argv: [value],
      env: value,
      cwd: realpathSync(dir),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed producer preserves the destination and its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-command-"));
  try {
    const output = join(dir, "held.json");
    writeFileSync(output, "held");
    const result = Bun.spawnSync(
      [
        process.execPath,
        entry,
        "--stdout-file",
        output,
        "--",
        "bun",
        "-e",
        "console.log('partial');console.error('failed producer');process.exitCode=7",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 7);
    expect(readFileSync(output, "utf8")).toBe("held");
    expect(result.stderr.toString()).toContain("failed producer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid deadlines and missing inputs refuse before running the child", () => {
  for (const args of [
    ["--timeout-seconds", "0"],
    ["--stdin-file", "nonexistent-input"],
  ]) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        entry,
        ...args,
        "--",
        "bun",
        "-e",
        "console.log('ran')",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, args[0] === "--stdin-file" ? 1 : 2);
    expect(result.stdout.toString()).not.toContain("ran");
  }
});

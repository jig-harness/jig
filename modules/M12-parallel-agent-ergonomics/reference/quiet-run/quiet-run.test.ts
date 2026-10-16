import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { lastLines, parseArgs } from "./quiet-run.ts";

const gate = join(import.meta.dir, "quiet-run.ts"),
  fix = join(import.meta.dir, "fixtures");
const bun = process.execPath;

function run(args: string[], stdin?: string) {
  const result = Bun.spawnSync([bun, gate, ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const fixture = (name: string) => [bun, join(fix, name)];
const lastLine = (text: string) => text.trimEnd().split("\n").at(-1);

test("a passing run is condensed to its tail and one verdict line", () => {
  const result = run(["--name", "unit", "--", ...fixture("pass.ts")]);
  expectSpawnExit(result, 0, "pass");
  expect(result.stdout).not.toContain("line 1 of");
  expect(result.stdout).toContain("line 16 of a passing run");
  expect(lastLine(result.stdout)).toBe(
    "unit: passed — 40 line(s) condensed, last 25 shown",
  );
  expect(result.stderr).toBe("");
});

test("a failing run prints everything and keeps its exit status", () => {
  const result = run(["--name", "unit", "--", ...fixture("fail.ts")]);
  expectSpawnExit(result, 1, "fail");
  expect(result.stdout).toContain("line 1 of a failing run");
  expect(result.stderr).toContain("assertion failed: expected 2, got 3");
  expect(lastLine(result.stdout)).toBe("unit: FAILED (exit 1)");
});

test("a child's could-not-check status passes through unchanged", () => {
  const result = run(["--name", "undecided", ...fixture("undecided.ts")]);
  expectSpawnExit(result, 2, "undecided");
  expect(result.stderr).toContain("could not check: input.yaml not found");
  expect(lastLine(result.stdout)).toBe("undecided: FAILED (exit 2)");
});

test("a silent pass says it condensed nothing", () => {
  const result = run(["--name", "types", ...fixture("silent-pass.ts")]);
  expectSpawnExit(result, 0, "silent");
  expect(result.stdout).toBe(
    "types: passed — 0 line(s) condensed, last 0 shown\n",
  );
});

test("a green run's warnings on stderr stay in the condensed tail", () => {
  const result = run(["--name", "lint", ...fixture("warn-pass.ts")]);
  expectSpawnExit(result, 0, "warn-pass");
  expect(result.stdout.trimEnd().split("\n")).toEqual([
    "checked 12 files",
    "warning: 1 rule at warn level has 3 findings",
    "lint: passed — 2 line(s) condensed, last 2 shown",
  ]);
});

test("--tail bounds the lines shown; zero shows only the verdict", () => {
  const two = run([
    "--name",
    "pass",
    "--tail",
    "2",
    "--",
    ...fixture("pass.ts"),
  ]);
  expectSpawnExit(two, 0, "tail 2");
  expect(two.stdout.trimEnd().split("\n")).toEqual([
    "line 39 of a passing run",
    "line 40 of a passing run",
    "pass: passed — 40 line(s) condensed, last 2 shown",
  ]);
  const none = run(["--name", "pass", "--tail", "0", ...fixture("pass.ts")]);
  expectSpawnExit(none, 0, "tail 0");
  expect(none.stdout).toBe(
    "pass: passed — 40 line(s) condensed, last 0 shown\n",
  );
});

test.skipIf(process.platform === "win32")(
  "a child killed by a signal is could-not-run, with its output kept",
  () => {
    const result = run(["--name", "signal", ...fixture("signal.ts")]);
    expectSpawnExit(result, 2, "signal");
    expect(result.stdout).toContain("started");
    expect(lastLine(result.stdout)).toBe(
      "signal: could not run — killed by SIGTERM before it finished",
    );
  },
);

test("an executable that is not found is could-not-run, never a pass", () => {
  const result = run(["no-such-command-7f3a"]);
  expectSpawnExit(result, 2, "missing executable");
  expect(result.stdout).toContain("no-such-command-7f3a: could not run — ");
});

for (const args of [
  [],
  ["--"],
  ["--name"],
  ["--tail", "x", "--", ...fixture("pass.ts")],
  ["--tail", "-1", ...fixture("pass.ts")],
  ["--frobnicate", "--", ...fixture("pass.ts")],
])
  test(`usage error: ${args.map((a) => a.replace(fix, "")).join(" ") || "(none)"}`, () => {
    const result = run(args);
    expectSpawnExit(result, 2, "usage");
    expect(result.stderr).toContain("usage:");
  });

test("parseArgs names the part after the command's basename by default", () => {
  expect(parseArgs(["--", "/opt/tools/lint", "--fix"])).toEqual({
    name: "lint",
    tail: 25,
    command: ["/opt/tools/lint", "--fix"],
  });
  expect(parseArgs(["--name", "types", "--tail", "3", "--", "tsc"]).name).toBe(
    "types",
  );
  expect(parseArgs(["bun", "test", "--tail", "9"]).command).toEqual([
    "bun",
    "test",
    "--tail",
    "9",
  ]);
  expect(() => parseArgs(["--name", "", "--", ""])).toThrow("no command");
});

test("lastLines keeps the final lines and a trailing newline", () => {
  expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc\n");
  expect(lastLines("a\nb\nc", 5)).toBe("a\nb\nc\n");
  expect(lastLines("a\n", 0)).toBe("");
  expect(lastLines("", 3)).toBe("");
});

test("a verdict starts its own line after output that does not end one", () => {
  const result = run(["--name", "unit", ...fixture("no-newline-fail.ts")]);
  expectSpawnExit(result, 1, "no newline");
  expect(result.stdout).toBe("failure\nunit: FAILED (exit 1)\n");
  expect(result.stderr).toBe("diagnostic\n");
});

test("standard input reaches the command", () => {
  const result = run(
    ["--name", "echo", ...fixture("stdin-pass.ts")],
    "manifest\n",
  );
  expectSpawnExit(result, 0, "stdin");
  expect(result.stdout).toContain("manifest\n");
});

test("a run longer than one read of the spool is counted and tailed whole", () => {
  const result = run([
    "--name",
    "big",
    "--tail",
    "2",
    ...fixture("verbose-pass.ts"),
  ]);
  expectSpawnExit(result, 0, "verbose");
  expect(result.stdout).toBe(
    `5000 ${"x".repeat(60)}\nverbose: done\nbig: passed — 5001 line(s) condensed, last 2 shown\n`,
  );
});

test("a tail longer than the last chunk of output is shown whole", () => {
  const result = run([
    "--name",
    "big",
    "--tail",
    "2000",
    ...fixture("verbose-pass.ts"),
  ]);
  expectSpawnExit(result, 0, "verbose tail 2000");
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.at(-1)).toBe(
    "big: passed — 5001 line(s) condensed, last 2000 shown",
  );
  expect(lines.length).toBe(2001);
  expect(lines[0]).toBe(`3002 ${"x".repeat(60)}`);
});

const scratch = mkdtempSync(join(tmpdir(), "jig-quiet-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Poll until `ready` holds, failing after the deadline. */
async function until(ready: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.skipIf(process.platform === "win32")(
  "a cancelled wrapper stops the command and still prints what it wrote",
  async () => {
    const pidFile = join(scratch, "hang.pid");
    const wrapper = Bun.spawn(
      [bun, gate, "--name", "hang", ...fixture("hang.ts"), pidFile],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "",
      "the command to start",
    );
    const child = Number(readFileSync(pidFile, "utf8"));
    wrapper.kill("SIGTERM");
    const code = await wrapper.exited;
    const stdout = await new Response(wrapper.stdout).text();
    expect(code).toBe(2);
    expect(stdout).toContain("started");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "hang: could not run — the wrapper was cancelled by SIGTERM before the command finished",
    );
    await until(() => !alive(child), "the command to stop");
  },
);

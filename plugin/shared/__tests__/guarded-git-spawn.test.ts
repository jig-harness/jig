import { describe, expect, test } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { LEAKY_GIT_ENV, spawn, spawnSync } from "../guarded-git-spawn.ts";

const safe = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);

/** Text a shell would split, substitute, chain or expand. */
const SHELL_TEXT = [
  "two words",
  "x; echo INJECTED",
  "$(echo INJECTED)",
  "`echo INJECTED`",
  "a && b || c > d",
  "$HOME",
  "%PATH%",
];
const PRINT_ARGV = "console.log(JSON.stringify(process.argv.slice(1)))";

describe("spawnSync", () => {
  test("runs a command with an explicit safe env and returns text output", () => {
    const result = spawnSync(process.execPath, ["-e", "console.log('ok')"], {
      env: safe,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
  });

  // Every argument is one argv entry of the child; no shell reads it.
  test("passes each argument to the child as written, without a shell", () => {
    const result = spawnSync(
      process.execPath,
      ["-e", PRINT_ARGV, ...SHELL_TEXT],
      { env: safe },
    );
    expectSpawnExit(
      { exitCode: result.status, stdout: result.stdout, stderr: result.stderr },
      0,
    );
    expect(JSON.parse(result.stdout)).toEqual(SHELL_TEXT);
  });

  test("refuses to inherit the ambient env", () => {
    expect(() => spawnSync("git", ["--version"])).toThrow(/no explicit env/);
    expect(() => spawnSync("git", ["--version"], {})).toThrow(
      /no explicit env/,
    );
  });

  for (const key of LEAKY_GIT_ENV) {
    test(`refuses an env that leaks ${key}`, () => {
      expect(() =>
        spawnSync("git", ["--version"], { env: { ...safe, [key]: "/x" } }),
      ).toThrow(new RegExp(`leaks ${key}`));
    });

    // A Windows child sees a case-insensitive environment, so a differently
    // cased key is the same variable there.
    test(`refuses a differently cased ${key}`, () => {
      const mixed = key
        .split("_")
        .map((part) => part[0] + part.slice(1).toLowerCase())
        .join("_");
      expect(() =>
        spawnSync("git", ["--version"], { env: { ...safe, [mixed]: "/x" } }),
      ).toThrow(new RegExp(`leaks ${key}`));
    });
  }

  test("an explicit empty-string leak still counts as a leak", () => {
    expect(() =>
      spawnSync("git", ["--version"], { env: { ...safe, GIT_DIR: "" } }),
    ).toThrow(/leaks GIT_DIR/);
  });

  // The guard applies to every command, not only ones that look like git:
  // an intermediary can launch git while inheriting the leaking env.
  for (const [command, args] of [
    ["/usr/bin/env", ["git", "init"]],
    ["bash", ["-c", "git init"]],
    ["/opt/custom/bin/git", ["init"]],
  ] as const) {
    test(`guards ${command} without recognizing it as git`, () => {
      expect(() => spawnSync(command, [...args])).toThrow(/no explicit env/);
    });
  }
});

describe("spawn", () => {
  test("refuses a missing or leaking env before launching anything", () => {
    expect(() => spawn("bash", ["-c", "git init"])).toThrow(/no explicit env/);
    expect(() =>
      spawn("bash", ["-c", "git init"], { env: { ...safe, GIT_DIR: "/x" } }),
    ).toThrow(/leaks GIT_DIR/);
  });

  test("passes each argument to the child as written, without a shell", async () => {
    const child = spawn(process.execPath, ["-e", PRINT_ARGV, ...SHELL_TEXT], {
      env: safe,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    expectSpawnExit({ exitCode, stdout, stderr }, 0);
    expect(JSON.parse(stdout)).toEqual(SHELL_TEXT);
  });

  test("launches with a safe env and can be signalled", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: safe,
    });
    const exited = new Promise<[number | null, string | null]>((resolve) =>
      child.on("exit", (code, signal) => resolve([code, signal])),
    );
    try {
      child.kill("SIGTERM");
      expect(await exited).toEqual([null, "SIGTERM"]);
    } finally {
      // Reaps the child if an assertion failed before it died; a no-op once
      // it has exited.
      child.kill("SIGKILL");
    }
  });
});

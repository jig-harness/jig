import { expect, test } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { assertHost, bundleTool, shellQuote } from "../remote.ts";

test("every argument reaches the remote shell as it was", () => {
  const args = [
    "plain",
    "two words",
    "it's",
    "$HOME",
    "`x`",
    "a\nb",
    "~/clone",
    "",
    "-x",
  ];
  const run = Bun.spawnSync(
    ["sh", "-c", `printf '%s\\0' ${args.map(shellQuote).join(" ")}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(run, 0, "sh");
  expect(run.stdout.toString().split("\0").slice(0, -1)).toEqual(args);
});

test("a destination SSH would read as an option is refused", () => {
  for (const host of ["-oProxyCommand=x", "", "a b"])
    expect(() => assertHost(host)).toThrow("not an SSH destination");
  assertHost("user@host.example");
});

test("the bundled tool runs from standard input with nothing beside it", async () => {
  const script = await bundleTool();
  const run = Bun.spawnSync([process.execPath, "run", "-", "open"], {
    stdin: new TextEncoder().encode(script),
    cwd: "/",
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(run, 2, "bundled tool without --repo");
  expect(run.stderr.toString()).toContain("open needs --repo and --branch");
});

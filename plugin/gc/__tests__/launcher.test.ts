import { expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import {
  claudePluginDirectory,
  codexPluginDirectory,
  installedEntry,
  outsideCheckout,
  parseLauncherArguments,
} from "../launcher.ts";

/** The launcher as install leaves it: its file and startup config, alone. */
function installedLauncher(root: string): { launcher: string; config: string } {
  const directory = join(root, "launcher");
  mkdirSync(directory);
  for (const name of ["launcher.ts", "bunfig.toml"])
    copyFileSync(resolve(import.meta.dir, "..", name), join(directory, name));
  return {
    launcher: join(directory, "launcher.ts"),
    config: join(directory, "bunfig.toml"),
  };
}

/** A directory with a `jig.ts` that announces itself, outside any checkout. */
function pluginCopy(root: string, name: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "gc"), { recursive: true });
  writeFileSync(join(directory, "gc", "bunfig.toml"), "");
  writeFileSync(
    join(directory, "jig.ts"),
    `console.log(${JSON.stringify(name)} + ":" + process.argv.slice(2).join(" "));\n`,
  );
  return realpathSync(directory);
}

test("claude's user-scope install names the directory, a local folder first", () => {
  const list = [
    { id: "jig@jig", scope: "project", installPath: "/project" },
    { id: "jig@jig", scope: "user", installPath: "/cache/0.2.0" },
  ];
  expect(claudePluginDirectory(list)).toBe("/cache/0.2.0");
  expect(
    claudePluginDirectory([{ ...list[1], readFromFolder: "/local/plugin" }]),
  ).toBe("/local/plugin");
  expect(claudePluginDirectory([list[0]])).toBeNull();
  expect(claudePluginDirectory({})).toBeNull();
});

test("codex's install names the cache directory of its version", () => {
  const list = { installed: [{ pluginId: "jig@jig", version: "0.3.0" }] };
  expect(codexPluginDirectory(list, "/codex")).toBe(
    join("/codex", "plugins", "cache", "jig", "jig", "0.3.0"),
  );
  expect(codexPluginDirectory({ installed: [] }, "/codex")).toBeNull();
});

test("the launcher takes the recorded programs, then the collector's arguments", () => {
  expect(
    parseLauncherArguments(["--claude=/bin/claude", "--", "gc", "--scheduled"]),
  ).toEqual({
    programs: { claude: "/bin/claude" },
    rest: ["gc", "--scheduled"],
  });
  expect(() => parseLauncherArguments(["--other=1", "--"])).toThrow(
    "Unknown launcher argument",
  );
});

test("a copy inside a checkout is refused and the next tool is tried", () => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
  mkdirSync(join(checkout, ".git"));
  const inside = pluginCopy(checkout, "worktree");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
  const cached = join(home, "plugins", "cache", "jig", "jig");
  mkdirSync(cached, { recursive: true });
  cpSync(pluginCopy(home, "source"), join(cached, "9.9.9"), {
    recursive: true,
  });
  const lists: Record<string, unknown> = {
    claude: [{ id: "jig@jig", scope: "user", installPath: inside }],
    codex: { installed: [{ pluginId: "jig@jig", version: "9.9.9" }] },
  };
  const list = (program: string) => lists[program];
  expect(() => installedEntry({ claude: "claude" }, list)).toThrow(
    "inside a checkout",
  );
  expect(installedEntry({ claude: "claude", codex: "codex" }, list, home)).toBe(
    realpathSync(join(cached, "9.9.9", "jig.ts")),
  );
});

test.skipIf(skipsOnWindows("powershell", "symbolic links need privileges"))(
  "a link inside a checkout is inside it, wherever the link points",
  () => {
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    mkdirSync(join(checkout, ".git"));
    mkdirSync(join(checkout, "bin"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const program = join(outside, "claude");
    writeFileSync(program, "");
    expect(outsideCheckout(program)).toBe(true);
    // The link's own directory is in the checkout; its target is not.
    symlinkSync(program, join(checkout, "bin", "claude"));
    expect(outsideCheckout(join(checkout, "bin", "claude"))).toBe(false);
    // A directory link outside the checkout naming its bin directory.
    symlinkSync(join(checkout, "bin"), join(outside, "bin"));
    expect(outsideCheckout(join(outside, "bin", "claude"))).toBe(false);
    // A chain that leaves the checkout again: the hop in it still counts.
    symlinkSync(program, join(checkout, "bridge"));
    symlinkSync(join(checkout, "bridge"), join(outside, "chained"));
    expect(outsideCheckout(join(outside, "chained"))).toBe(false);
  },
);

test("no recorded tool, or a tool that cannot answer, is an error naming why", () => {
  expect(() => installedEntry({})).toThrow("no agent tool recorded");
  expect(() =>
    installedEntry({ claude: "claude" }, () => {
      throw new Error("exited 1: offline");
    }),
  ).toThrow("claude: exited 1: offline");
});

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)(
  "one launcher, run alone, runs whichever plugin copy is installed when it starts",
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const before = pluginCopy(root, "before");
    const after = pluginCopy(root, "after");
    const { launcher, config } = installedLauncher(root);
    const current = join(root, "current");
    const claude = join(root, "bin", "claude");
    mkdirSync(join(root, "bin"));
    writeFakeProgram(
      claude,
      `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
console.log(JSON.stringify([{ id: "jig@jig", scope: "user", installPath: readFileSync(${JSON.stringify(current)}, "utf8") }]));
`,
    );
    const start = (installed: string) => {
      writeFileSync(current, installed);
      return Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          `--config=${config}`,
          launcher,
          `--claude=${claude}`,
          "--",
          "gc",
          "--scheduled",
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30000 },
      );
    };
    const first = start(before);
    expectSpawnExit(first, 0);
    expect(first.stdout.toString().trim()).toBe("before:gc --scheduled");
    // A plugin update changes the registry, not the job.
    const second = start(after);
    expectSpawnExit(second, 0);
    expect(second.stdout.toString().trim()).toBe("after:gc --scheduled");
  },
);

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)("an uninstalled plugin fails the run rather than running nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
  const { launcher, config } = installedLauncher(root);
  const claude = join(root, "claude");
  writeFakeProgram(claude, `#!/usr/bin/env bun\nconsole.log("[]");\n`);
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${config}`,
      launcher,
      `--claude=${claude}`,
      "--",
      "gc",
    ],
    { stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("run jig gc install again");
});

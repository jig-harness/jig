import { expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  collectionDeadlineMs,
  installedEntry,
  listPlugins,
  outsideCheckout,
  parseLauncherArguments,
  runCollector,
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

test("a copy inside a checkout is refused and the next tool is tried", async () => {
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
  await expect(installedEntry({ claude: "claude" }, list)).rejects.toThrow(
    "inside a checkout",
  );
  expect(
    await installedEntry({ claude: "claude", codex: "codex" }, list, home),
  ).toBe(realpathSync(join(cached, "9.9.9", "jig.ts")));
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

test.skipIf(skipsOnWindows("powershell", "symbolic links need privileges"))(
  "a link is followed before the `..` after it, as the kernel resolves it",
  () => {
    // safe/bin/claude -> safe/hop/../payload, with safe/hop -> repo/subdir:
    // the kernel climbs from repo/subdir to repo/payload, not to safe/payload.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    mkdirSync(join(checkout, ".git"));
    mkdirSync(join(checkout, "subdir"));
    writeFileSync(join(checkout, "payload"), "");
    const safe = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    mkdirSync(join(safe, "bin"));
    writeFileSync(join(safe, "payload"), "");
    symlinkSync(join(checkout, "subdir"), join(safe, "hop"));
    symlinkSync(`${join(safe, "hop")}/../payload`, join(safe, "bin", "claude"));
    expect(realpathSync(join(safe, "bin", "claude"))).toBe(
      join(checkout, "payload"),
    );
    expect(outsideCheckout(join(safe, "bin", "claude"))).toBe(false);
    // The same text with no link in the way stays outside.
    symlinkSync(`${join(safe, "bin")}/../payload`, join(safe, "plain"));
    expect(outsideCheckout(join(safe, "plain"))).toBe(true);
  },
);

test.skipIf(
  skipsOnWindows("powershell", "a backslash separates Windows paths"),
)("a backslash is part of a POSIX filename, never a separator", () => {
  // root/repo\name is a checkout; root/repo/name, the same text split at
  // the backslash, is not, and holds a file of the same name.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
  const checkout = join(root, "repo\\name");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  mkdirSync(join(checkout, "bin"));
  writeFileSync(join(checkout, "bin", "claude"), "");
  mkdirSync(join(root, "repo", "name", "bin"), { recursive: true });
  writeFileSync(join(root, "repo", "name", "bin", "claude"), "");
  expect(outsideCheckout(join(checkout, "bin", "claude"))).toBe(false);
  expect(outsideCheckout(join(root, "repo", "name", "bin", "claude"))).toBe(
    true,
  );
  // A link whose target text holds the backslash leads into the checkout too.
  symlinkSync(join(checkout, "bin", "claude"), join(root, "linked"));
  expect(outsideCheckout(join(root, "linked"))).toBe(false);
});

/**
 * A file a signal-test child writes from its `SIGTERM` handler. The deadline
 * leaves the child time to start, and the file proves the handler under test
 * ran rather than the signal ending the child before it was installed.
 */
function signalMarker(): string {
  return join(mkdtempSync(join(tmpdir(), "gc-launcher-")), "caught");
}

test("a collection's deadline covers the lock wait it may spend first", () => {
  expect(collectionDeadlineMs({})).toBe((3600 + 7200) * 1000);
  expect(collectionDeadlineMs({ LOCK_TIMEOUT: "" })).toBe((3600 + 7200) * 1000);
  expect(collectionDeadlineMs({ LOCK_TIMEOUT: "60" })).toBe((60 + 7200) * 1000);
  // Zero is a valid wait: one attempt at the lock, then the work.
  expect(collectionDeadlineMs({ LOCK_TIMEOUT: "0" })).toBe(7200 * 1000);
  expect(collectionDeadlineMs({ LOCK_TIMEOUT: "nonsense" })).toBe(
    (3600 + 7200) * 1000,
  );
});

test.skipIf(
  skipsOnWindows("powershell", "process groups and signals are POSIX"),
)(
  "a collector past its deadline is stopped, even one that ignores SIGTERM",
  async () => {
    const caught = signalMarker();
    const started = Date.now();
    const status = await runCollector(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => require("node:fs").writeFileSync(process.argv[1], "")); setInterval(() => {}, 1000);',
        caught,
      ],
      2000,
      300,
    );
    expect(status).not.toBe(0);
    // The child ignored SIGTERM, so only the escalation could have ended it.
    expect(existsSync(caught)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
  },
);

test.skipIf(
  skipsOnWindows("powershell", "process groups and signals are POSIX"),
)("a stopped collector fails the run even when it exits 0", async () => {
  const caught = signalMarker();
  expect(
    await runCollector(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], ""); process.exit(0); }); setInterval(() => {}, 1000);',
        caught,
      ],
      2000,
      10_000,
    ),
  ).not.toBe(0);
  // The child's own exit-0 handler ran: the status is the launcher's verdict.
  expect(existsSync(caught)).toBe(true);
});

test("a collector that finishes keeps its own exit status", async () => {
  expect(
    await runCollector([process.execPath, "-e", "process.exit(3)"], 60_000),
  ).toBe(3);
});

test("no recorded tool, or a tool that cannot answer, is an error naming why", async () => {
  await expect(installedEntry({})).rejects.toThrow("no agent tool recorded");
  await expect(
    installedEntry({ claude: "claude" }, () => {
      throw new Error("exited 1: offline");
    }),
  ).rejects.toThrow("claude: exited 1: offline");
});

test.skipIf(skipsOnWindows("powershell", "signals are POSIX"))(
  "a tool that ignores SIGTERM and never answers fails the lookup in time",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const claude = join(root, "claude");
    const pidFile = join(root, "pid");
    writeFakeProgram(
      claude,
      `#!/usr/bin/env bun\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
    );
    const started = Date.now();
    await expect(listPlugins(claude, 1000)).rejects.toThrow(
      "did not answer within 1s",
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    // The tool is gone, not left running beside the collector.
    const pid = Number(readFileSync(pidFile, "utf8"));
    const deadline = Date.now() + 3000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  },
);

/** Whether `pid` is gone within `ms`, polled. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}

/** Polls for a file a child writes, and reads it. */
async function readWhenWritten(path: string, ms = 10_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (!existsSync(path) || readFileSync(path, "utf8") === "") {
    if (Date.now() > deadline) throw new Error(`${path} was never written`);
    await Bun.sleep(50);
  }
  return readFileSync(path, "utf8");
}

test.skipIf(skipsOnWindows("powershell", "process groups are POSIX"))(
  "a lookup ends the launcher at its deadline even while a descendant holds its pipes",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const claude = join(root, "claude");
    const pidFile = join(root, "pid");
    // The descendant leaves the tool's process group, so no group signal
    // reaches it, and keeps the tool's stdout and stderr open.
    writeFakeProgram(
      claude,
      `#!/usr/bin/env bun
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "inherit" });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    const lookup = join(root, "lookup.ts");
    writeFileSync(
      lookup,
      `const { listPlugins } = await import(process.argv[2]);
try { await listPlugins(process.argv[3], 1000); } catch (error) { console.error(error.message); process.exitCode = 3; }
`,
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        lookup,
        resolve(import.meta.dir, "..", "launcher.ts"),
        claude,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    const descendant = Number(await readWhenWritten(pidFile));
    try {
      expectSpawnExit(result, 3);
      expect(result.stderr.toString()).toContain("did not answer within 1s");
    } finally {
      process.kill(descendant, "SIGKILL");
    }
  },
);

test.skipIf(skipsOnWindows("powershell", "signals are POSIX"))(
  "a launcher told to stop during the lookup ends the tool and fails at once",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const { launcher, config } = installedLauncher(root);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const pidFile = join(root, "pid");
    const asked = join(root, "codex-asked");
    writeFakeProgram(
      claude,
      `#!/usr/bin/env bun\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    );
    // A stopped launch asks no further tool.
    writeFakeProgram(
      codex,
      `#!/usr/bin/env bun\nrequire("node:fs").writeFileSync(${JSON.stringify(asked)}, "");\nconsole.log("{}");\n`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        `--config=${config}`,
        launcher,
        `--claude=${claude}`,
        `--codex=${codex}`,
        "--",
        "gc",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const tool = Number(await readWhenWritten(pidFile));
    const started = Date.now();
    child.kill("SIGTERM");
    const status = await Promise.race([child.exited, Bun.sleep(15_000)]);
    if (status === undefined) {
      // The tool leads its own process group, so killing the launcher leaves it.
      child.kill("SIGKILL");
      try {
        process.kill(-tool, "SIGKILL");
      } catch {
        // The group already ended.
      }
    }
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expectSpawnExit({ exitCode: status ?? null, stdout, stderr }, 1);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(stderr).toContain("received SIGTERM");
    expect(await goneWithin(tool, 3000)).toBe(true);
    expect(existsSync(asked)).toBe(false);
  },
);

test.skipIf(skipsOnWindows("powershell", "process groups are POSIX"))(
  "a tool printing without end is stopped at the output budget",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
    const claude = join(root, "claude");
    writeFakeProgram(
      claude,
      `#!/usr/bin/env bun\nsetInterval(() => process.stderr.write("x".repeat(65536)), 1);\n`,
    );
    await expect(listPlugins(claude, 20_000, 200_000)).rejects.toThrow(
      "printed more than 200000 bytes",
    );
  },
);

test("a character split across output chunks survives the lookup", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gc-launcher-")));
  const claude = join(root, "claude");
  // é is C3 A9 in UTF-8; the tool writes the two bytes apart.
  writeFakeProgram(
    claude,
    `#!/usr/bin/env bun
process.stdout.write(Buffer.concat([Buffer.from('[{"id":"jig@jig","scope":"user","installPath":"/caf'), Buffer.from([0xc3])]));
setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from([0xa9]), Buffer.from('"}]')])), 200);
`,
  );
  expect(claudePluginDirectory(await listPlugins(claude))).toBe("/café");
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

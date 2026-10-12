import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { desiredEntry, install, parseArgs } from "./install.ts";

function machine(setup?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "launcher-install-"));
  setup?.(home);
  return {
    home,
    // Real files, so the "does not exist" checks pass.
    bun: process.execPath,
    script: join(import.meta.dirname, "launch.ts"),
    env: {},
    now: () => 1_700_000_000_000,
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const tools = (home: string) => join(home, ".linear", "coding-tools.json");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("a fresh machine gets the tracker entry with the absolute bun path and a starter config", () => {
  const m = machine();
  try {
    const report = install(m);
    expect(report.ok).toBe(true);
    expect(read(tools(m.home))).toEqual({
      openIssue: desiredEntry(m.bun, m.script),
    });
    expect(read(tools(m.home)).openIssue.env).not.toContain("LINEAR_API_KEY");
    // The key file is created here later, so the directory is private.
    expect(statSync(join(m.home, ".linear")).mode & 0o777).toBe(0o700);
    const config = readFileSync(
      join(m.home, ".linear", "launcher.yaml"),
      "utf8",
    );
    expect(config).toContain("provider: conductor");
    expect(report.lines.join("\n")).toContain("api-key");
  } finally {
    m.done();
  }
});

test("the printed key-file command works for a home with spaces, quotes and dollars", () => {
  const m = machine();
  const home = join(m.home, "Jane O'Doe $PWD");
  try {
    mkdirSync(home);
    const report = install({ ...m, home, check: true });
    const line = report.lines.find((l) => l.includes("api-key"));
    const command = line?.split("before any key lands: ")[1];
    expect(command).toBeDefined();
    const result = spawnSync("sh", ["-c", command as string]);
    expect(result.status).toBe(0);
    const keyFile = join(home, ".linear", "api-key");
    expect(readFileSync(keyFile, "utf8")).toBe("lin_api_…");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(m.home)).toEqual(["Jane O'Doe $PWD"]);
  } finally {
    m.done();
  }
});

test("running it again changes nothing", () => {
  const m = machine();
  try {
    install(m);
    const before = readdirSync(join(m.home, ".linear")).sort();
    const report = install(m);
    expect(report.ok).toBe(true);
    expect(readdirSync(join(m.home, ".linear")).sort()).toEqual(before);
    expect(report.lines.join("\n")).toContain("already runs the launcher");
  } finally {
    m.done();
  }
});

test("other keys survive and the replaced file is backed up", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(
      tools(home),
      JSON.stringify({ other: { keep: true }, openIssue: { path: "/old" } }),
    );
  });
  try {
    install(m);
    const merged = read(tools(m.home));
    expect(merged.other).toEqual({ keep: true });
    expect(merged.openIssue.path).toBe(m.bun);
    const backup = join(m.home, ".linear", "coding-tools.json.bak-1700000000");
    expect(read(backup).openIssue).toEqual({ path: "/old" });
  } finally {
    m.done();
  }
});

test("an existing launcher configuration is never overwritten", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(join(home, ".linear", "launcher.yaml"), "skill: /x:y\n");
  });
  try {
    install(m);
    expect(readFileSync(join(m.home, ".linear", "launcher.yaml"), "utf8")).toBe(
      "skill: /x:y\n",
    );
  } finally {
    m.done();
  }
});

test("a configuration that does not parse is reported", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(join(home, ".linear", "launcher.yaml"), "bogus: 1\n");
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("unknown key bogus");
  } finally {
    m.done();
  }
});

test("unparseable tracker configuration is left untouched", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(tools(home), "{ not json");
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(readFileSync(tools(m.home), "utf8")).toBe("{ not json");
  } finally {
    m.done();
  }
});

test("--check and --dry-run write nothing", () => {
  for (const mode of [{ check: true }, { dryRun: true }]) {
    const m = machine();
    try {
      const report = install({ ...m, ...mode });
      expect(readdirSync(m.home)).toEqual([]);
      expect(report.ok).toBe(!("check" in mode));
    } finally {
      m.done();
    }
  }
});

test("--check passes once installed and fails when the bun path has gone", () => {
  const m = machine();
  try {
    install(m);
    expect(install({ ...m, check: true }).ok).toBe(true);
    const gone = install({ ...m, bun: "/nowhere/bun", check: true });
    expect(gone.ok).toBe(false);
    expect(gone.lines.join("\n")).toContain("/nowhere/bun");
  } finally {
    m.done();
  }
});

test("a key file readable by others is made private, and its content is never read into the report", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(join(home, ".linear", "api-key"), "lin_api_secret");
    chmodSync(join(home, ".linear", "api-key"), 0o644);
  });
  try {
    const report = install(m);
    expect(statSync(join(m.home, ".linear", "api-key")).mode & 0o777).toBe(
      0o600,
    );
    expect(report.lines.join("\n")).not.toContain("lin_api_secret");
  } finally {
    m.done();
  }
});

test("an unknown provider is refused", () => {
  const m = machine();
  try {
    const report = install({ ...m, provider: "nowhere" });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain('unknown provider "nowhere"');
  } finally {
    m.done();
  }
});

test("the command line wires a scratch home and --check then passes", () => {
  const m = machine();
  try {
    const script = join(import.meta.dirname, "install.ts");
    const env = { HOME: m.home, PATH: "/usr/bin:/bin" };
    const first = Bun.spawnSync([process.execPath, script], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(first, 0, "install.ts");
    const check = Bun.spawnSync([process.execPath, script, "--check"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(check, 0, "install.ts --check");
  } finally {
    m.done();
  }
});

test("a failed install changes nothing, so a working entry survives", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(tools(home), JSON.stringify({ openIssue: { path: "/old" } }));
    writeFileSync(
      join(home, ".linear", "launcher.yaml"),
      "provider: nowhere\n",
    );
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("nothing was changed");
    expect(read(tools(m.home))).toEqual({ openIssue: { path: "/old" } });
    expect(readdirSync(join(m.home, ".linear")).sort()).toEqual([
      "coding-tools.json",
      "launcher.yaml",
    ]);
  } finally {
    m.done();
  }
});

test("a write that fails after the checks undoes the writes before it", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(tools(home), JSON.stringify({ openIssue: { path: "/old" } }));
    // A file where the configuration's directory belongs: every check passes,
    // and creating the directory fails after the tracker entry is written.
    writeFileSync(join(home, "not-a-dir"), "");
  });
  try {
    const report = install({
      ...m,
      env: { JIG_LAUNCHER_CONFIG: join(m.home, "not-a-dir", "l.yaml") },
    });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain(
      "the earlier changes were undone",
    );
    expect(read(tools(m.home))).toEqual({ openIssue: { path: "/old" } });
    expect(readdirSync(join(m.home, ".linear"))).toEqual(["coding-tools.json"]);
  } finally {
    m.done();
  }
});

test("on a fresh machine, a failed write leaves no directory behind", () => {
  const m = machine((home) => writeFileSync(join(home, "not-a-dir"), ""));
  try {
    const report = install({
      ...m,
      env: { JIG_LAUNCHER_CONFIG: join(m.home, "not-a-dir", "l.yaml") },
    });
    expect(report.ok).toBe(false);
    expect(readdirSync(m.home)).toEqual(["not-a-dir"]);
  } finally {
    m.done();
  }
});

test("a configuration write that fails after creating the file removes it", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(tools(home), JSON.stringify({ openIssue: { path: "/old" } }));
  });
  const config = join(m.home, ".linear", "launcher.yaml");
  const real = fs.writeFileSync;
  // The file is created, then filling it fails (a full disk, say).
  const spy = spyOn(fs, "writeFileSync").mockImplementation(((
    ...args: Parameters<typeof real>
  ) => {
    if (args[0] === config && args[2] === undefined)
      throw new Error("ENOSPC: no space left on device");
    return real(...args);
  }) as typeof real);
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain(
      "the earlier changes were undone",
    );
    expect(read(tools(m.home))).toEqual({ openIssue: { path: "/old" } });
    expect(readdirSync(join(m.home, ".linear"))).toEqual(["coding-tools.json"]);
  } finally {
    spy.mockRestore();
    m.done();
  }
});

test("a tracker entry file that is a link to a missing file is refused, not replaced", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    symlinkSync(join(home, "dotfiles", "coding-tools.json"), tools(home));
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain(
      "is a symbolic link to a missing file",
    );
    expect(lstatSync(tools(m.home)).isSymbolicLink()).toBe(true);
    expect(readdirSync(join(m.home, ".linear"))).toEqual(["coding-tools.json"]);
  } finally {
    m.done();
  }
});

test("a tracker entry file that is a link is written through it", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(join(home, "dotfiles", "coding-tools.json"), "{}");
    symlinkSync(join(home, "dotfiles", "coding-tools.json"), tools(home));
  });
  try {
    expect(install(m).ok).toBe(true);
    expect(lstatSync(tools(m.home)).isSymbolicLink()).toBe(true);
    expect(
      read(join(m.home, "dotfiles", "coding-tools.json")).openIssue.path,
    ).toBe(m.bun);
  } finally {
    m.done();
  }
});

test("an unknown tracker in the configuration is refused", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(join(home, ".linear", "launcher.yaml"), "tracker: nowhere\n");
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain('unknown tracker "nowhere"');
  } finally {
    m.done();
  }
});

test("two installs in one second keep both backups", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(
      tools(home),
      JSON.stringify({ openIssue: { path: "/first" } }),
    );
  });
  try {
    install(m);
    install({ ...m, script: join(import.meta.dirname, "install.ts") });
    const dir = join(m.home, ".linear");
    expect(
      read(join(dir, "coding-tools.json.bak-1700000000")).openIssue,
    ).toEqual({ path: "/first" });
    expect(
      read(join(dir, "coding-tools.json.bak-1700000000-1")).openIssue.path,
    ).toBe(m.bun);
  } finally {
    m.done();
  }
});

test("--check fails on a key file others can read, and leaves it as it is", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    writeFileSync(join(home, ".linear", "api-key"), "lin_api_secret");
    chmodSync(join(home, ".linear", "api-key"), 0o644);
  });
  try {
    install(m);
    chmodSync(join(m.home, ".linear", "api-key"), 0o644);
    const report = install({ ...m, check: true });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("readable by others");
    expect(statSync(join(m.home, ".linear", "api-key")).mode & 0o777).toBe(
      0o644,
    );
  } finally {
    m.done();
  }
});

test("the command line refuses a --provider without a value and unknown arguments", () => {
  expect(parseArgs(["--provider"])).toBe("--provider needs a provider name");
  expect(parseArgs(["--provider", "--check"])).toBe(
    "--provider needs a provider name",
  );
  expect(parseArgs(["--chekc"])).toBe("unknown argument --chekc");
  expect(parseArgs(["--check", "--provider", "conductor"])).toEqual({
    check: true,
    dryRun: false,
    provider: "conductor",
  });
});

test("an entry with the same fields in another order is already the launcher", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear"));
    const { path, args, env } = desiredEntry(
      process.execPath,
      join(import.meta.dirname, "launch.ts"),
    );
    writeFileSync(
      tools(home),
      JSON.stringify({ openIssue: { env, args, path } }),
    );
  });
  try {
    const report = install({ ...m, check: true });
    expect(report.lines.join("\n")).toContain("already runs the launcher");
  } finally {
    m.done();
  }
});

test("a launcher script or bun path that is a directory is not ready", () => {
  const m = machine();
  try {
    const report = install({ ...m, bun: m.home, script: m.home, check: true });
    expect(report.ok).toBe(false);
    const text = report.lines.join("\n");
    expect(text).toContain(`${m.home} is not an executable file`);
    expect(text).toContain(`${m.home} is not a readable file`);
  } finally {
    m.done();
  }
});

test("a launcher script this process cannot read is not ready", () => {
  const m = machine();
  const script = join(m.home, "launch.ts");
  try {
    writeFileSync(script, "");
    chmodSync(script, 0o200);
    const report = install({ ...m, script, check: true });
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain(
      `${script} is not a readable file`,
    );
  } finally {
    m.done();
  }
});

test("an api-key that is a directory is reported, never chmodded", () => {
  const m = machine((home) => {
    mkdirSync(join(home, ".linear", "api-key"), { recursive: true });
    chmodSync(join(home, ".linear", "api-key"), 0o755);
  });
  try {
    const report = install(m);
    expect(report.ok).toBe(false);
    expect(report.lines.join("\n")).toContain("api-key is not a file");
    expect(statSync(join(m.home, ".linear", "api-key")).mode & 0o777).toBe(
      0o755,
    );
  } finally {
    m.done();
  }
});

test("a configuration path override is reported as invisible to the tracker", () => {
  const m = machine();
  try {
    const report = install({
      ...m,
      check: true,
      env: { JIG_LAUNCHER_CONFIG: join(m.home, "elsewhere.yaml") },
    });
    expect(report.lines.join("\n")).toContain(
      "the tracker starts the launcher without it",
    );
  } finally {
    m.done();
  }
});

import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { cloneCheckouts, primaryCheckout } from "../checkout.ts";
import { gitEnvironment } from "../git.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt } from "../types.ts";

const script = resolve(import.meta.dir, "../../jig.ts");
function setup() {
  const root = mkdtempSync(join(tmpdir(), "gc-integration-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const user = join(root, "home");
  mkdirSync(user);
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    HOME: user,
    USERPROFILE: user,
    JIG_HOME: join(user, ".jig"),
    JIG_USER_LAYER: undefined,
    JIG_CONSUMER_ROOT: undefined,
    JIG_GC_HEAVY_LOCK: undefined,
    RESOURCE_LOCK_BYPASS: "1",
    DRIVE_PR_STATE_DIR: undefined,
  };
  const command = (args: string[]) => {
    const result = Bun.spawnSync(args, {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    });
    expectSpawnExit(result, 0);
    return result.stdout.toString().trim();
  };
  command(["git", "init", "--initial-branch=main"]);
  command(["git", "config", "user.email", "test@example.invalid"]);
  command(["git", "config", "user.name", "Test"]);
  mkdirSync(join(repo, ".config"));
  const declaration = {
    kinds: ["scratch"],
    worktree_roots: [],
    scratch_prefixes: [join(root, "scratch-")],
  };
  writeFileSync(join(repo, ".config/jig.yaml"), dump({ gc: declaration }));
  command(["git", "add", "."]);
  command(["git", "commit", "-m", "fixture"]);
  const remote = join(root, "remote.git");
  command(["git", "clone", "--bare", repo, remote]);
  command(["git", "remote", "add", "origin", remote]);
  command([
    "git",
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const homeFile = join(user, ".jig", "jig.yaml");
  mkdirSync(join(user, ".jig"));
  const machine = {
    repositories: [
      {
        path: repo,
        remote: "origin",
        remote_url: remote,
        base_branch: "main",
        bounds: declaration,
      },
    ],
  };
  writeFileSync(homeFile, dump({ gc: machine }));
  return { root, repo, user, env, declaration, command, homeFile, machine };
}
function run(f: ReturnType<typeof setup>, args: string[], entry = script) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(entry), "gc", "bunfig.toml")}`,
      entry,
      "gc",
      ...args,
    ],
    {
      cwd: f.repo,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
}
test("collect ignores a widened checkout, environment and overlay file", () => {
  const f = setup();
  const scope = `${f.declaration.scratch_prefixes[0]}dead`;
  mkdirSync(scope);
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    "gc: {kinds: [tool-state], scratch_prefixes: ['/']}\n",
  );
  const overlay = join(f.root, "malicious.yaml");
  writeFileSync(overlay, "gc: {command: unsafe}\n");
  const result = Bun.spawnSync(
    [process.execPath, script, "gc", "--collect", "--repo", f.repo, "--json"],
    {
      cwd: f.repo,
      env: { ...f.env, JIG_OVERLAY: overlay, JIG__GC__KINDS: "[tool-state]" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.kinds.map((kind) => kind.name)).toEqual(["scratch"]);
  expect(receipt.kinds[0]?.declaration).toContain("refs/heads/main @");
  expect(receipt.resources[0]).toMatchObject({
    resource: scope,
    outcome: "finding",
  });
  expect(existsSync(scope)).toBe(true);
  const days = readdirSync(join(f.user, ".local", "state", "jig", "gc"));
  expect(days).toHaveLength(1);
});
test("uninstalled repositories refuse collection and persist the refusal", () => {
  const f = setup();
  writeFileSync(f.homeFile, "{}\n");
  const result = run(f, ["--collect", "--repo", f.repo, "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "finding",
    reason: expect.stringContaining("no confirmed machine entry"),
  });
});
test("a changed remote fails the inventory closed with exit 1", () => {
  const f = setup();
  f.command([
    "git",
    "remote",
    "set-url",
    "origin",
    join(f.root, "different.git"),
  ]);
  const result = run(f, ["--collect", "--repo", f.repo, "--json"]);
  expectSpawnExit(result, 1);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "unverified",
    reason: expect.stringContaining("remote URL changed"),
  });
});
test("a URL rewrite of the installed remote fails the inventory closed", () => {
  const f = setup();
  const remote = f.machine.repositories[0]?.remote_url as string;
  // The configured name still expands to the installed URL; only the fetch
  // of that URL is redirected.
  f.command(["git", "remote", "set-url", "origin", "alias:fixture"]);
  f.command(["git", "config", `url.${remote}.insteadOf`, "alias:fixture"]);
  f.command([
    "git",
    "config",
    `url.${join(f.root, "different.git")}.insteadOf`,
    remote,
  ]);
  const result = run(f, ["--collect", "--repo", f.repo, "--json"]);
  expectSpawnExit(result, 1);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "unverified",
    reason: expect.stringContaining("insteadOf"),
  });
});
test("install previews without writing a machine file or job", () => {
  const f = setup();
  const previous = readFileSync(f.homeFile, "utf8");
  const result = run(f, ["install", "--repo", f.repo]);
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("Preview only");
  expect(result.stdout.toString()).toContain("Scheduler preview");
  if (process.platform !== "win32")
    expect(result.stdout.toString()).toContain("--scheduled");
  expect(readFileSync(f.homeFile, "utf8")).toBe(previous);
  expect(existsSync(join(f.user, "Library", "LaunchAgents"))).toBe(false);
});
test("install proposes the configured remote, not origin", () => {
  const f = setup();
  f.command(["git", "remote", "rename", "origin", "upstream"]);
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    dump({ gc: f.declaration, repository: { remote: "upstream" } }),
  );
  const result = run(f, ["install", "--repo", f.repo]);
  expectSpawnExit(result, 0);
  const preview = result.stdout.toString();
  expect(preview).toContain("remote: upstream");
  expect(preview).toContain("base_branch: main");
  expect(preview).not.toContain("remote: origin");
});
test("install takes the repository's base branch without reading the remote's HEAD", () => {
  const f = setup();
  f.command(["git", "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    dump({ gc: f.declaration, repository: { base_branch: "main" } }),
  );
  // The environment layer clears the value collection reads; install still
  // proposes the one the repository file declares.
  const result = run(
    { ...f, env: { ...f.env, JIG__REPOSITORY__BASE_BRANCH: "null" } },
    ["install", "--repo", f.repo],
  );
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("base_branch: main");
});
test("install from a linked worktree registers the primary checkout and resolves roots from it", () => {
  const f = setup();
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    dump({ gc: { ...f.declaration, worktree_roots: ["../worktrees"] } }),
  );
  f.command(["git", "commit", "-am", "declare a relative root"]);
  f.command(["git", "push", "origin", "main"]);
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  const result = run(f, ["install", "--repo", linked]);
  expectSpawnExit(result, 0);
  const preview = result.stdout.toString();
  const primary = realpathSync(f.repo);
  expect(preview).toContain(`path: ${primary}`);
  expect(preview).toContain(`- ${join(dirname(primary), "worktrees")}`);
  expect(preview).not.toContain(`path: ${linked}`);
});
test("a primary checkout whose path holds a newline is read whole", async () => {
  if (process.platform === "win32") return;
  const f = setup();
  const primary = join(f.root, "jig\ncheckout");
  f.command(["git", "clone", f.repo, primary]);
  const linked = join(f.root, "linked");
  expectSpawnExit(
    Bun.spawnSync(["git", "worktree", "add", "-b", "linked", linked], {
      cwd: primary,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    }),
    0,
  );
  const checkouts = await cloneCheckouts(linked);
  expect(checkouts.primary).toBe(realpathSync(primary));
  expect(primaryCheckout(linked, checkouts)).toBe(realpathSync(primary));
});
test("collect from a linked worktree selects the primary checkout's entry", () => {
  const f = setup();
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  const result = run(f, ["--collect", "--repo", linked, "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.kinds.map((kind) => kind.name)).toEqual(["scratch"]);
  expect(JSON.stringify(receipt)).not.toContain("no confirmed machine entry");
});
test("collect from a checkout Git cannot read fails the inventory with exit 1", () => {
  const f = setup();
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(f.root, "missing")}\n`);
  const result = run(f, ["--collect", "--repo", linked, "--json"]);
  expectSpawnExit(result, 1);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "unverified",
    reason: expect.stringContaining("Cannot identify the clone"),
  });
  expect(JSON.stringify(receipt)).not.toContain("no confirmed machine entry");
});
test("collect from a checkout whose .git is a dangling link fails the inventory", () => {
  if (process.platform === "win32") return;
  const f = setup();
  const broken = mkdtempSync(join(tmpdir(), "gc-dangling-git-"));
  symlinkSync(join(broken, "missing"), join(broken, ".git"));
  const result = run(f, ["--collect", "--repo", broken, "--json"]);
  expectSpawnExit(result, 1);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "unverified",
    reason: expect.stringContaining("Cannot identify the clone"),
  });
});
test("collect from a path that is no checkout reports a missing entry", () => {
  const f = setup();
  const elsewhere = mkdtempSync(join(tmpdir(), "gc-not-a-clone-"));
  const result = run(f, ["--collect", "--repo", elsewhere, "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources[0]).toMatchObject({
    outcome: "finding",
    reason: expect.stringContaining("no confirmed machine entry"),
  });
});
test("install replaces and uninstall removes an entry naming a linked worktree", () => {
  const f = setup();
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  const legacy = { ...f.machine.repositories[0], path: linked };
  writeFileSync(f.homeFile, dump({ gc: { repositories: [legacy] } }));
  const install = run(f, ["install", "--repo", linked]);
  expectSpawnExit(install, 0);
  const preview = install.stdout.toString();
  expect(preview).toContain(`Replacing the entry for ${linked}`);
  expect(preview).toContain(`path: ${realpathSync(f.repo)}`);
  expect(preview).not.toContain(`path: ${linked}`);
  const uninstall = run(f, ["install", "--repo", linked, "--uninstall"]);
  expectSpawnExit(uninstall, 0);
  expect(uninstall.stdout.toString()).toContain("repositories: []");
});
test("uninstall refuses a checkout Git cannot read that no entry names", () => {
  const f = setup();
  const elsewhere = mkdtempSync(join(tmpdir(), "gc-not-a-clone-"));
  const result = run(f, ["install", "--repo", elsewhere, "--uninstall"]);
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("Cannot identify the clone");
});
test("an entry spelling the clone through a symbolic link is the same clone", () => {
  if (process.platform === "win32") return;
  const f = setup();
  const alias = join(f.root, "alias");
  symlinkSync(f.repo, alias);
  const aliased = { ...f.machine.repositories[0], path: alias };
  writeFileSync(f.homeFile, dump({ gc: { repositories: [aliased] } }));
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  const collect = run(f, ["--collect", "--repo", linked, "--json"]);
  expectSpawnExit(collect, 0);
  expect(collect.stdout.toString()).not.toContain("no confirmed machine entry");
  const install = run(f, ["install", "--repo", linked]);
  expectSpawnExit(install, 0);
  const preview = install.stdout.toString();
  expect(preview).toContain(`Replacing the entry for ${alias}`);
  expect(preview.split("\n").filter((line) => /\bpath: /.test(line))).toEqual([
    expect.stringContaining(`path: ${realpathSync(f.repo)}`),
  ]);
});
test("machine-wide uninstall identifies no clone, so it runs from any directory", () => {
  const f = setup();
  const elsewhere = mkdtempSync(join(tmpdir(), "gc-not-a-clone-"));
  const result = run(f, [
    "install",
    "--repo",
    elsewhere,
    "--uninstall",
    "--machine",
  ]);
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("repositories: []");
});
test("a report from a linked worktree reads that checkout's own declaration", () => {
  const f = setup();
  const linked = join(f.root, "linked");
  f.command(["git", "worktree", "add", "-b", "linked", linked]);
  const result = run(f, ["--repo", linked, "--json"]);
  expectSpawnExit(result, 0);
  const text = result.stdout.toString();
  expect(text).toContain(`${linked}/.config/jig.yaml (checkout; report only)`);
  expect(text).not.toContain(`${f.repo}/.config/jig.yaml`);
});
test("uninstall reads only machine policy, so a broken checkout cannot block it", () => {
  const f = setup();
  writeFileSync(join(f.repo, ".config/jig.yaml"), "gc: {kinds: [unknown]}\n");
  const result = run(f, ["install", "--repo", f.repo, "--uninstall"]);
  expectSpawnExit(result, 0);
  expect(result.stdout.toString()).toContain("Preview only");
});
test("the command runs from a copied plugin with no node_modules", () => {
  const f = setup();
  const cache = join(f.root, "cache");
  cpSync(resolve(import.meta.dir, "../.."), cache, {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  const result = run(
    f,
    ["--repo", f.repo, "--kind", "scratch", "--json"],
    join(cache, "jig.ts"),
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString()).kinds[0].name).toBe("scratch");
});
test("bad configuration and arguments return exit 2", () => {
  const f = setup();
  expectSpawnExit(run(f, ["--kind", "missing"]), 2);
  writeFileSync(join(f.repo, ".config/jig.yaml"), "gc: {command: unsafe}\n");
  expectSpawnExit(run(f, ["--repo", f.repo]), 2);
});

test("trusted startup prevents a checkout preload and environment file from executing", () => {
  const f = setup();
  const marker = join(f.root, "preload-ran");
  writeFileSync(join(f.repo, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  writeFileSync(
    join(f.repo, "preload.ts"),
    `await Bun.write(${JSON.stringify(marker)}, "executed");`,
  );
  writeFileSync(
    join(f.repo, ".env"),
    "GH_REPO=wrong/repository\nJIG__GC__KINDS=[tool-state]\n",
  );
  const result = run(f, ["--collect", "--repo", f.repo, "--json"]);
  expectSpawnExit(result, 0);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(result.stdout.toString()).kinds[0].name).toBe("scratch");
});

test("scope creation records the subprocess identity in every nested scope", () => {
  const f = setup();
  const source = `import { scopeTestTmpdir } from ${JSON.stringify(resolve(import.meta.dir, "../../../lib/test-tmpdir.ts"))};
    import { readFileSync } from "node:fs"; import { join } from "node:path";
    const first = scopeTestTmpdir(); const second = scopeTestTmpdir();
    const records = [first, second].map((scope) => JSON.parse(readFileSync(join(scope.root, ".jig-scratch-owner.json"), "utf8")));
    console.log(JSON.stringify({ records, pid: process.pid })); second.release(); first.release();`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    { cwd: f.repo, env: f.env, stdout: "pipe", stderr: "pipe", timeout: 30000 },
  );
  expectSpawnExit(result, 0);
  const value = JSON.parse(result.stdout.toString());
  expect(value.records).toHaveLength(2);
  for (const record of value.records)
    expect(record).toMatchObject({
      version: 1,
      pid: value.pid,
      start: expect.any(String),
    });
});

/**
 * Agent-tool fakes that list the plugin as installed at `installPath` (or not
 * installed), as `claude plugin list --json` and `codex plugin list --json`
 * answer; the job asks them where the plugin is at each run.
 */
function writeAgentTools(bin: string, installPath: string | null): void {
  writeFakeProgram(
    join(bin, "claude"),
    `#!/usr/bin/env bun
console.log(JSON.stringify(${JSON.stringify(installPath === null ? [] : [{ id: "jig@jig", scope: "user", installPath }])}));
`,
  );
  writeFakeProgram(
    join(bin, "codex"),
    `#!/usr/bin/env bun
console.log(JSON.stringify({ installed: [] }));
`,
  );
}
/**
 * The scheduler variants the install round trip runs under: launchd on macOS;
 * on Linux both systemd and cron, chosen by whether the user manager's socket
 * exists under `XDG_RUNTIME_DIR`.
 */
const schedulerVariants =
  process.platform === "linux" ? ["systemd", "cron"] : [process.platform];

test
  .skipIf(
    skipsOnWindows(
      "powershell",
      "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
    ),
  )
  .each(schedulerVariants)(
  "confirmed install preserves unrelated settings and uninstall removes only its job (%s)",
  (variant) => {
    const f = setup();
    const cache = join(f.root, "installed");
    cpSync(resolve(import.meta.dir, "../.."), cache, {
      recursive: true,
      filter: (source) => !source.includes("__tests__"),
    });
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const log = join(f.root, "scheduler-calls.jsonl"),
      cron = join(f.root, "crontab"),
      loaded = join(f.root, "loaded"),
      enabled = join(f.root, "enabled"),
      timer = join(f.user, ".config/systemd/user/jig-gc.timer");
    const runtime = join(f.root, "runtime");
    mkdirSync(join(runtime, "systemd"), { recursive: true });
    if (variant === "systemd")
      writeFileSync(join(runtime, "systemd", "private"), "");
    f.env.XDG_RUNTIME_DIR = runtime;
    const source = (name: string) => `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program:${JSON.stringify(name)},args })+"\\n");
if (${JSON.stringify(name)} === "launchctl") {
  if(args[0]==="print") process.exit(existsSync(${JSON.stringify(loaded)})?0:113);
  if(args[0]==="bootstrap") writeFileSync(${JSON.stringify(loaded)},"loaded");
  if(args[0]==="bootout") rmSync(${JSON.stringify(loaded)},{force:true});
}
if (${JSON.stringify(name)} === "systemctl") {
  if(args[1]==="show") console.log("LoadState=" + (existsSync(${JSON.stringify(timer)})?"loaded":"not-found") + "\\nUnitFileState=" + (existsSync(${JSON.stringify(enabled)})?"enabled":"disabled") + "\\nActiveState=" + (existsSync(${JSON.stringify(loaded)})?"active":"inactive"));
  if(args[1]==="enable") { writeFileSync(${JSON.stringify(enabled)},""); if(args.includes("--now")) writeFileSync(${JSON.stringify(loaded)},""); }
  if(args[1]==="disable") { rmSync(${JSON.stringify(enabled)},{force:true}); rmSync(${JSON.stringify(loaded)},{force:true}); }
}
if (${JSON.stringify(name)} === "crontab") {
  if(args[0]==="-l") { if(!existsSync(${JSON.stringify(cron)})) { console.error("no crontab"); process.exit(1); } process.stdout.write(readFileSync(${JSON.stringify(cron)},"utf8")); }
  else writeFileSync(${JSON.stringify(cron)}, await Bun.stdin.text());
}
`;
    for (const name of ["launchctl", "systemctl", "crontab"])
      writeFakeProgram(join(bin, name), source(name));
    writeAgentTools(bin, cache);
    const homeText = readFileSync(f.homeFile, "utf8");
    writeFileSync(f.homeFile, `${homeText}personal_setting: preserved\n`);
    f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
    const entry = join(cache, "jig.ts");
    // A lock wait the heavy-run lock would refuse is refused before any write.
    f.env.LOCK_TIMEOUT = "soon";
    const before = readFileSync(f.homeFile, "utf8");
    const refused = run(f, ["install", "--repo", f.repo, "--yes"], entry);
    expectSpawnExit(refused, 1);
    expect(refused.stderr.toString()).toContain("LOCK_TIMEOUT must be");
    expect(readFileSync(f.homeFile, "utf8")).toBe(before);
    f.env.LOCK_TIMEOUT = "60";
    const installed = run(f, ["install", "--repo", f.repo, "--yes"], entry);
    expectSpawnExit(installed, 0);
    expect(readFileSync(f.homeFile, "utf8")).toContain(
      "personal_setting: preserved",
    );
    const jobs: Record<string, string> = {
      darwin: join(f.user, "Library/LaunchAgents/dev.jig.gc.plist"),
      systemd: join(f.user, ".config/systemd/user/jig-gc.service"),
      cron,
    };
    const job = jobs[variant] as string;
    const content = readFileSync(job, "utf8");
    // The job names the launcher, never the plugin release that installed it.
    const launcher = join(f.user, ".local/state/jig/gc/launcher");
    expect(content).toContain("--no-env-file");
    expect(content).toContain(join(launcher, "bunfig.toml"));
    expect(content).toContain(join(launcher, "launcher.ts"));
    expect(content).not.toContain(cache);
    expect(content).toContain(`--claude=${join(bin, "claude")}`);
    // The job waits for the lock, and bounds its run, as configured at install.
    expect(content).toMatch(/LOCK_TIMEOUT(<\/key><string>|=)60\b/);
    expect(existsSync(join(launcher, "launcher.ts"))).toBe(true);
    expect(existsSync(join(launcher, "bunfig.toml"))).toBe(true);
    if (variant !== "cron") expect(existsSync(loaded)).toBe(true);
    const removed = run(
      f,
      ["install", "--repo", f.repo, "--uninstall", "--machine", "--yes"],
      entry,
    );
    expectSpawnExit(removed, 0);
    expect(readFileSync(f.homeFile, "utf8")).toContain(
      "personal_setting: preserved",
    );
    expect(existsSync(launcher)).toBe(false);
    if (variant === "cron")
      expect(readFileSync(cron, "utf8")).not.toContain("# jig-gc");
    else {
      expect(existsSync(job)).toBe(false);
      expect(existsSync(loaded)).toBe(false);
    }
  },
);

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)("a failed scheduler update restores the machine configuration", () => {
  const f = setup();
  const cache = join(f.root, "installed");
  cpSync(resolve(import.meta.dir, "../.."), cache, {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  for (const name of ["launchctl", "systemctl", "crontab"])
    writeFakeProgram(
      join(bin, name),
      // Prior state reads as absent; every change fails.
      `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "print") process.exit(113);
if (args[1] === "show") { console.log("LoadState=not-found\\nUnitFileState=\\nActiveState=inactive"); process.exit(0); }
console.error("no crontab: scheduler unavailable");
process.exit(1);
`,
    );
  writeAgentTools(bin, cache);
  f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
  writeFileSync(f.homeFile, dump({ gc: { repositories: [] } }));
  const previous = readFileSync(f.homeFile, "utf8");
  const result = run(
    f,
    ["install", "--repo", f.repo, "--yes"],
    join(cache, "jig.ts"),
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("machine configuration");
  expect(readFileSync(f.homeFile, "utf8")).toBe(previous);
});

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)("install refuses a job whose launcher could not find the plugin", () => {
  const f = setup();
  const cache = join(f.root, "installed");
  cpSync(resolve(import.meta.dir, "../.."), cache, {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeAgentTools(bin, null);
  const previous = readFileSync(f.homeFile, "utf8");
  f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
  const result = run(
    f,
    ["install", "--repo", f.repo, "--yes"],
    join(cache, "jig.ts"),
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("jig@jig is not installed");
  expect(readFileSync(f.homeFile, "utf8")).toBe(previous);
  expect(
    existsSync(join(f.user, ".local/state/jig/gc/launcher/launcher.ts")),
  ).toBe(false);
});

/**
 * Scheduler fakes that refuse to start a job built by this install, so the
 * update fails after replacing the previous job's files. systemd keeps the
 * timer's enablement and activity as two independent markers.
 */
function restoringFake(
  name: string,
  paths: { cron: string; enabled: string; active: string; units: string },
): string {
  const { cron, enabled, active, units } = paths;
  return `#!/usr/bin/env bun
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const refuse = (text) => { if (text.includes("--scheduled")) { console.error("refused"); process.exit(1); } };
if (${JSON.stringify(name)} === "crontab") {
  if (args[0] === "-l") process.stdout.write(readFileSync(${JSON.stringify(cron)}, "utf8"));
  else { const text = await Bun.stdin.text(); refuse(text); writeFileSync(${JSON.stringify(cron)}, text); }
}
if (${JSON.stringify(name)} === "launchctl") {
  if (args[0] === "print") process.exit(existsSync(${JSON.stringify(active)}) ? 0 : 113);
  if (args[0] === "bootout") rmSync(${JSON.stringify(active)}, { force: true });
  if (args[0] === "bootstrap") { refuse(readFileSync(args[2], "utf8")); writeFileSync(${JSON.stringify(active)}, ""); }
}
if (${JSON.stringify(name)} === "systemctl") {
  if (args[1] === "show") console.log("LoadState=loaded\\nUnitFileState=" + (existsSync(${JSON.stringify(enabled)}) ? "enabled" : "disabled") + "\\nActiveState=" + (existsSync(${JSON.stringify(active)}) ? "active" : "inactive"));
  if (args[1] === "disable") { rmSync(${JSON.stringify(enabled)}, { force: true }); rmSync(${JSON.stringify(active)}, { force: true }); }
  if (args[1] === "enable") { refuse(readFileSync(${JSON.stringify(join(units, "jig-gc.service"))}, "utf8")); writeFileSync(${JSON.stringify(enabled)}, ""); if (args.includes("--now")) writeFileSync(${JSON.stringify(active)}, ""); }
  if (args[1] === "start") writeFileSync(${JSON.stringify(active)}, "");
}
`;
}

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)("a failed scheduler update restores the job that was running before", () => {
  const f = setup();
  const cache = join(f.root, "installed");
  cpSync(resolve(import.meta.dir, "../.."), cache, {
    recursive: true,
    filter: (source) => !source.includes("__tests__"),
  });
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  const cron = join(f.root, "crontab"),
    enabled = join(f.root, "enabled"),
    active = join(f.root, "active");
  const plist = join(f.user, "Library/LaunchAgents/dev.jig.gc.plist");
  const units = join(f.user, ".config/systemd/user");
  for (const name of ["launchctl", "systemctl", "crontab"])
    writeFakeProgram(
      join(bin, name),
      restoringFake(name, { cron, enabled, active, units }),
    );
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(units, { recursive: true });
  const previous = {
    [plist]: "previous launchd job\n",
    [join(units, "jig-gc.service")]: "previous service\n",
    [join(units, "jig-gc.timer")]: "previous timer\n",
    [cron]: "0 4 * * * previous-job # jig-gc\n",
  };
  // The launcher the previous job runs, which this install replaces.
  const launcher = join(f.user, ".local/state/jig/gc/launcher");
  mkdirSync(launcher, { recursive: true });
  previous[join(launcher, "launcher.ts")] = "previous launcher\n";
  previous[join(launcher, "bunfig.toml")] = "previous bunfig\n";
  for (const [path, text] of Object.entries(previous))
    writeFileSync(path, text);
  writeFileSync(enabled, "");
  writeFileSync(active, "");
  writeAgentTools(bin, cache);
  f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
  const result = run(
    f,
    ["install", "--repo", f.repo, "--yes"],
    join(cache, "jig.ts"),
  );
  expectSpawnExit(result, 1);
  expect(result.stderr.toString()).toContain("previous scheduler job restored");
  for (const [path, text] of Object.entries(previous))
    expect(readFileSync(path, "utf8")).toBe(text);
  expect(existsSync(active)).toBe(true);
});

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)(
  "removing one repository keeps the job and launcher, without finding the plugin",
  () => {
    const f = setup();
    const cache = join(f.root, "installed");
    cpSync(resolve(import.meta.dir, "../.."), cache, {
      recursive: true,
      filter: (source) => !source.includes("__tests__"),
    });
    const bin = join(f.root, "bin");
    mkdirSync(bin);
    const calls = join(f.root, "scheduler-calls");
    for (const name of ["launchctl", "systemctl", "crontab"])
      writeFakeProgram(
        join(bin, name),
        // The job the remaining repository runs must not be read or rewritten.
        `#!/usr/bin/env bun
require("node:fs").appendFileSync(${JSON.stringify(calls)}, "${name}\\n");
process.exit(1);
`,
      );
    const launcher = join(
      f.env.HOME as string,
      ".local",
      "state",
      "jig",
      "gc",
      "launcher",
    );
    mkdirSync(launcher, { recursive: true });
    writeFileSync(
      join(launcher, "launcher.ts"),
      "// the running job's launcher\n",
    );
    writeAgentTools(bin, null);
    f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
    const other = { ...f.machine.repositories[0], path: join(f.root, "other") };
    writeFileSync(
      f.homeFile,
      dump({ gc: { repositories: [...f.machine.repositories, other] } }),
    );
    const result = run(
      f,
      ["install", "--repo", f.repo, "--uninstall", "--yes"],
      join(cache, "jig.ts"),
    );
    expectSpawnExit(result, 0);
    const text = readFileSync(f.homeFile, "utf8");
    expect(text).toContain(other.path);
    expect(text).not.toContain(`path: ${f.repo}\n`);
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(join(launcher, "launcher.ts"), "utf8")).toBe(
      "// the running job's launcher\n",
    );
  },
);

test("tool-state delegates to the native reaper in report mode", () => {
  const f = setup();
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    "gc: {kinds: [tool-state]}\n",
  );
  const result = run(f, ["--repo", f.repo, "--kind", "tool-state", "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString());
  expect(receipt.resources).toHaveLength(1);
  expect(receipt.resources[0].kind).toBe("tool-state");
  expect(receipt.resources[0].outcome).toBe("refused");
  expect(receipt.resources[0].details.retire).toEqual([]);
});

test("worktree reports detect untracked content even when Git hides it by default", () => {
  const f = setup();
  const tree = join(f.root, "worktrees", "topic");
  f.command(["git", "worktree", "add", "-b", "topic", tree]);
  f.command(["git", "config", "status.showUntrackedFiles", "no"]);
  writeFileSync(join(tree, "personal-note.txt"), "keep");
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    dump({
      gc: { kinds: ["worktrees"], worktree_roots: [join(f.root, "worktrees")] },
    }),
  );
  const result = run(f, ["--repo", f.repo, "--kind", "worktrees", "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString());
  expect(receipt.resources[0]).toMatchObject({
    resource: realpathSync.native(tree),
    outcome: "refused",
    reason: "uncommitted or untracked changes",
  });
  expect(existsSync(join(tree, "personal-note.txt"))).toBe(true);
});

test("worktree index flags cannot hide edits from the report", () => {
  const f = setup();
  const tree = join(f.root, "worktrees", "topic");
  f.command(["git", "worktree", "add", "-b", "topic", tree]);
  f.command([
    "git",
    "-C",
    tree,
    "update-index",
    "--assume-unchanged",
    ".config/jig.yaml",
  ]);
  writeFileSync(join(tree, ".config/jig.yaml"), "personal: changes\n");
  writeFileSync(
    join(f.repo, ".config/jig.yaml"),
    dump({
      gc: { kinds: ["worktrees"], worktree_roots: [join(f.root, "worktrees")] },
    }),
  );
  const result = run(f, ["--repo", f.repo, "--kind", "worktrees", "--json"]);
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString()).resources[0]).toMatchObject({
    outcome: "refused",
    reason: "index flags hide possible changes from git status",
  });
});
test("collecting receipts alone never fetches a registered repository", () => {
  const f = setup();
  writeFileSync(
    f.homeFile,
    dump({
      gc: {
        repositories: f.machine.repositories.map((entry) => ({
          ...entry,
          remote_url: join(f.root, "missing.git"),
        })),
        receipts: true,
      },
    }),
  );
  const result = run(f, ["--collect", "--kind", "receipts", "--json"]);
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.kinds.map((kind) => kind.name)).toEqual(["receipts"]);
});

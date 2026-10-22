import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
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

test.skipIf(
  skipsOnWindows(
    "powershell",
    "GC scheduler installation supports launchd, systemd and cron on macOS/Linux",
  ),
)(
  "confirmed install preserves unrelated settings and uninstall removes only its job",
  () => {
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
      loaded = join(f.root, "loaded");
    const source = (name: string) => `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)}, JSON.stringify({ program:${JSON.stringify(name)},args })+"\\n");
if (${JSON.stringify(name)} === "launchctl") {
  if(args[0]==="print") process.exit(existsSync(${JSON.stringify(loaded)})?0:1);
  if(args[0]==="bootstrap") writeFileSync(${JSON.stringify(loaded)},"loaded");
  if(args[0]==="bootout") rmSync(${JSON.stringify(loaded)},{force:true});
}
if (${JSON.stringify(name)} === "crontab") {
  if(args[0]==="-l") { if(!existsSync(${JSON.stringify(cron)})) { console.error("no crontab"); process.exit(1); } process.stdout.write(readFileSync(${JSON.stringify(cron)},"utf8")); }
  else writeFileSync(${JSON.stringify(cron)}, await Bun.stdin.text());
}
`;
    for (const name of ["launchctl", "systemctl", "crontab"])
      writeFakeProgram(join(bin, name), source(name));
    const homeText = readFileSync(f.homeFile, "utf8");
    writeFileSync(f.homeFile, `${homeText}personal_setting: preserved\n`);
    f.env.PATH = `${bin}${delimiter}${f.env.PATH}`;
    const entry = join(cache, "jig.ts");
    const installed = run(f, ["install", "--repo", f.repo, "--yes"], entry);
    expectSpawnExit(installed, 0);
    expect(readFileSync(f.homeFile, "utf8")).toContain(
      "personal_setting: preserved",
    );
    const candidates = [
      join(f.user, "Library/LaunchAgents/dev.jig.gc.plist"),
      join(f.user, ".config/systemd/user/jig-gc.service"),
      cron,
    ];
    const job = candidates.find(existsSync);
    expect(job).toBeDefined();
    const content = readFileSync(job as string, "utf8");
    expect(content).toContain("--no-env-file");
    expect(content).toContain("bunfig.toml");
    expect(content).toContain(entry);
    const removed = run(
      f,
      ["install", "--repo", f.repo, "--uninstall", "--machine", "--yes"],
      entry,
    );
    expectSpawnExit(removed, 0);
    expect(readFileSync(f.homeFile, "utf8")).toContain(
      "personal_setting: preserved",
    );
    for (const path of candidates.filter((path) => path !== cron))
      expect(existsSync(path)).toBe(false);
    if (existsSync(cron))
      expect(readFileSync(cron, "utf8")).not.toContain("# jig-gc");
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
      `#!/usr/bin/env bun
console.error("no crontab: scheduler unavailable");
process.exit(1);
`,
    );
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
    resource: realpathSync(tree),
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

/**
 * The worktrees kind against a fake `orca` command: an Orca-managed checkout
 * is told from a plain one, Orca's registry joins its idle proof, and
 * collection runs through Orca (remove hook, park, `orca worktree rm`).
 *
 * The forge repository is derived from the remote URL, so the fixture remote
 * is `fakeforge:acme/app.git`, served from a local bare clone through an SSH
 * command the repository configures; `gh` is a fake answering the merged pull
 * request, and `lsof` a fake reporting no process holding the worktree, so the
 * proof does not depend on what else the machine has mounted.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import { gitEnvironment } from "../git.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt, ReceiptLine } from "../types.ts";

const script = resolve(import.meta.dir, "../../jig.ts");
const REMOTE = "fakeforge:acme/app.git";
const DAY_MS = 86_400_000;

interface OrcaRow {
  id: string;
  path: string;
  agents: { state: string }[];
}
interface OrcaState {
  repo: string;
  worktrees: OrcaRow[];
  /** Subcommands (`list`, `ps`, `rm`) that fail. */
  fail: string[];
}

/** A fake `orca` reading and writing its registry in `state.json`. */
function fakeOrca(bin: string, root: string): string {
  return writeFakeProgram(
    join(bin, "orca"),
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const file = ${JSON.stringify(join(root, "orca-state.json"))};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "orca-calls"))}, args.join(" ") + "\\n");
const state = JSON.parse(readFileSync(file, "utf8"));
const sub = args[1];
const answer = (result) => { console.log(JSON.stringify({ ok: true, result })); process.exit(0); };
const refuse = (code) => { console.log(JSON.stringify({ ok: false, error: { code, message: code } })); process.exit(1); };
if (state.fail.includes(sub)) { console.error("orca: runtime unavailable"); process.exit(1); }
const value = (flag) => args[args.indexOf(flag) + 1];
if (sub === "list") {
  if (value("--repo") !== "path:" + state.repo) refuse("repo_not_found");
  answer({ worktrees: state.worktrees.map(({ id, path }) => ({ id, path })), totalCount: state.worktrees.length, truncated: false });
}
if (sub === "ps")
  answer({ worktrees: state.worktrees.map(({ path, agents }) => ({ path, agents })), totalCount: state.worktrees.length, truncated: false });
if (sub === "rm") {
  const id = value("--worktree").replace(/^id:/, "");
  const row = state.worktrees.find((entry) => entry.id === id);
  if (!row) refuse("selector_not_found");
  const removed = Bun.spawnSync(["git", "-C", state.repo, "worktree", "remove", row.path]);
  if (removed.exitCode !== 0) refuse("worktree_dirty");
  state.worktrees = state.worktrees.filter((entry) => entry !== row);
  writeFileSync(file, JSON.stringify(state));
  answer({ removed: true });
}
refuse("unknown_command");
`,
  );
}

function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gc-orca-")));
  const repo = join(root, "repo");
  const user = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, user, bin, join(root, "forge", "acme")])
    mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    HOME: user,
    USERPROFILE: user,
    JIG_HOME: join(user, ".jig"),
    JIG_USER_LAYER: undefined,
    JIG_CONSUMER_ROOT: undefined,
    JIG_GC_HEAVY_LOCK: undefined,
    RESOURCE_LOCK_BYPASS: "1",
    ORCA_CLI_COMMAND: undefined,
    ORCA_CLI_BIN_DIR: undefined,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const command = (args: string[], cwd = repo): string => {
    const result = Bun.spawnSync(args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    expectSpawnExit(result, 0);
    return result.stdout.toString().trim();
  };
  // The fixture remote: SSH to `fakeforge` runs the command in the forge.
  const ssh = join(bin, "fake-ssh");
  writeFileSync(
    ssh,
    `#!/bin/sh\nfor last; do :; done\ncd ${JSON.stringify(join(root, "forge"))} && exec sh -c "$last"\n`,
  );
  chmodSync(ssh, 0o755);
  command(["git", "init", "--bare", join(root, "forge", "acme", "app.git")]);
  command(["git", "init", "--initial-branch=main"]);
  command(["git", "config", "user.email", "test@example.invalid"]);
  command(["git", "config", "user.name", "Test"]);
  command(["git", "config", "core.sshCommand", ssh]);
  const roots = join(root, "worktrees");
  const declaration = {
    kinds: ["worktrees"],
    worktree_roots: [roots],
    scratch_prefixes: [],
  };
  mkdirSync(join(repo, ".config", "worktree-hooks"), { recursive: true });
  writeFileSync(join(repo, ".config/jig.yaml"), dump({ gc: declaration }));
  writeFileSync(
    join(repo, ".config/worktree-hooks/remove"),
    `#!/bin/sh\necho "removing $(pwd)" > ${JSON.stringify(join(root, "hook-ran"))}\n[ -x "$(dirname "$0")/helper.sh" ] && "$(dirname "$0")/helper.sh"\nexit 0\n`,
  );
  chmodSync(join(repo, ".config/worktree-hooks/remove"), 0o755);
  command(["git", "add", "."]);
  command(["git", "commit", "-m", "fixture"]);
  command(["git", "remote", "add", "origin", REMOTE]);
  command(["git", "push", "origin", "main"]);
  command(["git", "fetch", "origin"]);
  command([
    "git",
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const tree = join(roots, "topic");
  command(["git", "worktree", "add", "-b", "topic", tree]);
  command(["git", "push", "origin", "topic"]);
  /** The fake `gh` answering a merged pull request at the checkout's current head. */
  const refreshGh = (): void => {
    const head = command(["git", "-C", tree, "rev-parse", "HEAD"]);
    writeFakeProgram(
      join(bin, "gh"),
      `#!/usr/bin/env bun
console.log(JSON.stringify([{ state: "MERGED", headRefOid: ${JSON.stringify(head)}, headRepository: { name: "app" }, headRepositoryOwner: { login: "acme" } }]));
`,
    );
  };
  refreshGh();
  writeFakeProgram(join(bin, "lsof"), "#!/bin/sh\nexit 1\n");
  const orca = fakeOrca(bin, root);
  const machine = {
    repositories: [
      {
        path: repo,
        remote: "origin",
        remote_url: REMOTE,
        base_branch: "main",
        bounds: declaration,
      },
    ],
    orca: { command: orca },
  };
  mkdirSync(join(user, ".jig"));
  writeFileSync(join(user, ".jig", "jig.yaml"), dump({ gc: machine }));
  const id = `repo-1::${tree}`;
  const writeState = (state: Partial<OrcaState>): void =>
    writeFileSync(
      join(root, "orca-state.json"),
      JSON.stringify({
        repo,
        worktrees: [{ id, path: tree, agents: [{ state: "done" }] }],
        fail: [],
        ...state,
      }),
    );
  writeState({});
  return {
    root,
    repo,
    tree,
    id,
    env,
    command,
    writeState,
    makeIdle,
    refreshGh,
  };
}

/** Every entry of the worktree and its git directory, eight days old. */
function makeIdle(tree: string, admin: string): void {
  const then = new Date(Date.now() - 8 * DAY_MS);
  const age = (path: string): void => {
    if (lstatSync(path).isDirectory())
      for (const entry of readdirSync(path)) age(join(path, entry));
    if (!lstatSync(path).isSymbolicLink()) utimesSync(path, then, then);
  };
  age(tree);
  age(admin);
}

function gc(
  f: ReturnType<typeof setup>,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${join(dirname(script), "gc", "bunfig.toml")}`,
      script,
      "gc",
      "--repo",
      f.repo,
      "--kind",
      "worktrees",
      ...args,
    ],
    {
      cwd: f.repo,
      env: { ...f.env, ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    },
  );
}

function line(result: ReturnType<typeof gc>): ReceiptLine {
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources).toHaveLength(1);
  return receipt.resources[0] as ReceiptLine;
}

function idle(f: ReturnType<typeof setup>): void {
  makeIdle(f.tree, join(f.repo, ".git", "worktrees", "topic"));
}

const FINDING_TITLE = "The setup step assumed a running database";

/** Note one reflection finding in the checkout's journal, through the reflect skill's own command. */
function noteFinding(f: ReturnType<typeof setup>): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../../skills/reflect/scripts/journal.ts"),
      "note",
    ],
    {
      cwd: f.tree,
      env: {
        ...f.env,
        JIG_CONSUMER_ROOT: f.tree,
        JIG__REFLECTION__ENABLED: "true",
      },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          kind: "error",
          severity: "medium",
          class: "instruction-missing-precondition",
          target: { scope: "repository", name: "AGENTS.md" },
          title: FINDING_TITLE,
          description:
            "The instructions never say the database must be started first.",
          suggested_fix: "Add the start command to the setup section.",
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    },
  );
  expectSpawnExit(result, 0);
}

/** Everything under the machine's pending directory, where parked findings go. */
function pendingText(f: ReturnType<typeof setup>): string {
  const base = join(f.env.JIG_HOME as string, "pending");
  if (!existsSync(base)) return "";
  const text: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else text.push(readFileSync(join(dir, entry.name), "utf8"));
  };
  walk(base);
  return text.join("\n");
}

function calls(f: ReturnType<typeof setup>): string[] {
  const file = join(f.root, "orca-calls");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

describe.skipIf(
  skipsOnWindows(
    "git-bash",
    "the fixture remote is served through a shell script as the SSH command, and the remove hook is one",
  ),
)("worktrees Orca manages", () => {
  test("a report lists an Orca checkout with its runtime and the proof it is idle", () => {
    const f = setup();
    idle(f);
    expect(line(gc(f, ["--json"]))).toMatchObject({
      resource: f.tree,
      outcome: "would-collect",
      reason: expect.stringContaining(
        "the runtime's registry shows no agent at work in it",
      ),
      details: { runtime: "orca", orca: f.id },
    });
    const human = gc(f, []);
    expectSpawnExit(human, 0);
    expect(human.stdout.toString()).toContain(
      `${f.tree} (orca): would-collect`,
    );
    expect(calls(f)).not.toContainEqual(expect.stringMatching(/ rm /));
  }, 60_000);

  test("a dependency directory alone does not veto; the worktree still reaches would-collect", () => {
    const f = setup();
    // A lockfile must be tracked, like `.gitignore` itself, so neither counts
    // as untracked content that would veto before the ignored-content check.
    writeFileSync(join(f.tree, ".gitignore"), "node_modules/\n");
    writeFileSync(join(f.tree, "package-lock.json"), "{}\n");
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "track a lockfile"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    // Both a top-level and a monorepo's nested dependency directory count.
    mkdirSync(join(f.tree, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(f.tree, "node_modules", ".bin", "tsc"), "");
    mkdirSync(join(f.tree, "website", "node_modules"), { recursive: true });
    writeFileSync(join(f.tree, "website", "node_modules", "pkg.js"), "");
    idle(f);
    expect(line(gc(f, ["--json"]))).toMatchObject({
      outcome: "would-collect",
      reason: expect.stringContaining(
        "the runtime's registry shows no agent at work in it",
      ),
      details: {
        runtime: "orca",
        orca: f.id,
        rebuildable: expect.arrayContaining([
          "node_modules/.bin/tsc",
          "website/node_modules/pkg.js",
        ]),
      },
    });
  }, 60_000);

  test("another ignored path beside the dependency directory still is a finding naming it", () => {
    const f = setup();
    writeFileSync(join(f.tree, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(f.tree, "package-lock.json"), "{}\n");
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "track a lockfile"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    mkdirSync(join(f.tree, "node_modules"), { recursive: true });
    writeFileSync(join(f.tree, "node_modules", "pkg.js"), "");
    writeFileSync(join(f.tree, ".env"), "SECRET=1\n");
    const receipt = line(gc(f, ["--json"]));
    expect(receipt.outcome).toBe("finding");
    expect(receipt.reason).toContain(".env");
    expect(receipt.reason).not.toContain("node_modules");
    expect(receipt.details).toMatchObject({
      rebuildable: ["node_modules/pkg.js"],
    });
  }, 60_000);

  test("an ignored path with no recognisable package manager is still a finding", () => {
    const f = setup();
    writeFileSync(join(f.tree, ".gitignore"), ".env\n");
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "track a gitignore"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    writeFileSync(join(f.tree, ".env"), "SECRET=1\n");
    const receipt = line(gc(f, ["--json"]));
    expect(receipt.outcome).toBe("finding");
    expect(receipt.reason).toContain(".env");
    expect(receipt.details).toMatchObject({ runtime: "orca" });
    expect(receipt.details).not.toHaveProperty("rebuildable");
  }, 60_000);

  test("collecting an idle Orca checkout runs the remove hook, parks, and removes it through Orca", () => {
    const f = setup();
    idle(f);
    const collected = line(gc(f, ["--collect", "--json"]));
    expect(collected).toMatchObject({
      outcome: "collected",
      reason: expect.stringContaining(
        "ran .config/worktree-hooks/remove, parked reflection findings, orca worktree rm",
      ),
      proof: expect.stringContaining("pull request merged"),
      details: {
        runtime: "orca",
        hook: expect.stringMatching(/\.config\/worktree-hooks\/remove$/),
        parked: true,
      },
    });
    expect(readFileSync(join(f.root, "hook-ran"), "utf8")).toContain(f.tree);
    expect(existsSync(f.tree)).toBe(false);
    const state = JSON.parse(
      readFileSync(join(f.root, "orca-state.json"), "utf8"),
    ) as OrcaState;
    expect(state.worktrees).toEqual([]);
    expect(calls(f)).toContain(`worktree rm --worktree id:${f.id} --json`);
  }, 60_000);

  test("collecting a worktree whose only ignored content is a dependency directory still reports it as rebuildable", () => {
    const f = setup();
    writeFileSync(join(f.tree, ".gitignore"), "node_modules/\n");
    writeFileSync(join(f.tree, "package-lock.json"), "{}\n");
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "track a lockfile"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    mkdirSync(join(f.tree, "node_modules"), { recursive: true });
    writeFileSync(join(f.tree, "node_modules", "pkg.js"), "");
    idle(f);
    const collected = line(gc(f, ["--collect", "--json"]));
    expect(collected).toMatchObject({
      outcome: "collected",
      details: {
        runtime: "orca",
        hook: expect.stringMatching(/\.config\/worktree-hooks\/remove$/),
        parked: true,
        rebuildable: ["node_modules/pkg.js"],
      },
    });
    expect(existsSync(f.tree)).toBe(false);
  }, 60_000);

  test("collecting preserves an unsent reflection finding outside the removed checkout", () => {
    const f = setup();
    idle(f);
    noteFinding(f);
    const collected = line(gc(f, ["--collect", "--json"]));
    expect(collected).toMatchObject({ outcome: "collected" });
    expect(existsSync(f.tree)).toBe(false);
    expect(pendingText(f)).toContain(FINDING_TITLE);
  }, 60_000);

  test("a failed park keeps the checkout and never calls orca worktree rm", () => {
    const f = setup();
    idle(f);
    noteFinding(f);
    // A file where the pending directory must go makes parking fail.
    writeFileSync(join(f.env.JIG_HOME as string, "pending"), "");
    const result = gc(f, ["--collect", "--json"]);
    expectSpawnExit(result, 1);
    const receipt = JSON.parse(result.stdout.toString()) as Receipt;
    expect(receipt.resources[0]).toMatchObject({ outcome: "failed" });
    expect(existsSync(f.tree)).toBe(true);
    expect(calls(f)).not.toContainEqual(expect.stringMatching(/ rm /));
  }, 60_000);

  test("collection runs the base branch's remove hook, never the one the branch changed", () => {
    const f = setup();
    const hook = join(f.tree, ".config/worktree-hooks/remove");
    writeFileSync(
      hook,
      `#!/bin/sh\ntouch ${JSON.stringify(join(f.root, "branch-hook-ran"))}\n`,
    );
    f.command(["git", "-C", f.tree, "commit", "-am", "change the hook"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    idle(f);
    const receipt = line(gc(f, ["--collect", "--json"]));
    expect(receipt).toMatchObject({ outcome: "collected" });
    expect(existsSync(join(f.root, "branch-hook-ran"))).toBe(false);
    expect(readFileSync(join(f.root, "hook-ran"), "utf8")).toContain(f.tree);
  }, 60_000);

  test("a branch that deletes the remove hook still gets the base branch's run", () => {
    const f = setup();
    f.command([
      "git",
      "-C",
      f.tree,
      "rm",
      "-q",
      ".config/worktree-hooks/remove",
    ]);
    f.command(["git", "-C", f.tree, "commit", "-m", "delete the hook"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    idle(f);
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "collected",
      reason: expect.stringContaining("ran .config/worktree-hooks/remove"),
    });
    expect(readFileSync(join(f.root, "hook-ran"), "utf8")).toContain(f.tree);
  }, 60_000);

  test("a hook that export attributes would leave out of the archive keeps the checkout", () => {
    const f = setup();
    const attributes = join(f.root, "repo", ".git", "info", "attributes");
    mkdirSync(dirname(attributes), { recursive: true });
    writeFileSync(attributes, ".config/worktree-hooks/** export-ignore\n");
    idle(f);
    const result = gc(f, ["--collect", "--json"]);
    expectSpawnExit(result, 1);
    expect(
      (JSON.parse(result.stdout.toString()) as Receipt).resources[0],
    ).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("export attributes"),
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("a helper the branch added beside the remove hook is never run by collection", () => {
    const f = setup();
    writeFileSync(
      join(f.tree, ".config/worktree-hooks/helper.sh"),
      `#!/bin/sh\ntouch ${JSON.stringify(join(f.root, "helper-ran"))}\n`,
    );
    chmodSync(join(f.tree, ".config/worktree-hooks/helper.sh"), 0o755);
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "add a helper"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    idle(f);
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "collected",
    });
    expect(existsSync(join(f.root, "helper-ran"))).toBe(false);
  }, 60_000);

  test("a bunfig.toml the base branch lacks keeps the checkout", () => {
    const f = setup();
    writeFileSync(
      join(f.tree, "bunfig.toml"),
      "# a startup file the base branch lacks\n",
    );
    f.command(["git", "-C", f.tree, "add", "-A"]);
    f.command(["git", "-C", f.tree, "commit", "-m", "add a bunfig"]);
    f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
    f.command(["git", "-C", f.tree, "fetch", "origin"]);
    f.refreshGh();
    idle(f);
    const result = gc(f, ["--collect", "--json"]);
    expectSpawnExit(result, 1);
    const receipt = (JSON.parse(result.stdout.toString()) as Receipt)
      .resources[0];
    expect(receipt).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("bunfig.toml differs"),
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("a session's journal override keeps the checkout, whose findings it may hold", () => {
    const f = setup();
    idle(f);
    const result = gc(f, ["--collect", "--json"], {
      JIG__REFLECTION__JOURNAL: join(f.root, "elsewhere.jsonl"),
    });
    const receipt = JSON.parse(result.stdout.toString()) as Receipt;
    expect(receipt.resources[0]).toMatchObject({
      outcome: "failed",
      reason: expect.stringContaining("JIG__REFLECTION__JOURNAL"),
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("a registry listing the checkout twice refuses collection", () => {
    const f = setup();
    idle(f);
    f.writeState({
      worktrees: [
        { id: f.id, path: f.tree, agents: [] },
        { id: f.id, path: f.tree, agents: [{ state: "working" }] },
      ],
    });
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "unverified",
      reason: expect.stringContaining("lists the worktree more than once"),
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("a checkout whose agent Orca reports working is refused with the registry as the reason", () => {
    const f = setup();
    idle(f);
    f.writeState({
      worktrees: [{ id: f.id, path: f.tree, agents: [{ state: "working" }] }],
    });
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "refused",
      reason: "Orca's registry reports an agent working in the worktree",
    });
    expect(existsSync(f.tree)).toBe(true);
    expect(existsSync(join(f.root, "hook-ran"))).toBe(false);
    expect(calls(f)).not.toContainEqual(expect.stringMatching(/ rm /));
  }, 60_000);

  test("an unreadable registry refuses collection", () => {
    const f = setup();
    idle(f);
    f.writeState({ fail: ["ps"] });
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "unverified",
      reason: expect.stringContaining(
        "Orca's registry (orca worktree ps) could not be read",
      ),
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("an unreadable worktree list fails the inventory rather than pass a checkout for a plain one", () => {
    const f = setup();
    idle(f);
    f.writeState({ fail: ["list"] });
    const result = gc(f, ["--json"]);
    expectSpawnExit(result, 1);
    expect(
      (JSON.parse(result.stdout.toString()) as Receipt).resources[0],
    ).toMatchObject({
      resource: "*",
      outcome: "unverified",
      reason: expect.stringContaining("Orca's worktree list could not be read"),
    });
  }, 60_000);

  test("a checkout Orca does not list stays a plain, report-only worktree", () => {
    const f = setup();
    idle(f);
    f.writeState({ worktrees: [] });
    expect(line(gc(f, ["--collect", "--json"]))).toMatchObject({
      outcome: "refused",
      reason:
        "workspace opener does not hold shared session admission; report only",
      details: { runtime: "none" },
    });
    expect(existsSync(f.tree)).toBe(true);
  }, 60_000);

  test("Orca's command must be an absolute path in the machine entry", () => {
    const f = setup();
    const file = join(f.env.JIG_HOME as string, "jig.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(/command: .*/, "command: orca"),
    );
    const result = gc(f, ["--json"]);
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain(
      "gc.orca.command must be an absolute path",
    );
  }, 60_000);
});

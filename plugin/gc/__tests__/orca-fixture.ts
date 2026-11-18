/**
 * The fixture of the worktrees kind's tests against a fake `orca` command: a
 * repository with one checkout under a declared root, a forge served from a
 * local bare clone, and fakes for `orca`, `gh` and `lsof`, with `jig gc` run
 * as a subprocess in a home directory of its own.
 *
 * The forge repository is derived from the remote URL, so the fixture remote
 * is `fakeforge:acme/app.git`, served from a local bare clone through an SSH
 * command the repository configures; `gh` is a fake answering the merged pull
 * request, and `lsof` a fake reporting no process holding the worktree, so the
 * proof does not depend on what else the machine has mounted.
 */
import { expect } from "bun:test";
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
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { FIXTURE_REMOTE, setupWorktreeFixture } from "./worktree-fixture.ts";
import { dump } from "../../shared/yaml.ts";
import type { Receipt, ReceiptLine } from "../types.ts";

const script = resolve(import.meta.dir, "../../jig.ts");
const REMOTE = FIXTURE_REMOTE;
const DAY_MS = 86_400_000;

interface OrcaRow {
  id: string;
  path: string;
  agents: { state: string }[];
}
export interface OrcaState {
  repo: string;
  worktrees: OrcaRow[];
  /** Subcommands (`list`, `ps`, `rm`) that fail. */
  fail: string[];
  /**
   * Where `ps` writes a launch marker for the first worktree once gc's
   * admission for it stands: a launch the plugin let through while gc held
   * the worktree.
   */
  launchAfterAdmission?: string;
  /**
   * How `rm` goes wrong: `exit` exits nonzero with no reply, and
   * `unreadable` prints output that is not Orca's, both removing nothing;
   * `lost-reply` removes the worktree, then exits nonzero with no output, as
   * a reply lost on its way back; `accepted` answers that Orca is still
   * deleting the worktree, removing nothing yet, and `in-progress` refuses
   * the call for a removal already under way, removing nothing either;
   * `refused` refuses it.
   */
  rm?:
    | "exit"
    | "unreadable"
    | "lost-reply"
    | "accepted"
    | "in-progress"
    | "refused";
  /** Where `rm` reads gc's admission for the worktree, copying it to `admission-at-rm.json`. */
  guard?: string;
  /**
   * Where a process in the worktree tries a commit: `rm` before Orca removes
   * it, writing the attempt's exit code and error output to `window-commit`;
   * `ps` once, at the first registry read after the remove hook ran.
   */
  commitAt?: "rm" | "ps";
  /** Rows of other workspaces Orca lists before this repository's, enough to push its worktrees past a default page. */
  filler?: number;
}

/** A fake `orca` reading and writing its registry in `state.json`. */
function fakeOrca(bin: string, root: string): string {
  return writeFakeProgram(
    join(bin, "orca"),
    `#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
const file = ${JSON.stringify(join(root, "orca-state.json"))};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, "orca-calls"))}, args.join(" ") + "\\n");
const state = JSON.parse(readFileSync(file, "utf8"));
const sub = args[1];
const answer = (result) => { console.log(JSON.stringify({ ok: true, result })); process.exit(0); };
const refuse = (code) => { console.log(JSON.stringify({ ok: false, error: { code, message: code } })); process.exit(1); };
if (state.fail.includes(sub)) { console.error("orca: runtime unavailable"); process.exit(1); }
const value = (flag) => args[args.indexOf(flag) + 1];
const root = ${JSON.stringify(root)};
const commit = (tree, message) =>
  Bun.spawnSync(["git", "-c", "user.email=t@example.invalid", "-c", "user.name=T", "-C", tree, "commit", "-q", "--allow-empty", "-m", message], { stdout: "pipe", stderr: "pipe" });
if (sub === "ps" && state.commitAt === "ps" && existsSync(join(root, "hook-ran")) && !existsSync(join(root, "late-commit"))) {
  writeFileSync(join(root, "late-commit"), String(commit(state.worktrees[0].path, "late").exitCode));
}
// Orca answers a listing with its first 200 rows unless --limit asks for more, and marks a cut page truncated.
const page = (rows) => {
  const limit = args.includes("--limit") ? Number(value("--limit")) : 200;
  const all = [...Array.from({ length: state.filler ?? 0 }, (_, index) => ({ id: "filler-" + index, path: "/orca/filler-" + index, agents: [] })), ...rows];
  return { rows: all.slice(0, limit), totalCount: all.length, truncated: all.length > limit };
};
if (sub === "list") {
  if (value("--repo") !== "path:" + state.repo) refuse("repo_not_found");
  const { rows, totalCount, truncated } = page(state.worktrees);
  answer({ worktrees: rows.map(({ id, path }) => ({ id, path })), totalCount, truncated });
}
if (sub === "ps" && state.launchAfterAdmission) {
  const guard = state.launchAfterAdmission;
  const path = state.worktrees[0].path;
  const key = createHash("sha256").update(path).digest("hex");
  if (existsSync(join(guard, "admissions", key + ".json"))) {
    mkdirSync(join(guard, "launches"), { recursive: true });
    writeFileSync(join(guard, "launches", ".staged.tmp"), JSON.stringify({ kind: "orca-guard-launch", v: 1, key, writer: { host: hostname(), pid: process.pid }, at: new Date().toISOString(), path, workspaceId: "ws-1", agent: "claude" }));
    renameSync(join(guard, "launches", ".staged.tmp"), join(guard, "launches", key + ".json"));
  }
}
if (sub === "ps") {
  const { rows, totalCount, truncated } = page(state.worktrees);
  answer({ worktrees: rows.map(({ path, agents }) => ({ path, agents })), totalCount, truncated });
}
if (sub === "rm") {
  const id = value("--worktree").replace(/^id:/, "");
  const row = state.worktrees.find((entry) => entry.id === id);
  if (!row) refuse("selector_not_found");
  if (state.guard) {
    const admission = join(state.guard, "admissions", createHash("sha256").update(row.path).digest("hex") + ".json");
    writeFileSync(${JSON.stringify(join(root, "admission-at-rm.json"))}, existsSync(admission) ? readFileSync(admission, "utf8") : "absent");
  }
  if (state.rm === "exit") { console.error("orca: connection lost"); process.exit(1); }
  if (state.rm === "unreadable") { console.log("orca: something went sideways"); process.exit(0); }
  if (state.rm === "accepted") answer({ removing: true });
  if (state.rm === "in-progress") refuse("worktree_removal_in_progress");
  if (state.rm === "refused") refuse("worktree_dirty");
  if (state.commitAt === "rm") {
    const tried = commit(row.path, "window");
    writeFileSync(join(root, "window-commit"), tried.exitCode + "\\n" + tried.stderr.toString());
  }
  const removed = Bun.spawnSync(["git", "-C", state.repo, "worktree", "remove", row.path]);
  if (removed.exitCode !== 0) refuse("worktree_dirty");
  state.worktrees = state.worktrees.filter((entry) => entry !== row);
  writeFileSync(file, JSON.stringify(state));
  if (state.rm === "lost-reply") process.exit(1);
  answer({ removed: true });
}
refuse("unknown_command");
`,
  );
}

export type Fixture = ReturnType<typeof setup>;

export function setup() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gc-orca-")));
  const { repo, user, bin, env, command } = setupWorktreeFixture(root);
  const roots = join(root, "worktrees");
  const declaration = {
    kinds: ["worktrees"],
    worktree_roots: [roots],
    scratch_prefixes: [],
    regenerable_paths: [".fallow"],
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
  // Marking began before the checkout was made, so its ignored content gets
  // no one-time archive unless a test moves the stamp (`predateMarking`).
  const state = join(user, ".local", "state", "jig", "gc");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "marking-since"),
    `${new Date(Date.now() - 30 * DAY_MS).toISOString()}\n`,
  );
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
    state,
    machine,
    guard: join(user, ".local", "state", "jig", "orca-guard"),
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

export function gc(
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

export function line(result: ReturnType<typeof gc>): ReceiptLine {
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString()) as Receipt;
  expect(receipt.resources).toHaveLength(1);
  return receipt.resources[0] as ReceiptLine;
}

export function idle(f: ReturnType<typeof setup>): void {
  makeIdle(f.tree, join(f.repo, ".git", "worktrees", "topic"));
}

/** The Orca plugin's heartbeat, written as the plugin writes it. */
export function heartbeat(f: ReturnType<typeof setup>, at: Date): void {
  mkdirSync(f.guard, { recursive: true });
  writeFileSync(
    join(f.guard, "heartbeat.json"),
    JSON.stringify({
      kind: "orca-guard-heartbeat",
      v: 1,
      key: "heartbeat",
      writer: { host: hostname(), pid: process.pid },
      at: at.toISOString(),
      pid: process.pid,
      pluginVersion: "0.4.0",
    }),
  );
}

export function calls(f: ReturnType<typeof setup>): string[] {
  const file = join(f.root, "orca-calls");
  return existsSync(file)
    ? readFileSync(file, "utf8").split("\n").filter(Boolean)
    : [];
}

export function commitAndPush(
  f: ReturnType<typeof setup>,
  message: string,
  files: Record<string, string>,
): void {
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(f.tree, name), text);
  f.command(["git", "-C", f.tree, "add", "-A"]);
  f.command(["git", "-C", f.tree, "commit", "-m", message]);
  f.command(["git", "-C", f.tree, "push", "origin", "topic"]);
  f.command(["git", "-C", f.tree, "fetch", "origin"]);
  f.refreshGh();
}

/**
 * Detach the checkout at its head and make `gh` answer the forge's pull
 * requests for a commit with the merged pull request #12 at `head`, that it
 * has no other commit (as the forge refuses one), and no pull request for any
 * branch.
 */
export function detachWithMergedPull(
  f: ReturnType<typeof setup>,
  head: string,
): void {
  f.command(["git", "-C", f.tree, "switch", "--quiet", "--detach"]);
  const pulls = [
    {
      number: 12,
      state: "closed",
      merged_at: "2026-11-01T00:00:00Z",
      head: { sha: head, repo: { full_name: "acme/app" } },
    },
  ];
  writeFakeProgram(
    join(f.root, "bin", "gh"),
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(f.root, "gh-calls"))}, process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "api" && !args.at(-1).includes(${JSON.stringify(head)})) {
  console.error("gh: No commit found for SHA: " + args.at(-1) + " (HTTP 422)");
  process.exit(1);
}
console.log(JSON.stringify(args[0] === "api" ? ${JSON.stringify(pulls)} : []));
`,
  );
}

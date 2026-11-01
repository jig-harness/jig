/**
 * A world for one tick: the drive suite's fake forge (a `gh` that keeps
 * each pull request's comments in a file), wrapped by a `gh` that also
 * answers the calls the tick adds (the repository view, the configuration
 * file on the default branch, the pull request listings, and a comment's
 * update or removal on whichever pull request holds it); a fake `orca`
 * answering `repo list` and `worktree ps` from files, listing the worktrees
 * it creates there, and keeping a workspace's comment and unread mark
 * (`worktree set`, `worktree show`) in that file; and the GitHub
 * tracker adapter's issue nodes served as a GraphQL endpoint the adapter
 * reaches through `JIG_GITHUB_GRAPHQL_URL`. The tick runs as a child with
 * its own home, so its receipts and lock never touch the real ones.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import {
  conn,
  issueNode,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import {
  fakeForge,
  forgeComment,
  ledgerBody,
} from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  type Ledger,
  ledgerFromState,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { freshState } from "../../skills/drive-pr/scripts/lib/state/schema.ts";

export const SLUG = "example-org/example-repo";
const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

const WRAPPER = (driveGh: string) => `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/gh-calls.log", args.join(" ") + "\\n");
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
if (args[0] === "repo" && args[1] === "view" && args.includes("nameWithOwner,defaultBranchRef"))
  out({ nameWithOwner: "${SLUG}", defaultBranchRef: { name: "main" } });
if (args[0] === "pr" && args[1] === "list") {
  const state = args[args.indexOf("--state") + 1];
  out(fs.readFileSync(F + "/prs-" + state + ".json", "utf8"));
}
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("reviewThreads"))) {
  // A pull request's unresolved review threads, as many as threads-<pr> says.
  const pr = (args.find((a) => a.startsWith("pr=")) ?? "pr=0").slice(3);
  const file = F + "/threads-" + pr;
  if (!fs.existsSync(file)) { process.stderr.write("gh: no threads for " + pr + "\\n"); process.exit(1); }
  const open = Number(fs.readFileSync(file, "utf8"));
  out({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: Array.from({ length: open }, () => ({ isResolved: false })) } } } } });
}
const single = args[0] === "api" && args.includes("-X") ? /issues\\/comments\\/(\\d+)$/.exec(args.find((a) => /issues\\/comments\\/\\d+$/.test(a)) ?? "") : null;
if (single !== null) {
  // A comment's update or removal, on whichever pull request's file holds it.
  const id = Number(single[1]);
  const method = args[args.indexOf("-X") + 1];
  const input = method === "PATCH" ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
  for (const name of fs.readdirSync(F).filter((n) => /^comments-\\d+\\.json$/.test(n))) {
    const all = JSON.parse(fs.readFileSync(F + "/" + name, "utf8"));
    const at = all.findIndex((c) => c.id === id);
    if (at < 0) continue;
    if (method === "DELETE") all.splice(at, 1); else all[at].body = input.body;
    fs.writeFileSync(F + "/" + name, JSON.stringify(all));
    out("{}");
  }
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
if (args[0] === "api" && /\\/contents\\/\\.config\\/jig\\.yaml\\?ref=main$/.test(args[1] ?? "")) {
  if (!fs.existsSync(F + "/jig.yaml")) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  out({ encoding: "base64", content: fs.readFileSync(F + "/jig.yaml").toString("base64") });
}
const r = Bun.spawnSync([${JSON.stringify(driveGh)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(r.exitCode ?? 1);
`;

const FAKE_ORCA = `#!/usr/bin/env bun
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const F = process.env.DISPATCH_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/orca-calls.log", JSON.stringify(args) + "\\n");
const answer = (result) => { process.stdout.write(JSON.stringify({ id: "x", ok: true, result })); process.exit(0); };
if (args[0] === "terminal" && args[1] === "create") {
  // A hang past the runtime's deadline, an answer that starts nothing, or a terminal running the command.
  if (fs.existsSync(F + "/orca-terminal-hang")) { Bun.sleepSync(30000); process.exit(0); }
  if (!fs.existsSync(F + "/orca-terminal-noop")) {
    const command = args[args.indexOf("--command") + 1];
    const log = fs.openSync(F + "/terminal.log", "a");
    spawn("sh", ["-c", command], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  }
  answer({ terminal: { handle: "term-1" } });
}
if (args[0] === "terminal" && args[1] === "show")
  answer({ terminal: { handle: args[args.indexOf("--terminal") + 1], tabId: "tab-1", leafId: "leaf-1" } });
if (args[0] === "terminal" && args[1] === "list") {
  // The terminals orca-terminals.json lists; none when it does not exist.
  const terminals = fs.existsSync(F + "/orca-terminals.json") ? JSON.parse(fs.readFileSync(F + "/orca-terminals.json", "utf8")) : [];
  answer({ terminals, hostScope: { hostIds: ["local"], omittedHostIds: [] } });
}
if (args[0] === "terminal" && args[1] === "read")
  // The rendered screen orca-screen.json holds.
  answer({ terminal: { handle: args[args.indexOf("--terminal") + 1], status: "running", source: "screen", tail: JSON.parse(fs.readFileSync(F + "/orca-screen.json", "utf8")), truncated: false, nextCursor: null } });
if (args[0] === "terminal" && args[1] === "send") {
  fs.appendFileSync(F + "/orca-sends.jsonl", JSON.stringify({ terminal: args[args.indexOf("--terminal") + 1], text: args[args.indexOf("--text") + 1], enter: args.includes("--enter") }) + "\\n");
  answer({ accepted: true });
}
if (args[0] === "worktree" && args[1] === "create") {
  // A real worktree of the clone, on a branch Orca names after the worktree.
  const name = args[args.indexOf("--name") + 1];
  const base = args[args.indexOf("--base-branch") + 1];
  const clone = JSON.parse(fs.readFileSync(F + "/orca-repos.json", "utf8")).repos[0].path;
  const path = require("node:path").join(F, "..", "worktrees", name.replace(/[^A-Za-z0-9.-]/g, "-"));
  const made = Bun.spawnSync(["git", "-C", clone, "worktree", "add", "-q", "-b", "orca/" + name, path, base], { stderr: "pipe" });
  if (made.exitCode !== 0) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "git", message: made.stderr.toString() } })); process.exit(1); }
  // Listed by worktree ps from then on, on the branch git says it holds.
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  ps.worktrees.push({ worktreeId: "repo-1::" + path, repoId: "repo-1", path, branch: "", gitBranch: true, isArchived: false, linkedPR: null, linkedIssue: null, linkedLinearIssue: null, linkedItems: [], comment: "", unread: false, unverifiableTerminalCount: 0, agents: [] });
  ps.totalCount = ps.worktrees.length;
  fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
  answer({ worktree: { id: "repo-1::" + path, path, branch: "refs/heads/orca/" + name } });
}
if (args[0] === "worktree" && (args[1] === "set" || args[1] === "show")) {
  // A workspace's comment and unread mark, kept in its worktree ps row.
  const path = args[args.indexOf("--worktree") + 1].replace(/^path:/, "");
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  const row = ps.worktrees.find((w) => w.path === path);
  if (!row) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "not_found" } })); process.exit(1); }
  if (args[1] === "set" && !fs.existsSync(F + "/orca-set-noop")) {
    if (args.includes("--comment")) row.comment = args[args.indexOf("--comment") + 1];
    if (args.includes("--unread")) row.unread = true;
    fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
  }
  answer({ worktree: { id: row.worktreeId, path: row.path, comment: row.comment } });
}
if (args[0] === "worktree" && args[1] === "ps") {
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  for (const row of ps.worktrees.filter((w) => w.gitBranch)) {
    const head = Bun.spawnSync(["git", "-C", row.path, "symbolic-ref", "--short", "HEAD"], { stderr: "pipe" });
    row.branch = "refs/heads/" + head.stdout.toString().trim();
  }
  answer(ps);
}
if (args[0] === "worktree" && args[1] === "list")
  answer({ worktrees: JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8")).worktrees.map((w) => ({ id: w.worktreeId, path: w.path, branch: w.branch })) });
const file = args[0] === "repo" && args[1] === "list" ? "orca-repos.json"
  : args[0] === "worktree" && args[1] === "ps" ? "orca-ps.json" : null;
if (file === null) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "unhandled" } })); process.exit(1); }
answer(JSON.parse(fs.readFileSync(F + "/" + file, "utf8")));
`;

/** The drive the wrapper starts in tests: it records how it was started and exits with `drive-exit`'s code. */
const FAKE_DRIVE = `const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/drive-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + "\\n");
process.exit(fs.existsSync(F + "/drive-exit") ? Number(fs.readFileSync(F + "/drive-exit", "utf8")) : 0);
`;

/** The Claude Code a pickup's wrapper starts in tests: it records how it was started and runs until \`claude-exit\` appears. */
const FAKE_CLAUDE = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/claude-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + "\\n");
const until = Date.now() + 60000;
while (!fs.existsSync(F + "/claude-exit") && Date.now() < until) Bun.sleepSync(50);
process.exit(0);
`;

export interface OrcaAgent {
  state: string;
  paneKey?: string;
  /** When it entered its state, in milliseconds (`stateStartedAt`). */
  since?: number;
}

export interface OrcaRow {
  branch: string;
  /** A real directory, for a workspace a launch runs in; `/ws/<i>` when absent. */
  path?: string;
  linkedPR?: number;
  agents?: OrcaAgent[];
  unverifiableTerminalCount?: number;
  comment?: string;
  unread?: boolean;
}

/** An open pull request as `gh pr list --json` returns it. */
export const openPr = (number: number, head: string) => ({
  number,
  url: `https://github.com/${SLUG}/pull/${number}`,
  title: `Pull request ${number}`,
  headRefName: head,
});

/** A merged pull request as `gh pr list --json` returns it. */
export const mergedPr = (number: number, head: string, mergedAt: string) => ({
  ...openPr(number, head),
  mergedAt,
});

/** A drive ledger whose driver stopped with `exit` (absent: no exit). */
export function stoppedLedger(
  pr: number,
  exit: number | undefined,
  extra: Partial<Ledger> = {},
): Ledger {
  return {
    ...ledgerFromState(freshState(pr), {
      generation: 3,
      driver: {
        actor: "wt-0123456789abcdef",
        clone: "clone-a",
        heartbeat: "2026-10-30T22:00:00.000Z",
        state: "stopped",
        ...(exit === undefined ? {} : { exit }),
      },
      narrative: [],
      claims: [],
    }),
    ...extra,
  };
}

/** The ledger comment a pull request carries, written by a member. */
export const ledgerComment = (id: number, ledger: Ledger) =>
  forgeComment(id, ledgerBody(ledger), "maintainer", "MEMBER");

export interface World {
  root: string;
  repo: string;
  home: string;
  dir: string;
  env: Record<string, string>;
  /** The tracker's issues assigned to the identity, as GitHub nodes. */
  setIssues(nodes: Array<Record<string, unknown>>): void;
  /** From the issue listing after the `n`th on, the tracker answers with `nodes` instead: a change between a tick's reads. */
  setIssuesAfter(n: number, nodes: Array<Record<string, unknown>>): void;
  /** Who made each issue's assignment, by issue number. */
  setAssigner(number: number, login: string, permission: string): void;
  setPrs(state: "open" | "merged", prs: unknown[]): void;
  setComments(pr: number, comments: unknown[]): void;
  setWorkspaces(rows: OrcaRow[]): void;
  setConfig(yaml: string | null): void;
  /** Run `jig dispatch` with `args` (or the script `entry` in its place); resolves to its exit and output. */
  dispatch(
    args: string[],
    entry?: string,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>;
  close(): void;
}

export function world(): World {
  const forge = fakeForge([], { login: "drive-bot" });
  const root = mkdtempSync(join(tmpdir(), "dispatch-tick-"));
  const dir = forge.dir;
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFakeProgram(join(bin, "gh"), WRAPPER(join(dir, "..", "bin", "gh")));
  writeFakeProgram(join(bin, "orca"), FAKE_ORCA);
  writeFakeProgram(join(bin, "claude"), FAKE_CLAUDE);
  writeFileSync(join(root, "fake-drive.js"), FAKE_DRIVE);
  const write = (name: string, value: unknown) =>
    writeFileSync(
      join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  write("prs-open.json", []);
  write("prs-merged.json", []);
  write("orca-repos.json", {
    repos: [
      {
        id: "repo-1",
        path: forge.repo,
        gitRemoteIdentity: { canonicalKey: `github.com/${SLUG}` },
      },
    ],
  });
  write("orca-ps.json", {
    worktrees: [],
    hostScope: { hostIds: ["local"], omittedHostIds: [] },
    totalCount: 0,
    truncated: false,
  });

  let issues: Array<Record<string, unknown>> = [];
  const assigners = new Map<number, { login: string; permission: string }>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
      const data = answer(op, variables);
      return Response.json(
        data === undefined
          ? { errors: [{ message: `unhandled ${op}` }] }
          : { data },
      );
    },
  });
  let listings = 0;
  let later: { after: number; nodes: Array<Record<string, unknown>> } | null =
    null;
  function answer(op: string | undefined, v: Record<string, unknown>): unknown {
    if (op === "TrackerIssues") {
      listings += 1;
      if (later !== null && listings > later.after) issues = later.nodes;
      const filter = v.filterBy as Record<string, unknown>;
      return {
        repository: {
          issues: conn(
            issues.filter((n) =>
              (n.assignees as { nodes: Array<{ login: string }> }).nodes.some(
                (a) => a.login === filter.assignee,
              ),
            ),
          ),
        },
      };
    }
    if (op === "TrackerAssignedBy") {
      const found = issues.find((n) => n.number === v.number);
      const by = assigners.get(Number(v.number));
      const assignee = (found?.assignees as { nodes: Array<{ login: string }> })
        ?.nodes[0];
      return {
        repository: {
          issue: {
            assignees: { nodes: assignee ? [assignee] : [] },
            timelineItems: {
              pageInfo: { hasPreviousPage: false },
              nodes:
                by && assignee
                  ? [
                      {
                        createdAt: "2026-10-30T08:00:00Z",
                        actor: { login: by.login },
                        assignee: { login: assignee.login },
                      },
                    ]
                  : [],
            },
          },
        },
      };
    }
    if (op === "TrackerCollaborator") {
      const match = [...assigners.values()].find((a) => a.login === v.login);
      return {
        repository: {
          collaborators: {
            edges: match
              ? [{ permission: match.permission, node: { login: match.login } }]
              : [],
          },
        },
      };
    }
    return undefined;
  }

  const env: Record<string, string> = {
    ...forge.env,
    PATH: `${bin}${delimiter}${forge.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    JIG_HOME: join(home, ".jig"),
    JIG_USER_LAYER: "off",
    DISPATCH_FAKE_DIR: dir,
    JIG_DISPATCH_DRIVE_SCRIPT: join(root, "fake-drive.js"),
    JIG_GITHUB_GRAPHQL_URL: `http://127.0.0.1:${server.port}/graphql`,
    GH_TOKEN: "test-token",
  };
  delete env.ORCA_CLI_COMMAND;
  delete env.ORCA_CLI_BIN_DIR;
  delete env.JIG_CONSUMER_ROOT;

  return {
    root,
    repo: forge.repo,
    home,
    dir,
    env,
    setIssues: (nodes) => {
      issues = nodes;
    },
    setIssuesAfter: (after, nodes) => {
      later = { after: listings + after, nodes };
    },
    setAssigner: (number, login, permission) => {
      assigners.set(number, { login, permission });
    },
    setPrs: (state, prs) => write(`prs-${state}.json`, prs),
    setComments: (pr, comments) => write(`comments-${pr}.json`, comments),
    setWorkspaces: (rows) =>
      write("orca-ps.json", {
        worktrees: rows.map((r, i) => ({
          worktreeId: `repo-1::/ws/${i}`,
          repoId: "repo-1",
          path: r.path ?? `/ws/${i}`,
          branch: `refs/heads/${r.branch}`,
          isArchived: false,
          linkedPR:
            r.linkedPR === undefined
              ? null
              : { number: r.linkedPR, state: "open" },
          linkedIssue: null,
          linkedLinearIssue: null,
          linkedItems: [],
          comment: r.comment ?? "",
          unread: r.unread ?? false,
          unverifiableTerminalCount: r.unverifiableTerminalCount ?? 0,
          agents: (r.agents ?? []).map((a, j) => ({
            paneKey: a.paneKey ?? `pane-${i}-${j}`,
            state: a.state,
            agentType: "claude",
            ...(a.since === undefined ? {} : { stateStartedAt: a.since }),
          })),
        })),
        hostScope: { hostIds: ["local"], omittedHostIds: [] },
        totalCount: rows.length,
        truncated: false,
      }),
    setConfig: (yaml) => {
      if (yaml === null) rmSync(join(dir, "jig.yaml"), { force: true });
      else write("jig.yaml", yaml);
    },
    async dispatch(args, entry) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          ...(entry === undefined ? [JIG, "dispatch"] : [entry]),
          ...args,
        ],
        { cwd: forge.repo, env, stdout: "pipe", stderr: "pipe" },
      );
      const deadline = setTimeout(() => child.kill(), 60_000);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(deadline);
      return { exitCode, stdout, stderr };
    },
    close: () => {
      server.stop(true);
    },
  };
}

/** An open issue of the tracker, assigned to `login`, in GitHub node form. */
export function assignedIssue(number: number, login: string, labels: string[]) {
  return issueNode({
    number,
    repo: SLUG,
    assignee: login,
    labels,
    extra: { subIssues: { pageInfo: { hasNextPage: false }, nodes: [] } },
  });
}

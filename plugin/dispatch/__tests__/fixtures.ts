/**
 * A world for one tick: the drive suite's fake forge (a `gh` that keeps
 * each pull request's comments in a file), wrapped by a `gh` that also
 * answers the calls the tick adds (the repository view, the configuration
 * file on the default branch, the pull request listings); a fake `orca`
 * answering `repo list` and `worktree ps` from files; and the GitHub
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
if (args[0] === "api" && /\\/contents\\/\\.config\\/jig\\.yaml\\?ref=main$/.test(args[1] ?? "")) {
  if (!fs.existsSync(F + "/jig.yaml")) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  out({ encoding: "base64", content: fs.readFileSync(F + "/jig.yaml").toString("base64") });
}
const r = Bun.spawnSync([${JSON.stringify(driveGh)}, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
process.exit(r.exitCode ?? 1);
`;

const FAKE_ORCA = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/orca-calls.log", args.join(" ") + "\\n");
const file = args[0] === "repo" && args[1] === "list" ? "orca-repos.json"
  : args[0] === "worktree" && args[1] === "ps" ? "orca-ps.json" : null;
if (file === null) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "unhandled" } })); process.exit(1); }
process.stdout.write(JSON.stringify({ id: "x", ok: true, result: JSON.parse(fs.readFileSync(F + "/" + file, "utf8")) }));
`;

export interface OrcaAgent {
  state: string;
  paneKey?: string;
}

export interface OrcaRow {
  branch: string;
  linkedPR?: number;
  agents?: OrcaAgent[];
  unverifiableTerminalCount?: number;
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
  /** Who made each issue's assignment, by issue number. */
  setAssigner(number: number, login: string, permission: string): void;
  setPrs(state: "open" | "merged", prs: unknown[]): void;
  setComments(pr: number, comments: unknown[]): void;
  setWorkspaces(rows: OrcaRow[]): void;
  setConfig(yaml: string | null): void;
  /** Run `jig dispatch` with `args`; resolves to its exit and output. */
  dispatch(args: string[]): Promise<{
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
  function answer(op: string | undefined, v: Record<string, unknown>): unknown {
    if (op === "TrackerIssues") {
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
          path: `/ws/${i}`,
          branch: `refs/heads/${r.branch}`,
          isArchived: false,
          linkedPR:
            r.linkedPR === undefined
              ? null
              : { number: r.linkedPR, state: "open" },
          linkedIssue: null,
          linkedLinearIssue: null,
          linkedItems: [],
          comment: "",
          unread: false,
          unverifiableTerminalCount: r.unverifiableTerminalCount ?? 0,
          agents: (r.agents ?? []).map((a, j) => ({
            paneKey: a.paneKey ?? `pane-${i}-${j}`,
            state: a.state,
            agentType: "claude",
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
    async dispatch(args) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          JIG,
          "dispatch",
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

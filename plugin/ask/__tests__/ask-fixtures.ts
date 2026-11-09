/**
 * A world for `jig ask` and `jig send`: a fake `gh` that answers the
 * conditional reads (`gh api -i <path>`) from JSON files named after the
 * path, records each call, and logs the writes `jig send` makes (a label
 * edit, a comment posted) without making them, a checkout whose remote
 * names the test repository, an empty home of
 * its own, and helpers that write the dispatcher's records into that home the
 * way a tick would. `jig ask` runs as a child with that home, so nothing it
 * reads or migrates is the real one.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { closeStateDb } from "../../dispatch/lib/state.ts";

export const REPO = "example-org/example-repo";
const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../../dispatch/bunfig.toml");

const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.ASK_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/gh-calls.log", args.join(" ") + "\\n");
if (args[0] === "api" && args[1] === "-i") {
  const path = args[args.length - 1];
  const [base, query] = path.split("?");
  const file = F + "/api/" + base.replace(/\\//g, "_") + ".json";
  if (fs.existsSync(F + "/api-fail")) { process.stdout.write("HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n{}"); process.exit(1); }
  if (!fs.existsSync(file)) { process.stdout.write("HTTP/2.0 404 Not Found\\r\\n\\r\\n{}"); process.exit(1); }
  let body = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(body) && query !== undefined) {
    const q = new URLSearchParams(query);
    const per = Number(q.get("per_page") ?? "30");
    const page = Number(q.get("page") ?? "1");
    body = body.slice((page - 1) * per, page * per);
  }
  process.stdout.write("HTTP/2.0 200 OK\\r\\nEtag: \\"x\\"\\r\\n\\r\\n" + JSON.stringify(body));
  process.exit(0);
}
// The Ready predicate's board query: board.json's answer, failing when no test wrote one.
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("query DispatchBoard"))) {
  if (!fs.existsSync(F + "/board.json")) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(F + "/board.json", "utf8"));
  process.exit(0);
}
// The writes jig send makes: a label edit, and a comment posted.
if (args[0] === "pr" && args[1] === "edit") {
  fs.appendFileSync(F + "/gh-writes.log", JSON.stringify(args) + "\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
  fs.appendFileSync(F + "/gh-writes.log", JSON.stringify(args) + "\\n");
  const pr = (args[3].match(/issues\\/(\\d+)\\/comments/) || [])[1];
  process.stdout.write(JSON.stringify({ id: 901, html_url: "https://github.com/" + process.env.ASK_FAKE_REPO + "/pull/" + pr + "#issuecomment-901" }));
  process.exit(0);
}
process.stderr.write("fake gh: unhandled " + args.join(" ") + "\\n");
process.exit(1);
`;

export interface AskWorld {
  root: string;
  home: string;
  /** A checkout of the test repository. */
  repo: string;
  /** A directory in no checkout. */
  away: string;
  dir: string;
  /** The dispatcher's state directory under the world's home. */
  state: string;
  env: Record<string, string>;
  /** What `gh api -i <path>` answers for `path` (without its query). */
  api(path: string, body: unknown): void;
  /** Every forge call the fake answered. */
  calls(): string[];
  /** Every write the fake took (`gh pr edit`, a comment posted), as its arguments. */
  writes(): string[][];
  ask(args: string[], cwd?: string): Promise<Spawned>;
  /** `jig <args>`, a child with the world's home and environment. */
  jig(args: string[], cwd?: string): Promise<Spawned>;
  close(): void;
}

export interface Spawned {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

export function askWorld(): AskWorld {
  const root = mkdtempSync(join(tmpdir(), "jig-ask-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dir = join(root, "fake");
  const repo = join(root, "checkout");
  const away = join(root, "away");
  for (const d of [home, bin, join(dir, "api"), repo, away])
    mkdirSync(d, { recursive: true });
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  writeFileSync(join(dir, "gh-calls.log"), "");
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", `https://github.com/${REPO}.git`);
  const state = join(home, ".local", "state", "jig", "dispatch");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (
      v !== undefined &&
      !k.startsWith("DRIVE_PR_") &&
      !k.startsWith("JIG_") &&
      !k.startsWith("GH_")
    )
      env[k] = v;
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    USERPROFILE: home,
    JIG_HOME: join(home, ".jig"),
    JIG_USER_LAYER: "off",
    JIG_GH_CACHE: "off",
    GH_TOKEN: "test-token",
    ASK_FAKE_DIR: dir,
    ASK_FAKE_REPO: REPO,
  });
  const jig = async (args: string[], cwd = repo): Promise<Spawned> => {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", `--config=${BUNFIG}`, JIG, ...args],
      { cwd, env, stdout: "pipe", stderr: "pipe" },
    );
    const deadline = setTimeout(() => child.kill(), 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(deadline);
    return { exitCode, stdout, stderr };
  };
  return {
    root,
    home,
    repo,
    away,
    dir,
    state,
    env,
    api: (path, body) =>
      writeFileSync(
        join(dir, "api", `${path.replace(/\//g, "_")}.json`),
        JSON.stringify(body),
      ),
    calls: () =>
      readFileSync(join(dir, "gh-calls.log"), "utf8")
        .split("\n")
        .filter((l) => l !== ""),
    writes: () => {
      const log = join(dir, "gh-writes.log");
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as string[])
        : [];
    },
    ask: (args, cwd) => jig(["ask", ...args], cwd),
    jig,
    close: () => {
      closeStateDb(state);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A pull request as the forge's REST read returns it. */
export function pullDoc(
  number: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    state: "open",
    merged: false,
    merged_at: null,
    mergeable: true,
    head: { sha: "a".repeat(40) },
    user: { login: "author" },
    labels: [],
    ...extra,
  };
}

/** A comment as the forge's REST listing returns it. */
export function comment(
  id: number,
  body: string,
  login = "maintainer",
  association = "MEMBER",
  createdAt = "2026-11-01T10:00:00Z",
): Record<string, unknown> {
  return {
    id,
    body,
    user: { login },
    author_association: association,
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/${REPO}/pull/1#issuecomment-${id}`,
  };
}

/** The board query's answer for PR `number` at `head`: mergeable and clean, a member's approval of the head, no configuration on the default branch. */
export function boardAnswer(number: number, head: string): string {
  const none = { pageInfo: { hasNextPage: false }, nodes: [] };
  return JSON.stringify({
    data: {
      repository: {
        squashMergeAllowed: true,
        defaultBranchRef: { target: { file: null } },
        [`pr${number}`]: {
          number,
          headRefOid: head,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          authorAssociation: "MEMBER",
          labels: none,
          reviewThreads: none,
          reviewRequests: none,
          latestReviews: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                state: "APPROVED",
                authorAssociation: "MEMBER",
                author: { __typename: "User", login: "maintainer" },
                commit: { oid: head },
              },
            ],
          },
          commits: {
            nodes: [{ commit: { oid: head, statusCheckRollup: null } }],
          },
        },
      },
    },
  });
}

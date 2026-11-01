/**
 * A fake forge for the provisional-decision and morning-report suites: a
 * `gh` that answers from files in `$PROV_FAKE_DIR` and records what it was
 * asked to change.
 *
 * - `threads.json`: the pull request's unresolved threads, as
 *   `list-unresolved-threads.ts` reads them (`threadsPayload`).
 * - `thread-<id>.json`: one thread's comments, for the single-thread reads
 *   (`more-<id>` says the thread holds a further page of them).
 * - `comments-<N>.json`: pull request N's conversation comments.
 * - `pr-<N>.json`: `gh pr view N` (title, url, state, body, author).
 * - `search.json`: the search's one page, narrowed to a query's `author:`
 *   (`fail-search` fails every search);
 *   `login`: the signed-in login.
 * - Writes `replies.jsonl` (each posted reply), `resolved.txt` (each resolved
 *   thread) and `calls.log`.
 *
 * Every script is spawned in a scratch `git init` tree with `$DRIVE_PR_STATE_DIR`
 * at a clone-scoped leaf and an explicit `$DRIVE_PR_SESSION`, as the
 * triage-thread suite does, so no subprocess reads this checkout's state.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import { stateDirIdentityToken } from "../scripts/lib/state/lease.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");
export const RRC = join(
  SCRIPTS,
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
);

const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.PROV_FAKE_DIR;
const args = process.argv.slice(2);
const joined = args.join(" ");
fs.appendFileSync(F + "/calls.log", joined + "\\n");
const file = (name) => F + "/" + name;
const has = (name) => fs.existsSync(file(name));
const read = (name) => fs.readFileSync(file(name), "utf8");
const out = (text) => { process.stdout.write(text); process.exit(0); };
const value = (prefix) => (args.find((a) => a.startsWith(prefix)) ?? "").slice(prefix.length);
if (args[0] === "repo" && args[1] === "view") {
  if (args.includes("-q")) out("example-org example-repo\\n");
  if (args.includes("--jq")) out("example-org/example-repo\\n");
  out(JSON.stringify({ owner: { login: "example-org" }, name: "example-repo", nameWithOwner: "example-org/example-repo" }));
}
if (args[0] === "pr" && args[1] === "view") {
  const n = args[2];
  if (!has("pr-" + n + ".json")) { process.stderr.write("no pull request " + n + "\\n"); process.exit(1); }
  out(read("pr-" + n + ".json"));
}
if (args[0] === "api" && args[1] === "user") {
  if (!has("login")) process.exit(1);
  out(read("login").trim() + "\\n");
}
if (joined.includes("pullRequest { number state }"))
  out(JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", id: value("threadId="), pullRequest: { number: 12, state: "OPEN" } } } }));
if (joined.includes("addPullRequestReviewThreadReply")) {
  const req = JSON.parse(fs.readFileSync(0, "utf8"));
  const n = has("replies.jsonl") ? read("replies.jsonl").split("\\n").filter(Boolean).length : 0;
  fs.appendFileSync(file("replies.jsonl"), JSON.stringify(req.variables) + "\\n");
  out("https://example.invalid/reply-" + (n + 1) + "\\n");
}
if (joined.includes("unresolveReviewThread")) {
  const id = value("threadId=");
  const left = has("resolved.txt") ? read("resolved.txt").split("\\n").filter((x) => x && x !== id) : [];
  fs.writeFileSync(file("resolved.txt"), left.map((x) => x + "\\n").join(""));
  fs.appendFileSync(file("unresolved.txt"), id + "\\n");
  out("false\\n");
}
if (joined.includes("resolveReviewThread")) {
  fs.appendFileSync(file("resolved.txt"), value("threadId=") + "\\n");
  out("true\\n");
}
if (joined.includes("reviewThreads(")) out(read("threads.json"));
if (joined.includes("node(id:$id)") || joined.includes("node(id:")) {
  const id = value("id=");
  if (!has("thread-" + id + ".json")) { process.stderr.write("no thread " + id + "\\n"); process.exit(1); }
  const comments = JSON.parse(read("thread-" + id + ".json"));
  out(JSON.stringify({ data: { node: { isResolved: has("resolved.txt") && read("resolved.txt").split("\\n").includes(id), comments: { pageInfo: { hasNextPage: has("more-" + id) }, nodes: comments } } } }));
}
const issue = joined.match(/issues\\/(\\d+)\\/comments/);
if (issue && has("fail-comments-after")) {
  const reads = (has("comments-reads") ? Number(read("comments-reads")) : 0) + 1;
  fs.writeFileSync(file("comments-reads"), String(reads));
  if (reads > Number(read("fail-comments-after"))) { process.stderr.write("comments failed\\n"); process.exit(1); }
}
if (issue) out(JSON.stringify([has("comments-" + issue[1] + ".json") ? JSON.parse(read("comments-" + issue[1] + ".json")) : []]));
if (joined.includes("search/issues") && has("fail-search")) { process.stderr.write("search failed\\n"); process.exit(1); }
if (joined.includes("search/issues")) {
  const page = has("search.json") ? JSON.parse(read("search.json")) : { items: [] };
  const author = (value("q=").match(/author:(\\S+)/) ?? [])[1];
  if (author !== undefined) page.items = page.items.filter((it) => it.user && it.user.login === author);
  out(JSON.stringify([page]));
}
process.stderr.write("fake gh: unhandled " + joined + "\\n");
process.exit(1);
`;

export interface Comment {
  author: string;
  association: string;
  body: string;
  at?: string;
}

/** One thread's comments as the GraphQL readers see them. */
export function commentNodes(threadId: string, comments: Comment[]) {
  return comments.map((c, i) => ({
    url: `https://example.invalid/${threadId}/comment-${i}`,
    author: {
      login: c.author,
      __typename: c.author.endsWith("[bot]") ? "Bot" : "User",
    },
    authorAssociation: c.association,
    body: c.body,
    createdAt: c.at ?? new Date(Date.UTC(2026, 9, 27, 0, i)).toISOString(),
  }));
}

/** The unresolved-threads listing for `threads`. */
export function threadsPayload(
  threads: Array<{ id: string; comments: Comment[] }>,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads.map((t) => ({
              id: t.id,
              isResolved: false,
              isOutdated: false,
              path: "a.ts",
              line: 1,
              comments: {
                pageInfo: { hasNextPage: false },
                nodes: commentNodes(t.id, t.comments),
              },
            })),
          },
        },
      },
    },
  });
}

export interface Forge {
  dir: string;
  tree: string;
  stateDir: string;
  env: Record<string, string>;
  write(name: string, value: unknown): void;
  thread(id: string, comments: Comment[]): void;
  replies(): Array<{ threadId: string; body: string }>;
  resolved(): string[];
  calls(): string[];
}

/** A fake forge, a scratch tree and a state directory; `overlay` is the repository's configuration. */
export function fakeForge(overlay = ""): Forge {
  const root = mkdtempSync(join(tmpdir(), "provisional-"));
  const dir = join(root, "forge");
  const bin = join(root, "bin");
  const tree = join(root, "tree");
  for (const d of [dir, bin, tree]) mkdirSync(d, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], {
    cwd: tree,
    env: gitIdentityEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(init, 0);
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  const overlayFile = join(root, "jig.yaml");
  writeFileSync(overlayFile, overlay);
  const stateDir = scopedStateDir(join(root, "state"), tree);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("GIT_") && !k.startsWith("DRIVE_PR_"))
      env[k] = v;
  Object.assign(env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    PROV_FAKE_DIR: dir,
    DRIVE_PR_STATE_DIR: stateDir,
    DRIVE_PR_STATE_DIR_IDENTITY: stateDirIdentityToken(stateDir),
    DRIVE_PR_SESSION: String(process.pid),
    DRIVE_PR_HANDOFF_DIR: join(root, "handoff"),
    JIG_OVERLAY: overlayFile,
    JIG_HOME: join(root, "home"),
    // The dispatcher's receipts the morning report reads are this home's, never the machine's.
    HOME: join(root, "home"),
    USERPROFILE: join(root, "home"),
  });
  const lines = (name: string) =>
    existsSync(join(dir, name))
      ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean)
      : [];
  return {
    dir,
    tree,
    stateDir,
    env,
    write: (name, value) =>
      writeFileSync(
        join(dir, name),
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    thread: (id, comments) =>
      writeFileSync(
        join(dir, `thread-${id}.json`),
        JSON.stringify(commentNodes(id, comments)),
      ),
    replies: () => lines("replies.jsonl").map((l) => JSON.parse(l)),
    resolved: () => lines("resolved.txt"),
    calls: () => lines("calls.log"),
  };
}

/** Run a drive-pr or resolve-review-comments script in the forge's tree. */
export async function runIn(
  forge: Forge,
  script: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: forge.tree,
    env: { ...forge.env, ...(opts.env ?? {}) },
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

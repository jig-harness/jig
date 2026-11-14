/**
 * A world for one tick: the drive suite's fake forge (a `gh` that keeps
 * each pull request's comments in a file), wrapped by a `gh` that also
 * answers the calls the tick adds (the repository's query, answered by
 * `fixtures/repository-query-fake.ts`, the repository view, the configuration file
 * on the default branch, the pull request listings, and a comment's
 * update or removal on whichever pull request holds it, an update refused
 * while `comment-edit-fail` exists); a fake Orca command (on `PATH` under
 * the name Orca installs it under, `orca-ide` on Linux) answering `repo list` and `worktree ps` from files, listing the worktrees
 * it creates there under the name asked for, and keeping a workspace's
 * comment, unread mark and name (`worktree set`, `worktree show`) in that
 * file; and the GitHub
 * tracker adapter's issue nodes served as a GraphQL endpoint the adapter
 * reaches through `JIG_GITHUB_GRAPHQL_URL`. The tick runs as a child with
 * its own home, so its receipts and lock never touch the real ones.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
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
import { orcaInstalledName } from "../../shared/orca.ts";

export const SLUG = "example-org/example-repo";
const JIG = resolve(import.meta.dir, "../../jig.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const QUERY_FAKE = resolve(
  import.meta.dir,
  "fixtures",
  "repository-query-fake.ts",
);

/**
 * Git as the world's checkouts see it: `remote get-url` names the forge URL of
 * ${SLUG}, since a local path names no repository, while every other command
 * runs real Git against the local origin the world cloned.
 */
const GIT_SHIM = (realGit: string) => `#!/usr/bin/env bun
const run = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], { stdin: "inherit" });
const args = process.argv.slice(2);
const forgeUrl = "https://github.com/${SLUG}.git";
const named = run.exitCode === 0 && args.includes("remote") && args.includes("get-url");
process.stderr.write(run.stderr);
process.stdout.write(named ? run.stdout.toString().replace(/^.+$/gm, forgeUrl) : run.stdout);
process.exit(run.exitCode ?? 1);
`;

const WRAPPER = (driveGh: string) => `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/gh-calls.log", args.join(" ").replace(/\\n/g, " ") + "\\n");
const out = (v) => { process.stdout.write(typeof v === "string" ? v : JSON.stringify(v)); process.exit(0); };
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("query DispatchRepository"))) {
  const answer = require(${JSON.stringify(QUERY_FAKE)}).repositoryQuery(F, args, process.cwd());
  if (answer === null) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  out(answer);
}
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("query DispatchComments"))) {
  const answer = require(${JSON.stringify(QUERY_FAKE)}).commentsQuery(F, args);
  if (answer === null) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  out(answer);
}
if (args[0] === "api" && args[1] === "graphql" && args.some((a) => a.includes("query DispatchBoard"))) {
  // The board read's query: board.json's answer, failing while board-fail exists or when no test wrote one.
  if (fs.existsSync(F + "/board-fail") || !fs.existsSync(F + "/board.json")) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  out(fs.readFileSync(F + "/board.json", "utf8"));
}
if (args[0] === "repo" && args[1] === "view" && args.includes("nameWithOwner,defaultBranchRef"))
  // A checkout named "other" is another repository; every other is ${SLUG}.
  out({ nameWithOwner: process.cwd().endsWith("/other") ? "example-org/other-repo" : "${SLUG}", defaultBranchRef: { name: "main" } });
if (args[0] === "api" && args[1] === "rate_limit")
  // What is left: 4990 unless rate-remaining says otherwise.
  out({ resources: { core: { limit: 5000, remaining: fs.existsSync(F + "/rate-remaining") ? Number(fs.readFileSync(F + "/rate-remaining", "utf8")) : 4990, reset: 1793000000 } } });
if (args[0] === "pr" && args[1] === "list") {
  const state = args[args.indexOf("--state") + 1];
  // A listing that fails while prs-<state>-fail exists.
  if (fs.existsSync(F + "/prs-" + state + "-fail")) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  out(fs.readFileSync(F + "/prs-" + state + ".json", "utf8"));
}
if (args[0] === "pr" && args[1] === "view" && args.some((a) => a.includes("headRefOid"))) {
  if (args.some((a) => a.includes("labels")) && fs.existsSync(F + "/pr-labels-fail")) { process.stderr.write("gh: labels unavailable\\n"); process.exit(1); }
  // One open pull request read again, as prs-open.json lists it.
  const listed = JSON.parse(fs.readFileSync(F + "/prs-open.json", "utf8")).find((p) => p.number === Number(args[2]));
  if (listed === undefined) { process.stderr.write("gh: no pull requests found\\n"); process.exit(1); }
  if (args.some((a) => a.includes("isCrossRepository"))) {
    const head = Bun.spawnSync(["git", "rev-parse", "--verify", "refs/heads/" + listed.headRefName]);
    out({ ...listed, state: "OPEN", headRefOid: head.exitCode === 0 ? head.stdout.toString().trim() : listed.headRefOid,
      isCrossRepository: false, headRepositoryOwner: { login: "example-org" }, headRepository: { name: "example-repo" },
      url: "https://github.com/${SLUG}/pull/" + listed.number });
  }
  out({ ...listed, state: "OPEN" });
}
if (args[0] === "pr" && args[1] === "view" && args[args.length - 1] === "labels") {
  // One pull request's labels read again, open or merged, as its listing holds them.
  const all = ["open", "merged"].flatMap((s) => JSON.parse(fs.readFileSync(F + "/prs-" + s + ".json", "utf8")));
  const listed = all.find((p) => p.number === Number(args[2]));
  if (listed === undefined) { process.stderr.write("gh: no pull requests found\\n"); process.exit(1); }
  out({ labels: listed.labels ?? [] });
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
  // A comment's update or removal, on whichever pull request's file holds it; an update is refused while comment-edit-fail exists.
  const id = Number(single[1]);
  const method = args[args.indexOf("-X") + 1];
  if (method === "DELETE" && fs.existsSync(F + "/comment-delete-fail")) { fs.writeFileSync(F + "/comment-delete-refused", String(id)); process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n"); process.exit(1); }
  if (method === "PATCH" && fs.existsSync(F + "/comment-edit-fail")) { process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n"); process.exit(1); }
  const input = method === "PATCH" ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
  for (const name of fs.readdirSync(F).filter((n) => /^comments-\\d+\\.json$/.test(n))) {
    const all = JSON.parse(fs.readFileSync(F + "/" + name, "utf8"));
    const at = all.findIndex((c) => c.id === id);
    if (at < 0) continue;
    if (method === "DELETE") all.splice(at, 1); else all[at].body = input.body;
    fs.writeFileSync(F + "/" + name, JSON.stringify(all));
    if (method === "DELETE" && fs.existsSync(F + "/comment-delete-lost")) { process.stderr.write("gh: response lost\\n"); process.exit(1); }
    out("{}");
  }
  if (args.includes("--include")) process.stdout.write("HTTP/2.0 404 Not Found\\r\\n\\r\\n");
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "edit") {
  // A pull request's labels changed in prs-open.json or prs-merged.json; refused while label-edit-fail exists, or for a label labels-repo.json lacks.
  if (fs.existsSync(F + "/label-edit-fail")) { process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n"); process.exit(1); }
  const n = Number(args[2]);
  const values = (flag) => args.flatMap((a, i) => (a === flag ? args[i + 1].split(",") : []));
  const add = values("--add-label");
  const remove = values("--remove-label");
  if (fs.existsSync(F + "/labels-repo.json")) {
    const have = JSON.parse(fs.readFileSync(F + "/labels-repo.json", "utf8"));
    const absent = add.find((l) => !have.includes(l));
    if (absent !== undefined) { process.stderr.write("could not add label: '" + absent + "' not found\\n"); process.exit(1); }
  }
  for (const state of ["open", "merged"]) {
    const file = F + "/prs-" + state + ".json";
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const p of all.filter((p) => p.number === n)) {
      const names = (p.labels ?? []).map((l) => l.name).filter((l) => !remove.includes(l));
      for (const l of add) if (!names.includes(l)) names.push(l);
      p.labels = names.map((name) => ({ name }));
    }
    fs.writeFileSync(file, JSON.stringify(all));
  }
  out("https://github.com/${SLUG}/pull/" + n + "\\n");
}
if (args[0] === "label" && args[1] === "list")
  out((fs.existsSync(F + "/labels-repo.json") ? JSON.parse(fs.readFileSync(F + "/labels-repo.json", "utf8")) : []).map((name) => ({ name })));
if (args[0] === "label" && args[1] === "create") {
  // One label added to labels-repo.json; refused while label-create-fail exists.
  if (fs.existsSync(F + "/label-create-fail")) { process.stderr.write("gh: Resource not accessible by integration (HTTP 403)\\n"); process.exit(1); }
  const have = fs.existsSync(F + "/labels-repo.json") ? JSON.parse(fs.readFileSync(F + "/labels-repo.json", "utf8")) : [];
  have.push(args[2]);
  fs.writeFileSync(F + "/labels-repo.json", JSON.stringify(have));
  out("");
}
if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/git\\/ref\\/heads\\//.test(args[1] ?? "")) {
  // The head of the base branch, as base-head holds it; base-head-next replaces it after this read, for a base that moves between two reads.
  fs.appendFileSync(F + "/base-reads.log", args[1] + "\\n");
  if (!fs.existsSync(F + "/base-head")) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  const sha = fs.readFileSync(F + "/base-head", "utf8");
  if (fs.existsSync(F + "/base-head-next")) fs.renameSync(F + "/base-head-next", F + "/base-head");
  out({ ref: "refs/heads/main", object: { sha, type: "commit" } });
}
const files = args[0] === "api" ? /^repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)\\/files\\?per_page=(\\d+)&page=(\\d+)$/.exec(args[1] ?? "") : null;
if (files !== null) {
  // The files files-<pr>.json lists, one page at a time; refused while files-<pr>-fail exists.
  if (fs.existsSync(F + "/files-" + files[1] + "-fail")) { process.stderr.write("gh: HTTP 502\\n"); process.exit(1); }
  const all = fs.existsSync(F + "/files-" + files[1] + ".json") ? JSON.parse(fs.readFileSync(F + "/files-" + files[1] + ".json", "utf8")) : [];
  const per = Number(files[2]);
  const page = Number(files[3]);
  out(all.slice((page - 1) * per, page * per).map((filename) => ({ filename })));
}
const contents = args[0] === "api" ? /\\/contents\\/(.+)\\?ref=main$/.exec(args[1] ?? "") : null;
if (contents !== null && contents[1] !== ".config/jig.yaml") {
  // Another file of the default branch, as repo-files/<path> holds it.
  const file = F + "/repo-files/" + decodeURIComponent(contents[1]);
  if (!fs.existsSync(file)) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  out({ encoding: "base64", content: fs.readFileSync(file).toString("base64") });
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
// A second host's Orca keeps its own workspaces, in DISPATCH_ORCA_DIR.
const F = process.env.DISPATCH_ORCA_DIR ?? process.env.DISPATCH_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/orca-calls.log", JSON.stringify(args) + "\\n");
const answer = (result) => { process.stdout.write(JSON.stringify({ id: "x", ok: true, result })); process.exit(0); };
if (args[0] === "terminal" && args[1] === "create") {
  // A hang past the runtime's deadline, an answer that starts nothing, or a terminal running the command.
  if (fs.existsSync(F + "/orca-terminal-hang")) { Bun.sleepSync(30000); process.exit(0); }
  if (!fs.existsSync(F + "/orca-terminal-noop")) {
    const command = args[args.indexOf("--command") + 1];
    const log = fs.openSync(F + "/terminal.log", "a");
    // With orca-terminal-shell, a shell that outlives its command as a login shell does, named by its PID as Orca names it.
    const shell = fs.existsSync(F + "/orca-terminal-shell");
    const envFile = F + "/orca-terminal-env.json";
    const env = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, "utf8")) : process.env;
    const cwdFile = F + "/orca-terminal-cwd";
    const cwd = fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, "utf8") : process.cwd();
    const child = spawn("sh", ["-c", shell ? command + "; exec sleep 60" : command], { detached: true, stdio: ["ignore", log, log], env, cwd });
    child.unref();
    if (shell) answer({ terminal: { handle: "term-1", tabId: "tab-1", processId: child.pid } });
  }
  answer({ terminal: { handle: "term-1" } });
}
if (args[0] === "terminal" && args[1] === "close") {
  if (fs.existsSync(F + "/orca-close-fail")) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "refused" } })); process.exit(1); }
  answer({ close: { handle: args[args.indexOf("--terminal") + 1] } });
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
  // A real worktree of the clone, its folder and branch named after the worktree's name as Orca sanitizes it (a taken one gets a suffix), shown under the name asked for.
  const name = args[args.indexOf("--name") + 1];
  const base = args[args.indexOf("--base-branch") + 1];
  const clone = JSON.parse(fs.readFileSync(F + "/orca-repos.json", "utf8")).repos[0].path;
  const slug = name.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  let folder = slug;
  for (let n = 2; fs.existsSync(require("node:path").join(F, "..", "worktrees", folder)); n++) folder = slug + "-" + n;
  const path = require("node:path").join(F, "..", "worktrees", folder);
  const made = Bun.spawnSync(["git", "-C", clone, "worktree", "add", "-q", "-b", "orca/" + folder, path, base], { stderr: "pipe" });
  if (made.exitCode !== 0) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "git", message: made.stderr.toString() } })); process.exit(1); }
  // Listed by worktree ps from then on, on the branch git says it holds.
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  const comment = args.includes("--comment") ? args[args.indexOf("--comment") + 1] : "";
  ps.worktrees.push({ worktreeId: "repo-1::" + path, repoId: "repo-1", path, branch: "", gitBranch: true, isArchived: false, displayName: name, linkedPR: null, linkedIssue: null, linkedLinearIssue: null, linkedItems: [], comment, unread: false, unverifiableTerminalCount: 0, agents: [] });
  ps.totalCount = ps.worktrees.length;
  fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
  answer({ worktree: { id: "repo-1::" + path, path, branch: "refs/heads/orca/" + folder } });
}
if (args[0] === "worktree" && (args[1] === "set" || args[1] === "show")) {
  // A workspace's comment and unread mark, kept in its worktree ps row.
  const path = args[args.indexOf("--worktree") + 1].replace(/^path:/, "");
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  const row = ps.worktrees.find((w) => w.path === path);
  if (!row) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "not_found" } })); process.exit(1); }
  if (args[1] === "show" && fs.existsSync(F + "/orca-show-switch")) {
    const switched = Bun.spawnSync(["git", "-C", path, "checkout", "-b", "personal-work"], { stderr: "pipe" });
    if (switched.exitCode !== 0) process.exit(1);
    fs.unlinkSync(F + "/orca-show-switch");
  }
  if (args[1] === "show" && fs.existsSync(F + "/orca-on-show.json")) {
    Object.assign(row, JSON.parse(fs.readFileSync(F + "/orca-on-show.json", "utf8")));
    fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
    fs.unlinkSync(F + "/orca-on-show.json");
  }
  if (args[1] === "show" && fs.existsSync(F + "/orca-show-card.json"))
    answer({ worktree: JSON.parse(fs.readFileSync(F + "/orca-show-card.json", "utf8")) });
  // A write Orca refuses while orca-set-fail exists.
  if (args[1] === "set" && fs.existsSync(F + "/orca-set-fail")) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "refused" } })); process.exit(1); }
  if (args[1] === "set" && !fs.existsSync(F + "/orca-set-noop")) {
    if (args.includes("--comment")) row.comment = args[args.indexOf("--comment") + 1];
    if (args.includes("--unread")) row.unread = true;
    if (args.includes("--display-name")) row.displayName = args[args.indexOf("--display-name") + 1];
    fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
    if (fs.existsSync(F + "/orca-set-lost")) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "response_lost" } })); process.exit(1); }
  }
  answer({ worktree: { id: row.worktreeId, path: row.path, comment: row.comment, isUnread: row.unread === true, displayName: row.displayName } });
}
if (args[0] === "worktree" && args[1] === "ps") {
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  for (const row of ps.worktrees.filter((w) => w.gitBranch)) {
    const head = Bun.spawnSync(["git", "-C", row.path, "symbolic-ref", "--short", "HEAD"], { stderr: "pipe" });
    row.branch = "refs/heads/" + head.stdout.toString().trim();
  }
  answer(ps);
}
if (args[0] === "worktree" && args[1] === "rm") {
  // The worktree removed from git and from worktree ps, its branch deleted with --delete-branch.
  const path = args[args.indexOf("--worktree") + 1].replace(/^path:/, "");
  const ps = JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8"));
  const row = ps.worktrees.find((w) => w.path === path);
  if (!row) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "not_found" } })); process.exit(1); }
  const clone = JSON.parse(fs.readFileSync(F + "/orca-repos.json", "utf8")).repos[0].path;
  const branch = Bun.spawnSync(["git", "-C", path, "symbolic-ref", "--short", "HEAD"], { stderr: "pipe" }).stdout.toString().trim();
  const removed = Bun.spawnSync(["git", "-C", clone, "worktree", "remove", path], { stderr: "pipe" });
  if (removed.exitCode !== 0) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "git", message: removed.stderr.toString() } })); process.exit(1); }
  if (args.includes("--delete-branch")) {
    const deleted = Bun.spawnSync(["git", "-C", clone, "branch", "-d", branch], { stderr: "pipe" });
    if (deleted.exitCode !== 0) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "git", message: deleted.stderr.toString() } })); process.exit(1); }
  }
  ps.worktrees = ps.worktrees.filter((w) => w !== row);
  ps.totalCount = ps.worktrees.length;
  fs.writeFileSync(F + "/orca-ps.json", JSON.stringify(ps));
  answer({ removed: { path } });
}
if (args[0] === "worktree" && args[1] === "list")
  answer({ worktrees: JSON.parse(fs.readFileSync(F + "/orca-ps.json", "utf8")).worktrees.map((w) => ({ id: w.worktreeId, path: w.path, branch: w.branch })) });
const file = args[0] === "repo" && args[1] === "list" ? "orca-repos.json"
  : args[0] === "worktree" && args[1] === "ps" ? "orca-ps.json" : null;
if (file === null) { process.stdout.write(JSON.stringify({ ok: false, error: { code: "unhandled" } })); process.exit(1); }
answer(JSON.parse(fs.readFileSync(F + "/" + file, "utf8")));
`;

/** The drive the wrapper starts in tests: it records how it was started, runs while `drive-hold` exists, and exits with `drive-exit`'s code. */
const FAKE_DRIVE = `const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/drive-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  codexHome: process.env.CODEX_HOME ?? null,
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
  openaiKey: process.env.OPENAI_API_KEY ?? null,
  launch: process.env.JIG_LAUNCH ?? null,
}) + "\\n");
const until = Date.now() + 60000;
if (fs.existsSync(F + "/drive-stderr")) process.stderr.write(fs.readFileSync(F + "/drive-stderr"));
while (fs.existsSync(F + "/drive-hold") && Date.now() < until) Bun.sleepSync(50);
if (fs.existsSync(F + "/drive-output")) process.stdout.write(fs.readFileSync(F + "/drive-output"));
process.exit(fs.existsSync(F + "/drive-exit") ? Number(fs.readFileSync(F + "/drive-exit", "utf8")) : 0);
`;

/** The drive doctor the tick reads in tests: \`doctor.json\` as \`drives.ts --json\` prints it, or no rows. */
const FAKE_DOCTOR = `const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/doctor-runs.jsonl", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
process.stdout.write(fs.existsSync(F + "/doctor.json") ? fs.readFileSync(F + "/doctor.json", "utf8") : JSON.stringify({ rows: [] }));
`;

/** The Codex a pickup's wrapper starts in tests: it records how it was started and runs until \`claude-exit\` appears. */
const FAKE_CODEX = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/codex-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME ?? null,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + "\\n");
const until = Date.now() + 60000;
while (!fs.existsSync(F + "/claude-exit") && Date.now() < until) Bun.sleepSync(50);
process.exit(0);
`;

/**
 * The Claude Code a wrapper starts in tests: it records how it was started
 * and runs until \`claude-exit\` appears, then prints \`claude-said\` when
 * there is one and exits with the code \`claude-exit\` holds (0 when empty).
 * With \`claude-stubborn\` present it ignores SIGTERM and leaves a tool
 * command running, whose pid it writes to \`claude-tool-pid\`.
 */
const FAKE_CLAUDE = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.DISPATCH_FAKE_DIR;
fs.appendFileSync(F + "/claude-runs.jsonl", JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
}) + "\\n");
if (fs.existsSync(F + "/claude-stubborn")) {
  process.on("SIGTERM", () => {});
  const tool = require("node:child_process").spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(F + "/claude-tool-pid", String(tool.pid));
}
const until = Date.now() + 60000;
while (!fs.existsSync(F + "/claude-exit") && Date.now() < until) Bun.sleepSync(50);
if (fs.existsSync(F + "/claude-said")) {
  const said = fs.readFileSync(F + "/claude-said");
  // With \`claude-split\` present, the first multi-byte character is cut between two writes.
  const stream = fs.existsSync(F + "/claude-stderr") ? process.stderr : process.stdout;
  const cut = fs.existsSync(F + "/claude-split") ? said.findIndex((b) => b >= 0xc0) + 1 : 0;
  if (cut > 0) {
    stream.write(said.subarray(0, cut));
    if (fs.existsSync(F + "/claude-interleave")) {
      Bun.sleepSync(150);
      (stream === process.stderr ? process.stdout : process.stderr).write("diagnostic\\n");
    }
    Bun.sleepSync(300);
  }
  stream.write(said.subarray(cut));
}
process.exit(Number(fs.existsSync(F + "/claude-exit") ? fs.readFileSync(F + "/claude-exit", "utf8") : 0) || 0);
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
  /** The name Orca shows for it; its branch when absent. */
  name?: string;
}

/** The head commit an open pull request reports unless a test names another. */
export const HEAD_SHA = "a".repeat(40);

/** The head commit of the base branch unless a test names another. */
export const BASE_SHA = "c".repeat(40);

/** An open pull request as `gh pr list --json` returns it: at `HEAD_SHA` and mergeable, unless `extra` says otherwise. */
export const openPr = (
  number: number,
  head: string,
  extra: { headRefOid?: string; mergeable?: string; baseRefName?: string } = {},
) => ({
  number,
  url: `https://github.com/${SLUG}/pull/${number}`,
  title: `Pull request ${number}`,
  headRefName: head,
  headRefOid: HEAD_SHA,
  baseRefName: "main",
  mergeable: "MERGEABLE",
  labels: [] as Array<{ name: string }>,
  ...extra,
});

/** A failed check on an open pull request's head, as the listing gives it. */
export const FAILING = {
  statusCheckRollup: [
    {
      __typename: "CheckRun",
      name: "ci",
      status: "COMPLETED",
      conclusion: "FAILURE",
    },
  ],
};

/** A pull request as the listing returns it, carrying `labels`. */
export const labeled = <T extends object>(pr: T, ...labels: string[]) => ({
  ...pr,
  labels: labels.map((name) => ({ name })),
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
  /** The head of the base branch; `null` for a branch that does not read. With `next`, the head after the next read of it. */
  setBaseHead(sha: string | null, next?: string): void;
  setWorkspaces(rows: OrcaRow[]): void;
  setConfig(yaml: string | null): void;
  /** The files a pull request changes, as the forge lists them. */
  setFiles(pr: number, files: string[]): void;
  /** A file the default branch holds beside `.config/jig.yaml`. */
  setRepoFile(path: string, text: string): void;
  /** Run `jig dispatch` with `args` (or the script `entry` in its place), `extra` added to its environment; resolves to its exit and output. */
  dispatch(
    args: string[],
    entry?: string,
    extra?: Record<string, string>,
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
  writeFakeProgram(join(bin, "git"), GIT_SHIM(Bun.which("git") ?? "git"));
  writeFakeProgram(join(bin, orcaInstalledName()), FAKE_ORCA);
  writeFakeProgram(join(bin, "claude"), FAKE_CLAUDE);
  writeFakeProgram(join(bin, "codex"), FAKE_CODEX);
  writeFileSync(join(root, "fake-drive.js"), FAKE_DRIVE);
  writeFileSync(join(root, "fake-doctor.js"), FAKE_DOCTOR);
  const write = (name: string, value: unknown) =>
    writeFileSync(
      join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  write("prs-open.json", []);
  write("prs-merged.json", []);
  write("base-head", BASE_SHA);
  write("orca-repos.json", {
    repos: [
      {
        id: "repo-1",
        path: forge.repo,
        gitRemoteIdentity: { canonicalKey: `github.com/${SLUG}` },
      },
      // The repository a checkout named "other" belongs to (the fake gh's repository view).
      {
        id: "repo-2",
        path: `${forge.repo}-other`,
        gitRemoteIdentity: {
          canonicalKey: "github.com/example-org/other-repo",
        },
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
      // The tracker preflight's read, which every repository of the world answers.
      const data = op?.startsWith("TrackerFacet")
        ? { repository: noFacetStores(query) }
        : op === "TrackerRepository"
          ? { repository: { id: "R_repo" } }
          : answer(op, variables);
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
    if (op === "TrackerIssues" || op === "TrackerDispatchQueue") {
      listings += 1;
      if (later !== null && listings > later.after) issues = later.nodes;
      const assignee =
        op === "TrackerDispatchQueue"
          ? v.identity
          : (v.filterBy as Record<string, unknown>).assignee;
      return {
        repository: {
          issues: conn(
            issues.filter((n) =>
              (n.assignees as { nodes: Array<{ login: string }> }).nodes.some(
                (a) => a.login === assignee,
              ),
            ),
          ),
        },
      };
    }
    if (op === "TrackerUser")
      return { user: { id: `U_${String(v.login)}`, login: v.login } };
    if (op === "TrackerIssue" || op === "TrackerDispatchIssue") {
      const found = issues.find((n) => n.number === v.number);
      return {
        repository: {
          issue:
            found === undefined
              ? null
              : {
                  ...found,
                  parent: null,
                  relatesTo: conn([]),
                  blockedBy: conn([]),
                  blocking: conn([]),
                  duplicateOf: null,
                  timelineItems: conn([]),
                },
        },
      };
    }
    if (op === "TrackerComments")
      return {
        repository: {
          issue: { id: `i-${String(v.number)}`, comments: conn([]) },
        },
      };
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
    JIG_DISPATCH_DOCTOR_SCRIPT: join(root, "fake-doctor.js"),
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
    setBaseHead: (sha, next) => {
      if (sha === null) rmSync(join(dir, "base-head"), { force: true });
      else write("base-head", sha);
      if (next !== undefined) write("base-head-next", next);
    },
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
          displayName: r.name ?? r.branch,
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
    setFiles: (pr, files) => write(`files-${pr}.json`, files),
    setRepoFile: (path, text) => {
      mkdirSync(dirname(join(dir, "repo-files", path)), { recursive: true });
      writeFileSync(join(dir, "repo-files", path), text);
    },
    setConfig: (yaml) => {
      if (yaml === null) rmSync(join(dir, "jig.yaml"), { force: true });
      else write("jig.yaml", yaml);
    },
    async dispatch(args, entry, extra = {}) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          ...(entry === undefined ? [JIG, "dispatch"] : [entry]),
          ...args,
        ],
        {
          cwd: forge.repo,
          env: { ...env, ...extra },
          stdout: "pipe",
          stderr: "pipe",
        },
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

/**
 * The tracker's facet reads (detection, store health) answered for a
 * repository with no issue types, no issue fields and no issue carrying a
 * facet's label: every count aliased in `query` is zero, so each facet the
 * configuration leaves unnamed stays in labels.
 */
function noFacetStores(query: string): Record<string, unknown> {
  const none = { pageInfo: { hasNextPage: false }, nodes: [] };
  const counts = [...query.matchAll(/(\w+):\s*issues\(/g)].map((m) => [
    m[1] as string,
    { totalCount: 0 },
  ]);
  return {
    issueTypes: none,
    issueFields: none,
    owner: { __typename: "User", login: "example-org" },
    ...Object.fromEntries(counts),
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

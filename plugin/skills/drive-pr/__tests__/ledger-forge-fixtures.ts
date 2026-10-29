/**
 * A fake forge for the drive-ledger suites: a `gh` that keeps a pull
 * request's issue comments in a JSON file (`comments.json`, or
 * `comments-<N>.json` for pull request N) and answers the calls the ledger
 * makes (list, post, patch, delete, the signed-in login, the repository and
 * the search), recording each call. Opt-in files script the races and
 * failures:
 *
 * - `race-on-post` / `race-on-claim`: a rival comment (JSON) inserted, with
 *   the id it names, just before a ledger / claim post lands.
 * - `hide-ids`: `{ "ids": [...], "until": n }` hides those comments from
 *   every listing before the n-th, as a lagging read would.
 * - `bump-on-list` + `bump-body.json`: a concurrent writer rewrites the
 *   canonical comment on the listing that number names; with `bump-same-second`
 *   its `updated_at` does not move.
 * - `twin-on-list`: on the listing that number names, a concurrent writer
 *   replaces the ledger with one of the same generation and heartbeat but
 *   different content.
 * - `remove-on-list`: `{ "n": n, "path": p }` removes `p` on the n-th
 *   listing, as a driver releasing its lock during the reads would.
 * - `fail-list-after`: every listing after that number fails.
 * - `fail-search`: the search fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { scriptArgv } from "../../../../lib/test-helpers/script-argv.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";
import { type Ledger, renderLedger } from "../scripts/lib/state/ledger.ts";

export const SCRIPTS = join(import.meta.dir, "..", "scripts");

const FAKE_GH = `#!/usr/bin/env bun
const fs = require("node:fs");
const F = process.env.LEDGER_FAKE_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(F + "/calls.log", args.join(" ") + "\\n");
const has = (name) => fs.existsSync(F + "/" + name);
const text = (name) => fs.readFileSync(F + "/" + name, "utf8");
const fileFor = (pr) => F + "/" + (pr !== "" && has("comments-" + pr + ".json") ? "comments-" + pr + ".json" : "comments.json");
const read = (pr) => JSON.parse(fs.readFileSync(fileFor(pr), "utf8"));
const save = (pr, c) => fs.writeFileSync(fileFor(pr), JSON.stringify(c));
const stamp = (pr) => new Date(Date.parse("2026-10-01T11:00:00Z") + (read(pr).length + 1) * 1000).toISOString();
if (args[0] === "api" && args[1] === "user") {
  if (!has("login")) { process.stderr.write("no login\\n"); process.exit(1); }
  process.stdout.write(text("login").trim() + "\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  process.stdout.write("example-org/example-repo\\n");
  process.exit(0);
}
if (args[0] !== "api") { process.stderr.write("fake gh: unhandled " + args.join(" ") + "\\n"); process.exit(1); }
let method = "GET";
let endpoint = "";
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") { method = args[++i]; continue; }
  if (a === "-f" || a === "--jq" || a === "--input") { i++; continue; }
  if (a.startsWith("-")) continue;
  if (endpoint === "") endpoint = a;
}
const input = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
if (input !== null && method === "GET") method = "POST";
const self = has("login") ? text("login").trim() : "drive-bot";
if (endpoint.startsWith("search/issues")) {
  if (has("fail-search")) { process.stderr.write("search failed\\n"); process.exit(1); }
  fs.writeFileSync(F + "/search-query", args[args.indexOf("-f") + 1]);
  process.stdout.write(JSON.stringify([JSON.parse(text("search.json"))]));
  process.exit(0);
}
const one = endpoint.match(/issues\\/comments\\/(\\d+)/);
if (one) {
  const id = Number(one[1]);
  const all = read("");
  if (method === "DELETE") { save("", all.filter((c) => c.id !== id)); process.exit(0); }
  if (method === "PATCH") {
    const c = all.find((x) => x.id === id);
    if (!c) process.exit(1);
    c.body = input.body; c.updated_at = stamp("");
    save("", all); process.exit(0);
  }
}
const list = endpoint.match(/issues\\/(\\d+)\\/comments/);
if (list) {
  const pr = list[1];
  if (method === "POST") {
    const all = read(pr);
    const race = input.body.startsWith("<!-- drive-pr-ledger -->") ? "race-on-post" : input.body.startsWith("<!-- drive-pr-takeover-claim -->") ? "race-on-claim" : "";
    if (race !== "" && has(race)) {
      all.push(JSON.parse(text(race)));
      fs.rmSync(F + "/" + race);
    }
    const id = Math.max(100, ...all.map((c) => c.id)) + 1;
    all.push({ id, body: input.body, user: { login: self }, author_association: "MEMBER", updated_at: stamp(pr) });
    save(pr, all);
    process.stdout.write(JSON.stringify({ id, html_url: "https://example.invalid/c/" + id }));
    process.exit(0);
  }
  let n = has("list-count") ? Number(text("list-count")) : 0;
  n += 1;
  fs.writeFileSync(F + "/list-count", String(n));
  if (has("fail-list-after") && n > Number(text("fail-list-after"))) {
    process.stderr.write("listing failed\\n");
    process.exit(1);
  }
  if (has("bump-on-list") && Number(text("bump-on-list")) === n) {
    const all = read(pr);
    const bump = JSON.parse(text("bump-body.json"));
    const c = all.find((x) => x.id === bump.id);
    c.body = bump.body;
    if (!has("bump-same-second")) c.updated_at = "2099-01-01T00:00:00Z";
    save(pr, all);
  }
  if (has("remove-on-list")) {
    const rm = JSON.parse(text("remove-on-list"));
    if (rm.n === n) fs.rmSync(rm.path, { recursive: true, force: true });
  }
  if (has("twin-on-list") && Number(text("twin-on-list")) === n) {
    const all = read(pr);
    const c = all.find((x) => x.body.startsWith("<!-- drive-pr-ledger -->"));
    c.body = c.body.replace(/^Round /m, "Round 99");
    save(pr, all);
  }
  let shown = read(pr);
  if (has("hide-ids")) {
    const hide = JSON.parse(text("hide-ids"));
    if (n < hide.until) shown = shown.filter((c) => !hide.ids.includes(c.id));
  }
  process.stdout.write(JSON.stringify([shown]));
  process.exit(0);
}
process.stderr.write("fake gh: unhandled api " + args.join(" ") + "\\n");
process.exit(1);
`;

export interface FakeForge {
  /** The fixture directory: `comments.json`, `calls.log` and the opt-ins. */
  dir: string;
  /** A scratch repository the drive-state commands run in. */
  repo: string;
  stateDir: string;
  env: Record<string, string>;
  comments(): Array<{
    id: number;
    body: string;
    user: { login: string };
    author_association: string;
  }>;
  calls(): string[];
}

/** A comment as the forge returns it. */
export function forgeComment(
  id: number,
  body: string,
  login = "maintainer",
  association = "MEMBER",
) {
  return {
    id,
    body,
    user: { login },
    author_association: association,
    updated_at: "2026-10-01T11:00:00Z",
  };
}

export function ledgerBody(ledger: Ledger): string {
  const r = renderLedger(ledger);
  if ("error" in r) throw new Error(r.error);
  return r.body;
}

/** The environment every child of the suite starts from, minus inherited drive and git state. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(gitIdentityEnv()))
    if (v !== undefined && !k.startsWith("DRIVE_PR_") && k !== "CLAUDE_PID")
      env[k] = v;
  return env;
}

export function fakeForge(
  comments: unknown[],
  opts: { login?: string } = {},
): FakeForge {
  const root = mkdtempSync(join(tmpdir(), "drive-ledger-"));
  const dir = join(root, "forge");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(dir, "comments.json"), JSON.stringify(comments));
  writeFileSync(join(dir, "calls.log"), "");
  if (opts.login !== undefined) writeFileSync(join(dir, "login"), opts.login);
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
  const env = cleanEnv();
  for (const args of [
    ["init", "-q", "-b", "main"],
    [
      "-c",
      "user.name=Probe",
      "-c",
      "user.email=probe@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "seed",
    ],
  ]) {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(r, 0);
  }
  const stateDir = join(root, "state");
  return {
    dir,
    repo,
    stateDir,
    env: {
      ...env,
      PATH: `${bin}${delimiter}${env.PATH ?? ""}`,
      LEDGER_FAKE_DIR: dir,
      DRIVE_PR_STATE_DIR: stateDir,
      DRIVE_PR_HANDOFF_DIR: join(root, "handoff"),
    },
    comments: () =>
      JSON.parse(readFileSync(join(dir, "comments.json"), "utf8")),
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean),
  };
}

/** The variable a driver publishes for the ledger's writers. */
export function driverEnv(clone: string, floor = 0, login = "drive-bot") {
  return JSON.stringify({
    actor: "wt-bbbbbbbbbbbbbbbb",
    clone,
    login,
    floor,
    claim: null,
  });
}

/** Run a drive-pr script in the fake forge's repository. */
export async function runScript(
  forge: FakeForge,
  script: string,
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
) {
  const proc = Bun.spawn(scriptArgv(join(SCRIPTS, script), ...args), {
    cwd: forge.repo,
    env: { ...forge.env, ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

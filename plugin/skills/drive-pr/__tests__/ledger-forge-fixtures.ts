/**
 * A fake forge for the drive-ledger suites: a `gh` that keeps a pull
 * request's issue comments in a JSON file and answers the calls the ledger
 * makes (list, post, patch, delete, the signed-in login, the repository and
 * the search), recording each call. Two opt-in files script a race:
 * `race-on-post` inserts a rival ledger with a lower id just before a post
 * lands, and `bump-on-list` rewrites the canonical comment on the listing
 * that number names, as a concurrent writer would.
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
const file = F + "/comments.json";
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (c) => fs.writeFileSync(file, JSON.stringify(c));
const has = (name) => fs.existsSync(F + "/" + name);
const stamp = () => new Date(Date.now() + read().length * 1000).toISOString();
if (args[0] === "api" && args[1] === "user") {
  if (!has("login")) { process.stderr.write("no login\\n"); process.exit(1); }
  process.stdout.write(fs.readFileSync(F + "/login", "utf8").trim() + "\\n");
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
const self = has("login") ? fs.readFileSync(F + "/login", "utf8").trim() : "drive-bot";
if (endpoint.startsWith("search/issues")) {
  fs.writeFileSync(F + "/search-query", args[args.indexOf("-f") + 1]);
  process.stdout.write(JSON.stringify([JSON.parse(fs.readFileSync(F + "/search.json", "utf8"))]));
  process.exit(0);
}
const one = endpoint.match(/issues\\/comments\\/(\\d+)/);
if (one) {
  const id = Number(one[1]);
  const all = read();
  if (method === "DELETE") { save(all.filter((c) => c.id !== id)); process.exit(0); }
  if (method === "PATCH") {
    const c = all.find((x) => x.id === id);
    if (!c) process.exit(1);
    c.body = input.body; c.updated_at = stamp();
    save(all); process.exit(0);
  }
}
if (/issues\\/\\d+\\/comments/.test(endpoint)) {
  if (method === "POST") {
    const all = read();
    if (has("race-on-post") && input.body.startsWith("<!-- drive-pr-ledger -->")) {
      all.push(JSON.parse(fs.readFileSync(F + "/race-on-post", "utf8")));
      fs.rmSync(F + "/race-on-post");
    }
    const id = Math.max(100, ...all.map((c) => c.id)) + 1;
    all.push({ id, body: input.body, user: { login: self }, author_association: "MEMBER", updated_at: stamp() });
    save(all);
    process.stdout.write(JSON.stringify({ id, html_url: "https://example.invalid/c/" + id }));
    process.exit(0);
  }
  let n = has("list-count") ? Number(fs.readFileSync(F + "/list-count", "utf8")) : 0;
  n += 1;
  fs.writeFileSync(F + "/list-count", String(n));
  if (has("bump-on-list") && Number(fs.readFileSync(F + "/bump-on-list", "utf8")) === n) {
    const all = read();
    const bump = JSON.parse(fs.readFileSync(F + "/bump-body.json", "utf8"));
    const c = all.find((x) => x.id === bump.id);
    c.body = bump.body; c.updated_at = "2099-01-01T00:00:00Z";
    save(all);
  }
  process.stdout.write(JSON.stringify([read()]));
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
    account: null,
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

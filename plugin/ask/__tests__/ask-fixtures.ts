/**
 * A world for `jig ask`: a fake `gh` that answers the conditional reads
 * (`gh api -i <path>`) from JSON files named after the path and records each
 * call, a checkout whose remote names the test repository, an empty home of
 * its own, and helpers that write the dispatcher's records into that home the
 * way a tick would. `jig ask` runs as a child with that home, so nothing it
 * reads or migrates is the real one.
 */
import {
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
  ask(
    args: string[],
    cwd?: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  close(): void;
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
  });
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
    async ask(args, cwd = repo) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          JIG,
          "ask",
          ...args,
        ],
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
    },
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

/**
 * A repository's command: its scrubbed environment, its bounds, how it
 * ended, and its setting read from the default branch.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { oneLine, SCRUBBED_ENV, scrubbedEnv } from "../repo-command.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "repo-command");
const RUNNER = join(FIXTURES, "runner.ts");
const quoted = (path: string) =>
  process.platform === "win32"
    ? `"${path}"`
    : `'${path.replaceAll("'", "'\\''")}'`;
const program = (mode: string) =>
  `bun ${quoted(join(FIXTURES, "program.ts"))} ${mode}`;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function runner(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", RUNNER, ...args], {
    env: { ...process.env, JIG_USER_LAYER: "off", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expectSpawnExit({ exitCode, stdout, stderr }, 0);
  return JSON.parse(stdout);
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/**
 * A clone whose default branch (`origin/main`, named by `origin/HEAD`) holds
 * `committed` as `.config/jig.yaml`, and whose working tree holds `working`.
 */
function clone(committed: string | null, working?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-repo-command-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  if (committed !== null) {
    writeFileSync(join(dir, ".config", "jig.yaml"), committed);
    git(dir, "add", ".");
  }
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    dir,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  if (working !== undefined)
    writeFileSync(join(dir, ".config", "jig.yaml"), working);
  return dir;
}

describe("scrubbedEnv", () => {
  it("drops every tracker and forge token, and keeps the rest", () => {
    const env = Object.fromEntries(SCRUBBED_ENV.map((n) => [n, "secret"]));
    expect(scrubbedEnv({ ...env, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  it("names the Jira OAuth token and its broker command", () => {
    expect(SCRUBBED_ENV).toContain("JIRA_BEARER_TOKEN");
    expect(SCRUBBED_ENV).toContain("JIRA_TOKEN_COMMAND");
  });
});

describe("oneLine", () => {
  it("joins lines and bounds the length", () => {
    expect(oneLine("a\nb\tc")).toBe("a b c");
    expect(oneLine("x".repeat(500)).length).toBe(301);
  });
});

describe("runRepoCommand", () => {
  it("runs without the tokens, keeping other variables", async () => {
    const out = await runner(["run", ".", "30", program("env")], {
      GH_TOKEN: "secret",
      KEPT: "yes",
    });
    expect(out.kind).toBe("exited");
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ GH_TOKEN: null, KEPT: "yes" });
  });

  it("gives the command its input and reports its exit", async () => {
    const out = await runner(["run", ".", "30", program("stdin")]);
    expect(out).toMatchObject({ kind: "exited", code: 5 });
    expect(out.stdout.trim()).toBe("input");
  });

  it("fails a command that writes more than 64 KiB", async () => {
    const out = await runner(["run", ".", "30", program("flood")]);
    expect(out).toEqual({
      kind: "failed",
      reason: "the command wrote more than 64 KiB of output",
    });
  });

  it("fails a command still running at the deadline", async () => {
    const out = await runner(["run", ".", "1", program("hang")]);
    expect(out).toEqual({
      kind: "failed",
      reason: "the command was still running after 1s and was stopped",
    });
  });

  it("fails a command that cannot start", async () => {
    const out = await runner([
      "run",
      "/nonexistent-dir-repo-command",
      "30",
      "true",
    ]);
    expect(out.kind).toBe("failed");
    expect(out.reason).toContain("could not start");
  });
});

describe("defaultBranchSetting", () => {
  it("reads the field as the default branch holds it, not the working tree", async () => {
    const dir = clone(
      "do_item:\n  preflight_command: check-main\n",
      "do_item:\n  preflight_command: check-branch\n",
    );
    expect(
      await runner(["setting", dir, "do_item", "preflight_command"]),
    ).toEqual({ ok: true, value: "check-main" });
  });

  it("is null when the default branch sets nothing, whatever the working tree says", async () => {
    const dir = clone("do_item: {}\n", "do_item:\n  preflight_command: x\n");
    expect(
      await runner(["setting", dir, "do_item", "preflight_command"]),
    ).toEqual({ ok: true, value: null });
    const bare = clone(null, "do_item:\n  preflight_command: x\n");
    expect(
      await runner(["setting", bare, "do_item", "preflight_command"]),
    ).toEqual({ ok: true, value: null });
  });

  it("fails when the clone names no default branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-repo-command-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "main");
    const out = await runner(["setting", dir, "do_item", "preflight_command"]);
    expect(out.ok).toBe(false);
    expect(out.failure.reason).toContain("names no default branch");
  });

  it("fails when the default branch's file does not parse", async () => {
    const dir = clone("do_item: [unclosed\n");
    const out = await runner(["setting", dir, "do_item", "preflight_command"]);
    expect(out.ok).toBe(false);
    expect(out.failure.reason).toContain("does not parse");
  });
});

describe("defaultBranchSettings", () => {
  it("reads several fields from one default-branch read, unset ones as null", async () => {
    const dir = clone(
      "do_item:\n  claim_from: [todo]\n",
      "do_item:\n  claim_from: [backlog]\n  claim_marker: true\n",
    );
    expect(
      await runner(["settings", dir, "do_item", "claim_from,claim_marker"]),
    ).toEqual({
      ok: true,
      value: { claim_from: ["todo"], claim_marker: null },
    });
  });

  it("fails as a whole when the default branch cannot be read", async () => {
    const dir = clone("do_item: [unclosed\n");
    const out = await runner([
      "settings",
      dir,
      "do_item",
      "claim_from,claim_marker",
    ]);
    expect(out.ok).toBe(false);
    expect(out.value).toBeUndefined();
  });
});

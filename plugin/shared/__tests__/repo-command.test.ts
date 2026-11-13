/**
 * A repository's command: its scrubbed environment, its bounds, how it
 * ended, and its setting read from the default branch.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  oneLine,
  promisorRemotes,
  SCRUBBED_ENV,
  scrubbedEnv,
} from "../repo-command.ts";

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

  it("drops a token whatever the case of its name", () => {
    const env = {
      Jira_Bearer_Token: "secret",
      jira_token_command: "broker",
      Gh_Token: "secret",
      Path: "/bin",
    };
    expect(scrubbedEnv(env)).toEqual({ Path: "/bin" });
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

describe("withDefaultBranchTree", () => {
  /** A clone whose default branch commit holds `note.txt`; returns it and that commit. */
  function noted(): { dir: string; commit: string } {
    const dir = clone("do_item: {}\n");
    writeFileSync(join(dir, "note.txt"), "committed\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "note");
    return { dir, commit: head(dir) };
  }
  const head = (dir: string) =>
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir })
      .stdout.toString()
      .trim();
  const home = () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-home-"));
    dirs.push(dir);
    return dir;
  };

  it("holds the commit's tracked files, not the working tree's, and is removed afterwards", async () => {
    const { dir, commit } = noted();
    const jigHome = home();
    writeFileSync(join(dir, "note.txt"), "edited\n");
    writeFileSync(join(dir, "untracked.txt"), "x");
    expect(
      await runner(["tree", dir, commit], { JIG_HOME: jigHome }),
    ).toMatchObject({
      out: {
        ok: true,
        value: { files: [".config", "note.txt"], note: "committed\n" },
      },
      removed: true,
    });
    expect(readdirSync(join(jigHome, "tmp"))).toEqual([]);
  });

  it("copies under the Jig home, never the system's temporary directory", async () => {
    const { dir, commit } = noted();
    const jigHome = home();
    const out = await runner(["tree", dir, commit], { JIG_HOME: jigHome });
    expect(out.dir.startsWith(join(jigHome, "tmp"))).toBe(true);
  });

  it("runs no hook of the working tree", async () => {
    const { dir, commit } = noted();
    const marker = join(dir, "hook-ran");
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(
      join(dir, ".githooks", "post-index-change"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o755 },
    );
    git(dir, "config", "core.hooksPath", ".githooks");
    await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(existsSync(marker)).toBe(false);
  });

  it("copies bytes the way the commit's attributes say, not the working tree's", async () => {
    const { dir, commit } = noted();
    writeFileSync(join(dir, ".gitattributes"), "note.txt eol=crlf\n");
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out.value.note).toBe("committed\n");
  });

  it("runs no filter the clone configures", async () => {
    const { dir, commit } = noted();
    const marker = join(dir, "filter-ran");
    writeFileSync(join(dir, ".gitattributes"), "note.txt filter=custom\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "attributes");
    git(dir, "config", "filter.custom.smudge", `touch '${marker}'; cat`);
    git(dir, "config", "filter.custom.process", `touch '${marker}'`);
    await runner(["tree", dir, head(dir)], { JIG_HOME: home() });
    expect(existsSync(marker)).toBe(false);
    expect(commit).not.toBe(head(dir));
  });

  it("is removed when the process is terminated mid-copy", async () => {
    if (process.platform === "win32") return;
    const { dir, commit } = noted();
    const child = Bun.spawn(["bun", RUNNER, "treewait", dir, commit], {
      env: { ...process.env, JIG_USER_LAYER: "off", JIG_HOME: home() },
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const tree = new TextDecoder().decode(first.value).trim();
    expect(existsSync(tree)).toBe(true);
    child.kill("SIGTERM");
    await child.exited;
    expect(existsSync(tree)).toBe(false);
  });

  it("fails, running nothing and leaving nothing, for a commit the clone does not have", async () => {
    const { dir } = noted();
    const jigHome = home();
    const { out, removed } = await runner(["tree", dir, "0".repeat(40)], {
      JIG_HOME: jigHome,
    });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("unreadable");
    expect(removed).toBe(false);
    expect(readdirSync(join(jigHome, "tmp"))).toEqual([]);
  });

  /** A repository at `dir` (made here) with one committed `note.txt`; returns its commit. */
  function committedAt(dir: string, ...initArgs: string[]): string {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main", ...initArgs);
    writeFileSync(join(dir, "note.txt"), "committed\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "note");
    return head(dir);
  }

  it("copies from a clone whose path holds the object list's separator", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-sep-"));
    dirs.push(parent);
    const dir = join(
      parent,
      process.platform === "win32" ? "work;archive" : "work:archive;repo",
    );
    const commit = committedAt(dir);
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies from a SHA-256 clone", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-sha256-"));
    dirs.push(parent);
    const dir = join(parent, "repo");
    const commit = committedAt(dir, "--object-format=sha256");
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies from a SHA-1 clone while git defaults to SHA-256", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-sha1-"));
    dirs.push(parent);
    const dir = join(parent, "repo");
    const commit = committedAt(dir, "--object-format=sha1");
    const out = await runner(["tree", dir, commit], {
      JIG_HOME: home(),
      GIT_DEFAULT_HASH: "sha256",
    });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies files a partial clone has not downloaded", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-partial-"));
    dirs.push(parent);
    const origin = join(parent, "origin");
    const commit = committedAt(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const dir = join(parent, "clone");
    git(
      parent,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      `file://${origin}`,
      dir,
    );
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies files of a partial clone that holds several undownloaded blobs", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-partial-many-"));
    dirs.push(parent);
    const origin = join(parent, "origin");
    committedAt(origin);
    writeFileSync(join(origin, "second.txt"), "second\n");
    writeFileSync(join(origin, "third.txt"), "third\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "more");
    const commit = head(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const dir = join(parent, "clone");
    git(
      parent,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      `file://${origin}`,
      dir,
    );
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  /** A partial clone of a fresh origin, its single remote then reconfigured. */
  function partialClone(prefix: string) {
    const parent = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(parent);
    const origin = join(parent, "origin");
    const commit = committedAt(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const dir = join(parent, "clone");
    git(
      parent,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      `file://${origin}`,
      dir,
    );
    return { parent, origin, commit, dir };
  }

  it("takes a remote that only sets a partial-clone filter as a promisor", async () => {
    const { commit, dir } = partialClone("jig-partial-filter-");
    git(dir, "config", "--unset", "remote.origin.promisor");
    git(dir, "config", "remote.origin.partialCloneFilter", "blob:none");
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("skips a remote whose promisor setting is false", async () => {
    const { parent, commit, dir } = partialClone("jig-partial-off-");
    git(dir, "remote", "add", "cache", `file://${join(parent, "nowhere")}`);
    git(dir, "config", "remote.cache.promisor", "false");
    expect(await promisorRemotes(dir)).toEqual(["origin"]);
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("tries the extension's remote last, as git does", async () => {
    const { parent, dir } = partialClone("jig-partial-order-");
    git(dir, "remote", "add", "cache", `file://${join(parent, "nowhere")}`);
    git(dir, "config", "remote.cache.promisor", "true");
    git(dir, "config", "extensions.partialClone", "origin");
    expect(await promisorRemotes(dir)).toEqual(["cache", "origin"]);
  });

  it("falls back to the next promisor when the first cannot supply the files", async () => {
    const { parent, commit, dir } = partialClone("jig-partial-fallback-");
    git(dir, "remote", "add", "cache", `file://${join(parent, "nowhere")}`);
    git(dir, "config", "remote.cache.promisor", "true");
    git(dir, "config", "extensions.partialClone", "origin");
    // The unreachable cache is tried before the origin the objects come from.
    expect(await promisorRemotes(dir)).toEqual(["cache", "origin"]);
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies files under a tree a tree-filtered clone has not downloaded", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-partial-tree-"));
    dirs.push(parent);
    const origin = join(parent, "origin");
    committedAt(origin);
    mkdirSync(join(origin, "scripts", "deep"), { recursive: true });
    writeFileSync(join(origin, "scripts", "deep", "run.txt"), "run\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "nested");
    const commit = head(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const dir = join(parent, "clone");
    git(
      parent,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=tree:0",
      `file://${origin}`,
      dir,
    );
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("copies files nested deeper than any fixed number of tree levels", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-partial-depth-"));
    dirs.push(parent);
    const origin = join(parent, "origin");
    committedAt(origin);
    const nested = join(origin, ...Array.from({ length: 70 }, () => "d"));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "run.txt"), "run\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "nested");
    const commit = head(origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const dir = join(parent, "clone");
    git(
      parent,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=tree:0",
      `file://${origin}`,
      dir,
    );
    const out = await runner(["tree", dir, commit], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  }, 120000);

  it("copies a commit that holds a submodule whose objects the clone lacks", async () => {
    const parent = mkdtempSync(join(tmpdir(), "jig-gitlink-"));
    dirs.push(parent);
    const dir = join(parent, "repo");
    committedAt(dir);
    git(
      dir,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},mod`,
    );
    git(dir, "commit", "-q", "-m", "gitlink");
    const out = await runner(["tree", dir, head(dir)], { JIG_HOME: home() });
    expect(out.out).toMatchObject({ ok: true, value: { note: "committed\n" } });
  });

  it("refuses anything but a full commit id", async () => {
    const { dir } = noted();
    for (const bad of ["HEAD", "--all", "main", "abc123"]) {
      const { out } = await runner(["tree", dir, bad], { JIG_HOME: home() });
      expect(out.ok).toBe(false);
      expect(out.failure.reason).toContain("not a full commit id");
    }
  });
});

describe("the default branch's commit", () => {
  it("reads the configuration of the commit it names, whatever replaces it", async () => {
    const dir = clone("do_item:\n  preflight_command: real\n");
    const real = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir })
      .stdout.toString()
      .trim();
    writeFileSync(
      join(dir, ".config", "jig.yaml"),
      "do_item:\n  preflight_command: fake\n",
    );
    git(dir, "commit", "-q", "-am", "fake");
    const fake = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir })
      .stdout.toString()
      .trim();
    git(dir, "reset", "-q", "--hard", real);
    git(dir, "replace", real, fake);
    expect(
      await runner(["setting", dir, "do_item", "preflight_command"]),
    ).toEqual({ ok: true, value: "real" });
  });

  it("runs no hook of the working tree when it fetches", async () => {
    const dir = clone("do_item: {}\n");
    const remote = mkdtempSync(join(tmpdir(), "jig-remote-"));
    dirs.push(remote);
    git(remote, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "newer");
    git(dir, "push", "-q", "origin", "main");
    git(dir, "reset", "-q", "--hard", "HEAD~1");
    git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    const marker = join(dir, "hook-ran");
    mkdirSync(join(dir, ".githooks"));
    writeFileSync(
      join(dir, ".githooks", "reference-transaction"),
      `#!/bin/sh\ntouch '${marker}'\n`,
      { mode: 0o755 },
    );
    git(dir, "config", "core.hooksPath", ".githooks");
    await runner(["setting", dir, "do_item", "preflight_command"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("is the remote-tracking branch's, even when a tag has the short name", async () => {
    const dir = clone("do_item:\n  preflight_command: check-main\n");
    writeFileSync(
      join(dir, ".config", "jig.yaml"),
      "do_item:\n  preflight_command: check-tag\n",
    );
    git(dir, "commit", "-q", "-am", "elsewhere");
    git(dir, "tag", "origin/main");
    expect(
      await runner(["setting", dir, "do_item", "preflight_command"]),
    ).toEqual({ ok: true, value: "check-main" });
  });
});

/**
 * The Orca workspace tool with Orca and git replaced by a table of answers
 * keyed on the whole command line: nothing here reaches Orca, git or a host.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Answer,
  fail,
  fakeContext,
  type FakeContext,
  ok,
} from "../../herdr/__tests__/fake.ts";
import type { RunResult } from "../../herdr/runner.ts";
import {
  MACOS_APP_COMMAND,
  orcaArgv,
  parseOrcaEnvelope,
  resolveOrcaCommand,
} from "../cli.ts";
import { remoteCommand, remoteRunner, type Workspace } from "../runner.ts";
import {
  CREATE_HOOK_MARK,
  type OpenOptions,
  openWorkspace,
  parseOpen,
  receiptPath,
  removeWorkspace,
} from "../workspace.ts";

const R = "/repo";
const B = "feat/x";
const WT = "/ws/repo/feat-x";
const RID = "rid";
const ID = `${RID}::${WT}`;
const ORCA_BRANCH = "me/feat-x";
const HOOK = `${WT}/.config/worktree-hooks/create`;
const MARK = `/repo/.git/worktrees/feat-x/${CREATE_HOOK_MARK}`;

/** An Orca success envelope. */
const answer = (result: unknown): RunResult =>
  ok(JSON.stringify({ id: "1", ok: true, result }));
/** An Orca error envelope, exit 1. */
const orcaError = (code: string, message = code): RunResult => ({
  status: 1,
  stdout: JSON.stringify({ id: "1", ok: false, error: { code, message } }),
  stderr: "",
});

const porcelain = (rows: [string, string][]): RunResult =>
  ok(
    rows
      .flatMap(([path, branch]) => [
        `worktree ${path}`,
        `branch refs/heads/${branch}`,
        "",
      ])
      .join("\0"),
  );

const row = (branch: string, path = WT, id = ID) => ({
  id,
  path,
  branch: `refs/heads/${branch}`,
});

const options: OpenOptions = {
  repo: "app",
  branch: B,
  base: "origin/main",
  agent: "claude",
  noAgent: false,
  prompt: "/jig:do-item ENG-1",
  key: "ENG-1",
  comment: "ENG-1: Fix",
  linearIssue: "ENG-1",
  activate: true,
};

const show = "orca repo show --repo name:app --json";
const list = `orca worktree list --repo id:${RID} --json`;
const gitList = `git -C ${R} worktree list --porcelain -z`;
const lsRemote = `git -C ${R} ls-remote --exit-code --heads origin ${B}`;
const fetchBranch = `git -C ${R} fetch --prune origin +refs/heads/${B}:refs/remotes/origin/${B}`;
const dropRef = `git -C ${R} update-ref -d refs/remotes/origin/${B}`;
const remoteRef = `git -C ${R} rev-parse --verify --quiet refs/remotes/origin/${B}`;
const localRef = `git -C ${R} show-ref --verify --quiet refs/heads/${B}`;
const fetchBase = `git -C ${R} fetch --prune origin +refs/heads/main:refs/remotes/origin/main`;
const create = (from: string) =>
  `orca worktree create --repo id:${RID} --name ${B} --base-branch ${from} --no-parent --setup skip --comment ENG-1: Fix --activate --json`;
const link = `orca worktree set --worktree id:${ID} --linear-issue ENG-1 --json`;
const launch = `orca agent launch --agent claude --worktree id:${ID} --prompt /jig:do-item ENG-1 --json`;
const testHook = `test -x ${HOOK}`;
const gitDir = `git -C ${WT} rev-parse --absolute-git-dir`;

/** What every run asks: the name check, the repository, the checks of the worktree. */
const common: Record<string, Answer> = {
  [`git check-ref-format --branch ${B}`]: ok(B),
  [show]: answer({ repo: { id: RID, path: R } }),
  [gitDir]: ok("/repo/.git/worktrees/feat-x\n"),
  [`git -C ${WT} rev-parse --path-format=absolute --git-common-dir`]:
    ok("/repo/.git\n"),
  [testHook]: fail(1),
  [link]: orcaError("linear_not_connected"),
};

/** A branch neither side has, created from the base. */
const fresh: Record<string, Answer> = {
  ...common,
  [gitList]: [
    porcelain([[R, "main"]]),
    porcelain([
      [R, "main"],
      [WT, B],
    ]),
  ],
  [lsRemote]: fail(2),
  [fetchBranch]: fail(128, "couldn't find remote ref"),
  [dropRef]: ok(),
  [remoteRef]: fail(1),
  [localRef]: fail(1),
  [fetchBase]: ok(),
  [create("origin/main")]: answer({
    worktree: row(ORCA_BRANCH),
  }),
  [`git -C ${WT} symbolic-ref --short HEAD`]: ok(`${ORCA_BRANCH}\n`),
  [`git -C ${WT} branch -m ${ORCA_BRANCH} ${B}`]: ok(),
  [launch]: answer({ launch: { outcome: { kind: "terminal" } } }),
};

function workspaceOf(
  table: Record<string, Answer>,
  environment?: string,
  ssh?: string,
): Workspace & { ctx: FakeContext } {
  const ctx = fakeContext(table, mkdtempSync(join(tmpdir(), "orca-state-")));
  return {
    ctx,
    orca: ctx,
    host: ctx,
    target: {
      command: "orca",
      ...(environment === undefined ? {} : { environment }),
    },
    ...(ssh === undefined ? {} : { ssh }),
  };
}

describe("a branch no checkout holds", () => {
  test("is created through Orca from the refreshed base, renamed, and its agent started once", () => {
    const ws = workspaceOf(fresh);
    const opened = openWorkspace(ws, options);
    expect(opened).toEqual({
      path: WT,
      branch: B,
      worktreeId: ID,
      reattached: false,
      hookRan: false,
      agentLaunched: true,
      kickoff: "sent",
    });
    const calls = ws.ctx.calls;
    expect(calls.indexOf(fetchBase)).toBeLessThan(
      calls.indexOf(create("origin/main")),
    );
    expect(calls.indexOf(create("origin/main"))).toBeLessThan(
      calls.indexOf(`git -C ${WT} branch -m ${ORCA_BRANCH} ${B}`),
    );
    expect(
      calls.indexOf(`git -C ${WT} branch -m ${ORCA_BRANCH} ${B}`),
    ).toBeLessThan(calls.indexOf(launch));
    expect(ws.ctx.lines.some((l) => l.includes("could not link ENG-1"))).toBe(
      true,
    );
    const receipt = JSON.parse(readFileSync(receiptPath(ws, "ENG-1"), "utf8"));
    expect(receipt).toMatchObject({
      key: "ENG-1",
      status: "sent",
      worktreeId: ID,
      agent: "claude",
      environment: null,
    });
    // Opening it again reattaches and does not start the agent a second time.
    const again = workspaceOf({
      ...common,
      [gitList]: porcelain([
        [R, "main"],
        [WT, B],
      ]),
      [list]: answer({ worktrees: [row(B)] }),
    });
    mkdirSync(dirname(receiptPath(again, "ENG-1")), { recursive: true });
    writeFileSync(
      receiptPath(again, "ENG-1"),
      readFileSync(receiptPath(ws, "ENG-1")),
    );
    const reopened = openWorkspace(again, options);
    expect(reopened).toMatchObject({
      reattached: true,
      agentLaunched: false,
      kickoff: "already-sent",
    });
    expect(
      again.ctx.calls.some((c) => c.startsWith("orca worktree create")),
    ).toBe(false);
    expect(again.ctx.calls.some((c) => c.startsWith("orca agent launch"))).toBe(
      false,
    );
  });

  test("that origin has is created from origin's copy and set to track it", () => {
    const ws = workspaceOf({
      ...fresh,
      [lsRemote]: ok(`abc\trefs/heads/${B}`),
      [fetchBranch]: ok(),
      [remoteRef]: ok("abc\n"),
      [create(`origin/${B}`)]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} checkout --quiet -B ${B} origin/${B}`]: ok(),
      [`git -C ${WT} branch -D ${ORCA_BRANCH}`]: ok(),
      [`git -C ${R} branch --set-upstream-to origin/${B} ${B}`]: ok(),
    });
    expect(openWorkspace(ws, options)).toMatchObject({ reattached: false });
    expect(ws.ctx.calls).toContain(create(`origin/${B}`));
    expect(ws.ctx.calls).toContain(
      `git -C ${R} branch --set-upstream-to origin/${B} ${B}`,
    );
    expect(ws.ctx.calls).not.toContain(fetchBase);
  });

  test("that only this clone has is checked out as it is", () => {
    const ws = workspaceOf({
      ...fresh,
      [localRef]: ok(),
      [create(B)]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} checkout --quiet ${B}`]: ok(),
      [`git -C ${WT} branch -D ${ORCA_BRANCH}`]: ok(),
    });
    openWorkspace(ws, options);
    expect(ws.ctx.calls).toContain(create(B));
    expect(ws.ctx.calls).toContain(`git -C ${WT} checkout --quiet ${B}`);
  });

  test("whose local copy holds commits origin lacks is refused before anything is created", () => {
    const ws = workspaceOf({
      ...fresh,
      [lsRemote]: ok(`abc\trefs/heads/${B}`),
      [fetchBranch]: ok(),
      [remoteRef]: ok("abc\n"),
      [localRef]: ok(),
      [`git -C ${R} rev-list origin/${B}..${B}`]: ok("def\n"),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "1 commit(s) origin lacks",
    );
    expect(ws.ctx.calls.some((c) => c.startsWith("orca worktree create"))).toBe(
      false,
    );
  });

  test("keeps the branch git reports when it is already the one asked for", () => {
    const ws = workspaceOf({
      ...fresh,
      // Orca's answer names a branch; what git has checked out is what counts.
      [create("origin/main")]: answer({ worktree: row(ORCA_BRANCH) }),
      [`git -C ${WT} symbolic-ref --short HEAD`]: ok(`${B}\n`),
    });
    openWorkspace(ws, options);
    expect(ws.ctx.calls.some((c) => c.includes(" branch -m "))).toBe(false);
  });

  test("whose creation left no branch checked out is refused", () => {
    const ws = workspaceOf({
      ...fresh,
      [`git -C ${WT} symbolic-ref --short HEAD`]: fail(
        128,
        "ref HEAD is not a symbolic ref",
      ),
    });
    expect(() => openWorkspace(ws, options)).toThrow("no branch checked out");
  });

  test("lists a detached checkout of the clone without a branch", () => {
    const ws = workspaceOf({
      ...common,
      [gitList]: porcelain([
        [R, "main"],
        [WT, B],
      ]),
      [list]: answer({
        worktrees: [{ id: `${RID}::${R}`, path: R, branch: null }, row(B)],
      }),
      [launch]: answer({}),
    });
    expect(openWorkspace(ws, options)).toMatchObject({ reattached: true });
  });

  test("whose creation Orca reports somewhere git does not list is refused", () => {
    const ws = workspaceOf({
      ...fresh,
      [gitList]: porcelain([[R, "main"]]),
    });
    expect(() => openWorkspace(ws, options)).toThrow(
      "git worktree list has nothing",
    );
  });
});

describe("the repository's create hook", () => {
  const hooked: Record<string, Answer> = {
    ...fresh,
    [testHook]: ok(),
    [`test -f ${MARK}`]: fail(1),
    [HOOK]: ok("installed\n"),
    [`sh -c printf ok > ${MARK}`]: ok(),
  };

  test("runs once in the new worktree, before the agent starts, and leaves a mark", () => {
    const ws = workspaceOf(hooked);
    const opened = openWorkspace(ws, options);
    expect(opened.hookRan).toBe(true);
    const at = ws.ctx.calls.indexOf(HOOK);
    expect(ws.ctx.options[at]?.cwd).toBe(WT);
    expect(at).toBeLessThan(ws.ctx.calls.indexOf(launch));
    expect(ws.ctx.calls.indexOf(`sh -c printf ok > ${MARK}`)).toBeLessThan(
      ws.ctx.calls.indexOf(launch),
    );
    expect(ws.ctx.lines).toContain("installed");
  });

  test("is not run again where its mark is", () => {
    const ws = workspaceOf({ ...hooked, [`test -f ${MARK}`]: ok() });
    expect(openWorkspace(ws, options).hookRan).toBe(false);
    expect(ws.ctx.calls).not.toContain(HOOK);
  });

  test("that fails stops the open before the agent starts, and leaves no mark or receipt", () => {
    const ws = workspaceOf({ ...hooked, [HOOK]: fail(3, "no network") });
    expect(() => openWorkspace(ws, options)).toThrow(
      `${HOOK} failed (exit 3); fix the hook and open the workspace again`,
    );
    expect(ws.ctx.calls).not.toContain(launch);
    expect(ws.ctx.calls).not.toContain(`sh -c printf ok > ${MARK}`);
    expect(existsSync(receiptPath(ws, "ENG-1"))).toBe(false);
  });
});

describe("a branch a checkout already holds", () => {
  const held: Record<string, Answer> = {
    ...common,
    [gitList]: porcelain([
      [R, "main"],
      [WT, B],
    ]),
    [list]: answer({ worktrees: [row(B)] }),
    [launch]: answer({}),
  };

  test("is reattached, and its agent started when no open started one", () => {
    const ws = workspaceOf(held);
    expect(openWorkspace(ws, options)).toMatchObject({
      reattached: true,
      agentLaunched: true,
      kickoff: "sent",
    });
    expect(ws.ctx.calls).not.toContain(link);
  });

  test("that Orca does not list is refused rather than duplicated", () => {
    const ws = workspaceOf({ ...held, [list]: answer({ worktrees: [] }) });
    expect(() => openWorkspace(ws, options)).toThrow(
      "which Orca does not list",
    );
  });

  test("whose earlier start has no recorded outcome is refused until a person looks", () => {
    const ws = workspaceOf(held);
    const file = receiptPath(ws, "ENG-1");
    const pending = {
      key: "ENG-1",
      status: "pending",
      worktreeId: ID,
      agent: "claude",
      environment: null,
      at: "2026-01-01T00:00:00Z",
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(pending));
    expect(() => openWorkspace(ws, options)).toThrow("no outcome recorded");
    expect(ws.ctx.calls).not.toContain(launch);
  });

  test("is opened on the one existing branch its reuse prefix finds", () => {
    const reuse = { ...options, branch: "feat/x-new", reusePrefix: "feat/x" };
    const ws = workspaceOf({
      ...held,
      "git check-ref-format --branch feat/x-new": ok(),
      [`git -C ${R} for-each-ref --format=%(refname) refs/heads/`]: ok(
        `refs/heads/main\nrefs/heads/${B}\n`,
      ),
      [`git -C ${R} ls-remote --heads origin`]: ok(""),
    });
    expect(openWorkspace(ws, reuse).branch).toBe(B);
  });

  test("with --no-agent is opened without starting anything", () => {
    const ws = workspaceOf(held);
    expect(openWorkspace(ws, { ...options, noAgent: true })).toMatchObject({
      agentLaunched: false,
      kickoff: "none",
    });
    expect(ws.ctx.calls).not.toContain(launch);
  });
});

describe("a paired server", () => {
  test("is named on every Orca call, and its receipts are kept apart", () => {
    const serverFresh: Record<string, Answer> = {};
    for (const [key, value] of Object.entries(fresh))
      serverFresh[
        key.startsWith("orca ")
          ? key.replace(/ --json$/, " --environment box --json")
          : key
      ] = value;
    const ws = workspaceOf(serverFresh, "box", "box");
    openWorkspace(ws, options);
    for (const call of ws.ctx.calls.filter((c) => c.startsWith("orca ")))
      expect(call.endsWith(" --environment box --json")).toBe(true);
    expect(receiptPath(ws, "ENG-1")).toBe(
      join(ws.ctx.stateDir, "kickoff", "box", "ENG-1.json"),
    );
    expect(
      JSON.parse(readFileSync(receiptPath(ws, "ENG-1"), "utf8")).environment,
    ).toBe("box");
  });

  test("names a repository Orca does not have there", () => {
    const ws = workspaceOf(
      {
        [`git check-ref-format --branch ${B}`]: ok(),
        "orca repo show --repo name:app --environment box --json":
          orcaError("repo_not_found"),
      },
      "box",
      "box",
    );
    expect(() => openWorkspace(ws, options)).toThrow(
      "Orca on box has no repository named app",
    );
  });
});

describe("remove", () => {
  const removable: Record<string, Answer> = {
    [show]: answer({ repo: { id: RID, path: R } }),
    [gitList]: porcelain([
      [R, "main"],
      [WT, B],
    ]),
    [gitDir]: ok("/repo/.git/worktrees/feat-x\n"),
    [`git -C ${WT} rev-parse --path-format=absolute --git-common-dir`]:
      ok("/repo/.git\n"),
    [list]: answer({ worktrees: [row(B)] }),
    [`test -x ${WT}/.config/worktree-hooks/remove`]: fail(1),
    [`orca worktree rm --worktree id:${ID} --environment box --json`]: answer({
      removed: true,
    }),
  };

  test("on a server runs the remove hook, says findings are not parked, and removes through Orca", async () => {
    const table: Record<string, Answer> = {};
    for (const [key, value] of Object.entries(removable))
      table[
        key.startsWith("orca ") && !key.includes("--environment")
          ? key.replace(/ --json$/, " --environment box --json")
          : key
      ] = value;
    const ws = workspaceOf(table, "box", "box");
    expect(
      await removeWorkspace(ws, { repo: "app", branch: B, force: false }),
    ).toBe(WT);
    expect(ws.ctx.lines.some((l) => l.includes("not parked on box"))).toBe(
      true,
    );
  });

  test("refuses a worktree with uncommitted changes unless forced", async () => {
    const table: Record<string, Answer> = {};
    for (const [key, value] of Object.entries(removable))
      table[
        key.startsWith("orca ") && !key.includes("--environment")
          ? key.replace(/ --json$/, " --environment box --json")
          : key
      ] = value;
    table[`orca worktree rm --worktree id:${ID} --environment box --json`] =
      orcaError("worktree_dirty", "uncommitted changes");
    const ws = workspaceOf(table, "box", "box");
    await expect(
      removeWorkspace(ws, { repo: "app", branch: B, force: false }),
    ).rejects.toThrow("pass --force");
  });
});

describe("Orca's command", () => {
  const has =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  test("is the one of the terminal Orca opened, else the one on PATH, else the macOS app's", () => {
    expect(
      resolveOrcaCommand(
        { ORCA_CLI_BIN_DIR: "/app/bin", PATH: "/usr/bin" },
        "darwin",
        has("/app/bin/orca", "/usr/bin/orca"),
      ),
    ).toBe("/app/bin/orca");
    expect(
      resolveOrcaCommand(
        { PATH: "/usr/local/bin:/usr/bin" },
        "darwin",
        has("/usr/bin/orca"),
      ),
    ).toBe("/usr/bin/orca");
    expect(
      resolveOrcaCommand(
        { PATH: "/usr/bin" },
        "darwin",
        has(MACOS_APP_COMMAND),
      ),
    ).toBe(MACOS_APP_COMMAND);
  });

  test("on Linux is orca-ide, never the screen reader", () => {
    expect(
      resolveOrcaCommand(
        { PATH: "/usr/bin" },
        "linux",
        has("/usr/bin/orca", "/usr/bin/orca-ide"),
      ),
    ).toBe("/usr/bin/orca-ide");
    expect(() =>
      resolveOrcaCommand({ PATH: "/usr/bin" }, "linux", has("/usr/bin/orca")),
    ).toThrow("orca-ide) was not found");
  });

  test("carries the server and asks for JSON", () => {
    expect(orcaArgv({ command: "orca" }, ["repo", "list"])).toEqual([
      "orca",
      "repo",
      "list",
      "--json",
    ]);
    expect(
      orcaArgv({ command: "/a/orca-ide", environment: "box" }, ["status"]),
    ).toEqual(["/a/orca-ide", "status", "--environment", "box", "--json"]);
    expect(parseOrcaEnvelope("not json")).toBeNull();
    expect(parseOrcaEnvelope('{"ok":true,"result":1}')).toEqual({
      ok: true,
      result: 1,
    });
  });
});

describe("a command on the server's host", () => {
  test("runs over SSH in its directory with untranslated messages", () => {
    expect(remoteCommand(["git", "status"])).toBe(
      "LC_ALL=C LANGUAGE= git status",
    );
    expect(remoteCommand(["git", "log", "a b"], { cwd: "/w t" })).toBe(
      "cd '/w t' && LC_ALL=C LANGUAGE= git log 'a b'",
    );
    const seen: unknown[] = [];
    const run = remoteRunner("box", ((
      command: string,
      args: string[],
      opts: unknown,
    ) => {
      seen.push([command, args, opts]);
      return { status: 0, stdout: "ok", stderr: "" };
    }) as never);
    expect(run(["git", "status"], { cwd: "/w", timeoutMs: 5 })).toEqual({
      status: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(seen[0]).toMatchObject([
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "box",
        "cd /w && LC_ALL=C LANGUAGE= git status",
      ],
      { timeout: 5 },
    ]);
    expect(() => remoteRunner("-oProxyCommand=x")).toThrow(
      "not an SSH destination",
    );
  });
});

describe("the command line", () => {
  test("needs a repository and a branch, and a server needs its host", () => {
    expect(() => parseOpen(["--repo", "app"])).toThrow("--repo and --branch");
    expect(() =>
      parseOpen(["--repo", "app", "--branch", B, "--environment", "box"]),
    ).toThrow("--environment needs --ssh");
    expect(() =>
      parseOpen(["--repo", "app", "--branch", B, "--ssh", "box"]),
    ).toThrow("--ssh needs --environment");
    expect(() =>
      parseOpen(["--repo", "app", "--branch", B, "--key", "a b"]),
    ).toThrow("--key must match");
    expect(() =>
      parseOpen(["--repo", "app", "--branch", B, "--reuse-prefix", "other/"]),
    ).toThrow("must start with --reuse-prefix");
    expect(
      parseOpen([
        "--repo",
        "app",
        "--branch",
        B,
        "--environment",
        "box",
        "--ssh",
        "box.example",
        "--prompt",
        "hi",
        "--key",
        "ENG-1",
        "--json",
      ]),
    ).toEqual({
      repo: "app",
      branch: B,
      environment: "box",
      ssh: "box.example",
      agent: "claude",
      noAgent: false,
      prompt: "hi",
      key: "ENG-1",
      activate: false,
      json: true,
    });
  });
});

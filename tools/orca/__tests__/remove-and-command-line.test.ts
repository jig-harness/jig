/**
 * Removing Orca worktree workspaces, Orca's command and its answers, the
 * host's commands and the command line, against the table in table.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventProblems } from "../../../plugin/skills/reflect/scripts/lib/events.ts";
import { type Answer, fail, ok } from "../../herdr/__tests__/fake.ts";
import type { RunResult } from "../../herdr/runner.ts";
import {
  MACOS_APP_COMMAND,
  orcaArgv,
  parseOrcaEnvelope,
  resolveOrcaCommand,
} from "../cli.ts";
import { remoteCommand, remoteRunner } from "../runner.ts";
import { openArgs, parseOpen, removeWorkspace } from "../workspace.ts";
import {
  answer,
  B,
  commonDir,
  GIT_DIR,
  gitDir,
  gitList,
  hostHome,
  ID,
  JOURNAL,
  list,
  onBox,
  options,
  orcaError,
  porcelain,
  R,
  receiptOf,
  REPO_CONFIG,
  retiredBeside,
  RID,
  row,
  sentReceipt,
  show,
  USER_CONFIG,
  userConfigPath,
  workspaceOf,
  writeReceiptFile,
  WT,
} from "./table.ts";

describe("remove", () => {
  const removable: Record<string, Answer> = onBox({
    [show]: answer({ repo: { id: RID, path: R } }),
    [gitList]: porcelain([
      [R, "main"],
      [WT, B],
    ]),
    [gitDir]: ok(`${GIT_DIR}\n`),
    [commonDir(WT)]: ok("/repo/.git\n"),
    [list]: answer({ worktrees: [row(B)] }),
    [`test -x ${WT}/.config/worktree-hooks/remove`]: fail(1),
    // The host's configuration names no journal, so the default is looked at.
    [userConfigPath]: ok(USER_CONFIG),
    [`test -f ${USER_CONFIG}`]: fail(1),
    [`test -f ${REPO_CONFIG}`]: fail(1),
    [`test -f ${JOURNAL}`]: fail(1),
    [`orca worktree rm --worktree id:${ID} --json`]: answer({ removed: true }),
  });
  const removing = { repo: "app", branch: B, force: false };
  const rm = `orca worktree rm --worktree id:${ID} --environment box --json`;

  /** A finding as the reflect skill journals it, checked against its own rules. */
  const finding = {
    v: 1,
    type: "finding",
    id: "20260101T000000Z-0123456789abcdef",
    at: "2026-01-01T00:00:00Z",
    session: {
      jig_version: null,
      skills: [],
      harness: null,
      model: null,
      mode: null,
      stated: [],
    },
    change: {
      repository: "github.com/acme/app",
      branch: B,
      pull_request: null,
      issue: null,
    },
    kind: "error",
    severity: "low",
    class: "narrow-fix-per-round",
    target: { scope: "repository", name: "app" },
    title: "A finding",
    description: "What was seen",
    suggested_fix: "What to change",
  };
  const contributed = {
    type: "contributed",
    id: finding.id,
    ref: "store/1",
    at: "2026-01-01T00:00:01Z",
  };
  const journalOf = (...lines: object[]): RunResult =>
    ok(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));

  test("on a server runs the remove hook, sees the worktree has no journal, and removes through Orca", async () => {
    const ws = workspaceOf(removable, "box", "box");
    expect(await removeWorkspace(ws, removing)).toBe(WT);
    expect(ws.ctx.calls).toContain(rm);
    expect(
      ws.ctx.lines.some((l) =>
        l.includes("has no reflection journal; nothing to park on box"),
      ),
    ).toBe(true);
  });

  test("on a server refuses while the worktree's journal holds unsent findings", async () => {
    expect(eventProblems(finding)).toEqual([]);
    const ws = workspaceOf(
      {
        ...removable,
        [`test -f ${JOURNAL}`]: ok(),
        [`cat ${JOURNAL}`]: journalOf(finding),
      },
      "box",
      "box",
    );
    await expect(removeWorkspace(ws, removing)).rejects.toThrow(
      `${WT} has 1 unsent reflection finding(s) in ${JOURNAL}`,
    );
    expect(ws.ctx.calls).not.toContain(rm);
  });

  test("on a server removes a worktree whose findings were all sent", async () => {
    const ws = workspaceOf(
      {
        ...removable,
        [`test -f ${JOURNAL}`]: ok(),
        [`cat ${JOURNAL}`]: journalOf(finding, contributed),
      },
      "box",
      "box",
    );
    expect(await removeWorkspace(ws, removing)).toBe(WT);
    expect(
      ws.ctx.lines.some((l) => l.includes("has no unsent reflection findings")),
    ).toBe(true);
  });

  test("on a server looks for the journal where the worktree's configuration puts it, reflection on or off", async () => {
    const configured = `${WT}/.context/reflection.jsonl`;
    const ws = workspaceOf(
      {
        ...removable,
        [`test -f ${REPO_CONFIG}`]: ok(),
        [`cat ${REPO_CONFIG}`]: ok(
          "reflection:\n  enabled: false\n  journal: .context/reflection.jsonl\n",
        ),
        [`test -f ${configured}`]: ok(),
        [`cat ${configured}`]: journalOf(finding),
      },
      "box",
      "box",
    );
    await expect(removeWorkspace(ws, removing)).rejects.toThrow(
      `${WT} has 1 unsent reflection finding(s) in ${configured}`,
    );
    expect(ws.ctx.calls).not.toContain(`test -f ${JOURNAL}`);
    expect(ws.ctx.calls).not.toContain(rm);
  });

  test("on a server reads the host user's configuration under the worktree's, and ~ as the host's home", async () => {
    const ws = workspaceOf(
      {
        ...removable,
        [`test -f ${USER_CONFIG}`]: ok(),
        [`cat ${USER_CONFIG}`]: ok(
          "reflection:\n  journal: ~/journals/app.jsonl\n",
        ),
        [hostHome]: ok("/home/me\n"),
        "test -f /home/me/journals/app.jsonl": fail(1),
      },
      "box",
      "box",
    );
    expect(await removeWorkspace(ws, removing)).toBe(WT);
    expect(ws.ctx.calls).toContain("test -f /home/me/journals/app.jsonl");
    expect(ws.ctx.calls).not.toContain(`test -f ${JOURNAL}`);
    // The worktree's own setting is laid over the user's.
    const over = workspaceOf(
      {
        ...removable,
        [`test -f ${USER_CONFIG}`]: ok(),
        [`cat ${USER_CONFIG}`]: ok(
          "reflection:\n  journal: ~/journals/app.jsonl\n",
        ),
        [`test -f ${REPO_CONFIG}`]: ok(),
        [`cat ${REPO_CONFIG}`]: ok(
          "reflection:\n  journal: /srv/journals/app.jsonl\n",
        ),
        "test -f /srv/journals/app.jsonl": fail(1),
      },
      "box",
      "box",
    );
    expect(await removeWorkspace(over, removing)).toBe(WT);
    expect(over.ctx.calls).toContain("test -f /srv/journals/app.jsonl");
    expect(over.ctx.calls).not.toContain(hostHome);
  });

  test("on a server refuses while it cannot tell where the journal is", async () => {
    const cases: [Answer, string][] = [
      [fail(1, "Permission denied"), `cannot read ${REPO_CONFIG} on box`],
      [ok("reflection: ["), "could not be parsed"],
      [ok("reflection:\n  journal: 3\n"), "must be a path"],
      [ok("reflection:\n  journal: ''\n"), "must be a path"],
    ];
    for (const [config, message] of cases) {
      const ws = workspaceOf(
        {
          ...removable,
          [`test -f ${REPO_CONFIG}`]: ok(),
          [`cat ${REPO_CONFIG}`]: config,
        },
        "box",
        "box",
      );
      await expect(removeWorkspace(ws, removing)).rejects.toThrow(message);
      expect(ws.ctx.calls).not.toContain(`test -f ${JOURNAL}`);
      expect(ws.ctx.calls).not.toContain(rm);
    }
  });

  test("on a server refuses a journal it cannot read, naming the host", async () => {
    const ws = workspaceOf(
      {
        ...removable,
        [`test -f ${JOURNAL}`]: ok(),
        [`cat ${JOURNAL}`]: fail(1, "Permission denied"),
      },
      "box",
      "box",
    );
    await expect(removeWorkspace(ws, removing)).rejects.toThrow(
      `cannot read ${JOURNAL} on box`,
    );
    expect(ws.ctx.calls).not.toContain(rm);
  });

  test("refuses a worktree with uncommitted changes unless forced", async () => {
    const ws = workspaceOf(
      {
        ...removable,
        [rm]: orcaError("worktree_dirty", "uncommitted changes"),
      },
      "box",
      "box",
    );
    await expect(removeWorkspace(ws, removing)).rejects.toThrow("pass --force");
  });

  test("sets aside the receipts of agents started in the removed worktree, and nothing else", async () => {
    const ws = workspaceOf(removable, "box", "box");
    const gone = receiptOf(ws);
    const elsewhere = receiptOf(ws, "ENG-2");
    const notes = join(dirname(gone), "notes.txt");
    writeReceiptFile(gone, { ...sentReceipt(), environment: "box" });
    writeReceiptFile(elsewhere, {
      ...sentReceipt(`${RID}::/ws/repo/eng-2`),
      key: "ENG-2",
      environment: "box",
    });
    writeFileSync(notes, "not a receipt");
    await removeWorkspace(ws, removing);
    expect(existsSync(gone)).toBe(false);
    expect(retiredBeside(gone)).toHaveLength(1);
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(notes)).toBe(true);
    expect(
      ws.ctx.lines.some((l) =>
        l.includes("the next open of ENG-1 starts it again"),
      ),
    ).toBe(true);
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
  });

  test("answers one of two envelopes, and anything else is no answer", () => {
    expect(parseOrcaEnvelope("not json")).toBeNull();
    expect(parseOrcaEnvelope('{"ok":true,"result":1}')).toEqual({
      ok: true,
      result: 1,
    });
    expect(parseOrcaEnvelope('{"ok":true}')).toEqual({
      ok: true,
      result: undefined,
    });
    expect(
      parseOrcaEnvelope('{"ok":false,"error":{"code":"x","message":"m"}}'),
    ).toEqual({ ok: false, error: { code: "x", message: "m" } });
    expect(parseOrcaEnvelope('{"ok":false}')).toBeNull();
    expect(parseOrcaEnvelope('{"result":{}}')).toBeNull();
    expect(parseOrcaEnvelope('{"ok":"yes","result":{}}')).toBeNull();
  });

  test("whose answer is malformed is a failed call, never a success", async () => {
    const ws = workspaceOf(
      {
        ...onBox({
          [show]: answer({ repo: { id: RID, path: R } }),
          [gitList]: porcelain([
            [R, "main"],
            [WT, B],
          ]),
          [gitDir]: ok(`${GIT_DIR}\n`),
          [commonDir(WT)]: ok("/repo/.git\n"),
          [list]: answer({ worktrees: [row(B)] }),
          [`test -x ${WT}/.config/worktree-hooks/remove`]: fail(1),
          [userConfigPath]: ok(USER_CONFIG),
          [`test -f ${USER_CONFIG}`]: fail(1),
          [`test -f ${REPO_CONFIG}`]: fail(1),
          [`test -f ${JOURNAL}`]: fail(1),
        }),
        [`orca worktree rm --worktree id:${ID} --environment box --json`]:
          ok('{"ok":false}'),
      },
      "box",
      "box",
    );
    await expect(
      removeWorkspace(ws, { repo: "app", branch: B, force: false }),
    ).rejects.toThrow("orca worktree rm: unreadable output");
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
      parseOpen(["--repo", "app", "--branch", B, "--agent", " "]),
    ).toThrow("--agent needs an Orca agent id");
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

  test("is what openArgs writes for a caller that runs the tool as a process", () => {
    const target = { environment: "box", ssh: "box.example" };
    const full = { ...options, reusePrefix: "feat/" };
    expect(parseOpen([...openArgs(full, target), "--json"])).toEqual({
      ...full,
      ...target,
      json: true,
    });
    const { prompt: _prompt, ...unprompted } = options;
    expect(parseOpen(openArgs({ ...unprompted, noAgent: true }))).toMatchObject(
      { noAgent: true, activate: true, json: false },
    );
    expect(openArgs(options)).not.toContain("--environment");
  });
});

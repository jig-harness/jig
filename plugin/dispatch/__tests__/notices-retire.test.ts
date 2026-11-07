/**
 * dispatch --apply: the repository's notices workspace is removed once its
 * job is done, read for `dispatch.notices_linger` or unread with every cause
 * it carried gone, and never while it holds something of a person's. A new
 * one has its first terminal closed. Removing it sends nothing again.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { TickReceipt } from "../receipts.ts";
import { statePath } from "../lib/state.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { notifyWrites, orcaCalls, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #8 stopped on exit 7 with no workspace of its own, so its notice goes to the notices workspace. */
function fixture(config = CONFIG, before?: (w: World) => void): World {
  const w = world();
  current = w;
  w.setConfig(config);
  before?.(w);
  withOrigin(w);
  w.setPrs("open", [openPr(8, "feature/8-failed")]);
  w.setComments(8, [ledgerComment(801, stoppedLedger(8, 7))]);
  w.setWorkspaces([]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const outcome = (r: TickReceipt) => r.repos[0]?.noticesWorkspace;

type PsRow = { path: string; unread: boolean; comment: string };

function psRows(w: World): PsRow[] {
  return (
    JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
      worktrees: PsRow[];
    }
  ).worktrees;
}

/** A person opens the workspace at `path`: Orca clears its unread mark. */
function read(w: World, path: string): void {
  const ps = JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
    worktrees: PsRow[];
  };
  for (const row of ps.worktrees) if (row.path === path) row.unread = false;
  writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
}

/** Move the time the tick first found the notices workspace read back by `ms`. */
function backdate(w: World, ms: number): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.run("UPDATE notices_read SET since = since - ?", [ms]);
  } finally {
    db.close();
  }
}

/** The notices workspace's path, from the first tick's notification. */
async function opened(w: World): Promise<string> {
  const first = await tick(w);
  const path = first.repos[0]?.notifications[0]?.workspace ?? "";
  expect(path).not.toBe("");
  expect(outcome(first)).toEqual({
    workspace: path,
    outcome: "kept",
    detail: "written this tick",
  });
  return path;
}

describe("jig dispatch --apply retires the notices workspace", () => {
  it("prunes ownership snapshots when their workspace leaves the runtime", async () => {
    const w = fixture();
    await opened(w);
    const before = new Database(statePath(dispatchState(w)));
    before.run(
      "INSERT INTO notices_content (workspace, comment, repo) VALUES (?, ?, ?)",
      ["/other-repository/notices", "other notices", "other/repo"],
    );
    before.close();
    w.setWorkspaces([{ path: w.repo, branch: "feature/other" }]);
    await tick(w);
    const db = new Database(statePath(dispatchState(w)));
    try {
      expect(db.query("SELECT workspace FROM notices_content").all()).toEqual([
        { workspace: "/other-repository/notices" },
      ]);
    } finally {
      db.close();
    }
  });
  it("closes a new notices workspace's terminals, and keeps it while its cause stands unread", async () => {
    const w = fixture();
    const path = await opened(w);
    expect(orcaCalls(w, "terminal", "close")).toEqual([
      ["terminal", "close", "--worktree", `path:${path}`, "--all", "--json"],
    ]);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "kept",
      detail: expect.stringContaining("still stands"),
    });
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  it("removes it once read for the linger, and opens no new one for the cause already sent", async () => {
    const w = fixture();
    const path = await opened(w);
    read(w, path);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({
        outcome: "kept",
        detail: expect.stringContaining("dispatch.notices_linger"),
      }),
    );
    backdate(w, 61 * 60_000);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ workspace: path, outcome: "retired" }),
    );
    expect(orcaCalls(w, "worktree", "rm")).toEqual([
      [
        "worktree",
        "rm",
        "--worktree",
        `path:${path}`,
        "--delete-branch",
        "--json",
      ],
    ]);
    expect(psRows(w).map((r) => r.path)).not.toContain(path);
    const branch = Bun.spawnSync([
      "git",
      "-C",
      w.repo,
      "show-ref",
      "--quiet",
      "--verify",
      "refs/heads/jig-dispatch-notices",
    ]);
    expectSpawnExit(branch, 1);

    const after = await tick(w);
    expect(after.repos[0]?.notifications).toEqual([
      expect.objectContaining({ target: "PR #8", outcome: "suppressed" }),
    ]);
    expect(outcome(after)).toBeUndefined();
    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(notifyWrites(w)).toHaveLength(1);
  });

  it("removes it at the first read tick when dispatch.notices_linger is 0s", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    read(w, path);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ workspace: path, outcome: "retired" }),
    );
  });

  it("does not run the repository's create hook in it, so what a hook installs never keeps it", async () => {
    // A create hook that installs ignored content, as a dependency install does.
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`, (w) => {
      const hook = join(w.repo, ".config", "worktree-hooks", "create");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(
        hook,
        "#!/bin/sh\nmkdir -p node_modules && touch node_modules/.installed\n",
      );
      chmodSync(hook, 0o755);
      writeFileSync(join(w.repo, ".gitignore"), "node_modules/\n");
      for (const args of [
        ["add", "-A"],
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.com",
          "commit",
          "-q",
          "-m",
          "add a create hook",
        ],
      ])
        expectSpawnExit(
          Bun.spawnSync(["git", "-C", w.repo, ...args], {
            env: w.env,
            stdout: "pipe",
            stderr: "pipe",
          }),
          0,
        );
    });
    const path = await opened(w);
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    read(w, path);
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ workspace: path, outcome: "retired" }),
    );
  });

  it("removes it unread once every cause it carried is gone", async () => {
    const w = fixture();
    const path = await opened(w);
    w.setPrs("open", []);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "retired",
      detail: expect.stringContaining("every cause it carried is gone"),
    });
  });

  it("leaves it for a person when git shows changes in it", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    writeFileSync(join(path, "notes.md"), "a person's notes\n");
    read(w, path);
    expect(outcome(await tick(w))).toEqual({
      workspace: path,
      outcome: "refused",
      detail: "git reports changes in it; left for a person",
    });
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  it("leaves it for a person when its comment is not the dispatcher's", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    const ps = JSON.parse(
      readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
    ) as {
      worktrees: PsRow[];
    };
    for (const row of ps.worktrees)
      if (row.path === path) {
        row.comment = "Look at the flaky retry test";
        row.unread = false;
      }
    writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
    expect(outcome(await tick(w))).toEqual(
      expect.objectContaining({ outcome: "refused" }),
    );
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });
  it("keeps personal notes appended to a dispatcher notice", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    const ps = JSON.parse(
      readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
    ) as { worktrees: PsRow[] };
    for (const row of ps.worktrees)
      if (row.path === path) {
        row.comment += "\nMy personal notes";
        row.unread = false;
      }
    writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
    expect(outcome(await tick(w))?.outcome).toBe("refused");
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  it("restarts the linger after an unread tick that holds personal content", async () => {
    const w = fixture();
    const path = await opened(w);
    read(w, path);
    await tick(w);
    backdate(w, 61 * 60_000);
    const ps = JSON.parse(
      readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
    ) as { worktrees: Array<PsRow & { agents: unknown[] }> };
    const row = ps.worktrees.find((r) => r.path === path);
    if (row === undefined) throw new Error("notices workspace missing");
    row.unread = true;
    row.agents = [{ paneKey: "tab:pane", state: "running" }];
    writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
    expect(outcome(await tick(w))?.outcome).toBe("refused");
    row.agents = [];
    row.unread = false;
    writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
    expect(outcome(await tick(w))?.outcome).toBe("kept");
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  for (const uncertainty of ["withheld", "unplaced", "out-of-scope"])
    it(`keeps a lasting cause whose target is ${uncertainty}`, async () => {
      const w = fixture();
      const path = await opened(w);
      const row = psRows(w).find((r) => r.path === path);
      if (!row) throw new Error("missing workspace");
      const child = join(w.root, "uncertain-retirement.ts");
      writeFileSync(
        child,
        `
        import { retireNotices } from ${JSON.stringify(new URL("../lib/actions/retire-notices.ts", import.meta.url).pathname)};
        const report = { records: [], unplaced: ${JSON.stringify(uncertainty === "unplaced" ? [{ target: "PR #8" }] : [])}, withheld: ${JSON.stringify(uncertainty === "withheld" ? ["PR #8"] : [])}, inScope: ${JSON.stringify(uncertainty === "out-of-scope" ? [] : [8])} };
        await retireNotices({ machine: { runtimeTimeoutMs: 5000 }, runtime: { retire: async () => ({ ok: true, detail: "removed" }) } }, report, { repo: "${SLUG}", workspace: ${JSON.stringify({ ...row, id: `repo-1::${path}`, agents: [], unverifiableTerminals: 0 })}, takesComment: true, written: new Set(), causes: [], records: [{ key: "drifting:8", target: "PR #8", workspace: ${JSON.stringify(path)}, lasting: true }], lingerMs: 0, nowMs: Date.now(), root: ${JSON.stringify(dispatchState(w))} });
        console.log(JSON.stringify(report.noticesWorkspace));
      `,
      );
      const result = await w.dispatch([], child);
      expectSpawnExit(result, 0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "kept",
        detail: expect.stringContaining("still has its record"),
      });
    });

  for (const unread of [undefined, null, "false"])
    it(`restarts linger after an unknown listed unread mark ${String(unread)}`, async () => {
      const w = fixture();
      const path = await opened(w);
      read(w, path);
      await tick(w);
      const ps = JSON.parse(
        readFileSync(join(w.dir, "orca-ps.json"), "utf8"),
      ) as { worktrees: Array<{ path: string; unread?: unknown }> };
      const row = ps.worktrees.find((r) => r.path === path);
      if (!row) throw new Error("missing workspace");
      row.unread = unread;
      writeFileSync(join(w.dir, "orca-ps.json"), JSON.stringify(ps));
      await tick(w);
      backdate(w, 61 * 60_000);
      read(w, path);
      expect(outcome(await tick(w))?.detail).toContain(
        "dispatch.notices_linger",
      );
      expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
    });

  for (const change of [
    { agents: [{ paneKey: "tab:pane", state: "running" }] },
    { unverifiableTerminalCount: 1 },
    { worktreeId: "replacement-workspace" },
  ])
    it(`refuses removal when the final read reveals ${JSON.stringify(change)}`, async () => {
      const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
      const path = await opened(w);
      read(w, path);
      writeFileSync(join(w.dir, "orca-on-show.json"), JSON.stringify(change));
      expect(outcome(await tick(w))?.outcome).toBe("refused");
      expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
    });

  for (const unread of [undefined, null, "false"])
    it(`refuses an unread mark of ${String(unread)}`, async () => {
      const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
      const path = await opened(w);
      read(w, path);
      const row = psRows(w).find((r) => r.path === path);
      if (row === undefined) throw new Error("notices workspace missing");
      writeFileSync(
        join(w.dir, "orca-show-card.json"),
        JSON.stringify({
          id: `repo-1::${path}`,
          path,
          comment: row.comment,
          isUnread: unread,
        }),
      );
      expect(outcome(await tick(w))?.outcome).toBe("refused");
      expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
    });

  it("keeps a checkout switched to a different clean branch during retirement", async () => {
    const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
    const path = await opened(w);
    read(w, path);
    writeFileSync(join(w.dir, "orca-show-switch"), "");
    expect(outcome(await tick(w))?.outcome).toBe("refused");
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  for (const change of [{ comment: "Personal notes" }, { unread: true }])
    it(`keeps card changes after the first reread: ${JSON.stringify(change)}`, async () => {
      const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
      const path = await opened(w);
      read(w, path);
      const row = psRows(w).find((r) => r.path === path);
      if (!row) throw new Error("missing workspace");
      writeFileSync(
        join(w.dir, "orca-show-card.json"),
        JSON.stringify({
          id: `repo-1::${path}`,
          path,
          comment: row.comment,
          isUnread: false,
        }),
      );
      writeFileSync(join(w.dir, "orca-on-show.json"), JSON.stringify(change));
      expect(outcome(await tick(w))?.outcome).toBe("refused");
      expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
    });

  it("restarts linger when the runtime observes an unread card", async () => {
    const w = fixture();
    const path = await opened(w);
    read(w, path);
    await tick(w);
    backdate(w, 61 * 60_000);
    writeFileSync(
      join(w.dir, "orca-on-show.json"),
      JSON.stringify({ unread: true }),
    );
    expect(outcome(await tick(w))?.outcome).toBe("kept");
    read(w, path);
    expect(outcome(await tick(w))?.detail).toContain("dispatch.notices_linger");
    expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
  });

  for (const hidden of ["ignored", "assume-unchanged", "skip-worktree"])
    it(`preserves personal files hidden by ${hidden}`, async () => {
      const w = fixture(`${CONFIG}dispatch:\n  notices_linger: 0s\n`);
      writeFileSync(join(w.repo, "tracked.txt"), "original\n");
      for (const args of [
        ["add", "tracked.txt"],
        [
          "-c",
          "user.name=Tester",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "seed tracked file",
        ],
        ["push", "-q", "origin", "main"],
      ])
        expectSpawnExit(
          Bun.spawnSync(["git", "-C", w.repo, ...args], { env: w.env }),
          0,
        );
      const path = await opened(w);
      if (hidden === "ignored") {
        const exclude = Bun.spawnSync([
          "git",
          "-C",
          path,
          "rev-parse",
          "--git-path",
          "info/exclude",
        ]);
        expectSpawnExit(exclude, 0);
        writeFileSync(
          resolve(path, exclude.stdout.toString().trim()),
          "personal.env\n",
        );
        writeFileSync(join(path, "personal.env"), "personal secret\n");
      } else {
        const files = Bun.spawnSync(["git", "-C", path, "ls-files", "-z"]);
        expectSpawnExit(files, 0);
        const file = files.stdout.toString().split("\0")[0] as string;
        const flagged = Bun.spawnSync([
          "git",
          "-C",
          path,
          "update-index",
          `--${hidden}`,
          "--",
          file,
        ]);
        expectSpawnExit(flagged, 0);
        writeFileSync(join(path, file), "personal changes\n");
      }
      read(w, path);
      const row = psRows(w).find((r) => r.path === path);
      if (!row) throw new Error("missing workspace");
      const child = join(w.root, "retire-runtime.ts");
      writeFileSync(
        child,
        `
        import { orcaRetire } from ${JSON.stringify(new URL("../lib/runtime/orca-retire.ts", import.meta.url).pathname)};
        console.log(JSON.stringify(await orcaRetire(
          ${JSON.stringify({ id: `repo-1::${path}`, path })},
          ${JSON.stringify({ comment: row.comment, unread: false })}, 5000,
        )));
      `,
      );
      const runtime = await w.dispatch([], child);
      expectSpawnExit(runtime, 0);
      expect(JSON.parse(runtime.stdout)).toMatchObject({ ok: false });
      expect(outcome(await tick(w))?.outcome).toBe("refused");
      expect(orcaCalls(w, "worktree", "rm")).toEqual([]);
    });

  it("reports an initial terminal close failure with its safe manual retry", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "orca-close-fail"), "");
    const result = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(result, 0);
    const receipt = JSON.parse(result.stdout) as TickReceipt;
    expect(receipt.repos[0]?.unplaced).toContainEqual(
      expect.objectContaining({
        target: "the notices workspace",
        reason: expect.stringContaining("inspect the workspace's terminals"),
      }),
    );
    expect(receipt.repos[0]?.notifications[0]?.outcome).toBe("sent");
  });
});

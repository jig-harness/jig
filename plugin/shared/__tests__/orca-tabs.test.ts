import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import type { OrcaRunner } from "../orca.ts";
import {
  closePreviousTabs,
  closeRunTab,
  endOwnTab,
  openedTab,
  prSubject,
  type RunTab,
  readRunTabs,
  recordRunTab,
  tabState,
  runTabEnv,
} from "../orca-tabs.ts";
import { type ProcessRow, processTable } from "../process-table.ts";

const SHELL = 4242;
const START = "Tue Nov  3 15:00:00 2026";

function row(
  pid: number,
  ppid: number,
  start = START,
  stat = "Ss",
): ProcessRow {
  return { pid, ppid, pgid: pid, start, stat, args: "zsh -l" };
}

const CREATED = {
  terminal: { handle: "term_new", tabId: "tab-new", processId: SHELL },
};

let dir: string;
let root: string;
let tree: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orca-tabs-"));
  root = join(dir, "tabs");
  tree = join(dir, "tree");
  mkdirSync(tree);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake Orca that records each call and answers `answer`. */
function fakeOrca(answer = { code: 0, stdout: '{"ok":true,"result":{}}' }): {
  runner: OrcaRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (_command, args) => {
      calls.push(args);
      return { stderr: "", ...answer };
    },
  };
}

function tab(fields: Partial<RunTab> = {}): RunTab {
  return {
    version: 1,
    handle: "term_old",
    tabId: "tab-old",
    shellPid: SHELL,
    shellStart: START,
    worktree: tree,
    subject: prSubject(42),
    title: "drive #42",
    orca: "orca",
    openedAt: "2026-11-03T15:00:00.000Z",
    ...fields,
  };
}

function write(t: RunTab): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${t.handle}.json`), JSON.stringify(t));
}

describe("recording a tab", () => {
  test("reads the handle, tab and shell PID from Orca's answer", () => {
    expect(openedTab(CREATED)).toEqual({
      handle: "term_new",
      tabId: "tab-new",
      shellPid: SHELL,
    });
  });

  test("an answer with no shell PID is not a run tab", () => {
    expect(openedTab({ terminal: { handle: "term_new" } })).toBeNull();
  });

  test("records the shell's start time beside its PID", async () => {
    const recorded = await recordRunTab(
      {
        orca: "orca",
        result: CREATED,
        worktree: tree,
        subject: prSubject(42),
        title: "drive #42",
      },
      { root, table: async () => [row(SHELL, 1)], now: () => 0 },
    );
    expect(recorded).toEqual({
      tab: expect.objectContaining({
        handle: "term_new",
        shellPid: SHELL,
        shellStart: START,
        subject: "pr:42",
      }),
    });
    expect(readRunTabs(root).map((t) => t.handle)).toEqual(["term_new"]);
  });

  test("a shell missing from the process table leaves the tab unrecorded", async () => {
    const recorded = await recordRunTab(
      {
        orca: "orca",
        result: CREATED,
        worktree: tree,
        subject: prSubject(42),
        title: "drive #42",
      },
      { root, table: async () => null, now: () => 0 },
    );
    expect(recorded).toEqual({ unrecorded: expect.stringContaining("4242") });
    expect(existsSync(root)).toBe(false);
  });
});

describe("whether a tab is idle", () => {
  test("a shell with no child is idle", () => {
    expect(tabState(tab(), [row(SHELL, 1)])).toBe("idle");
  });
  test("a shell running a command is busy", () => {
    expect(tabState(tab(), [row(SHELL, 1), row(5000, SHELL)])).toBe("busy");
  });
  test("a zombie child does not keep it busy", () => {
    expect(tabState(tab(), [row(SHELL, 1), row(5000, SHELL, START, "Z")])).toBe(
      "idle",
    );
  });
  test("a PID now held by another process is gone", () => {
    expect(tabState(tab(), [row(SHELL, 1, "Wed Nov  4 09:00:00 2026")])).toBe(
      "gone",
    );
  });
});

describe("closing a tab", () => {
  test("closes an idle tab's terminal only, not its tab, and drops the record", async () => {
    write(tab());
    const orca = fakeOrca();
    const outcome = await closeRunTab(tab(), {
      root,
      orca: orca.runner,
      table: async () => [row(SHELL, 1)],
    });
    expect(outcome).toBe("closed");
    expect(orca.calls).toEqual([
      ["terminal", "close", "--terminal", "term_old", "--json"],
    ]);
    expect(readRunTabs(root)).toEqual([]);
  });

  test("leaves a busy tab and an unreadable process table alone", async () => {
    write(tab());
    const orca = fakeOrca();
    const busy = await closeRunTab(tab(), {
      root,
      orca: orca.runner,
      table: async () => [row(SHELL, 1), row(5000, SHELL)],
    });
    const unknown = await closeRunTab(tab(), {
      root,
      orca: orca.runner,
      table: async () => null,
    });
    expect([busy, unknown]).toEqual(["busy", "busy"]);
    expect(orca.calls).toEqual([]);
    expect(readRunTabs(root)).toHaveLength(1);
  });

  test("decides reuse and idleness from one process-table read", async () => {
    write(tab());
    const orca = fakeOrca();
    let reads = 0;
    const deps = {
      root,
      orca: orca.runner,
      table: async () => {
        reads += 1;
        return [row(SHELL, 1), row(5000, SHELL), row(6000, SHELL)];
      },
    };
    const known = new Set([5000]);
    expect(await closeRunTab(tab(), deps, undefined, known)).toBe("reused");
    expect(reads).toBe(1);
    // Only the ending run's own children: still busy, which a caller retries.
    expect(
      await closeRunTab(tab(), deps, undefined, new Set([5000, 6000])),
    ).toBe("busy");
    expect(orca.calls).toEqual([]);
  });

  test("drops the record of a tab whose shell is gone, without calling Orca", async () => {
    write(tab());
    const orca = fakeOrca();
    const outcome = await closeRunTab(tab(), {
      root,
      orca: orca.runner,
      table: async () => [row(1, 0)],
    });
    expect(outcome).toBe("gone");
    expect(orca.calls).toEqual([]);
    expect(readRunTabs(root)).toEqual([]);
  });

  test("a handle Orca no longer knows is gone", async () => {
    write(tab());
    const stale = fakeOrca({
      code: 1,
      stdout: '{"ok":false,"error":{"code":"terminal_handle_stale"}}',
    });
    const outcome = await closeRunTab(tab(), {
      root,
      orca: stale.runner,
      table: async () => [row(SHELL, 1)],
    });
    expect(outcome).toBe("gone");
    expect(readRunTabs(root)).toEqual([]);
  });

  test("a close Orca refuses keeps the record", async () => {
    write(tab());
    const refused = fakeOrca({
      code: 1,
      stdout: '{"ok":false,"error":{"code":"refused"}}',
    });
    const outcome = await closeRunTab(tab(), {
      root,
      orca: refused.runner,
      table: async () => [row(SHELL, 1)],
    });
    expect(outcome).toEqual({ failed: expect.stringContaining("refused") });
    expect(readRunTabs(root)).toHaveLength(1);
  });
});

describe("closing a subject's earlier tabs", () => {
  test("closes only the same subject's tabs in the same worktree, never the new one", async () => {
    write(tab({ handle: "term_old" }));
    write(tab({ handle: "term_new" }));
    write(tab({ handle: "term_other_pr", subject: prSubject(7) }));
    write(tab({ handle: "term_other_tree", worktree: join(dir, "elsewhere") }));
    const orca = fakeOrca();
    const lines = await closePreviousTabs(
      { worktree: tree, subject: prSubject(42), except: "term_new" },
      { root, orca: orca.runner, table: async () => [row(SHELL, 1)] },
    );
    expect(lines).toEqual(["earlier run tab term_old (drive #42): closed"]);
    expect(orca.calls.map((args) => args[3])).toEqual(["term_old"]);
    expect(
      readRunTabs(root)
        .map((t) => t.handle)
        .sort(),
    ).toEqual(["term_new", "term_other_pr", "term_other_tree"]);
  });
});

describe("a run ending in its own tab", () => {
  type Started = [string, number, number[]];
  const ready = (
    rows: ProcessRow[] | null,
    until: number | null = null,
    extra: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) => ({
    until,
    now: extra.now ?? Date.now,
    sleep: extra.sleep ?? (async () => undefined),
    table: async () => rows,
  });

  test("starts the closer for the tab whose shell is its parent", async () => {
    write(tab());
    const started: Started[] = [];
    const line = await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t, pid, _root, known) => started.push([t.handle, pid, known]),
      ready([row(SHELL, 1), row(777, SHELL)]),
    );
    expect(started).toEqual([["term_old", 777, [777]]]);
    expect(line).toContain("closes once this run has exited");
  });

  test("hands the closer the shell's children as they are when the run ends", async () => {
    write(tab());
    const started: Started[] = [];
    await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t, pid, _root, known) => started.push([t.handle, pid, known]),
      ready([
        row(SHELL, 1),
        row(777, SHELL),
        row(800, SHELL),
        row(801, SHELL, START, "Z"),
        row(900, 800),
      ]),
    );
    expect(started).toEqual([["term_old", 777, [777, 800]]]);
  });

  test("takes the record whose shell start matches, not a stale one with the same PID", async () => {
    write(
      tab({ handle: "term_stale", shellStart: "Mon Nov  2 08:00:00 2026" }),
    );
    write(tab({ handle: "term_current" }));
    const started: Started[] = [];
    await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t, pid, _root, known) => started.push([t.handle, pid, known]),
      ready([row(SHELL, 1), row(777, SHELL)]),
    );
    expect(started.map(([handle]) => handle)).toEqual(["term_current"]);
  });

  test("does nothing when only a stale record has its parent's PID", async () => {
    write(tab({ shellStart: "Mon Nov  2 08:00:00 2026" }));
    const started: unknown[] = [];
    const line = await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t) => started.push(t),
      ready([row(SHELL, 1), row(777, SHELL)]),
    );
    expect(line).toBeNull();
    expect(started).toEqual([]);
  });

  test("leaves the tab open when the process table cannot be read", async () => {
    write(tab());
    const started: unknown[] = [];
    const line = await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t) => started.push(t),
      ready(null),
    );
    expect(started).toEqual([]);
    expect(line).toContain("stays open");
  });

  test("leaves the tab open when the run needs a person, and says so", async () => {
    write(tab());
    const started: unknown[] = [];
    const line = await endOwnTab(
      false,
      root,
      { pid: 777, ppid: SHELL },
      (t) => started.push(t),
      ready([row(SHELL, 1), row(777, SHELL)]),
    );
    expect(started).toEqual([]);
    expect(line).toContain("stays open");
  });

  test("does nothing when its parent is no recorded tab's shell", async () => {
    write(tab());
    const started: unknown[] = [];
    const line = await endOwnTab(
      true,
      root,
      { pid: 777, ppid: 1 },
      (t) => started.push(t),
      ready([row(1, 0)]),
    );
    expect(line).toBeNull();
    expect(started).toEqual([]);
  });

  test("waits for the opener's record when one is coming", async () => {
    const started: unknown[] = [];
    let clock = 0;
    let sleeps = 0;
    const line = await endOwnTab(
      true,
      root,
      { pid: 777, ppid: SHELL },
      (t) => started.push(t),
      ready([row(SHELL, 1), row(777, SHELL)], 100_000, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          sleeps += 1;
          if (sleeps === 3) write(tab());
        },
      }),
    );
    expect(started).toHaveLength(1);
    expect(line).toContain("closes once this run has exited");
  });

  test("does not wait when no record is expected, and waits as long as the opener's deadline when one is", async () => {
    let clock = 0;
    const clockDeps = (until: number | null) =>
      ready([row(SHELL, 1)], until, {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
    const self = { pid: 777, ppid: SHELL };
    expect(
      await endOwnTab(true, root, self, () => undefined, clockDeps(null)),
    ).toBeNull();
    expect(clock).toBe(0);
    // A launch allowed longer than any fixed wait (a runtime_timeout of 3m).
    expect(
      await endOwnTab(true, root, self, () => undefined, clockDeps(185_000)),
    ).toBeNull();
    expect(clock).toBeGreaterThanOrEqual(185_000);
  });

  test("the run's variable carries the opener's deadline", () => {
    const [pending] = runTabEnv({}, 1_000_000);
    expect(pending).toBe("JIG_ORCA_TAB_PENDING=1005000");
  });
});

describe("closing within a deadline", () => {
  test("starts no call once the deadline has passed", async () => {
    write(tab());
    const orca = fakeOrca();
    let tableCalls = 0;
    const outcome = await closeRunTab(
      tab(),
      {
        root,
        orca: orca.runner,
        table: async () => {
          tableCalls += 1;
          return [row(SHELL, 1)];
        },
      },
      Date.now() - 1,
    );
    expect(outcome).toBe("out of time");
    expect(tableCalls).toBe(0);
    expect(orca.calls).toEqual([]);
  });

  test("bounds the process-table read and the close call by what is left", async () => {
    const seen: Array<number | undefined> = [];
    const outcome = await closeRunTab(
      tab(),
      {
        root,
        orca: async (_command, _args, timeoutSec) => {
          seen.push(timeoutSec);
          return { code: 0, stdout: '{"ok":true,"result":{}}', stderr: "" };
        },
        table: async (timeoutSec) => {
          seen.push(timeoutSec);
          return [row(SHELL, 1)];
        },
      },
      Date.now() + 2_000,
    );
    expect(outcome).toBe("closed");
    expect(seen).toHaveLength(2);
    for (const sec of seen) {
      expect(sec).toBeGreaterThan(0);
      expect(sec).toBeLessThanOrEqual(2);
    }
  });

  test("records no tab once the deadline has passed", async () => {
    const recorded = await recordRunTab(
      {
        orca: "orca",
        result: CREATED,
        worktree: tree,
        subject: prSubject(42),
        title: "drive #42",
      },
      { root, table: async () => [row(SHELL, 1)], now: Date.now },
      Date.now() - 1,
    );
    expect(recorded).toHaveProperty("unrecorded");
    expect(readRunTabs(root)).toEqual([]);
  });
});

describe.skipIf(
  skipsOnWindows(
    "process-lifecycle",
    "the closer's fixtures are sleep, true and a #!/bin/sh fake Orca",
  ),
)("the detached closer", () => {
  /** A shell stand-in and a fake Orca, with the tab recorded for them. */
  async function recordedShell(): Promise<{
    shell: ReturnType<typeof Bun.spawn>;
    calls: string;
  }> {
    const shell = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
    const rows = await processTable();
    const start = rows?.find((r) => r.pid === shell.pid)?.start;
    expect(start).toBeString();
    const calls = join(dir, "orca-calls.log");
    const orca = join(dir, "orca");
    writeFileSync(
      orca,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho '{"ok":true,"result":{}}'\n`,
    );
    chmodSync(orca, 0o755);
    write(tab({ shellPid: shell.pid, shellStart: start as string, orca }));
    return { shell, calls };
  }

  test("closes nothing while the run is still alive, then closes once it exits", async () => {
    const { shell, calls } = await recordedShell();
    const run = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
    const closer = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "orca-tabs.ts"),
        "close",
        "term_old",
        String(run.pid),
      ],
      {
        env: { ...process.env, JIG_ORCA_TABS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await new Promise((settle) => setTimeout(settle, 1500));
      expect(existsSync(calls)).toBe(false);
      run.kill();
      await expectSpawnExited(closer, 0, "orca-tabs.ts close");
      expect(readFileSync(calls, "utf8").trim()).toBe(
        "terminal close --terminal term_old --json",
      );
    } finally {
      run.kill();
      closer.kill();
      shell.kill();
    }
  });

  test("waits for the run to exit, then closes its idle tab through Orca", async () => {
    // The tab's shell: a live process with no child.
    const shell = Bun.spawn(["sleep", "30"], { stdout: "ignore" });
    try {
      const rows = await processTable();
      const start = rows?.find((r) => r.pid === shell.pid)?.start;
      expect(start).toBeString();
      const calls = join(dir, "orca-calls.log");
      const orca = join(dir, "orca");
      writeFileSync(
        orca,
        `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho '{"ok":true,"result":{}}'\n`,
      );
      chmodSync(orca, 0o755);
      write(tab({ shellPid: shell.pid, shellStart: start as string, orca }));
      // The run: already exited by the time the closer looks.
      const run = Bun.spawnSync(["true"]);
      expectSpawnExit(
        { exitCode: run.exitCode, stdout: null, stderr: null },
        0,
      );
      const closer = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "..", "orca-tabs.ts"),
          "close",
          "term_old",
          String(run.pid),
        ],
        {
          env: { ...process.env, JIG_ORCA_TABS_DIR: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(closer, 0, "orca-tabs.ts close");
      expect(readFileSync(calls, "utf8").trim()).toBe(
        "terminal close --terminal term_old --json",
      );
      expect(readRunTabs(root)).toEqual([]);
    } finally {
      shell.kill();
    }
  });

  test("leaves the tab when its shell has a child the ending run did not list", async () => {
    // The tab's shell, with one child of its own besides the exited run.
    const shell = Bun.spawn(["sh", "-c", "sleep 30 & wait"], {
      stdout: "ignore",
    });
    try {
      let child: ProcessRow | undefined;
      let rows: ProcessRow[] | null = null;
      const limit = Date.now() + 10_000;
      while (child === undefined && Date.now() < limit) {
        rows = await processTable();
        child = rows?.find((r) => r.ppid === shell.pid);
        if (child === undefined) await new Promise((r) => setTimeout(r, 50));
      }
      expect(child).toBeDefined();
      const start = rows?.find((r) => r.pid === shell.pid)?.start;
      expect(start).toBeString();
      const calls = join(dir, "orca-calls.log");
      const orca = join(dir, "orca");
      writeFileSync(
        orca,
        `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\necho '{"ok":true,"result":{}}'\n`,
      );
      chmodSync(orca, 0o755);
      write(tab({ shellPid: shell.pid, shellStart: start as string, orca }));
      const run = Bun.spawnSync(["true"]);
      const closed = Bun.spawnSync(
        [
          process.execPath,
          join(import.meta.dir, "..", "orca-tabs.ts"),
          "close",
          "term_old",
          String(run.pid),
          "",
        ],
        {
          env: { ...process.env, JIG_ORCA_TABS_DIR: root },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expectSpawnExit(closed, 1, "orca-tabs.ts close, child unlisted");
      expect(existsSync(calls)).toBe(false);
    } finally {
      shell.kill();
      Bun.spawnSync(["pkill", "-P", String(shell.pid)]);
    }
  });
});

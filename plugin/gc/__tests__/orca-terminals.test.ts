import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMachine } from "../config.ts";
import { orcaTerminalsKind } from "../kinds/orca-terminals.ts";
import type { OrcaRunner } from "../../shared/orca.ts";
import type { RunTab, RunTabDeps } from "../../shared/orca-tabs.ts";
import type { ProcessRow } from "../../shared/process-table.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { CollectionKind, Resource } from "../types.ts";

const ORCA = "/opt/orca/orca-ide";
const SHELL = 4242;
const START = "Tue Nov  3 15:00:00 2026";
const OPENED = "2026-11-03T15:00:00.000Z";
/** Two days after the tab opened: past the 24-hour guard. */
const NOW = parseMs("2026-11-05T15:00:00.000Z");
const HOUR = 3_600_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gc-orca-terminals-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function shell(pid = SHELL, start = START): ProcessRow {
  return { pid, ppid: 1, pgid: pid, start, stat: "Ss", args: "zsh -l" };
}

function child(pid: number): ProcessRow {
  return { pid, ppid: SHELL, pgid: pid, start: START, stat: "S+", args: "vim" };
}

function record(fields: Partial<RunTab> = {}): RunTab {
  const tab: RunTab = {
    version: 1,
    handle: "term_old",
    tabId: "tab-old",
    shellPid: SHELL,
    shellStart: START,
    worktree: "/work/tree",
    subject: "pr:42",
    title: "drive #42",
    orca: "/somewhere/else/orca",
    openedAt: OPENED,
    ...fields,
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${tab.handle}.json`), JSON.stringify(tab));
  return tab;
}

interface Terminal {
  handle: string;
  lastOutputAt?: number | null;
}

/** A fake Orca listing `terminals`, answering every close with `close`. */
function fakeOrca(
  terminals: Terminal[],
  options: { complete?: boolean; close?: string; list?: string } = {},
): { runner: OrcaRunner; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const listing = JSON.stringify({
    ok: true,
    result: {
      terminals: terminals.map((t) => ({ lastOutputAt: null, ...t })),
      hostScope: {
        hostIds: ["local"],
        omittedHostIds: options.complete === false ? ["remote"] : [],
      },
      totalCount: terminals.length,
      truncated: false,
    },
  });
  return {
    calls,
    runner: async (command, args) => {
      calls.push({ command, args });
      if (args[1] === "list")
        return { code: 0, stdout: options.list ?? listing, stderr: "" };
      return {
        code: 0,
        stdout: options.close ?? '{"ok":true,"result":{}}',
        stderr: "",
      };
    },
  };
}

function kind(
  orca: OrcaRunner,
  rows: ProcessRow[] | null,
  now = NOW,
): CollectionKind {
  const deps: RunTabDeps = {
    root,
    orca,
    table: async () => rows,
    now: () => now,
    sleep: () => Promise.resolve(),
  };
  return orcaTerminalsKind(ORCA, 24, deps);
}

async function inventory(k: CollectionKind): Promise<Resource[]> {
  const listed = await k.inventory();
  expect(listed.ok).toBe(true);
  return listed.ok ? listed.value : [];
}

describe("the orca-terminals kind's proof", () => {
  test("an idle tab past the guard would be closed, with its proof", async () => {
    record();
    const k = kind(fakeOrca([{ handle: "term_old" }]).runner, [shell()]);
    const [tab] = await inventory(k);
    const proof = await k.prove(tab as Resource);
    expect(proof.state).toBe("dead");
    expect(proof.reason).toContain("idle run tab");
    expect(proof.reason).toContain("24-hour guard");
  });

  test("a tab with a command typed into it is busy", async () => {
    record();
    const k = kind(fakeOrca([{ handle: "term_old" }]).runner, [
      shell(),
      child(5000),
    ]);
    const [tab] = await inventory(k);
    const proof = await k.prove(tab as Resource);
    expect(proof.state).toBe("live");
    expect(proof.reason).toContain("child process");
  });

  test("a tab whose shell PID was reused is kept", async () => {
    record();
    const k = kind(fakeOrca([{ handle: "term_old" }]).runner, [
      shell(SHELL, "Wed Nov  4 09:00:00 2026"),
    ]);
    const [tab] = await inventory(k);
    const proof = await k.prove(tab as Resource);
    expect(proof.state).toBe("live");
    expect(proof.reason).toContain("gone or was reused");
  });

  test("a tab whose shell is gone is kept", async () => {
    record();
    const k = kind(fakeOrca([{ handle: "term_old" }]).runner, []);
    const [tab] = await inventory(k);
    expect((await k.prove(tab as Resource)).state).toBe("live");
  });

  test("an unreadable process table counts every tab as busy", async () => {
    record();
    record({ handle: "term_two" });
    const k = kind(
      fakeOrca([{ handle: "term_old" }, { handle: "term_two" }]).runner,
      null,
    );
    for (const tab of await inventory(k)) {
      const proof = await k.prove(tab);
      expect(proof.state).toBe("live");
      expect(proof.reason).toContain("could not be read");
    }
  });

  test("output inside the guard keeps an idle tab", async () => {
    record();
    const k = kind(
      fakeOrca([{ handle: "term_old", lastOutputAt: NOW - 2 * HOUR }]).runner,
      [shell()],
    );
    const [tab] = await inventory(k);
    const proof = await k.prove(tab as Resource);
    expect(proof.state).toBe("live");
    expect(proof.reason).toContain("inside the 24-hour guard");
  });

  test("a tab opened inside the guard is kept though Orca has no output time", async () => {
    record({ openedAt: isoFromMs(NOW - HOUR) });
    const k = kind(fakeOrca([{ handle: "term_old" }]).runner, [shell()]);
    const [tab] = await inventory(k);
    expect((await k.prove(tab as Resource)).state).toBe("live");
  });

  test("a tab Orca no longer lists has only its record to delete", async () => {
    record();
    const k = kind(fakeOrca([]).runner, [shell()]);
    const [tab] = await inventory(k);
    const proof = await k.prove(tab as Resource);
    expect(proof.state).toBe("dead");
    expect(proof.details).toEqual({ action: "forget-record" });
  });

  test("a listing that leaves out a host proves nothing about an unlisted tab", async () => {
    record();
    const k = kind(fakeOrca([], { complete: false }).runner, [shell()]);
    const [tab] = await inventory(k);
    expect((await k.prove(tab as Resource)).state).toBe("unverified");
  });

  test("a listing Orca cannot give fails the inventory", async () => {
    record();
    const k = kind(
      fakeOrca([], {
        list: '{"ok":false,"error":{"code":"runtime_unavailable","message":"Orca is not running"}}',
      }).runner,
      [shell()],
    );
    const listed = await k.inventory();
    expect(listed.ok).toBe(false);
    if (!listed.ok)
      expect(listed.failure.reason).toContain("Orca is not running");
  });

  test("a report closes nothing and deletes no record", async () => {
    record();
    const orca = fakeOrca([{ handle: "term_old" }]);
    const k = kind(orca.runner, [shell()]);
    for (const tab of await inventory(k)) await k.prove(tab);
    expect(orca.calls.map((c) => c.args[1])).toEqual(["list"]);
    expect(existsSync(join(root, "term_old.json"))).toBe(true);
  });
});

describe("collecting run tabs", () => {
  test("closes the recorded terminal, not its tab, through the configured command", async () => {
    record();
    const orca = fakeOrca([{ handle: "term_old" }]);
    const k = kind(orca.runner, [shell()]);
    const [tab] = await inventory(k);
    const collected = await k.collect(tab as Resource);
    expect(collected.outcome).toBe("collected");
    const close = orca.calls.find((c) => c.args[1] === "close");
    expect(close).toEqual({
      command: ORCA,
      args: ["terminal", "close", "--terminal", "term_old", "--json"],
    });
    expect(existsSync(join(root, "term_old.json"))).toBe(false);
  });

  test("a tab a command was typed into since the report stays", async () => {
    record();
    let rows: ProcessRow[] = [shell()];
    const orca = fakeOrca([{ handle: "term_old" }]);
    const k = orcaTerminalsKind(ORCA, 24, {
      root,
      orca: orca.runner,
      table: async () => rows,
      now: () => NOW,
      sleep: () => Promise.resolve(),
    });
    const [tab] = await inventory(k);
    expect((await k.prove(tab as Resource)).state).toBe("dead");
    rows = [shell(), child(5000)];
    const collected = await k.collect(tab as Resource);
    expect(collected.outcome).toBe("refused");
    expect(orca.calls.some((c) => c.args[1] === "close")).toBe(false);
    expect(existsSync(join(root, "term_old.json"))).toBe(true);
  });

  test("Orca refusing the close is recorded as live", async () => {
    record();
    const orca = fakeOrca([{ handle: "term_old" }], {
      close: '{"ok":false,"error":{"code":"busy","message":"terminal busy"}}',
    });
    const k = kind(orca.runner, [shell()]);
    const [tab] = await inventory(k);
    const collected = await k.collect(tab as Resource);
    expect(collected.outcome).toBe("refused");
    expect(existsSync(join(root, "term_old.json"))).toBe(true);
  });

  test("the record of a tab Orca no longer lists is deleted without calling Orca to close", async () => {
    record();
    const orca = fakeOrca([]);
    const k = kind(orca.runner, [shell()]);
    const [tab] = await inventory(k);
    const collected = await k.collect(tab as Resource);
    expect(collected.outcome).toBe("collected");
    expect(orca.calls.some((c) => c.args[1] === "close")).toBe(false);
    expect(existsSync(join(root, "term_old.json"))).toBe(false);
  });
});

describe("the machine's orca entry", () => {
  test("the run-tab guard defaults to 24 hours", () => {
    const parsed = parseMachine({ orca: { command: ORCA } });
    expect(parsed.ok && parsed.value.orca).toEqual({
      command: ORCA,
      terminal_idle_hours: 24,
    });
  });

  test("the guard can be lengthened, never shortened", () => {
    const longer = parseMachine({
      orca: { command: ORCA, terminal_idle_hours: 72 },
    });
    expect(longer.ok && longer.value.orca?.terminal_idle_hours).toBe(72);
    const shorter = parseMachine({
      orca: { command: ORCA, terminal_idle_hours: 1 },
    });
    expect(shorter.ok).toBe(false);
  });

  test("the kind can be disabled", () => {
    const parsed = parseMachine({ disabled: ["orca-terminals"] });
    expect(parsed.ok && parsed.value.disabled).toEqual(["orca-terminals"]);
  });
});

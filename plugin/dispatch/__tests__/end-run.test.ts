/**
 * The tick's `endRun` (`end-runs.ts`): each run that ended is handed to the
 * session runtime once, on a tick that may act, whether or not an earlier
 * tick already logged its outcome row; and Orca's answer to it
 * (`orca-end-run.ts`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EndRun, endRuns, SETTLE_MS } from "../lib/end-runs.ts";
import {
  readEnded,
  readRecord,
  type ReadRecord,
  recordExit,
} from "../lib/launches.ts";
import { logEnded } from "../lib/log-ended.ts";
import { orcaEndRun } from "../lib/runtime/orca-end-run.ts";
import type { EndedRun, RuntimeReceipt } from "../lib/runtime/port.ts";
import { endRunOf } from "../lib/tick-settle.ts";
import type { TickContext } from "../lib/tick-context.ts";
import { readRunTabs, type RunTab } from "../../shared/orca-tabs.ts";
import { currentMs, parseMs } from "../../shared/time.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";
import { type World, world } from "./fixtures.ts";

let current: World | null = null;
const dirs: string[] = [];
afterEach(() => {
  current?.close();
  current = null;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const NOW = parseMs("2026-11-01T12:05:00.000Z");

const CLAIM = {
  hostId: "",
  host: "here",
  bootId: "",
  pid: 1,
  start: "x",
  claimedAt: "2026-11-01T12:00:00.000Z",
};

function fixture(): { w: World; root: string } {
  const w = world();
  current = w;
  return { w, root: dispatchState(w) };
}

/** A follow-up's record whose wrapper is gone without an exit. */
function died(w: World, root: string, id = "died-run"): ReadRecord {
  earlierRecord(w, { id, account: "a", action: "followup" });
  const record = readRecord(id, root);
  if (record === null) throw new TypeError("missing fixture launch");
  return {
    record,
    state: { kind: "died", reason: "its wrapper is gone", process: CLAIM },
    result: null,
  };
}

/** A record whose wrapper recorded its exit at `at`. */
function ended(w: World, root: string, at: string): ReadRecord {
  earlierRecord(w, { id: "ended-run", account: "a" });
  recordExit("ended-run", { at, code: 0, signal: null }, root);
  const r = readEnded("ended-run", root);
  if (r === null) throw new TypeError("missing fixture launch");
  return r;
}

/** A runtime's `endRun` that answers `receipt` and keeps every call. */
function fakeEndRun(
  receipt: RuntimeReceipt | Error = { ok: true, detail: "run tab t1: closed" },
): { calls: EndedRun[]; endRun: EndRun } {
  const calls: EndedRun[] = [];
  return {
    calls,
    endRun: async (run) => {
      calls.push(run);
      if (receipt instanceof Error) throw receipt;
      return receipt;
    },
  };
}

describe("ending what an ended run left", () => {
  it("asks the runtime once for a run whose wrapper died, and records that it asked", async () => {
    const { w, root } = fixture();
    const r = died(w, root);
    const fake = fakeEndRun();
    expect(await endRuns([r], fake.endRun, NOW, root)).toEqual([
      {
        record: "died-run",
        target: "PR #7",
        outcome: "ended",
        detail: "run tab t1: closed",
      },
    ]);
    expect(fake.calls).toEqual([
      { id: "died-run", workspace: { id: "repo-1::/ws/0", path: w.repo } },
    ]);
    expect(readRecord("died-run", root)?.runEndedAt).toBe(
      "2026-11-01T12:05:00.000Z",
    );
    // A later tick reads the mark and asks nothing.
    const again = { ...r, record: readRecord("died-run", root) ?? r.record };
    expect(await endRuns([again], fake.endRun, NOW, root)).toEqual([]);
    expect(fake.calls).toHaveLength(1);
  });

  it("still asks for a run whose outcome row a tick without --apply already wrote", async () => {
    const { w, root } = fixture();
    const r = died(w, root);
    // A report logs the row (and `endedAt`) and asks nothing.
    expect(
      await logEnded([r], {
        all: [r],
        drives: null,
        merged: async () => null,
        nowIso: "2026-11-01T12:01:00.000Z",
        root,
      }),
    ).toEqual([]);
    const logged = readRecord("died-run", root);
    expect(logged?.endedAt).toBeDefined();
    const fake = fakeEndRun();
    await endRuns(
      [{ ...r, record: logged ?? r.record }],
      fake.endRun,
      NOW,
      root,
    );
    expect(fake.calls.map((c) => c.id)).toEqual(["died-run"]);
  });

  it("asks for a run whose wrapper recorded its exit only once its own closer has had its time", async () => {
    const { w, root } = fixture();
    const recent = ended(w, root, "2026-11-01T12:04:30.000Z");
    const fake = fakeEndRun({
      ok: true,
      nothingLeft: true,
      detail: "no run tab recorded",
    });
    expect(await endRuns([recent], fake.endRun, NOW, root)).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(readRecord("ended-run", root)?.runEndedAt).toBeUndefined();
    // Past the settle time it asks; a run that left nothing is not reported.
    expect(await endRuns([recent], fake.endRun, NOW + SETTLE_MS, root)).toEqual(
      [],
    );
    expect(fake.calls).toHaveLength(1);
    expect(readRecord("ended-run", root)?.runEndedAt).toBeDefined();
  });

  it("reports what the runtime left, and a runtime that throws", async () => {
    for (const answer of [
      { ok: false, detail: "run tab t1: busy" },
      new Error("orca is gone"),
    ]) {
      const { w, root } = fixture();
      const r = died(w, root);
      expect(await endRuns([r], fakeEndRun(answer).endRun, NOW, root)).toEqual([
        {
          record: "died-run",
          target: "PR #7",
          outcome: "left",
          detail:
            answer instanceof Error
              ? `${answer.message}; a later tick asks again`
              : answer.detail,
        },
      ]);
      // An answer is not asked for again; a throw, which answered nothing, is.
      expect(readRecord("died-run", root)?.runEndedAt === undefined).toBe(
        answer instanceof Error,
      );
      w.close();
      current = null;
    }
  });

  it("stops asking, and marks nothing, once the tick's time is spent", async () => {
    const { w, root } = fixture();
    const first = died(w, root, "died-one");
    const second = died(w, root, "died-two");
    let asked = 0;
    const spent: EndRun = () => {
      asked += 1;
      return null;
    };
    expect(await endRuns([first, second], spent, NOW, root)).toEqual([]);
    expect(asked).toBe(1);
    expect(readRecord("died-one", root)?.runEndedAt).toBeUndefined();
  });

  it("leaves a record that has not ended alone", async () => {
    const { w, root } = fixture();
    const r = died(w, root);
    const fake = fakeEndRun();
    await endRuns(
      [{ ...r, state: { kind: "pending" } }],
      fake.endRun,
      NOW,
      root,
    );
    expect(fake.calls).toEqual([]);
  });
});

describe("which ticks end runs", () => {
  const contextOf = (apply: unknown) => ({ apply }) as unknown as TickContext;

  it("a tick without --apply ends nothing", () => {
    expect(endRunOf(contextOf(null))).toBeNull();
  });

  it("a tick with --apply asks its runtime, within the runtime's deadline", async () => {
    const asked: Array<number | undefined> = [];
    const endRun = endRunOf(
      contextOf({
        machine: { runtimeTimeoutMs: 60_000 },
        startedAt: undefined,
        runtime: {
          endRun: async (_run: EndedRun, timeoutMs?: number) => {
            asked.push(timeoutMs);
            return { ok: true, detail: "" };
          },
        },
      }),
    );
    await endRun?.({ id: "x", workspace: null });
    expect(asked).toEqual([60_000]);
  });

  it("asks nothing once the tick's time is spent", () => {
    const machine = {
      intervalMs: 5 * 60_000,
      runtimeTimeoutMs: 1_000,
      workspaceTimeoutMs: 1_000,
    };
    const endRun = endRunOf(
      contextOf({
        machine,
        // Past the six hours the launcher allows a tick.
        startedAt: currentMs() - 7 * 3_600_000,
        runtime: { endRun: async () => ({ ok: true, detail: "" }) },
      }),
    );
    expect(endRun?.({ id: "x", workspace: null })).toBeNull();
  });
});

describe("Orca's endRun", () => {
  function tabsRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "end-run-"));
    dirs.push(dir);
    return join(dir, "tabs");
  }

  function writeTab(root: string, tab: Partial<RunTab>): void {
    const full: RunTab = {
      version: 1,
      handle: "term_run",
      tabId: null,
      shellPid: 4242,
      shellStart: "start",
      worktree: "/ws",
      subject: "pr:7",
      title: "jig dispatch · rearm #7",
      orca: "orca",
      openedAt: "2026-11-01T12:00:00.000Z",
      ...tab,
    };
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${full.handle}.json`), JSON.stringify(full));
  }

  const shell =
    (children: number[] = []) =>
    async () => [
      {
        pid: 4242,
        ppid: 1,
        pgid: 4242,
        start: "start",
        stat: "Ss",
        args: "zsh",
      },
      ...children.map((pid) => ({
        pid,
        ppid: 4242,
        pgid: pid,
        start: "start",
        stat: "S",
        args: "vim",
      })),
    ];
  const orca = async () => ({
    code: 0,
    stdout: '{"ok":true,"result":{}}',
    stderr: "",
  });
  const run = { id: "run-1", workspace: null };

  it("has nothing left to end for a launch with no recorded tab", async () => {
    const root = tabsRoot();
    writeTab(root, { launch: "run-2" });
    expect(
      await orcaEndRun(run, "orca", 5000, { root, orca, table: shell() }),
    ).toEqual({ ok: true, nothingLeft: true, detail: "no run tab recorded" });
  });

  it("closes the launch's idle tab, and reports a busy one as left", async () => {
    const root = tabsRoot();
    writeTab(root, { launch: "run-1" });
    expect(
      await orcaEndRun(run, "orca", 5000, { root, orca, table: shell([7]) }),
    ).toEqual({
      ok: false,
      detail: "run tab term_run (jig dispatch · rearm #7): busy",
    });
    expect(
      await orcaEndRun(run, "orca", 5000, { root, orca, table: shell() }),
    ).toEqual({
      ok: true,
      detail: "run tab term_run (jig dispatch · rearm #7): closed",
    });
  });

  it("keeps the record of a tab whose shell is gone and reports it left", async () => {
    const root = tabsRoot();
    writeTab(root, { launch: "run-1" });
    const receipt = await orcaEndRun(run, "orca", 5000, {
      root,
      orca,
      table: async () => [],
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain("shell gone");
    expect(readRunTabs(root)).toHaveLength(1);
  });

  it("starts no cleanup once its signal aborted", async () => {
    const root = tabsRoot();
    writeTab(root, { launch: "run-1" });
    const receipt = await orcaEndRun(
      run,
      "orca",
      5000,
      { root, orca, table: shell() },
      AbortSignal.abort(),
    );
    expect(receipt).toEqual({
      ok: false,
      detail: "run tab term_run (jig dispatch · rearm #7): out of time",
    });
    expect(readRunTabs(root)).toHaveLength(1);
  });

  it("closes nothing when its signal aborts during the process-table read", async () => {
    const root = tabsRoot();
    writeTab(root, { launch: "run-1" });
    const controller = new AbortController();
    const calls: string[] = [];
    const receipt = await orcaEndRun(
      run,
      "orca",
      5000,
      {
        root,
        orca: async (...args) => {
          calls.push(String(args[1]));
          return orca();
        },
        table: async () => {
          controller.abort();
          return shell()();
        },
      },
      controller.signal,
    );
    expect(receipt.ok).toBe(false);
    expect(receipt.detail).toContain("out of time");
    expect(calls).toEqual([]);
    expect(readRunTabs(root)).toHaveLength(1);
  });
});

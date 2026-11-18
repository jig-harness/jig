/**
 * The tick's `endRun`: a run whose wrapper died, ending without recording an
 * exit, is ended through the session runtime once, when its outcome row is
 * written, and only on a tick that may act.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  readEnded,
  readRecord,
  type ReadRecord,
  recordExit,
} from "../lib/launches.ts";
import { type EndContext, logEnded } from "../lib/log-ended.ts";
import { readRows } from "../lib/log.ts";
import type { EndedRun, RuntimeReceipt } from "../lib/runtime/port.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";
import { type World, world } from "./fixtures.ts";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

const CLAIM = {
  hostId: "",
  host: "here",
  bootId: "",
  pid: 1,
  start: "x",
  claimedAt: "2026-11-01T12:00:00.000Z",
};

/** A follow-up's record whose wrapper is gone without an exit. */
function died(w: World, root: string): ReadRecord {
  earlierRecord(w, { id: "died-run", account: "a", action: "followup" });
  const record = readRecord("died-run", root);
  if (record === null) throw new TypeError("missing fixture launch");
  return {
    record,
    state: { kind: "died", reason: "its wrapper is gone", process: CLAIM },
    result: null,
  };
}

/** A runtime's `endRun` that answers `receipt` and keeps every call. */
function fakeEndRun(
  receipt: RuntimeReceipt | Error = { ok: true, detail: "run tab t1: closed" },
): { calls: EndedRun[]; endRun: NonNullable<EndContext["endRun"]> } {
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

function context(
  r: ReadRecord,
  root: string,
  endRun?: EndContext["endRun"],
): EndContext {
  return {
    all: [r],
    drives: null,
    merged: async () => null,
    nowIso: "2026-11-01T12:01:00.000Z",
    root,
    ...(endRun === undefined ? {} : { endRun }),
  };
}

describe("a run whose wrapper died", () => {
  it("is ended through the runtime once, when its row is written", async () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    const r = died(w, root);
    const fake = fakeEndRun();
    expect(await logEnded([r], context(r, root, fake.endRun))).toEqual({
      failed: [],
      ended: [
        {
          record: "died-run",
          target: "PR #7",
          outcome: "ended",
          detail: "run tab t1: closed",
        },
      ],
    });
    expect(fake.calls).toEqual([
      { id: "died-run", workspace: { id: "repo-1::/ws/0", path: w.repo } },
    ]);
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "died" },
    ]);
    // Its row is written: a later tick neither logs nor ends it again.
    expect(await logEnded([r], context(r, root, fake.endRun))).toEqual({
      failed: [],
      ended: [],
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("reports what the runtime left, and a runtime that throws, without losing the row", async () => {
    for (const answer of [
      { ok: false, detail: "run tab t1: busy" },
      new Error("orca is gone"),
    ]) {
      const w = world();
      current = w;
      const root = dispatchState(w);
      const r = died(w, root);
      const logged = await logEnded(
        [r],
        context(r, root, fakeEndRun(answer).endRun),
      );
      expect(logged.ended).toMatchObject([
        {
          outcome: "left",
          detail: answer instanceof Error ? answer.message : answer.detail,
        },
      ]);
      expect(logged.failed).toEqual([]);
      expect(readRows(undefined, undefined, root)).toHaveLength(1);
      w.close();
      current = null;
    }
  });

  it("is left alone by a tick that may not act", async () => {
    const w = world();
    current = w;
    const root = dispatchState(w);
    const r = died(w, root);
    expect(await logEnded([r], context(r, root))).toEqual({
      failed: [],
      ended: [],
    });
  });
});

it("never ends a run whose wrapper recorded its exit: the wrapper closed its tab", async () => {
  const w = world();
  current = w;
  const root = dispatchState(w);
  earlierRecord(w, { id: "ended-run", account: "a" });
  recordExit(
    "ended-run",
    { at: "2026-11-01T12:00:00.000Z", code: 0, signal: null },
    root,
  );
  const r = readEnded("ended-run", root);
  if (r === null) throw new TypeError("missing fixture launch");
  const fake = fakeEndRun();
  expect((await logEnded([r], context(r, root, fake.endRun))).ended).toEqual(
    [],
  );
  expect(fake.calls).toEqual([]);
});

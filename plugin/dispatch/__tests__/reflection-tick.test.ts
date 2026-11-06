/**
 * dispatch --apply: a tick, run as the installed command in a child with its
 * own home, records a class that recurs as one reflection finding, reading
 * the reflection section from the repository's default branch; says on its
 * receipt what it recorded or why it could not; keeps its exit status when
 * the store fails or hangs; and touches no store with reflection off.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeRow } from "../lib/log.ts";
import { formatReceipt } from "../lib/report.ts";
import { closeStateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import {
  type FakeStore,
  fakeStore,
  stoppedRow,
} from "./reflection-fixtures.ts";

const BASE = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

/** The default branch's file, with a reflection section that names `store`. */
const withReflection = (store: FakeStore, extra = "") => `${BASE}reflection:
  store: command
  command: [${store.command.map((w) => JSON.stringify(w)).join(", ")}]
  timeout_sec: 1
${extra}`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A world whose log shows a drive stopped for a person on three host days, with `notify` the one stage enabled, so nothing is launched. */
function fixture(config: (store: FakeStore) => string): {
  w: World;
  store: FakeStore;
} {
  const w = world();
  current = w;
  const store = fakeStore(w.root);
  w.setConfig(config(store));
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
  const now = Date.now();
  const state = dispatchState(w);
  for (const [i, hours] of [1, 25, 49].entries())
    writeRow(stoppedRow(SLUG, now - hours * 3_600_000, i + 1), state);
  closeStateDb(state);
  return { w, store };
}

async function tick(w: World, ...args: string[]): Promise<TickReceipt> {
  const r = await w.dispatch(["--json", ...args]);
  expectSpawnExit(r, 0);
  const receipt = JSON.parse(r.stdout) as TickReceipt;
  expect(receipt.exitStatus).toBe(0);
  return receipt;
}

const appends = (store: FakeStore) =>
  store.calls().filter((op) => op === "append").length;

describe("jig dispatch --apply records a class that recurs", () => {
  it("as one finding, the first tick of the week, and none at the next", async () => {
    const { w, store } = fixture(withReflection);
    const first = await tick(w, "--apply");
    expect(
      first.reflection?.recorded.map((r) => [r.repo, r.stage, r.class]),
    ).toEqual([[SLUG, "rearm", "gates failed"]]);
    expect(store.events().map((e) => e.class)).toEqual([
      "dispatch-recurring-gates-failed",
    ]);
    const second = await tick(w, "--apply");
    expect(second.reflection).toBeUndefined();
    expect(appends(store)).toBe(1);
  });

  it("keeps its exit status when the store hangs or fails, says why on its receipt, and appends at the next tick", async () => {
    const { w, store } = fixture(withReflection);
    store.flag("hang");
    const hung = await tick(w, "--apply");
    expect(hung.reflection?.failures.map((f) => f.code)).toEqual([
      "store-unavailable",
    ]);
    expect(hung.reflection?.failures[0]?.reason).toContain("within 1s");
    store.flag("hang", false);
    store.flag("fail");
    const failed = await tick(w, "--apply");
    expect(failed.reflection?.failures[0]?.reason).toContain(
      "the store is down",
    );
    expect(failed.reflection?.pending.map((p) => p.class)).toEqual([
      "gates failed",
    ]);
    store.flag("fail", false);
    const after = await tick(w, "--apply");
    expect(after.reflection?.recorded.map((r) => r.id)).toEqual(
      failed.reflection?.pending.map((p) => p.id),
    );
    expect(after.reflection?.failures).toEqual([]);
    expect(store.events()).toHaveLength(1);
  });

  it("only lists what it would record in a tick that reports", async () => {
    const { w, store } = fixture(withReflection);
    const report = await tick(w);
    expect(report.reflection?.would.map((r) => r.class)).toEqual([
      "gates failed",
    ]);
    expect(store.calls()).toEqual([]);
  });
});

describe("jig dispatch --apply with reflection off", () => {
  it("neither reads nor writes the store, with the section absent or switched off", async () => {
    for (const config of [
      () => BASE,
      (store: FakeStore) => withReflection(store, "  enabled: false\n"),
    ]) {
      const { w, store } = fixture(config);
      const receipt = await tick(w, "--apply");
      expect(receipt.reflection).toBeUndefined();
      expect(store.calls()).toEqual([]);
      current?.close();
      current = null;
    }
  });
});

describe("the receipt's text", () => {
  it("names each finding recorded, pending or that would be recorded, and each failure", () => {
    const found = (cls: string) => ({
      id: `drv-${"0".repeat(32)}`,
      repo: SLUG,
      stage: "rearm",
      class: cls,
      week: "2026-W45",
    });
    const text = formatReceipt(
      {
        runId: "r",
        apply: true,
        repos: [],
        reflection: {
          recorded: [found("gates failed")],
          pending: [found("stalled")],
          would: [found("died")],
          failures: [
            { repo: SLUG, code: "store-failed", reason: "the store said no" },
          ],
        },
      } as never,
      "receipt.json",
    );
    for (const line of [
      `reflection recorded gates failed on the rearm stage of ${SLUG}, 2026-W45`,
      `reflection pending  stalled on the rearm stage of ${SLUG}, 2026-W45`,
      `reflection would    record died on the rearm stage of ${SLUG}, 2026-W45`,
      `reflection failed   ${SLUG}: the store said no`,
    ])
      expect(text).toContain(line);
  });
});

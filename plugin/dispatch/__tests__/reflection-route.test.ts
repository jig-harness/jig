/**
 * The reflection route on its own: each class that recurs on a stage of a
 * repository becomes one finding in the reflection store per host-time week,
 * written through the store's contract under its deadline, never more than
 * once, and never when reflection is off; a store that fails or hangs leaves
 * the finding pending for the next tick. The tick's own part (its receipt
 * and its exit) is in reflection-tick.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReflection } from "../../skills/reflect/scripts/lib/settings.ts";
import {
  computeState,
  idConflicts,
  recurrence,
} from "../../skills/reflect/scripts/lib/events.ts";
import { Store } from "../../skills/reflect/scripts/lib/store-client.ts";
import { dashboardData } from "../dashboard.ts";
import { writeRow } from "../lib/log.ts";
import {
  repositoryReflection,
  type RepoReflection,
  routeRecurrences,
} from "../lib/reflection-route.ts";
import { closeStateDb } from "../lib/state.ts";
import type { OutcomeClass } from "../lib/log.ts";
import {
  type FakeStore,
  fakeStore,
  stoppedRow,
} from "./reflection-fixtures.ts";

const REPO = "example-org/web";
const DAY = 86_400_000;
/** Noon UTC on Wednesday 4 November 2026; the route reads the days in UTC. */
const WEDNESDAY = Date.parse("2026-11-04T12:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(join(dir, "state"));
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture extends Omit<FakeStore, "dir" | "command" | "lines"> {
  root: string;
  store: string;
  repo: RepoReflection;
}

function fixture(
  section: Record<string, unknown> | null = {},
  owner = true,
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-reflection-"));
  dirs.push(dir);
  const root = join(dir, "state");
  const checkout = join(dir, "checkout");
  for (const d of [root, checkout]) mkdirSync(d, { recursive: true });
  const store = fakeStore(dir);
  const reflection =
    section === null
      ? { on: false as const }
      : parseReflection(
          {
            store: "command",
            command: store.command,
            timeout_sec: 2,
            ...section,
          },
          checkout,
        );
  return {
    root,
    store: store.dir,
    repo: {
      slug: REPO,
      path: checkout,
      reflection: { ok: true, value: reflection },
      owner,
    },
    calls: store.calls,
    events: store.events,
    flag: store.flag,
  };
}

/** A drive stopped for a person, as the tick's notification writes its event row. */
function stopped(
  root: string,
  atMs: number,
  n: number,
  cls: OutcomeClass | null = "gates failed",
  stage = "rearm",
): void {
  writeRow(stoppedRow(REPO, atMs, n, cls, stage), root);
}

/** A launch that ended with `cls`. */
function ended(root: string, atMs: number, n: number, cls: OutcomeClass): void {
  writeRow(
    {
      kind: "ended",
      key: `ended r-${cls}-${atMs}-${n}`,
      at: new Date(atMs).toISOString(),
      repo: REPO,
      stage: "rearm",
      target: `PR #${n}`,
      record: `r-${n}`,
      account: "a",
      model: null,
      durationMs: 1,
      rounds: null,
      class: cls,
      reason: `exit for ${cls}`,
    },
    root,
  );
}

/** The class recurring through the week of `nowMs`: stops on that day and the two before it. */
function recurringUpTo(root: string, nowMs: number): void {
  for (const [i, back] of [0, 1, 2].entries())
    stopped(root, nowMs - back * DAY - 3_600_000, i + 1);
}

const route = (f: Fixture, nowMs: number, apply = true) =>
  routeRecurrences([f.repo], {
    apply,
    nowMs,
    timeZone: "UTC",
    root: f.root,
  });

describe("the shared definition of a recurring class", () => {
  it("lists event rows of a bad class on three of seven days on the dashboard, and the route records them", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    const page = dashboardData(new URLSearchParams(), WEDNESDAY, f.root);
    if (!page.ok) throw new Error(page.failure.reason);
    expect(
      page.value.recurring.map((r) => [r.class, r.repo, r.stage, r.rows]),
    ).toEqual([["gates failed", REPO, "rearm", 3]]);
    const report = await route(f, WEDNESDAY);
    expect(report?.recorded.map((r) => [r.class, r.stage, r.week])).toEqual([
      ["gates failed", "rearm", "2026-W45"],
    ]);
  });

  it("records the finding as an error about the dispatcher, with the days, the rows, the reasons and the dashboard's filter", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    await route(f, WEDNESDAY);
    const [finding] = f.events();
    expect(finding).toMatchObject({
      type: "finding",
      kind: "error",
      severity: "medium",
      class: "dispatch-recurring-gates-failed",
      target: { scope: "tool", tool: "jig", name: "dispatch" },
      at: "2026-11-04T12:00:00Z",
    });
    expect(finding?.id).toMatch(/^drv-[0-9a-f]{32}$/);
    const text = finding?.description ?? "";
    for (const part of [
      REPO,
      "the rearm stage",
      "3 of the seven host days",
      "2026-11-02, 2026-11-03, 2026-11-04",
      "3 rows",
      '"stopped 1: only a person settles it (see the drive\'s handoff)" (2 rows)',
      '"stopped 14: only a person settles it (see the drive\'s handoff)" (1 row)',
      "view=history&from=2026-10-29T00:00&to=2026-11-04T12:01&repo=example-org/web&stage=rearm&class=gates+failed",
      "2026-W45",
    ])
      expect(text).toContain(part);
  });
});

describe("one finding per recurring class per week", () => {
  it("appends one, then none for the rest of the week, then one more in a week the class still recurs", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    expect((await route(f, WEDNESDAY))?.recorded).toHaveLength(1);
    // Later the same week, with more rows: nothing new reaches the store.
    stopped(f.root, WEDNESDAY + DAY, 9);
    const later = await route(f, WEDNESDAY + DAY + 3_600_000);
    expect(later).toBeNull();
    expect(f.calls().filter((c) => c === "append")).toHaveLength(1);
    // The next Wednesday it still recurs: a new occurrence.
    const next = WEDNESDAY + 7 * DAY;
    recurringUpTo(f.root, next);
    expect((await route(f, next))?.recorded.map((r) => r.week)).toEqual([
      "2026-W46",
    ]);
    const events = f.events();
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
    expect(
      recurrence(
        computeState(events),
        "tool:jig",
        "dispatch-recurring-gates-failed",
      ),
    ).toBe(2);
  });

  it("counts a class on each stage on its own", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    for (const back of [0, 1, 2])
      stopped(
        f.root,
        WEDNESDAY - back * DAY - 7_200_000,
        20,
        "gates failed",
        "followup",
      );
    const report = await route(f, WEDNESDAY);
    expect(report?.recorded.map((r) => r.stage).sort()).toEqual([
      "followup",
      "rearm",
    ]);
    expect(f.calls().filter((c) => c === "append")).toHaveLength(1);
  });
});

describe("reflection off", () => {
  it("appends nothing and reads nothing from the store, with the section absent or switched off", async () => {
    for (const section of [null, { enabled: false }]) {
      const f = fixture(section);
      recurringUpTo(f.root, WEDNESDAY);
      expect(await route(f, WEDNESDAY)).toBeNull();
      expect(f.calls()).toEqual([]);
    }
  });
});

describe("a store that fails", () => {
  it("leaves the finding pending with the failure reported, and the next run appends it", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    f.flag("fail");
    const failed = await route(f, WEDNESDAY);
    expect(failed?.recorded).toEqual([]);
    expect(failed?.pending.map((p) => p.class)).toEqual(["gates failed"]);
    expect(failed?.failures).toEqual([
      expect.objectContaining({ repo: REPO, code: "store-unavailable" }),
    ]);
    expect(failed?.failures[0]?.reason).toContain("the store is down");
    f.flag("fail", false);
    const retried = await route(f, WEDNESDAY + 600_000);
    expect(retried?.recorded.map((r) => r.id)).toEqual(
      failed?.pending.map((p) => p.id),
    );
    expect(retried?.failures).toEqual([]);
    expect(f.events()).toHaveLength(1);
  });

  it("gives up on a store that does not answer within its deadline, and appends at the next run", async () => {
    const f = fixture({ timeout_sec: 1 });
    recurringUpTo(f.root, WEDNESDAY);
    f.flag("hang");
    const hung = await route(f, WEDNESDAY);
    expect(hung?.failures[0]?.code).toBe("store-unavailable");
    expect(hung?.failures[0]?.reason).toContain("within 1s");
    f.flag("hang", false);
    expect((await route(f, WEDNESDAY + 600_000))?.recorded).toHaveLength(1);
  });

  it("sends a retry the same bytes, so an append whose answer was lost leaves one event in the store", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    f.flag("lost");
    expect((await route(f, WEDNESDAY))?.failures[0]?.code).toBe("store-failed");
    // More rows before the retry change nothing in what it sends.
    stopped(f.root, WEDNESDAY + 60_000, 30);
    expect((await route(f, WEDNESDAY + 120_000))?.recorded).toHaveLength(1);
    const lines = readFileSync(join(f.store, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(lines[1]);
    const store = new Store(
      [process.execPath, join(f.store, "..", "fake-store.js")],
      2,
    );
    const held = await store.list();
    expect(held).toHaveLength(1);
    expect(
      idConflicts(held.map((h) => ({ id: h.event.id, text: h.text }))).size,
    ).toBe(0);
  });
});

describe("a tick with no time left", () => {
  it("starts no Git read and no append, lists nothing as recorded, and names no-time", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    const report = await routeRecurrences([f.repo], {
      apply: true,
      nowMs: WEDNESDAY,
      timeZone: "UTC",
      root: f.root,
      timeLeftMs: 0,
    });
    expect(report?.recorded).toEqual([]);
    expect(report?.failures).toEqual([
      expect.objectContaining({ repo: REPO, code: "no-time" }),
    ]);
    expect(f.events()).toHaveLength(0);
    expect((await route(f, WEDNESDAY + 600_000))?.recorded).toHaveLength(1);
  });
});

describe("what never becomes a finding", () => {
  it("a park, a convergence, a merge and a drift, however many days they occur on", async () => {
    const f = fixture();
    for (const back of [0, 1, 2, 3]) {
      const at = WEDNESDAY - back * DAY - 3_600_000;
      stopped(f.root, at, back, "parked for a person");
      stopped(f.root, at, back, null, "pickup");
      ended(f.root, at, back, "converged");
      ended(f.root, at, back, "merged");
    }
    const page = dashboardData(new URLSearchParams(), WEDNESDAY, f.root);
    if (!page.ok) throw new Error(page.failure.reason);
    expect(page.value.recurring).toEqual([]);
    expect(await route(f, WEDNESDAY)).toBeNull();
    expect(f.calls()).toEqual([]);
  });
});

describe("who records", () => {
  it("a run that only reports lists what it would record and writes nothing, so the next applying run records it", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    const report = await route(f, WEDNESDAY, false);
    expect(report?.would.map((w) => w.class)).toEqual(["gates failed"]);
    expect(report?.recorded).toEqual([]);
    expect(f.calls()).toEqual([]);
    expect((await route(f, WEDNESDAY))?.recorded).toHaveLength(1);
    // Once recorded, a report has nothing left to say of it.
    expect(await route(f, WEDNESDAY + 60_000, false)).toBeNull();
  });

  it("a host that does not own the repository records nothing for it", async () => {
    const f = fixture({}, false);
    recurringUpTo(f.root, WEDNESDAY);
    expect(await route(f, WEDNESDAY)).toBeNull();
    // Beside a repository it owns, only that one's finding is recorded.
    const owned = { ...f.repo, slug: "example-org/api", owner: true };
    for (const back of [0, 1, 2])
      writeRow(
        {
          kind: "ended",
          key: `ended api-${back}`,
          at: new Date(WEDNESDAY - back * DAY - 3_600_000).toISOString(),
          repo: owned.slug,
          stage: "pickup",
          target: "#4",
          record: `api-${back}`,
          account: "a",
          model: null,
          durationMs: 1,
          rounds: null,
          class: "died",
          reason: "no result recorded",
        },
        f.root,
      );
    const report = await routeRecurrences([f.repo, owned], {
      apply: true,
      nowMs: WEDNESDAY,
      timeZone: "UTC",
      root: f.root,
    });
    expect(report?.recorded.map((r) => [r.repo, r.class])).toEqual([
      ["example-org/api", "died"],
    ]);
  });

  it("reports the reflection settings that do not read, naming where they came from, and appends nothing", async () => {
    const f = fixture();
    recurringUpTo(f.root, WEDNESDAY);
    const unreadable = repositoryReflection(
      f.repo.path,
      "reflection:\n  store: carrier-pigeon\n",
      `${REPO}@main:.config/jig.yaml`,
      { JIG_USER_LAYER: "off" },
    );
    expect(unreadable.ok).toBe(false);
    const report = await routeRecurrences(
      [{ ...f.repo, reflection: unreadable }],
      { apply: true, nowMs: WEDNESDAY, timeZone: "UTC", root: f.root },
    );
    expect(report?.failures).toEqual([
      expect.objectContaining({ repo: REPO, code: "reflection-unreadable" }),
    ]);
    expect(report?.failures[0]?.reason).toContain("reflection.store");
    expect(report?.failures[0]?.reason).toContain(`${REPO}@main`);
    expect(f.calls()).toEqual([]);
  });

  it("reads the reflection section from the default branch's file and the other layers", () => {
    const f = fixture();
    const on = repositoryReflection(
      f.repo.path,
      "reflection:\n  path: ~/elsewhere\n",
      `${REPO}@main:.config/jig.yaml`,
      { JIG_USER_LAYER: "off" },
    );
    expect(on.ok && on.value.on && on.value.store).toBe("filesystem");
    const off = repositoryReflection(
      f.repo.path,
      null,
      `${REPO}@main:.config/jig.yaml`,
      { JIG_USER_LAYER: "off" },
    );
    expect(off).toEqual({ ok: true, value: { on: false } });
    const fromEnvironment = repositoryReflection(
      f.repo.path,
      null,
      `${REPO}@main:.config/jig.yaml`,
      { JIG_USER_LAYER: "off", JIG__REFLECTION__TIMEOUT_SEC: "7" },
    );
    expect(
      fromEnvironment.ok &&
        fromEnvironment.value.on &&
        fromEnvironment.value.timeoutSec,
    ).toBe(7);
  });
});

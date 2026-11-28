/**
 * The occurrences behind a recurring class: the finding names each row it
 * counted (the pull request, the head, the reason and the run's report), and
 * a drive's stall the once-per-head re-drive followed is left out of the
 * count and named as the re-drive's to settle.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReflection } from "../../skills/reflect/scripts/lib/settings.ts";
import { writeRecord } from "../lib/launches.ts";
import { type OutcomeClass, writeRow } from "../lib/log.ts";
import { recurringClasses } from "../lib/recurring.ts";
import { routeRecurrences } from "../lib/reflection-route.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import { record } from "./line-fixtures.ts";
import { fakeStore } from "./reflection-fixtures.ts";

const REPO = "example-org/web";
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Noon UTC on Wednesday 4 November 2026; the route reads the days in UTC. */
const WEDNESDAY = Date.parse("2026-11-04T12:00:00.000Z");
const HEAD = "abcdef1234567890abcdef1234567890abcdef12";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(join(dir, "state"));
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-recurring-stalls-"));
  dirs.push(dir);
  const root = join(dir, "state");
  const checkout = join(dir, "checkout");
  for (const d of [root, checkout]) mkdirSync(d, { recursive: true });
  const store = fakeStore(dir);
  const reflection = parseReflection(
    { store: "command", command: store.command, timeout_sec: 2 },
    checkout,
  );
  const route = (nowMs: number) =>
    routeRecurrences(
      [
        {
          slug: REPO,
          path: checkout,
          reflection: { ok: true, value: reflection },
          owner: true,
        },
      ],
      { apply: true, nowMs, timeZone: "UTC", root },
    );
  return { root, route, events: store.events };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A drive launch on `pr`, made at `atMs`; `redrove` makes it a re-drive of a stall at `HEAD`. */
function launch(
  root: string,
  id: string,
  pr: number,
  atMs: number,
  redrove = false,
): void {
  writeRecord(
    record({
      id,
      repo: REPO,
      pr,
      createdAt: iso(atMs),
      redrive: redrove
        ? {
            cause: "stopped 14, stalled",
            change: `head ${HEAD}, stopped 14`,
            mechanicalStop: "stall",
          }
        : null,
    }).record,
    root,
  );
}

/** The ended row of drive record `id` on `pr`, at `atMs`. */
function ended(
  root: string,
  id: string,
  pr: number,
  atMs: number,
  cls: OutcomeClass = "stalled",
  reason = "exit 14 (stalled)",
): void {
  writeRow(
    {
      kind: "ended",
      key: `ended ${id}`,
      at: iso(atMs),
      repo: REPO,
      stage: "rearm",
      target: `PR #${pr}`,
      record: id,
      account: "a",
      model: null,
      durationMs: 1,
      rounds: null,
      class: cls,
      reason,
      concluded: "The passes made no change for two rounds.",
    },
    root,
  );
}

/** A stall on each of the three days to `nowMs`, on its own pull request, launched an hour before it ended. */
function stallsUpTo(root: string, nowMs: number, redriven: boolean): void {
  for (const back of [0, 1, 2]) {
    const pr = 10 + back;
    const at = nowMs - back * DAY - 2 * HOUR;
    launch(root, `drive-${pr}`, pr, at - HOUR);
    ended(root, `drive-${pr}`, pr, at);
    if (redriven) launch(root, `redrive-${pr}`, pr, at + HOUR / 2, true);
  }
}

const stalled = (root: string, nowMs: number) =>
  recurringClasses(stateDb(root), nowMs, "UTC", REPO).filter(
    (r) => r.class === "stalled",
  );

describe("a drive's stall the re-drive followed", () => {
  it("is not counted as a recurrence, and no finding is recorded for it", async () => {
    const f = fixture();
    stallsUpTo(f.root, WEDNESDAY, true);
    expect(stalled(f.root, WEDNESDAY)).toEqual([]);
    expect(await f.route(WEDNESDAY)).toBeNull();
    expect(f.events()).toEqual([]);
  });

  it("still counts the stall of a re-drive that stalled again on its head", () => {
    const f = fixture();
    stallsUpTo(f.root, WEDNESDAY, true);
    // Each re-drive stalls in turn, with nothing re-driving it after.
    for (const back of [0, 1, 2]) {
      const pr = 10 + back;
      ended(f.root, `redrive-${pr}`, pr, WEDNESDAY - back * DAY - HOUR);
    }
    expect(
      stalled(f.root, WEDNESDAY).map((r) => [r.stage, r.rows, r.nights]),
    ).toEqual([["rearm", 3, [false, false, false, false, true, true, true]]]);
  });
  it("still counts a round limit and a takeover, even when a stall re-drive came next", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 30 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      ended(
        f.root,
        `drive-${pr}`,
        pr,
        at,
        "stalled",
        back === 1 ? "taken over (exit 14)" : "exit 7 (round limit)",
      );
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("counts a stall whose next launch was not its re-drive, such as a takeover launched before it ended", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 40 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      launch(f.root, `takeover-${pr}`, pr, at - HOUR / 2);
      ended(f.root, `drive-${pr}`, pr, at);
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("counts a stall when launches share a timestamp", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 70 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      // Timestamp precision cannot establish whether the takeover came before
      // or after the stalled drive, so the re-drive relationship is uncertain.
      launch(f.root, `z-takeover-${pr}`, pr, at - HOUR);
      launch(f.root, `a-drive-${pr}`, pr, at - HOUR);
      ended(f.root, `a-drive-${pr}`, pr, at);
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("counts a stall when later launches share a timestamp", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 80 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      ended(f.root, `drive-${pr}`, pr, at);
      // Neither order at this instant is known, so the re-drive cannot prove
      // it immediately followed the stalled drive.
      launch(f.root, `a-redrive-${pr}`, pr, at + HOUR / 2, true);
      launch(f.root, `z-takeover-${pr}`, pr, at + HOUR / 2);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("settles a stall when an unrelated later timestamp is tied", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 85 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      ended(f.root, `drive-${pr}`, pr, at);
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
      launch(f.root, `a-later-${pr}`, pr, at + HOUR);
      launch(f.root, `z-later-${pr}`, pr, at + HOUR);
    }
    expect(stalled(f.root, WEDNESDAY)).toEqual([]);
  });

  it("counts a stall when a launch's ordering timestamp is unreadable", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 90 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      ended(f.root, `drive-${pr}`, pr, at);
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
      const launchRecord = record({
        id: `unknown-time-${pr}`,
        repo: REPO,
        pr,
        createdAt: iso(at + HOUR),
      }).record;
      stateDb(f.root)
        .query(
          "INSERT INTO launches (id, repo, action, pr, created_at, record) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          `unknown-time-${pr}`,
          REPO,
          "takeover",
          pr,
          "not a timestamp",
          JSON.stringify(launchRecord),
        );
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("counts a stall when its launch record has expired", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 50 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      ended(f.root, `expired-${pr}`, pr, at);
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });

  it("counts a stall when an unreadable launch intervenes before its re-drive", () => {
    const f = fixture();
    for (const back of [0, 1, 2]) {
      const pr = 60 + back;
      const at = WEDNESDAY - back * DAY - 2 * HOUR;
      launch(f.root, `drive-${pr}`, pr, at - HOUR);
      ended(f.root, `drive-${pr}`, pr, at);
      const db = stateDb(f.root);
      db.query(
        "INSERT INTO launches (id, repo, action, pr, created_at, record) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(`unreadable-${pr}`, REPO, "rearm", pr, iso(at), "not json");
      launch(f.root, `redrive-${pr}`, pr, at + HOUR / 2, true);
    }
    expect(stalled(f.root, WEDNESDAY).map((r) => r.rows)).toEqual([3]);
  });
});

describe("the finding of a recurring class", () => {
  it("lists every stall it counted, with its pull request, head, reason and report, and the stalls it left out", async () => {
    const f = fixture();
    stallsUpTo(f.root, WEDNESDAY, true);
    for (const back of [0, 1, 2]) {
      const pr = 10 + back;
      ended(f.root, `redrive-${pr}`, pr, WEDNESDAY - back * DAY - HOUR);
    }
    const report = await f.route(WEDNESDAY);
    expect(report?.recorded.map((r) => r.class)).toEqual(["stalled"]);
    const text = f.events()[0]?.description ?? "";
    expect(text).toContain("3 rows in all");
    for (const back of [2, 1, 0]) {
      const pr = 10 + back;
      expect(text).toContain(
        `PR #${pr} at ${iso(WEDNESDAY - back * DAY - HOUR)} (head abcdef1): exit 14 (stalled), its report: "The passes made no change for two rounds."`,
      );
      expect(text).toContain(
        `PR #${pr} at ${iso(WEDNESDAY - back * DAY - 2 * HOUR)} (head abcdef1, re-drive redrive-${pr})`,
      );
    }
    expect(text).toContain(
      "Left out of the count: 3 stalls the once-per-head re-drive followed",
    );
  });

  it("lists the occurrences of any other class it counted", async () => {
    const f = fixture();
    for (const back of [0, 1, 2])
      ended(
        f.root,
        `gates-${back}`,
        20 + back,
        WEDNESDAY - back * DAY - HOUR,
        "gates failed",
        "exit 1 (failed)",
      );
    await f.route(WEDNESDAY);
    const text = f.events()[0]?.description ?? "";
    expect(text).toContain("The occurrences counted: PR #22 at ");
    expect(text).toContain("(head unknown): exit 1 (failed)");
    expect(text).not.toContain("Left out of the count");
  });
});

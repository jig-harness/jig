/**
 * A stage whose Claude Code session stops at startup on a usage notice walls
 * its account until the reset the notice states, and a pickup it stopped is
 * picked up again on another account, with no person asked.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AHEAD_MS, noticeReset } from "../lib/notice-reset.ts";
import {
  failedStartup,
  startupNext,
  startupReset,
} from "../lib/session-startup.ts";
import { readRecord } from "../lib/launches.ts";
import { wallOf } from "../lib/walls.ts";
import { isoFromMs } from "../../shared/time.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const at = (iso: string) => Temporal.Instant.from(iso);
const reset = (clause: string, now: string, host = "UTC") =>
  noticeReset(clause, at(now), host)?.toString() ?? null;

describe("the reset a usage notice states", () => {
  it("reads the clock-time form as its next occurrence in the notice's zone", () => {
    expect(
      reset("resets 3:20am (Europe/Amsterdam)", "2026-11-12T20:00:00Z"),
    ).toBe("2026-11-13T02:20:00Z");
    expect(reset("resets 10pm (UTC)", "2026-11-12T20:00:00Z")).toBe(
      "2026-11-12T22:00:00Z",
    );
    expect(reset("resets 5pm UTC", "2026-11-12T20:00:00Z")).toBe(
      "2026-11-13T17:00:00Z",
    );
  });

  it("reads the dated form, rolling the year over only when its date has passed", () => {
    expect(
      reset("resets Nov 13, 11am (Europe/Amsterdam)", "2026-11-11T09:00:00Z"),
    ).toBe("2026-11-13T10:00:00Z");
    expect(
      reset("resets January 2, 9:30pm (UTC)", "2026-12-30T00:00:00Z"),
    ).toBe("2027-01-02T21:30:00Z");
  });

  it("reads a notice with no zone in the host's", () => {
    expect(
      reset("resets Nov 13, 11am", "2026-11-11T09:00:00Z", "America/New_York"),
    ).toBe("2026-11-13T16:00:00Z");
  });

  it("refuses a reset that does not read or lies further out than a weekly window", () => {
    const now = "2026-11-11T09:00:00Z";
    expect(reset("resets Nov 13, 11am (Mars/Olympus)", now)).toBeNull();
    expect(reset("resets Feb 30, 11am (UTC)", now)).toBeNull();
    expect(reset("resets Smarch 3, 11am (UTC)", now)).toBeNull();
    expect(reset("resets 13pm (UTC)", now)).toBeNull();
    expect(reset("resets soon", now)).toBeNull();
    // A date just passed would be next year's: no weekly window lasts that long.
    expect(reset("resets Nov 10, 11am (UTC)", now)).toBeNull();
    expect(reset("resets Nov 20, 11am (UTC)", now)).toBeNull();
    expect(MAX_AHEAD_MS).toBe(8 * 24 * 60 * 60_000);
  });

  it("accepts a reset exactly eight days out and refuses one just beyond", () => {
    const now = "2026-11-11T09:00:00Z";
    expect(reset("resets Nov 19, 9am (UTC)", now)).toBe("2026-11-19T09:00:00Z");
    expect(reset("resets Nov 19, 9:01am (UTC)", now)).toBeNull();
  });

  it("refuses a reset already past within the current minute", () => {
    const now = "2026-11-13T11:00:30Z";
    expect(reset("resets 11am (UTC)", now)).toBeNull();
    expect(reset("resets Nov 13, 11am (UTC)", now)).toBeNull();
  });

  it("keeps a dated reset's clock transitions", () => {
    // A fall-back time shown twice resolves to the first showing still ahead.
    expect(
      reset("resets Oct 25, 2:30am (Europe/Amsterdam)", "2026-10-25T00:00:00Z"),
    ).toBe("2026-10-25T00:30:00Z");
    // Read seconds into the first showing, neither form slides to the second.
    const seconds = "2026-10-25T00:30:30Z";
    expect(reset("resets 2:30am (Europe/Amsterdam)", seconds)).toBeNull();
    expect(
      reset("resets Oct 25, 2:30am (Europe/Amsterdam)", seconds),
    ).toBeNull();
    // A time the clock skips does not read.
    expect(
      reset("resets Mar 29, 2:30am (Europe/Amsterdam)", "2026-03-28T12:00:00Z"),
    ).toBeNull();
  });

  it("reads the reset only from a recognized standalone notice", () => {
    const nowMs = at("2026-11-11T09:00:00Z").epochMilliseconds;
    expect(
      startupReset(
        "starting\nYou've hit your weekly limit · resets Nov 13, 11am (UTC)\n",
        nowMs,
      ),
    ).toEqual({
      clause: "resets Nov 13, 11am (UTC)",
      resetAt: "2026-11-13T11:00:00.000Z",
    });
    expect(
      startupReset("You've hit your limit · resets whenever", nowMs),
    ).toEqual({ clause: "resets whenever", resetAt: null });
    expect(
      startupReset("the docs say resets Nov 13, 11am (UTC)", nowMs),
    ).toBeNull();
  });
});

describe("which stages recognise a startup", () => {
  const root = join(process.cwd(), ".context", `startup-walls-${process.pid}`);
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const recordOf = (fields: Record<string, unknown>) => {
    const configDir = join(root, "config");
    mkdirSync(join(configDir, "projects"), { recursive: true });
    return {
      vendor: "claude",
      sessionId: "11111111-2222-3333-4444-555555555555",
      configDir,
      ...fields,
    } as unknown as Parameters<typeof failedStartup>[0];
  };
  const notice = "You've hit your weekly limit · resets Nov 13, 11am (UTC)\n";

  it.each([
    { action: "pickup", headless: true },
    { action: "steward" },
    { action: "followup" },
  ])(
    "classes a %o session that stopped on a usage notice as quota",
    (fields) => {
      const started = Date.now() - 10_000;
      expect(
        failedStartup(recordOf(fields), 1, started, notice, started + 5_000),
      ).toBe("quota");
    },
  );

  it.each([{ action: "pickup" }, { action: "rearm" }])(
    "leaves a %o session to the stage that runs it",
    (fields) => {
      const started = Date.now() - 10_000;
      expect(
        failedStartup(recordOf(fields), 1, started, notice, started + 5_000),
      ).toBeUndefined();
    },
  );
});

describe("who takes a pass that could not start on", () => {
  it("hands a pickup with no usage notice to a person, and every other start to the line", () => {
    expect(startupNext("pickup", "unstarted")).toMatchObject({
      owner: "person",
      act: "Decide",
    });
    expect(startupNext("pickup", "quota").owner).toBe("line");
    expect(startupNext("followup", "unstarted").owner).toBe("line");
    expect(startupNext("steward", "quota").owner).toBe("line");
  });
});

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** The dated notice Claude Code prints for a weekly wall that resets at `ms`, in UTC. */
function weeklyNotice(ms: number): string {
  const t =
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC");
  const month = t.toLocaleString("en-US", { month: "short" });
  const hour = t.hour % 12 === 0 ? 12 : t.hour % 12;
  return `You've hit your weekly limit · resets ${month} ${t.day}, ${hour}${t.hour < 12 ? "am" : "pm"} (UTC)\n`;
}

describe("a pickup that stops on a usage notice", () => {
  it("walls its account until the notice's reset and is picked up again on another account", async () => {
    const w = world();
    current = w;
    w.setConfig(
      `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  identity: factory-bot\n`,
    );
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(
      w,
      [account(w, "a", "a@example.com"), account(w, "b", "b@example.com")],
      {},
      ["pickup"],
    );
    const first = (await applyTick(w, false)).repos[0]?.launches?.[0];
    expect(first?.account).toBe("a");
    const id = String(first?.record);
    expect(readRecord(id, dispatchState(w))?.headless).toBe(true);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    // Two days out, on the hour, as the weekly notice states it.
    const resetMs =
      Math.floor((Date.now() + 2 * 24 * 60 * 60_000) / 3_600_000) * 3_600_000;
    writeFileSync(join(w.dir, "claude-said"), weeklyNotice(resetMs));
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    rmSync(join(w.dir, "claude-exit"));
    const wall = wallOf("a", Date.now(), dispatchState(w));
    expect(wall?.resetAt).toBe(isoFromMs(resetMs));
    expect(wall?.source).toContain("the usage notice's reset");
    const ticks = [await applyTick(w, false)];
    if (!ticks[0]?.repos[0]?.launches?.some((l) => l.outcome === "launched"))
      ticks.push(await applyTick(w, false));
    const again = ticks[ticks.length - 1];
    expect(again?.repos[0]?.launches).toContainEqual(
      expect.objectContaining({
        action: "pickup",
        account: "b",
        outcome: "launched",
      }),
    );
    for (const tick of ticks)
      expect(
        (tick.repos[0]?.actions ?? []).filter(
          (a) => a.cause === "pickup-ended",
        ),
      ).toEqual([]);
  });
});

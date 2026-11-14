/**
 * dispatch: what a tick does with a read a failed call stopped, for each
 * failure class. A class that clears by waiting does not fail the tick
 * under its threshold; a rate limit before its reset never does; any other
 * class fails it at once, which is when a person is told.
 */
import { describe, expect, it } from "bun:test";
import {
  clearsByWaiting,
  FAILURE_CLASSES,
  outboundFailure,
} from "../../shared/outbound/failure.ts";
import { failed } from "../../shared/outcome.ts";
import {
  combinedFailure,
  keepForgeReading,
  lastForgeReading,
  readFailureOf,
  waitingFailures,
  waitsOut,
} from "../lib/read-failures.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { emptyReport } from "../lib/tick-context.ts";
import type { ReadFailure, RepoReport } from "../lib/types.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const SETTINGS = { notifyAfter: 3 };

/** A repository's turn whose forge record failed as `failure`. */
function unread(failure?: ReadFailure): RepoReport {
  return {
    ...emptyReport("/checkouts/repo", ""),
    refused: null,
    records: [
      {
        record: "forge",
        source: "gh o/r",
        ok: false,
        detail: "the pull requests cannot be read",
        ...(failure === undefined ? {} : { failure }),
      },
    ],
  };
}

describe("a repository whose read a failed call stopped", () => {
  for (const code of FAILURE_CLASSES) {
    const failure: ReadFailure = {
      class: code,
      ...(code === "rate-limited"
        ? { until: new Date(NOW + 60_000).toISOString() }
        : {}),
    };
    const waits = clearsByWaiting(code);
    it(`${waits ? "waits out" : "fails the tick at once for"} ${code}`, () => {
      expect(waitsOut(unread(failure), 0, SETTINGS, NOW)).toBe(waits);
      // At the threshold a person is told, except of a rate limit before its reset.
      expect(waitsOut(unread(failure), 2, SETTINGS, NOW)).toBe(
        code === "rate-limited",
      );
    });
  }

  it("fails the tick for a read no call's class explains, or beside another failure", () => {
    expect(waitsOut(unread(), 0, SETTINGS, NOW)).toBe(false);
    const both = unread({ class: "unreachable" });
    both.stageDefects = [{ code: "defect", phase: "act", reason: "a defect" }];
    expect(waitingFailures(both)).toBeNull();
    const refused = {
      ...unread({ class: "server-fault" }),
      refused: "the forge cannot say which repository this is",
    };
    expect(waitingFailures(refused)).toBeNull();
    expect(
      waitingFailures({ ...refused, refusedBy: { class: "server-fault" } }),
    ).toHaveLength(2);
  });

  it("counts a rate limit past its reset like any other wait", () => {
    const past = unread({
      class: "rate-limited",
      until: new Date(NOW - 1).toISOString(),
    });
    expect(waitsOut(past, 2, SETTINGS, NOW)).toBe(false);
  });

  it("reads the class from the failure a call caused, or from what was thrown", () => {
    const limited = outboundFailure("rate-limited", "spent", { until: NOW });
    expect(
      readFailureOf({
        code: "unreadable",
        reason: "x",
        outbound: limited,
      } as never),
    ).toEqual({ class: "rate-limited", until: new Date(NOW).toISOString() });
    expect(
      readFailureOf(
        failed(
          "unreadable",
          "x",
          Object.assign(new Error("t"), { name: "TimeoutError" }),
        ).failure,
      ),
    ).toEqual({ class: "unreachable" });
    expect(readFailureOf(failed("unreadable", "x").failure)).toBeUndefined();
  });
});

describe("the forge's last reading", () => {
  it("is shown with its time and age", () => {
    const held = new Map<string, unknown>();
    const store: PickupReads = {
      get: <T>(key: string) => (held.get(key) as T) ?? null,
      set: (key, value) => held.set(key, value),
    };
    expect(lastForgeReading("/r", NOW, store)).toBe("");
    keepForgeReading("/r", "2 open pull request(s)", NOW - 90 * 60_000, store);
    expect(lastForgeReading("/r", NOW, store)).toBe(
      "; the last reading, of 2026-11-13T10:30:00.000Z (90m old): 2 open pull request(s)",
    );
  });
});

describe("combinedFailure", () => {
  it("keeps a failure waiting does not clear over one that does", () => {
    expect(
      combinedFailure([{ class: "unreachable" }, { class: "unauthorized" }]),
    ).toEqual({ class: "unauthorized" });
  });
  it("keeps no class when a failed read has none", () => {
    expect(
      combinedFailure([{ class: "unreachable" }, undefined]),
    ).toBeUndefined();
  });
  it("prefers a failure that counts over a rate limit, else the later reset", () => {
    const early = {
      class: "rate-limited",
      until: "2026-11-13T12:00:00.000Z",
    } as const;
    const late = {
      class: "rate-limited",
      until: "2026-11-13T13:00:00.000Z",
    } as const;
    expect(combinedFailure([early, { class: "server-fault" }])).toEqual({
      class: "server-fault",
    });
    expect(combinedFailure([early, late])).toEqual(late);
  });
});

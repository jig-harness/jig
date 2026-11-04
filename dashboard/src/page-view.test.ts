import { describe, expect, it } from "bun:test";
import type {
  RowsAnswer,
  StateAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import type { ReadFailure } from "./api.ts";
import { lastReadLead, pageStrip, pageView, readLine } from "./page-view.ts";
import type { Read, StateRead } from "./reads.ts";

const SAID = "2026-11-03T16:47:30.000Z";

function answer(id: Parameters<typeof fixture>[0]): StateAnswer {
  return {
    now: SAID,
    timeZone: "UTC",
    plugin: "0.0.0",
    schema: 3,
    line: fixture(id).line,
  };
}

function stateOf(
  value: StateAnswer | null,
  failure: ReadFailure | null = null,
): Read<StateRead> {
  return {
    data: value === null ? null : { answer: value, readAtMono: 1000 },
    failure,
  };
}

const NO_ROWS: Read<RowsAnswer> = { data: null, failure: null };
const GONE: ReadFailure = { kind: "gone" };
const CODED: ReadFailure = {
  kind: "failed",
  code: "log-unreadable",
  reason: "the outcome log cannot be read",
};

describe("the page before the server answered", () => {
  const view = pageView(stateOf(null), NO_ROWS, 0);

  it("knows no line, version or read", () => {
    expect(view).toMatchObject({
      answer: null,
      line: null,
      lastRead: null,
      version: null,
      gone: false,
      overdue: false,
      coded: null,
      pastTense: false,
    });
    expect(view.clock.timeZone).toBe("UTC");
  });

  it("says nothing of a tick, and has not read", () => {
    expect(pageStrip(view)).toEqual({
      main: "Newest tick not known",
      sub: "",
      alarm: false,
    });
    expect(readLine(view)).toBe("not read");
    expect(lastReadLead(view)).toBe("");
  });

  it("says the server is gone when it never answered", () => {
    const gone = pageView(stateOf(null, GONE), NO_ROWS, 0);
    expect(pageStrip(gone)).toMatchObject({
      sub: "server not answering",
      alarm: true,
    });
  });
});

describe("the page with an answer", () => {
  it("reads the server's clock, plus the time since on this device's own", () => {
    const view = pageView(stateOf(answer("quiet")), NO_ROWS, 61_000);
    expect(view.clock.nowMs).toBe(Date.parse(SAID) + 60_000);
  });

  it("never runs the server's clock backwards", () => {
    const view = pageView(stateOf(answer("quiet")), NO_ROWS, 0);
    expect(view.clock.nowMs).toBe(Date.parse(SAID));
  });

  it("names the version, the read and the line", () => {
    const view = pageView(stateOf(answer("quiet")), NO_ROWS, 1000);
    expect(view.version).toBe("plugin 0.0.0");
    expect(view.lastRead).toBe("16:47");
    expect(view.line?.runId).toBe(fixture("quiet").line?.runId);
    expect(readLine(view)).toBe(
      "read 16:47 host time; reads every 60 s and on focus",
    );
    expect(lastReadLead(view)).toBe("Last read 16:47; ");
    expect(pageStrip(view).main).toBe("Tick 16:45, 2 min ago");
  });

  it("says so when the server does not name its version", () => {
    const view = pageView(
      stateOf({ ...answer("quiet"), plugin: null }),
      NO_ROWS,
      1000,
    );
    expect(view.version).toBe("plugin not known");
  });

  it("reads in the host's zone", () => {
    const view = pageView(
      stateOf({ ...answer("quiet"), timeZone: "Asia/Tokyo" }),
      NO_ROWS,
      1000,
    );
    expect(view.lastRead).toBe("01:47");
  });
});

describe("what failed", () => {
  it("is gone when either read found no server, and speaks of the tick as past", () => {
    for (const [state, rows] of [
      [GONE, null],
      [null, GONE],
    ] as const) {
      const view = pageView(
        stateOf(answer("loud"), state),
        { data: null, failure: rows },
        1000,
      );
      expect(view.gone).toBe(true);
      expect(view.pastTense).toBe(true);
      expect(readLine(view)).toBe("last read 16:47 host time");
    }
  });

  it("takes the state read's coded failure before the log's", () => {
    const first = { ...CODED, code: "line-unreadable" };
    const view = pageView(
      stateOf(answer("quiet"), first),
      { data: null, failure: CODED },
      1000,
    );
    expect(view.coded).toEqual(first);
    expect(view.pastTense).toBe(true);
  });

  it("names the log's coded failure, and keeps the tense when only the log failed", () => {
    const view = pageView(
      stateOf(answer("quiet")),
      { data: null, failure: CODED },
      1000,
    );
    expect(view.coded).toEqual(CODED);
    expect(view.pastTense).toBe(false);
  });

  it("is overdue past the timer's tolerance, which turns the tense", () => {
    const view = pageView(stateOf(answer("stopped")), NO_ROWS, 1000);
    expect(view.overdue).toBe(true);
    expect(view.pastTense).toBe(true);
  });
});

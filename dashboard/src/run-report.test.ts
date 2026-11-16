/**
 * A run's closing report on the page: on its log line, on its work's page
 * of runs, newest first, and beside a need's question. A run that ended
 * `by: none` reads as ended without a report; where the suggested next
 * step's owner and the tick's `next` differ, both are shown.
 */
import { describe, expect, it } from "bun:test";
import type { LineNeed } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type {
  EndedRow,
  EventRow,
  LogRow,
} from "../../plugin/dispatch/lib/log.ts";
import { forgesOf } from "./links.ts";
import { activeFilters, type RowClock, rowView } from "./log-view.ts";
import { needView } from "./needs-view.ts";
import { NO_REPORT, runReport } from "./run-report.ts";
import { readFilter } from "./search.ts";
import { workView } from "./work-runs.tsx";

const ROW_CLOCK: RowClock = { today: "2026-11-03", timeZone: "UTC" };
const NO_FORGES = forgesOf(null);

const RUN: EndedRow = {
  kind: "ended",
  key: "ended r1",
  at: "2026-11-03T07:22:00.000Z",
  repo: "example-org/web",
  stage: "pickup",
  target: "#12",
  record: "r1",
  account: "work-a",
  model: null,
  durationMs: 600_000,
  rounds: null,
  class: "refused",
  reason: "result failed",
  by: "agent",
  concluded: "Stopped: the item asks for a schema the repository lacks.",
  suggested_next: {
    step: "Choose the schema.",
    owner: "person",
    act: "Decide",
  },
  cause: "scope",
  next: { person: "repository maintainer", act: "answer the question" },
};

describe("a run's report on its line", () => {
  it("shows what the run concluded, the next step it suggests and its cause", () => {
    const report = runReport(RUN);
    expect(report).toMatchObject({
      by: "agent",
      missing: false,
      concluded: RUN.concluded,
      suggested: "Choose the schema. (person, Decide)",
      cause: "scope",
      tickNext: null,
    });
    expect(report?.line).toBe(
      "Stopped: the item asks for a schema the repository lacks. · next: Choose the schema. (person, Decide) · cause: scope",
    );
    const view = rowView(RUN, ROW_CLOCK, NO_FORGES);
    expect(view.run?.line).toBe(report?.line);
    expect(view.evidence).toContainEqual({ k: "report by", v: "agent" });
  });

  it("shows the tick's next beside the suggestion where their owners differ, and decides nothing", () => {
    const report = runReport({
      ...RUN,
      suggested_next: { step: "Re-arm the drive.", owner: "line" },
      next: { none: "no handoff was recorded: exit 16" },
    });
    expect(report?.suggested).toBe("Re-arm the drive. (line)");
    expect(report?.tickNext).toBe("none: no handoff was recorded: exit 16");
    expect(report?.line).toContain(
      "the tick reads next: none: no handoff was recorded: exit 16",
    );
  });

  it("reads a run that left no report as ended without one", () => {
    const {
      concluded: _concluded,
      suggested_next: _next,
      cause: _cause,
      ...bare
    } = RUN;
    const report = runReport({ ...bare, by: "none" });
    expect(report).toMatchObject({ missing: true, line: NO_REPORT });
  });

  it("says nothing of a report for a row from before reports were kept, nor for an event", () => {
    const { by: _by, ...old } = RUN;
    expect(runReport(old)).toBeNull();
    const event: EventRow = {
      kind: "event",
      key: "event e1",
      at: RUN.at,
      repo: RUN.repo,
      stage: "pickup",
      target: "#12",
      event: "drifting",
      account: null,
      class: null,
      reason: "drifting",
    };
    expect(rowView(event, ROW_CLOCK, NO_FORGES).run).toBeNull();
  });
});

describe("a piece of work's page of runs", () => {
  const rows: LogRow[] = [
    { ...RUN, key: "ended r3", at: "2026-11-03T09:00:00.000Z", by: "none" },
    { ...RUN, key: "ended r2", target: "#13" },
    RUN,
  ];

  it("lists the work's ended runs newest first, as the log answered them", () => {
    const work = workView(
      rows,
      readFilter("?target=%2312&repo=example-org/web"),
      ROW_CLOCK,
      NO_FORGES,
    );
    expect(work?.heading).toBe("Runs of #12 in example-org/web, newest first");
    expect(work?.runs.map((r) => r.key)).toEqual(["ended r3", "ended r1"]);
    expect(work?.runs[0]?.run?.missing).toBe(true);
  });

  it("is no page without a work in the filter, and the filter names the work it shows", () => {
    expect(workView(rows, readFilter(""), ROW_CLOCK, NO_FORGES)).toBeNull();
    const filter = readFilter("?target=%2312&cause=scope&by=agent");
    expect(activeFilters(filter).map((a) => a.label)).toEqual([
      "cause scope",
      "report by agent",
      "work #12",
    ]);
  });
});

describe("a need's run on What needs you", () => {
  const NEED: LineNeed = {
    cause: "pickup-question",
    stage: "pickup",
    repo: "example-org/web",
    target: "#12",
    pr: null,
    item: "#12",
    url: null,
    title: "Export the report",
    since: "2026-11-03T10:00:00.000Z",
    reason: "the pickup stopped on a question for a person",
    question: "Should the export keep the old column?",
    decisions: [],
    notified: null,
    workspaces: [],
  };
  const CLOCK = { nowMs: Date.UTC(2026, 10, 3, 16, 47), timeZone: "UTC" };

  it("shows what the run concluded beside its question", () => {
    const view = needView(
      { ...NEED, concluded: "Stopped on the schema." },
      CLOCK,
    );
    expect(view.question).toBe("Should the export keep the old column?");
    expect(view.concluded).toBe("Stopped on the schema.");
  });

  it("shows nothing beside the question for a run that left no report", () => {
    expect(needView(NEED, CLOCK).concluded).toBeNull();
  });
});

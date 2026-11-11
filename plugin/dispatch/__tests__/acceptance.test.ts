/**
 * `jig dispatch log --acceptance`: per repository and decision class, how
 * many parks the log counted, how many people answered, how many chose the
 * recommended option with no note, and the median wait, from the park rows
 * alone.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptanceOf, waitText } from "../lib/acceptance.ts";
import {
  type EventRow,
  type LogRow,
  type ParkFacts,
  writeRow,
} from "../lib/log.ts";
import { closeStateDb } from "../lib/state.ts";
import { logMain } from "../log-command.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    closeStateDb(r);
    rmSync(r, { recursive: true, force: true });
  }
});

let n = 0;
function park(
  repo: string,
  at: string,
  facts: Partial<ParkFacts> & Pick<ParkFacts, "class">,
  durationMs?: number,
): EventRow {
  n++;
  return {
    kind: "event",
    key: `park ${n}`,
    at,
    repo,
    stage: "rearm",
    target: `PR #${n}`,
    event: "park-answered",
    account: null,
    class: null,
    reason: "r",
    ...(durationMs === undefined ? {} : { durationMs }),
    park: {
      key: `k${n}`,
      digest: null,
      parkedAt: at,
      outcome: "answered",
      form: "approve",
      recommended: true,
      note: false,
      ...facts,
    },
  };
}

const SEC = 1000;
const ROWS: LogRow[] = [
  park("o/a", "2026-11-01T00:00:00.000Z", { class: "release" }, 60 * SEC),
  park("o/a", "2026-11-02T00:00:00.000Z", { class: "release" }, 180 * SEC),
  park(
    "o/a",
    "2026-11-03T00:00:00.000Z",
    { class: "release", form: "choose", recommended: false },
    120 * SEC,
  ),
  park(
    "o/a",
    "2026-11-04T00:00:00.000Z",
    { class: "release", note: true },
    600 * SEC,
  ),
  park("o/a", "2026-11-05T00:00:00.000Z", {
    class: "release",
    outcome: "removed",
    form: null,
    recommended: null,
  }),
  park("o/b", "2026-11-06T00:00:00.000Z", { class: "release" }, 30 * SEC),
  park("o/a", "2026-11-07T00:00:00.000Z", {
    class: null,
    form: "free",
    recommended: null,
  }),
  {
    kind: "event",
    key: "nudge",
    at: "2026-11-08T00:00:00.000Z",
    repo: "o/a",
    stage: "steer",
    target: "t",
    event: "nudge",
    account: null,
    class: null,
    reason: "r",
  },
];

describe("the recommendation report", () => {
  it("counts each repository's classes from the park rows alone", () => {
    expect(acceptanceOf(ROWS)).toEqual([
      {
        repo: "o/a",
        class: null,
        parks: 1,
        answered: 1,
        asRecommended: 0,
        medianWaitMs: null,
      },
      {
        repo: "o/a",
        class: "release",
        parks: 5,
        answered: 4,
        asRecommended: 2,
        // 60s, 120s, 180s, 600s
        medianWaitMs: 150 * SEC,
      },
      {
        repo: "o/b",
        class: "release",
        parks: 1,
        answered: 1,
        asRecommended: 1,
        medianWaitMs: 30 * SEC,
      },
    ]);
  });

  it("reports nothing for a log without parks", () => {
    expect(acceptanceOf([])).toEqual([]);
  });

  it("reads a wait as its two largest units", () => {
    expect(waitText(null)).toBe("-");
    expect(waitText(0)).toBe("0s");
    expect(waitText(45 * SEC)).toBe("45s");
    expect(waitText(3600 * SEC)).toBe("1h 0m");
    expect(waitText((2 * 3600 + 5 * 60 + 9) * SEC)).toBe("2h 5m");
    expect(waitText((3 * 86400 + 4 * 3600) * SEC)).toBe("3d 4h");
  });

  it("prints a line a class from the database, and JSON lines with --jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "jig-acceptance-"));
    roots.push(root);
    for (const r of ROWS) writeRow(r, root);
    const lines: string[] = [];
    expect(
      logMain({ jsonl: false, acceptance: true }, root, (l) => lines.push(l)),
    ).toBe(0);
    expect(lines).toEqual([
      "o/a\t(no class)\t1 parks\t1 answered\t0 as recommended\tmedian wait -",
      "o/a\trelease\t5 parks\t4 answered\t2 as recommended\tmedian wait 2m 30s",
      "o/b\trelease\t1 parks\t1 answered\t1 as recommended\tmedian wait 30s",
    ]);

    const json: string[] = [];
    logMain({ jsonl: true, acceptance: true }, root, (l) => json.push(l));
    expect(json.map((l) => JSON.parse(l))).toEqual(acceptanceOf(ROWS));

    const since: string[] = [];
    logMain(
      { jsonl: false, acceptance: true, since: "2026-11-06" },
      root,
      (l) => since.push(l),
    );
    expect(since).toHaveLength(2);
  });
});

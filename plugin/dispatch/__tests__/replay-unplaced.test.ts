/**
 * A pending drive launch is not replayed while its pull request's place in a
 * serialized group is unknown to the tick: the replay is deferred and the
 * record kept, so the first launch of a record a tick stopped before making
 * does not start beside the leader another tick chose.
 */
import { describe, expect, it } from "bun:test";
import {
  type ApplyState,
  applyDrives,
  type FreshDrive,
} from "../lib/actions/drive.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import { emptyReport } from "../lib/tick-context.ts";
import type { SessionsReport } from "../lib/runtime/port.ts";

const SLUG = "o/r";
const repo = { path: "/r", slug: SLUG, defaultBranch: "main" };

const record = (pr: number) =>
  ({
    id: `r${pr}`,
    action: "rearm",
    repo: SLUG,
    pr,
    workspace: { id: "w", path: "/w" },
    attempts: [],
    facts: "f",
    account: "a",
    redrive: null,
  }) as unknown as LaunchRecord;

function state(records: LaunchRecord[]) {
  return {
    records: records.map((r) => ({
      record: r,
      state: { kind: "pending" },
      result: null,
    })),
  } as unknown as ApplyState & { records: unknown[] };
}

describe("replaying a pending drive launch", () => {
  it("defers one whose pull request has no place in its group, and keeps the record", async () => {
    let read = 0;
    const fresh: FreshDrive = {
      read: async () => {
        read++;
        return null;
      },
      held: () => false,
      unplaced: new Map([[5, "another tick acted while this one read"]]),
    };
    const report = emptyReport("/r", "");
    const apply = state([record(5), record(6)]);
    await applyDrives(apply, repo, report, {} as SessionsReport, fresh);
    const [five, six] = report.launches;
    expect(five?.outcome).toBe("waits");
    expect(five?.detail).toContain("another tick acted while this one read");
    expect(five?.detail).toContain("r5");
    // The other record went on to its own checks, which read its ledger.
    expect(six?.detail).toContain("ledger cannot be read again");
    expect(read).toBe(1);
    expect(apply.records).toHaveLength(2);
  });
});

import { describe, expect, it } from "bun:test";
import {
  type DriverRecord,
  readDriverRecord,
  removeSettledRecord,
  writeDriverRecord,
} from "../scripts/lib/ledger-stop.ts";
import {
  markIdlePersonStop,
  personStopFor,
  restoreIdlePersonStop,
} from "../scripts/lib/state/person-stop.ts";
import { fakeForge } from "./ledger-forge-fixtures.ts";
import { scopedStateDir } from "./scoped-state-dir.ts";

function stage() {
  const forge = fakeForge([], { login: "drive-bot" });
  const leaf = scopedStateDir(forge.stateDir, forge.repo);
  const started = new Date(Date.now() - 1000).toISOString();
  return { forge, leaf, started };
}

describe("an idle stop marks only a retained record", () => {
  it("never recreates a deleted record and ignores another acquisition", () => {
    const s = stage();
    expect(markIdlePersonStop(s.leaf, "999", s.started, "maintenance")).toBe(
      false,
    );
    expect(personStopFor(s.leaf, "999", s.started)).toEqual({});
    const driver = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    writeDriverRecord(s.leaf, "999", driver);
    expect(
      markIdlePersonStop(s.leaf, "999", "2001-01-01T00:00:00.000Z", "x"),
    ).toBe(false);
    expect(markIdlePersonStop(s.leaf, "999", s.started, "maintenance")).toBe(
      true,
    );
    expect(personStopFor(s.leaf, "999", s.started)).toMatchObject({
      personStop: { reason: "maintenance" },
    });
  });
});

describe("an idle stop whose record recovery deleted restores it with the stop", () => {
  it("leaves a released record carrying the person's stop, and never replaces a newer one", () => {
    const s = stage();
    const idle = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    expect(readDriverRecord(s.leaf, "999")).toBeNull();
    expect(restoreIdlePersonStop(s.leaf, "999", idle, "maintenance")).toBe(
      true,
    );
    expect(readDriverRecord(s.leaf, "999")).toMatchObject({
      started: s.started,
      released: true,
      personStop: { reason: "maintenance" },
    });
    expect(
      restoreIdlePersonStop(
        s.leaf,
        "999",
        { ...idle, started: "2001-01-01T00:00:00.000Z" },
        "other",
      ),
    ).toBe(false);
    expect(readDriverRecord(s.leaf, "999")?.started).toBe(s.started);
  });
});

describe("recovery settles a record only for the person stop it published", () => {
  it("keeps a record marked after its snapshot and drops it once the snapshot matches", () => {
    const s = stage();
    const driver = {
      worktree: s.forge.repo,
      started: s.started,
      pid: 1,
      host: "h",
    };
    writeDriverRecord(s.leaf, "999", driver);
    const snapshot = readDriverRecord(s.leaf, "999");
    expect(snapshot).not.toBeNull();
    expect(markIdlePersonStop(s.leaf, "999", s.started, "maintenance")).toBe(
      true,
    );
    expect(removeSettledRecord(s.leaf, "999", snapshot as DriverRecord)).toBe(
      "unsettled",
    );
    const marked = readDriverRecord(s.leaf, "999");
    expect(marked?.personStop?.reason).toBe("maintenance");
    expect(removeSettledRecord(s.leaf, "999", marked as DriverRecord)).toBe(
      "settled",
    );
    expect(readDriverRecord(s.leaf, "999")).toBeNull();
  });
});

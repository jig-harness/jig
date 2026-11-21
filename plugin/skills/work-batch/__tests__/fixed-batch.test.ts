/** A fixed batch's proposal: the dispatcher names the members, and no size is a question. */
import { describe, expect, it } from "bun:test";
import { renderTable, run, verdictPrompt } from "../scripts/candidates.ts";
import { catalog, fakeTracker, issue, policy, relabel } from "./helpers.ts";

const P = policy();
const base = issue("ENG-0").labels;
const medium = (key: string) =>
  issue(key, { labels: relabel(base, ["small"], ["medium"]) });
const large = (key: string) =>
  issue(key, { labels: relabel(base, ["small"], ["large"]) });
const options = (fixed?: string[]) => ({
  limit: P.maxItems,
  budget: P.pointBudget,
  claimed: new Set(fixed ?? []),
  ...(fixed === undefined ? {} : { fixed: new Set(fixed) }),
});
const propose = (
  issues: ReturnType<typeof issue>[],
  anchor: string,
  fixed?: string[],
) =>
  run(
    fakeTracker(issues),
    catalog(),
    P,
    anchor,
    options(fixed),
    import.meta.dir,
  );
const ids = (rows: readonly { identifier: string }[]) =>
  rows.map((r) => r.identifier);

describe("a fixed batch with a member of the most expensive size", () => {
  const members = ["ENG-1", "ENG-2", "ENG-3"];
  const pool = () => [medium("ENG-1"), issue("ENG-2"), issue("ENG-3")];

  it("keeps the small members as the batch and leaves the medium one out, with no verdict prompt", async () => {
    const p = await propose(pool(), "ENG-1", members);
    expect(ids(p.candidates).sort()).toEqual(["ENG-2", "ENG-3"]);
    expect(p.leftOut.map((l) => [l.identifier, l.size])).toEqual([
      ["ENG-1", "medium"],
    ]);
    const table = renderTable(p, P);
    expect(table).toContain("Left for their own pickups:");
    expect(table).toContain("ENG-1");
    expect(table).not.toContain(verdictPrompt("medium"));
  });

  it("leaves every member out when all are medium, so the pass works them one at a time", async () => {
    const p = await propose([medium("ENG-1"), medium("ENG-2")], "ENG-1", [
      "ENG-1",
      "ENG-2",
    ]);
    expect(p.candidates).toEqual([]);
    expect(ids(p.leftOut)).toEqual(["ENG-1", "ENG-2"]);
  });

  it("keeps one small member when the rest are left out", async () => {
    const p = await propose([medium("ENG-1"), issue("ENG-2")], "ENG-1", [
      "ENG-1",
      "ENG-2",
    ]);
    expect(ids(p.candidates)).toEqual(["ENG-2"]);
    expect(ids(p.leftOut)).toEqual(["ENG-1"]);
  });

  it("leaves out a member, the anchor included, that grew past the batchable sizes", async () => {
    const p = await propose(
      [large("ENG-1"), issue("ENG-2"), issue("ENG-3")],
      "ENG-1",
      members,
    );
    expect(ids(p.candidates).sort()).toEqual(["ENG-2", "ENG-3"]);
    expect(p.leftOut.map((l) => [l.identifier, l.size])).toEqual([
      ["ENG-1", "large"],
    ]);
    expect(p.excluded).toEqual([]);
  });

  it("leaves out an anchor whose size was cleared or doubled, and asks nothing", async () => {
    for (const anchor of [
      issue("ENG-1", { labels: relabel(base, ["small"]) }),
      issue("ENG-1", { labels: [...base, "medium"] }),
    ]) {
      const p = await propose(
        [anchor, issue("ENG-2"), issue("ENG-3")],
        "ENG-1",
        members,
      );
      expect(ids(p.candidates).sort()).toEqual(["ENG-2", "ENG-3"]);
      expect(p.leftOut.map((l) => [l.identifier, l.size])).toEqual([
        ["ENG-1", null],
      ]);
      expect(p.excluded).toEqual([]);
    }
  });

  it("leaves out a member, the anchor included, whose priority was cleared, and asks nothing", async () => {
    for (const anchor of ["ENG-1", "ENG-2"]) {
      const p = await propose(
        [
          issue("ENG-1", anchor === "ENG-1" ? { priority: 0 } : {}),
          issue("ENG-2", anchor === "ENG-2" ? { priority: 0 } : {}),
          issue("ENG-3"),
        ],
        "ENG-1",
        members,
      );
      const kept = members.filter((m) => m !== anchor);
      expect(ids(p.candidates).sort()).toEqual(kept);
      expect(p.leftOut.map((l) => [l.identifier, l.size])).toEqual([
        [anchor, null],
      ]);
      expect(p.leftOut[0]?.why).toContain("no priority");
      expect(p.excluded).toEqual([]);
      expect(p.labellingGaps).toEqual([]);
    }
  });

  it("warns about a member the tracker returns under another key", async () => {
    const tracker = fakeTracker([issue("ENG-1"), issue("ENG-2")]);
    const read = tracker.poolIssue.bind(tracker);
    tracker.poolIssue = async (key) =>
      key === "ENG-2" ? issue("OPS-5") : read(key);
    const p = await run(
      tracker,
      catalog(),
      P,
      "ENG-1",
      options(["ENG-1", "ENG-2"]),
      import.meta.dir,
    );
    expect(ids(p.candidates)).toEqual(["ENG-1"]);
    expect(p.warnings).toContain("fixed member ENG-2 came back as OPS-5");
  });

  it("refuses an epic as the anchor instead of proposing its children", async () => {
    const epic = issue("ENG-1", { isEpic: true, hasOpenChildren: true });
    await expect(
      propose([epic, issue("ENG-2")], "ENG-1", members),
    ).rejects.toThrow("ENG-1");
  });

  it("proposes only the named members, however large the area's pool is", async () => {
    const p = await propose(
      [issue("ENG-1"), issue("ENG-2"), issue("ENG-9")],
      "ENG-1",
      ["ENG-1", "ENG-2"],
    );
    expect(ids(p.candidates).sort()).toEqual(["ENG-1", "ENG-2"]);
    expect(p.overflow).toBe(0);
  });

  it("refuses an anchor outside the named members", async () => {
    await expect(propose(pool(), "ENG-3", ["ENG-1"])).rejects.toThrow(
      "ENG-3 is not among the --fixed keys",
    );
  });

  it("refuses an area anchor, which names no member", async () => {
    await expect(propose(pool(), "billing", members)).rejects.toThrow(
      "--fixed needs an issue's key as its anchor",
    );
  });
});

describe("an attended run", () => {
  it("still proposes a medium issue under its verdict prompt", async () => {
    const p = await propose([medium("ENG-1"), issue("ENG-2")], "ENG-1");
    expect(ids(p.candidates)).toContain("ENG-1");
    expect(p.leftOut).toEqual([]);
    expect(renderTable(p, P)).toContain(verdictPrompt("medium"));
  });
});

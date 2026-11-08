import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copy, movedFacets, restore, retire } from "../scripts/lib/move.ts";
import {
  type MoveRecord,
  MoveRecordError,
  readMoveRecord,
  writeMoveRecord,
} from "../scripts/lib/move-record.ts";
import { pacedWriter } from "../scripts/lib/pace.ts";
import {
  FakeRepo,
  fakeClock,
  LABEL_SECTION,
  labelled,
  NATIVE_SECTION,
} from "./fake-repo.ts";

/** A repository whose facets are in labels, moving to the issue type, Priority and Effort. */
function setup() {
  const repo = new FakeRepo();
  repo.add("#1", { labels: labelled("bug", "high", "small") });
  // Its destination already holds another type: the copy replaces it.
  repo.add("#2", {
    labels: labelled("docs", "low", "xs"),
    native: { type: "feature" },
  });
  // An epic needs no size.
  repo.add("#3", { labels: ["epic", ...labelled("feature", "medium")] });
  // Closed: never read or written, so it keeps its labels.
  repo.add("#4", { state: "closed", labels: labelled("bug", "high", "small") });
  // Started, its destination already at its values: nothing to copy.
  repo.add("#5", {
    state: "started",
    labels: labelled("chore", "urgent", "large"),
    native: { type: "chore", priority: 1, size: "large" },
  });
  repo.add("#6", {
    state: "triage",
    labels: labelled("infra", "medium", "medium"),
  });
  const source = repo.view(LABEL_SECTION);
  const target = repo.view(NATIVE_SECTION);
  const sides = {
    source: source.tracker,
    target: target.tracker,
    sourceFacets: source.facets,
    targetFacets: target.facets,
  };
  const record: MoveRecord = {
    kind: "facet-move",
    version: 1,
    team: "owner/repo",
    adapter: "github",
    source: LABEL_SECTION,
    target: NATIVE_SECTION,
    moved: movedFacets(source.facets, target.facets),
    previewedAt: "2026-01-01T00:00:00Z",
    snapshots: {},
    changes: [],
  };
  const saved: MoveRecord[] = [];
  const rec = {
    record,
    save: (r: MoveRecord) => saved.push(structuredClone(r)),
    now: () => "2026-01-02T00:00:00Z",
  };
  return { repo, sides, rec, saved };
}

/** The updates each issue received during `run`. */
async function updatesDuring(
  repo: FakeRepo,
  run: () => Promise<unknown>,
): Promise<Record<string, number>> {
  const from = repo.writes.length;
  await run();
  const per: Record<string, number> = {};
  for (const w of repo.writes.slice(from))
    if (w.kind === "update") per[w.key] = (per[w.key] ?? 0) + 1;
  return per;
}

const state = (repo: FakeRepo) =>
  repo.issues.map((i) => ({
    key: i.key,
    labels: [...i.labels].sort(),
    native: { ...i.native },
  }));

describe("the move between facet stores", () => {
  it("moves type, priority and size from labels to the issue's own fields", () => {
    const { rec } = setup();
    expect(rec.record.moved).toEqual(["type", "priority", "size"]);
  });

  it("previews what every open issue gets, and writes nothing", async () => {
    const { repo, sides, rec } = setup();
    const report = await copy(sides, rec, {
      apply: false,
      writer: pacedWriter(fakeClock()),
      preview: true,
    });
    expect(report.open).toBe(5);
    expect(report.unresolved).toEqual([]);
    expect(report.gets).toContainEqual({
      issue: "#3",
      values: { type: "feature", priority: "medium", size: null },
    });
    expect(report.writes.map((w) => w.issue)).toEqual(["#1", "#2", "#3", "#6"]);
    expect(report.writes[1]).toMatchObject({
      set: { type: "docs", priority: "low", size: "xs" },
      replaces: { type: "feature" },
    });
    expect(repo.writes).toEqual([]);
  });

  it("writes at most one update per open issue a run, skips what a stopped run moved, and is undone by restore", async () => {
    const { repo, sides, rec } = setup();
    const before = state(repo);
    const clock = fakeClock();

    // A run the tracker stops after two writes.
    let allowed = 2;
    repo.refuse = (w) =>
      w.kind === "update" && allowed-- <= 0
        ? Object.assign(new Error("HTTP 403 FORBIDDEN"), { status: 403 })
        : null;
    let report = await copy(sides, rec, {
      apply: true,
      writer: pacedWriter(clock),
    });
    expect(report.stopped).toBe("update #3: refused (HTTP 403)");
    expect(report.written).toEqual(["#1", "#2"]);

    // The next run skips the two it moved.
    repo.refuse = () => null;
    let per = await updatesDuring(repo, async () => {
      report = await copy(sides, rec, {
        apply: true,
        writer: pacedWriter(clock),
      });
    });
    expect(per).toEqual({ "#3": 1, "#6": 1 });
    expect(report.stopped).toBeNull();
    expect(repo.get("#2").native).toEqual({
      type: "docs",
      priority: 4,
      size: "xs",
    });
    expect(repo.get("#1").labels).toContain("bug");
    expect(rec.record.snapshots["#5"]).toEqual({
      type: "chore",
      priority: "urgent",
      size: "large",
    });
    expect(
      await updatesDuring(repo, () =>
        copy(sides, rec, { apply: true, writer: pacedWriter(clock) }),
      ),
    ).toEqual({});

    // Retire: one update per open issue, the closed one untouched.
    per = await updatesDuring(repo, async () => {
      report = await retire(sides, rec, {
        apply: true,
        writer: pacedWriter(clock),
      });
    });
    expect(per).toEqual({ "#1": 1, "#2": 1, "#3": 1, "#5": 1, "#6": 1 });
    for (const i of repo.issues.filter((i) => i.state !== "closed"))
      expect(
        i.labels.filter((l) => l !== "area:tracker" && l !== "epic"),
      ).toEqual([]);
    expect(repo.get("#4").labels).toEqual(labelled("bug", "high", "small"));
    expect(repo.get("#3").labels.sort()).toEqual(["area:tracker", "epic"]);
    expect(
      await updatesDuring(repo, () =>
        retire(sides, rec, { apply: true, writer: pacedWriter(clock) }),
      ),
    ).toEqual({});

    // Restore puts every value back, the replaced type included.
    per = await updatesDuring(repo, async () => {
      report = await restore(sides, rec, {
        apply: true,
        writer: pacedWriter(clock),
      });
    });
    expect(report.conflicts).toEqual([]);
    expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
    expect(state(repo)).toEqual(before);
    expect(
      await updatesDuring(repo, () =>
        restore(sides, rec, { apply: true, writer: pacedWriter(clock) }),
      ),
    ).toEqual({});
    // The refused write stays recorded as sent and not landed.
    expect(
      rec.record.changes
        .filter((c) => !c.done)
        .map((c) => `${c.phase} ${c.issue}`),
    ).toEqual(["copy #3"]);
  });

  it("refuses to copy while an open issue's source gives no value or two", async () => {
    const { repo, sides, rec } = setup();
    repo.add("#7", { labels: ["bug", "docs", "priority: low", "xs"] });
    repo.add("#8", { labels: ["bug", "small"] });
    const report = await copy(sides, rec, {
      apply: true,
      writer: pacedWriter(fakeClock()),
    });
    expect(report.unresolved).toEqual([
      { issue: "#7", why: "type has two values in its source (bug, docs)" },
      { issue: "#8", why: "priority has no value in its source" },
    ]);
    expect(report.problem).toContain("2 open issue(s) are unresolved");
    expect(repo.writes).toEqual([]);
  });

  it("leaves conflicts and a cleared destination for a person, and finishes a changed source in the next run", async () => {
    const { repo, sides, rec } = setup();
    const clock = fakeClock();
    await copy(sides, rec, { apply: true, writer: pacedWriter(clock) });
    // #1: source and destination both changed since the copy.
    repo.get("#1").labels = labelled("feature", "high", "small");
    repo.get("#1").native.type = "docs";
    // #2: only its source changed.
    repo.get("#2").labels = labelled("chore", "low", "xs");
    // #3: its destination was cleared.
    delete repo.get("#3").native.priority;
    // #7: filed after the copy, through a clone on the old configuration.
    repo.add("#7", { labels: labelled("bug", "low", "xs") });
    let per = await updatesDuring(repo, () =>
      retire(sides, rec, { apply: true, writer: pacedWriter(clock) }),
    );
    expect(per["#1"]).toBeUndefined();
    expect(per["#2"]).toBe(1);
    expect(per["#7"]).toBe(1);
    expect(repo.get("#2").native.type).toBe("chore");
    expect(repo.get("#2").labels).toContain("chore");
    expect(repo.get("#1").labels).toContain("feature");
    const report = await retire(sides, rec, {
      apply: false,
      writer: pacedWriter(clock),
    });
    expect(report.conflicts).toEqual([
      {
        issue: "#1",
        why: "type: its source changed to feature and its destination to docs since the copy wrote bug",
      },
    ]);
    expect(report.unresolved).toEqual([
      {
        issue: "#3",
        why: "priority: its destination was cleared or names no value, and its source still holds medium",
      },
    ]);
    per = await updatesDuring(repo, () =>
      retire(sides, rec, { apply: true, writer: pacedWriter(clock) }),
    );
    expect(per["#2"]).toBe(1);
    expect(per["#7"]).toBe(1);
    expect(repo.get("#7").labels).toEqual(["area:tracker"]);
    expect(repo.get("#7").native).toEqual({
      type: "bug",
      priority: 4,
      size: "xs",
    });
  });

  it("stops a run on the fourth refusal that asks it to wait, and reports it", async () => {
    const { repo, sides, rec } = setup();
    const clock = fakeClock();
    repo.refuse = (w) =>
      w.key === "#1"
        ? Object.assign(new Error("rate limited"), {
            unavailable: true,
            retryAfterSec: 30,
          })
        : null;
    const report = await copy(sides, rec, {
      apply: true,
      writer: pacedWriter(clock),
    });
    expect(clock.slept).toEqual([30_000, 30_000, 30_000]);
    expect(report.stopped).toBe(
      "update #1: unavailable, retry after 30s (after 3 waits this run)",
    );
    expect(report.written).toEqual([]);
  });
});

describe("the move record", () => {
  const scratch = mkdtempSync(join(tmpdir(), "move-record-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("is written whole into a folder it creates, and read back as written", () => {
    const { rec } = setup();
    const path = join(scratch, ".context", "facet-move", "record.json");
    writeMoveRecord(path, rec.record);
    expect(readMoveRecord(path)).toEqual(rec.record);
  });

  it("refuses a file that is not a record this release reads", () => {
    const { rec } = setup();
    const path = join(scratch, "newer.json");
    writeMoveRecord(path, {
      ...rec.record,
      version: 2,
    } as unknown as MoveRecord);
    expect(() => readMoveRecord(path)).toThrow(MoveRecordError);
    expect(() => readMoveRecord(path)).toThrow("this release reads 1");
    expect(() => readMoveRecord(join(scratch, "none.json"))).toThrow(
      "run the preview",
    );
  });
});

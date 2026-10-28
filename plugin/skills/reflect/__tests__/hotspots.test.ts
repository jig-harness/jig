/**
 * Conflict hotspots into the reflection loop: a scratch repository whose
 * merges conflict, replayed by resolve-conflicts' history report, then
 * `reflect.ts hotspots` on its JSON and the ordinary `contribute`, against
 * the filesystem store.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import type { FindingEvent } from "../scripts/lib/events.ts";
import { Machine, type Repo, type Run } from "./scratch.ts";

const RESOLVE = join(
  import.meta.dir,
  "..",
  "..",
  "resolve-conflicts",
  "scripts",
);

let m: Machine;
let branches = 0;
beforeEach(() => {
  m = new Machine();
  branches = 0;
});
afterEach(() => m.cleanup());

function succeeded(r: Run, what: string): string {
  expectSpawnExit(
    { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
    0,
    what,
  );
  return r.stdout;
}

/**
 * Commit `base` to `path` on main, change it to `theirs` on a branch and to
 * `ours` on main, then record a merge of the two without running it, so the
 * replay alone decides what conflicted.
 */
function conflictingMerge(
  repo: Repo,
  path: string,
  base: string,
  ours: string,
  theirs: string,
): void {
  repo.commit("base", { [path]: base });
  const branch = `feature-${++branches}`;
  repo.git("checkout", "-q", "-b", branch);
  const theirsCommit = repo.commit("theirs", { [path]: theirs });
  repo.git("checkout", "-q", "main");
  const oursCommit = repo.commit("ours", { [path]: ours });
  const merge = repo
    .git(
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      oursCommit,
      "-p",
      theirsCommit,
      "-m",
      `Merge branch '${branch}'`,
    )
    .trim();
  repo.git("reset", "-q", "--hard", merge);
}

/** Both sides add a line at the same place: `append`. */
function appendMerge(repo: Repo): void {
  conflictingMerge(
    repo,
    "notes.md",
    "# Notes\n",
    "# Notes\nours\n",
    "# Notes\ntheirs\n",
  );
}

/** Both sides change the same line: `overlap`. */
function overlapMerge(repo: Repo): void {
  conflictingMerge(
    repo,
    "settings.txt",
    "colour = red\n",
    "colour = blue\n",
    "colour = green\n",
  );
}

/** A repository with two hotspots (two conflicting merges each, the threshold 2). */
function twoHotspots(): Repo {
  const repo = m.repository("web", "git@github.com:example/web.git");
  repo.commit("threshold", {
    ".config/jig.yaml": "resolve_conflicts:\n  hotspot_min_merges: 2\n",
  });
  appendMerge(repo);
  appendMerge(repo);
  overlapMerge(repo);
  overlapMerge(repo);
  return repo;
}

let reports = 0;
/** The history report's JSON, written to a file outside the repository. */
function historyReport(repo: Repo, range: string[] = ["--all"]): string {
  const file = join(m.dir, `merge-conflicts-${++reports}.json`);
  const out = succeeded(
    repo.script("history.ts", [...range, "--json"], undefined, RESOLVE),
    "history.ts",
  );
  writeFileSync(file, out);
  return file;
}

interface Recorded {
  hotspots: Array<{
    path: string;
    class: string;
    merges: number;
    action: string;
    id: string;
    status?: string;
  }>;
}

function hotspots(repo: Repo, file: string): Recorded {
  return JSON.parse(
    succeeded(repo.script("reflect.ts", ["hotspots", file]), "hotspots"),
  ) as Recorded;
}

function storedFindings(repo: Repo): FindingEvent[] {
  return succeeded(repo.script("store.ts", ["list"]), "store.ts list")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FindingEvent)
    .filter((event) => event.type === "finding");
}

function contribute(repo: Repo): string[] {
  const out = JSON.parse(
    succeeded(repo.script("reflect.ts", ["contribute"]), "contribute"),
  ) as { stored: Array<{ id: string }> };
  return out.stored.map((entry) => entry.id);
}

describe("reflect.ts hotspots", () => {
  it("writes one finding per hotspot into the store, its cause as the class", () => {
    m.userConfig();
    const repo = twoHotspots();
    const recorded = hotspots(repo, historyReport(repo));
    expect(
      recorded.hotspots.map(({ path, class: cause, merges, action }) => ({
        path,
        cause,
        merges,
        action,
      })),
    ).toEqual([
      { path: "notes.md", cause: "append", merges: 2, action: "noted" },
      { path: "settings.txt", cause: "overlap", merges: 2, action: "noted" },
    ]);
    expect(contribute(repo).sort()).toEqual(
      recorded.hotspots.map((entry) => entry.id).sort(),
    );
    const stored = storedFindings(repo).sort((a, b) =>
      a.target.name < b.target.name ? -1 : 1,
    );
    expect(
      stored.map((finding) => ({
        class: finding.class,
        target: finding.target,
        repository: finding.change.repository,
        branch: finding.change.branch,
      })),
    ).toEqual([
      {
        class: "append",
        target: { scope: "repository", name: "notes.md" },
        repository: "github.com/example/web",
        branch: null,
      },
      {
        class: "overlap",
        target: { scope: "repository", name: "settings.txt" },
        repository: "github.com/example/web",
        branch: null,
      },
    ]);
    const [notes] = stored;
    expect(notes?.title).toBe("notes.md conflicted in 2 merges (append)");
    expect(notes?.description).toContain("Both sides added lines");
    // What the measurement could not see travels with the finding.
    expect(notes?.description).toMatch(/hand-check(ed)? (of|found) the append/);
    // The report's limits travel whole: the report file does not outlive the finding.
    expect(notes?.description).toContain(
      "a conflict resolved during a rebase, a cherry-pick or a revert",
    );
    expect(notes?.description).toContain("the merges this clone's refs reach");
    expect(notes?.suggested_fix).toContain("one file per entry");
    expect(notes?.session.skills).toContain("resolve-conflicts");
  });

  it("merges a second measurement of the same path and cause into one finding", () => {
    m.userConfig();
    const repo = twoHotspots();
    const first = hotspots(repo, historyReport(repo));
    appendMerge(repo);
    const file = historyReport(repo);
    const second = hotspots(repo, file);
    expect(
      second.hotspots.map(({ path, merges, action }) => ({
        path,
        merges,
        action,
      })),
    ).toEqual([
      { path: "notes.md", merges: 3, action: "updated" },
      // Its own count stands, but the merges replayed rose.
      { path: "settings.txt", merges: 2, action: "updated" },
    ]);
    expect(second.hotspots.map((entry) => entry.id)).toEqual(
      first.hotspots.map((entry) => entry.id),
    );
    expect(hotspots(repo, file).hotspots.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    contribute(repo);
    const stored = storedFindings(repo);
    expect(stored).toHaveLength(2);
    expect(stored.map((finding) => finding.title).sort()).toEqual([
      "notes.md conflicted in 3 merges (append)",
      "settings.txt conflicted in 2 merges (overlap)",
    ]);

    // Once stored, a new measurement adds nothing.
    const third = hotspots(repo, historyReport(repo));
    expect(third.hotspots.map((entry) => entry.action)).toEqual([
      "stored",
      "stored",
    ]);
    expect(contribute(repo)).toEqual([]);
    expect(storedFindings(repo)).toHaveLength(2);
  });

  it("records a hotspot again once its fix is implemented and every merge measured came after it", () => {
    m.userConfig();
    const repo = twoHotspots();
    const file = historyReport(repo);
    hotspots(repo, file);
    contribute(repo);
    const notes = storedFindings(repo).find(
      (finding) => finding.target.name === "notes.md",
    ) as FindingEvent;
    succeeded(
      repo.review(
        ["record"],
        `${JSON.stringify({ finding: notes.id, decision: "implemented", reason: "entries moved to one file each", commit: "a1b2c3d" })}\n`,
      ),
      "review.ts record",
    );
    // The whole history still holds the merges from before the fix.
    expect(hotspots(repo, file).hotspots.map((entry) => entry.action)).toEqual([
      "stored",
      "stored",
    ]);
    // Two more append conflicts, committed an hour after the fix was recorded.
    const later = Math.floor(Date.now() / 1000) + 3600;
    m.env.GIT_COMMITTER_DATE = `@${later} +0000`;
    m.env.GIT_AUTHOR_DATE = `@${later} +0000`;
    appendMerge(repo);
    appendMerge(repo);
    delete m.env.GIT_COMMITTER_DATE;
    delete m.env.GIT_AUTHOR_DATE;
    // The replay of a range starting after the fix holds only those: the cause recurred.
    const since = new Date((later - 60) * 1000).toISOString();
    const recurred = hotspots(
      repo,
      historyReport(repo, ["--since", since]),
    ).hotspots;
    expect(
      recurred.map(({ path, merges, action }) => ({ path, merges, action })),
    ).toEqual([{ path: "notes.md", merges: 2, action: "noted" }]);
    expect(recurred[0]?.id).not.toBe(notes.id);
  });

  it("does not take a range starting at the very moment of the fix as after it", () => {
    m.userConfig();
    const repo = twoHotspots();
    const file = historyReport(repo);
    hotspots(repo, file);
    contribute(repo);
    const notes = storedFindings(repo).find(
      (finding) => finding.target.name === "notes.md",
    ) as FindingEvent;
    succeeded(
      repo.review(
        ["record"],
        `${JSON.stringify({ finding: notes.id, decision: "implemented", reason: "entries moved to one file each", commit: "a1b2c3d" })}\n`,
      ),
      "review.ts record",
    );
    const decision = succeeded(
      repo.script("store.ts", ["list"]),
      "store.ts list",
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; at: string })
      .find((event) => event.type === "decision");
    const at = decision?.at as string;
    // A merge at that same moment falls inside the range and may predate the fix.
    const boundary = JSON.parse(readFileSync(file, "utf8")) as {
      range: { since: string | null };
      merges: Array<{ date: string }>;
      paths: Array<{ lastConflict: string }>;
    };
    // As history.ts --since writes it.
    boundary.range.since = new Date(at).toISOString();
    for (const merge of boundary.merges) merge.date = at;
    for (const entry of boundary.paths) entry.lastConflict = at;
    const same = join(m.dir, "at-the-fix.json");
    writeFileSync(same, JSON.stringify(boundary));
    expect(hotspots(repo, same).hotspots.map((entry) => entry.action)).toEqual([
      "stored",
      "stored",
    ]);
  });

  it("refuses a report whose values the history report could not have written", () => {
    m.userConfig();
    const repo = twoHotspots();
    const real = JSON.parse(readFileSync(historyReport(repo), "utf8")) as {
      hotspotMinMerges: number;
      range: { since: string | null; until: string | null };
      limits?: string[];
      hotspots: string[];
      merges: Array<{ date: string }>;
      paths: Array<{
        path: string;
        merges: number;
        lastConflict: string;
        topCause: string;
        causes: Record<string, number>;
      }>;
    };
    const first = (report: typeof real) =>
      report.paths[0] as (typeof real.paths)[number];
    const faults: Array<[string, (report: typeof real) => void]> = [
      [
        "with no region of its top cause",
        (report) => {
          first(report).causes = {};
        },
      ],
      [
        "whose top cause is not its most frequent",
        (report) => {
          const entry = first(report);
          entry.causes = { [entry.topCause]: 1, echo: 5 };
        },
      ],
      [
        "whose last conflict predates its range",
        (report) => {
          const after = Date.parse(first(report).lastConflict) + 1000;
          report.range.since = new Date(after).toISOString();
        },
      ],
      [
        "whose last conflict is at its range's end",
        (report) => {
          report.range.until = first(report).lastConflict;
        },
      ],
      [
        "whose range ends before it starts",
        (report) => {
          report.range.since = "2026-02-01T00:00:00Z";
          report.range.until = "2026-01-01T00:00:00Z";
        },
      ],
      [
        "without its limits",
        (report) => {
          delete report.limits;
        },
      ],
      [
        "below the threshold",
        (report) => {
          report.hotspotMinMerges = 3;
        },
      ],
      [
        "not a date",
        (report) => {
          (report.paths[0] as { lastConflict: string }).lastConflict =
            "yesterday";
        },
      ],
      [
        "with its hotspots left out",
        (report) => {
          report.hotspots = [];
        },
      ],
      [
        "with a hotspot named twice",
        (report) => {
          report.hotspots = [...report.hotspots, report.hotspots[0] as string];
        },
      ],
      [
        "with a path entry twice",
        (report) => {
          report.paths = [...report.paths, first(report)];
        },
      ],
      [
        "with an empty list of limits",
        (report) => {
          report.limits = [];
        },
      ],
      [
        "from a shallow clone without its partial-coverage limit",
        (report) => {
          (report as { shallow?: boolean }).shallow = true;
        },
      ],
      [
        "whose range start has no time zone",
        (report) => {
          report.range.since = "2000-01-01T00:00:00";
        },
      ],
      [
        "whose merge is dated without a time zone",
        (report) => {
          const merge = report.merges[0] as { date: string };
          merge.date = merge.date.replace(/(Z|[+-]\d{2}:\d{2})$/, "");
        },
      ],
    ];
    for (const [problem, damage] of faults) {
      const report = structuredClone(real);
      damage(report);
      const file = join(m.dir, "damaged.json");
      writeFileSync(file, JSON.stringify(report));
      const r = repo.script("reflect.ts", ["hotspots", file]);
      expectSpawnExit(
        { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
        2,
        `hotspots on a report ${problem}`,
      );
    }
    expect(existsSync(join(repo.root, ".git", "jig"))).toBe(false);
  });

  it("notes nothing when the store is unavailable (exit 3) or answers with something else (exit 1)", () => {
    const repo = twoHotspots();
    const file = historyReport(repo);
    const stores: Array<[number, string]> = [
      [3, 'console.error("the store is down"); process.exit(3);\n'],
      [1, 'console.log("not an event");\n'],
    ];
    for (const [code, body] of stores) {
      const command = join(m.dir, `store-${code}.ts`);
      writeFileSync(command, body);
      m.userConfig(
        `reflection:\n  store: command\n  command: [${JSON.stringify(process.execPath)}, ${JSON.stringify(command)}]\n`,
      );
      const r = repo.script("reflect.ts", ["hotspots", file]);
      expectSpawnExit(
        { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
        code,
        "hotspots",
      );
      expect(r.stderr).toContain("nothing was noted");
      expect(
        succeeded(repo.script("journal.ts", ["unsent"]), "journal.ts unsent"),
      ).not.toContain("conflicted in");
    }
  });

  it("says reflection is off and writes nothing without a reflection section", () => {
    const repo = twoHotspots();
    const out = JSON.parse(
      succeeded(
        repo.script("reflect.ts", ["hotspots", historyReport(repo)]),
        "hotspots",
      ),
    );
    expect(out).toEqual({ on: false });
    expect(existsSync(join(repo.root, ".git", "jig"))).toBe(false);
    expect(existsSync(m.store)).toBe(false);
  });

  it("refuses a file that is not the history report, noting nothing", () => {
    m.userConfig();
    const repo = m.repository("web", "git@github.com:example/web.git");
    const file = join(m.dir, "other.json");
    writeFileSync(file, JSON.stringify({ schema: "something-else/v1" }));
    const r = repo.script("reflect.ts", ["hotspots", file]);
    expectSpawnExit(
      { exitCode: r.code, stdout: r.stdout, stderr: r.stderr },
      2,
      "hotspots",
    );
    expect(r.stderr).toContain("merge-conflicts/v1");
    expect(existsSync(join(repo.root, ".git", "jig"))).toBe(false);
  });
});

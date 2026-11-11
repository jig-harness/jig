/** The tracker settings: defaults, validation and opening the adapter they name. */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  defaultStateName,
  parseTrackerConfig,
  requireTeamKey,
} from "../scripts/lib/tracker/config.ts";
import { knownAdapters, openTracker } from "../scripts/lib/tracker/index.ts";
import {
  CANONICAL_STATES,
  OPTIONAL_STATES,
  type RequiredState,
} from "../scripts/lib/tracker/port.ts";

describe("tracker configuration", () => {
  it("defaults the adapter and every canonical state name", () => {
    const c = parseTrackerConfig({});
    expect(c.adapter).toBe("github");
    expect(c.team).toBeNull();
    expect(c.states.in_progress).toBe("In Progress");
    expect(c.states.ops_pending).toBe("Ops Pending");
    for (const s of CANONICAL_STATES)
      expect(c.states[s]).toBe(
        (OPTIONAL_STATES as readonly string[]).includes(s)
          ? null
          : defaultStateName(s as RequiredState),
      );
    expect(c.states.pr_open).toBeNull();
  });

  it("names pr_open on its own, or shared with in_review on a tracker with one review status", () => {
    expect(
      parseTrackerConfig({
        issue_tracker: { states: { pr_open: "Awaiting Review" } },
      }).states.pr_open,
    ).toBe("Awaiting Review");
    const shared = parseTrackerConfig({
      issue_tracker: { states: { pr_open: "In Review" } },
    }).states;
    expect(shared.pr_open).toBe("In Review");
    expect(shared.in_review).toBe("In Review");
    expect(
      parseTrackerConfig({
        issue_tracker: {
          states: {
            pr_open: "Review",
            in_review: "Review",
            ops_pending: "Review",
          },
        },
      }).states.ops_pending,
    ).toBe("Review");
  });

  it("refuses pr_open named like a state other than in_review", () => {
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { pr_open: "In Progress" } },
      }),
    ).toThrow(
      "issue_tracker.states.in_progress and issue_tracker.states.pr_open both name 'In Progress'",
    );
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { pr_open: "Ops Pending" } },
      }),
    ).toThrow(
      "issue_tracker.states.pr_open and issue_tracker.states.ops_pending both name 'Ops Pending'",
    );
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { pr_open: "Done" } },
      }),
    ).toThrow("both name 'Done'");
  });

  it("reads the team and maps states by canonical key", () => {
    const c = parseTrackerConfig({
      issue_tracker: {
        adapter: "linear",
        team: "ENG",
        file_command: "/file-issue",
        states: { in_review: "Code Review", done: "Shipped" },
      },
    });
    expect(c.team).toBe("ENG");
    expect(c.states.in_review).toBe("Code Review");
    expect(c.states.done).toBe("Shipped");
    expect(c.states.todo).toBe("Todo");
  });

  it("refuses a non-canonical state key, a bad team key and an empty adapter", () => {
    expect(() =>
      parseTrackerConfig({ issue_tracker: { states: { shipped: "Done" } } }),
    ).toThrow("not a canonical state");
    expect(() =>
      parseTrackerConfig({ issue_tracker: { adapter: "linear", team: "eng" } }),
    ).toThrow("issue key prefix");
    expect(() =>
      parseTrackerConfig({ issue_tracker: { adapter: "" } }),
    ).toThrow("adapter");
  });

  it("refuses two states named alike, outside an aliasable group", () => {
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { in_review: "In Progress" } },
      }),
    ).toThrow(
      "issue_tracker.states.in_progress and issue_tracker.states.in_review both name 'In Progress'",
    );
    expect(() =>
      parseTrackerConfig({
        issue_tracker: { states: { done: "in review" } },
      }),
    ).toThrow("both name");
    const aliased = parseTrackerConfig({
      issue_tracker: {
        states: {
          triage: "Backlog",
          duplicate: "Canceled",
          ops_pending: "In Review",
        },
      },
    });
    expect(aliased.states.triage).toBe("Backlog");
    expect(aliased.states.duplicate).toBe("Canceled");
    expect(aliased.states.ops_pending).toBe("In Review");
  });

  it("refuses a team that names no adapter, which the default would ignore", () => {
    expect(() =>
      parseTrackerConfig({ issue_tracker: { team: "ENG" } }),
    ).toThrow("issue_tracker.adapter: linear");
    expect(() =>
      parseTrackerConfig({ issue_tracker: { adapter: null, team: "ENG" } }),
    ).toThrow("issue_tracker.adapter: linear");
    expect(
      parseTrackerConfig({ issue_tracker: { adapter: "github", team: "ENG" } })
        .adapter,
    ).toBe("github");
  });

  it("names the missing field when a team is required", () => {
    expect(() => requireTeamKey(parseTrackerConfig({}))).toThrow(
      "issue_tracker.team",
    );
  });

  it("refuses an unknown adapter at open time", () => {
    expect(knownAdapters()).toEqual(["linear", "github", "jira"]);
    expect(() =>
      openTracker(
        parseTrackerConfig({
          issue_tracker: { adapter: "nonesuch", team: "ENG" },
        }),
      ),
    ).toThrow("not supported");
  });

  describe("opening from the overlay", () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });
    it("opening the tracker refuses the pre-rename do_issue section", () => {
      dir = mkdtempSync(join(tmpdir(), "tracker-config-"));
      const path = join(dir, "overlay.yaml");
      writeFileSync(
        path,
        "issue_tracker:\n  adapter: linear\n  team: ENG\ndo_issue:\n  gates: []\n",
      );
      // The overlay is named in a child's environment, never this process's.
      const index = join(import.meta.dir, "../scripts/lib/tracker/index.ts");
      const r = spawnSync(
        process.execPath,
        [
          "-e",
          `import { openTracker } from ${JSON.stringify(index)};
try { openTracker(); } catch (e) { console.log(e.message); process.exit(3); }`,
        ],
        {
          env: { ...process.env, JIG_OVERLAY: path },
          encoding: "utf8",
          timeout: 60_000,
        },
      );
      expectSpawnExit(
        { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
        3,
      );
      expect(r.stdout).toContain("now called do_item");
    });
  });
});

it("openTracker preserves recovery reads with explicit stores and a malformed taxonomy", () => {
  const root = mkdtempSync(join(tmpdir(), "tracker-recovery-"));
  try {
    writeFileSync(join(root, "broken.yaml"), "version: 1\ntypes: oops\n");
    const index = join(import.meta.dir, "../scripts/lib/tracker/index.ts");
    const configModule = join(
      import.meta.dir,
      "../scripts/lib/tracker/config.ts",
    );
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import { openTracker } from ${JSON.stringify(index)};
      import { parseTrackerConfig } from ${JSON.stringify(configModule)};
      globalThis.fetch = async () => Response.json({ data: { issueLabels: {
        nodes: [], pageInfo: { hasNextPage: false, endCursor: null }
      } } });
      const t = openTracker(parseTrackerConfig({ issue_tracker: {
        adapter: "linear", team: "ENG", taxonomy: "broken.yaml",
        facets: { type: { store: "label" }, size: { store: "label" } }
      } }), ${JSON.stringify(root)});
      if (JSON.stringify(await t.listLabels()) !== "[]") throw Error("recovery read failed");
      try { await t.createIssue({ title: "x", description: "", labels: [], type: "bug", size: "small", priority: 2 }); }
      catch (e) { if (e.message.includes("fails its lint")) process.exit(0); throw e; }
      throw Error("invalid taxonomy allowed a filing");
    `,
      ],
      {
        env: { ...process.env, LINEAR_API_KEY: "test-key" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expectSpawnExit(
      { exitCode: r.status, stdout: r.stdout, stderr: r.stderr },
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

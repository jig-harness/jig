import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import {
  dropRepeatedLabelNeeds,
  NEEDS_REPOSITORY_LABEL,
  otherRepoLabel,
  repoScopeOf,
  type RepoScope,
  type UnlabeledMode,
  unlabeledModeOf,
} from "../lib/sources/served-repo.ts";
import type { Unplaced } from "../lib/types.ts";
import { freshServedPickup, readServedPickups } from "../lib/sources/served.ts";
import { issue } from "./served-fixtures.ts";

const scope: RepoScope = { own: "api", others: ["web", "site"] };
const people = [
  {
    name: "Alex",
    forge: ["alex"],
    tracker: { github: "alex", linear: "alex" },
  },
];

function fake(
  roots: PoolIssue[],
  children: Record<string, PoolIssue[]> = {},
  adapter = "github",
) {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const all = [...roots, ...Object.values(children).flat()];
  const tracker = {
    adapter,
    team: "example/repo",
    assignedIssues: async (_: string, s: string[]) =>
      s.includes("in_progress") ? [] : roots,
    assignedBy: async () => ({ id: "w", name: "writer", trusted: true }),
    openChildren: async (k: string) => children[k] ?? [],
    user: async (identity: string) => ({ id: identity, name: identity }),
    listRelations: async () => [],
    poolIssue: async (k: string) => all.find((i) => i.identifier === k) ?? null,
    getIssue: async (k: string) => ({
      identifier: k,
      description: "",
      parent: null,
    }),
  } as unknown as Tracker;
  return { tracker, cache };
}

const read = (
  f: ReturnType<typeof fake>,
  repoScope?: RepoScope,
  unlabeled?: UnlabeledMode,
) =>
  readServedPickups(f.tracker, people, {
    cache: f.cache,
    epic: "epic",
    nowMs: 1,
    headroom: true,
    ...(repoScope === undefined ? {} : { repoScope }),
    ...(unlabeled === undefined ? {} : { unlabeled }),
  });

describe("served pickups across repositories", () => {
  it("leaves an item that carries another repository's label to that checkout", async () => {
    const f = fake([issue("#1", ["web"]), issue("#2", ["api"])]);
    const reading = await read(f, scope);
    expect(reading.wanted.map((i) => i.key)).toEqual(["#2"]);
    // It is not this repository's, so it is not reported as held here either.
    expect(reading.unplaced).toEqual([]);
  });

  it("starts an unlabelled item and one labelled for this repository among others", async () => {
    const f = fake([
      issue("#1"),
      issue("#2", ["web", "api"]),
      issue("#3", ["bug"]),
    ]);
    const reading = await read(f, scope);
    expect(reading.wanted.map((i) => i.key).sort()).toEqual(["#1", "#2", "#3"]);
  });

  it("reads a repository label by its name, whatever its case or its group's prefix", async () => {
    const f = fake([issue("#1", ["Repo:Web"])]);
    expect((await read(f, scope)).wanted).toEqual([]);
  });

  it("without a scope reads every assignment as before", async () => {
    const f = fake([issue("#1", ["web"])]);
    expect((await read(f)).wanted.map((i) => i.key)).toEqual(["#1"]);
  });

  it("walks an epic of another repository and filters its children one by one", async () => {
    const f = fake([issue("#1", ["epic", "web"])], {
      "#1": [issue("#2", ["web"], null), issue("#3", ["api"], null)],
    });
    const reading = await read(f, scope);
    expect(reading.wanted.map((i) => i.key)).toEqual(["#3"]);
  });

  it("does not start a foreign epic whose children have all closed", async () => {
    const f = fake([issue("#1", ["epic", "web"])]);
    expect((await read(f, scope)).wanted).toEqual([]);
  });

  it("starts nothing and says why when the supplied scope is invalid", async () => {
    const f = fake([issue("#1", ["web"]), issue("#2", ["api"])]);
    const invalid = repoScopeOf({
      review: { repo_label: "api", taxonomy: { repos: "web" } },
    });
    const reading = await read(f, invalid);
    expect(reading.wanted).toEqual([]);
    expect(reading.unplaced[0]?.reason).toContain("scope is invalid");
    const fresh = await freshServedPickup(f.tracker, "#2", "alex", undefined, {
      ...(invalid === undefined ? {} : { repoScope: invalid }),
    });
    expect(fresh).toContain("scope is invalid");
  });

  it("keeps reading claimed items while an invalid scope refuses new pickups", async () => {
    const f = fake([issue("#1", ["web"])]);
    const claimed = issue("#9", ["api"]);
    const tracker = {
      ...f.tracker,
      assignedIssues: async (_: string, s: string[]) =>
        s.includes("in_progress") ? [claimed] : [],
    } as unknown as Tracker;
    const reading = await readServedPickups(tracker, people, {
      cache: f.cache,
      epic: "epic",
      nowMs: 1,
      headroom: true,
      repoScope: { own: "", others: [], invalid: "empty taxonomy list" },
    });
    expect(reading.wanted).toEqual([]);
    expect(reading.claimed.map((c) => c.key)).toEqual(["#9"]);
    expect(reading.unplaced[0]?.reason).toContain("scope is invalid");
  });

  it("refuses at launch an item whose label moved to another repository", async () => {
    const f = fake([issue("#1", ["web"])]);
    const fresh = await freshServedPickup(f.tracker, "#1", "alex", undefined, {
      repoScope: scope,
    });
    expect(fresh).toBe(
      "it carries the repository label web, which is another repository's",
    );
    const own = await freshServedPickup(f.tracker, "#1", "alex");
    expect(typeof own).toBe("object");
  });
});

describe("repoScopeOf", () => {
  const values = (review: unknown) => ({ review }) as Record<string, unknown>;

  it("takes this repository's label and every other the taxonomy lists", () => {
    expect(
      repoScopeOf(
        values({
          repo_label: "api",
          taxonomy: { repos: ["web", "api", "jig"] },
        }),
      ),
    ).toEqual({ own: "api", others: ["web", "jig"] });
  });

  it("is none without a repository label or without another repository", () => {
    expect(repoScopeOf(values({ taxonomy: { repos: ["a", "b"] } }))).toBe(
      undefined,
    );
    expect(repoScopeOf(values({ repo_label: "a" }))).toBe(undefined);
    expect(
      repoScopeOf(values({ repo_label: "a", taxonomy: { repos: ["a"] } })),
    ).toBe(undefined);
    expect(repoScopeOf({})).toBe(undefined);
  });

  it("refuses a supplied scope it cannot validate rather than widening it", () => {
    const bad = (review: unknown) => repoScopeOf(values(review))?.invalid;
    expect(bad({ repo_label: "api", taxonomy: { repos: "web" } })).toBeString();
    expect(
      bad({ repo_label: "api", taxonomy: { repos: ["api", 123] } }),
    ).toBeString();
    expect(bad({ repo_label: 7 })).toBeString();
    expect(bad({ repo_label: "api", taxonomy: { repos: [] } })).toBeString();
    expect(bad({ repo_label: "api", taxonomy: "web" })).toBeString();
    expect(bad("api")).toBeString();
    expect(
      bad({ repo_label: "api", taxonomy: { repos: ["web"] } }),
    ).toBeUndefined();
  });

  it("names the other label an item carries", () => {
    expect(otherRepoLabel(["x", "web"], scope)).toBe("web");
    expect(otherRepoLabel(["x"], scope)).toBeNull();
    expect(otherRepoLabel(["web"], undefined)).toBeNull();
  });
});

describe("served items no repository label places", () => {
  const web: RepoScope = { own: "web", others: ["api"] };
  const api: RepoScope = { own: "api", others: ["web"] };
  const defaults = { "linear:eng": "/srv/api" };
  const mode = (scope: RepoScope, repoPath: string, team = "ENG") =>
    unlabeledModeOf({
      scope,
      adapter: "linear",
      team,
      defaults,
      repoPath,
    });

  /** One tick of both repositories sharing a team: each reads the same assignments. */
  async function tick(labels: string[], modes: [UnlabeledMode, UnlabeledMode]) {
    const mine = await read(
      fake([issue("ENG-1", labels)], {}, "linear"),
      web,
      modes[0],
    );
    const theirs = await read(
      fake([issue("ENG-1", labels)], {}, "linear"),
      api,
      modes[1],
    );
    return { web: mine, api: theirs };
  }

  it("is started by the team's default repository alone", async () => {
    const modes: [UnlabeledMode, UnlabeledMode] = [
      mode(web, "/srv/web"),
      mode(api, "/srv/api"),
    ];
    expect(modes).toEqual(["leave", "start"]);
    const both = await tick([], modes);
    expect(both.web.wanted).toEqual([]);
    expect(both.web.unplaced).toEqual([]);
    expect(both.api.wanted.map((i) => i.key)).toEqual(["ENG-1"]);
  });

  it("is reported once as needing a repository label, and started by none, without a default", async () => {
    const modes: [UnlabeledMode, UnlabeledMode] = [
      mode(web, "/srv/web", "OPS"),
      mode(api, "/srv/api", "OPS"),
    ];
    expect(modes).toEqual(["hold", "hold"]);
    const both = await tick([], modes);
    expect(both.web.wanted).toEqual([]);
    expect(both.api.wanted).toEqual([]);
    const reports = [both.web, both.api];
    dropRepeatedLabelNeeds(reports);
    const needs = reports.flatMap((r) => r.unplaced);
    expect(needs).toEqual([
      {
        target: "ENG-1",
        record: "tracker",
        reason: NEEDS_REPOSITORY_LABEL,
        cause: "needs-repository-label",
      },
    ]);
  });

  it("still sends a labelled item only to the repository its label names", async () => {
    for (const modes of [
      ["leave", "start"],
      ["hold", "hold"],
    ] as [UnlabeledMode, UnlabeledMode][]) {
      const both = await tick(["web"], modes);
      expect(both.web.wanted.map((i) => i.key)).toEqual(["ENG-1"]);
      expect(both.api.wanted).toEqual([]);
      expect(both.web.unplaced).toEqual([]);
      expect(both.api.unplaced).toEqual([]);
    }
  });

  it("refuses at launch an unlabelled item this repository is not the default for", async () => {
    const f = fake([issue("ENG-1")], {}, "linear");
    const refused = await freshServedPickup(
      f.tracker,
      "ENG-1",
      "alex",
      undefined,
      {
        repoScope: web,
        unlabeled: "leave",
      },
    );
    expect(refused).toContain("not its team's default");
    const held = await freshServedPickup(
      f.tracker,
      "ENG-1",
      "alex",
      undefined,
      {
        repoScope: web,
        unlabeled: "hold",
      },
    );
    expect(typeof held).toBe("string");
    const started = await freshServedPickup(
      f.tracker,
      "ENG-1",
      "alex",
      undefined,
      {
        repoScope: api,
        unlabeled: "start",
      },
    );
    expect(typeof started).toBe("object");
  });

  it("applies the mode to an epic's children one by one, and to a repo:-prefixed label", async () => {
    const f = fake(
      [issue("ENG-1", ["epic"])],
      {
        "ENG-1": [issue("ENG-2", [], null), issue("ENG-3", ["repo:Web"], null)],
      },
      "linear",
    );
    const left = await read(f, web, "leave");
    expect(left.wanted.map((i) => i.key)).toEqual(["ENG-3"]);
    const g = fake(
      [issue("ENG-1", ["epic"])],
      { "ENG-1": [issue("ENG-2", [], null)] },
      "linear",
    );
    const held = await read(g, web, "hold");
    expect(held.wanted).toEqual([]);
    expect(held.unplaced.map((u) => u.target)).toEqual(["ENG-2"]);
  });

  it("leaves a GitHub repository's own issues and an unscoped checkout alone", () => {
    expect(
      unlabeledModeOf({
        scope: web,
        adapter: "github",
        team: "o/r",
        defaults: {},
        repoPath: "/srv/web",
      }),
    ).toBe("start");
    expect(
      unlabeledModeOf({
        scope: undefined,
        adapter: "linear",
        team: "ENG",
        defaults: {},
        repoPath: "/srv/web",
      }),
    ).toBe("start");
    expect(
      unlabeledModeOf({
        scope: { own: "", others: [], invalid: "x" },
        adapter: "linear",
        team: "ENG",
        defaults: {},
        repoPath: "/srv/web",
      }),
    ).toBe("start");
  });

  it("separates defaults for tracker namespaces with the same team", () => {
    expect(
      unlabeledModeOf({
        scope: web,
        adapter: "linear",
        team: "ENG",
        defaults: {
          "linear:eng": "/srv/web",
          "jira:https://one.atlassian.net:eng": "/srv/api",
        },
        repoPath: "/srv/web",
      }),
    ).toBe("start");
    expect(
      unlabeledModeOf({
        scope: api,
        adapter: "jira",
        team: "ENG",
        site: "https://one.atlassian.net",
        defaults: {
          "linear:eng": "/srv/web",
          "jira:https://one.atlassian.net:eng": "/srv/api",
        },
        repoPath: "/srv/api",
      }),
    ).toBe("start");
  });

  it("keeps each item's first report only across repositories, and others untouched", () => {
    const need = (target: string): Unplaced => ({
      target,
      record: "tracker",
      reason: NEEDS_REPOSITORY_LABEL,
      cause: "needs-repository-label",
    });
    const other: Unplaced = {
      target: "ENG-1",
      record: "tracker",
      reason: "needs a person to start",
    };
    const reports = [
      { unplaced: [need("ENG-1"), need("ENG-2")] },
      { unplaced: [need("ENG-1"), other] },
    ];
    dropRepeatedLabelNeeds(reports);
    expect(reports[0]?.unplaced.map((u) => u.target)).toEqual([
      "ENG-1",
      "ENG-2",
    ]);
    expect(reports[1]?.unplaced).toEqual([other]);
  });
});

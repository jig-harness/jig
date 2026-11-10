import { describe, expect, it } from "bun:test";
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import {
  otherRepoLabel,
  repoScopeOf,
  type RepoScope,
} from "../lib/sources/served-repo.ts";
import { freshServedPickup, readServedPickups } from "../lib/sources/served.ts";

const scope: RepoScope = { own: "api", others: ["web", "site"] };
const people = [{ name: "Alex", forge: ["alex"], tracker: { github: "alex" } }];

const issue = (
  key: string,
  labels: string[] = [],
  assignee: string | null = "alex",
): PoolIssue => ({
  identifier: key,
  title: key,
  url: null,
  priority: 2,
  type: "task",
  size: "small",
  createdAt: "2026-01-01",
  updatedAt: "v1",
  state: { id: "s", name: "Todo", type: "unstarted" },
  assignee: assignee ? { id: assignee, name: assignee } : null,
  labels,
  hasOpenChildren: labels.includes("epic"),
  truncated: [],
});

function fake(roots: PoolIssue[], children: Record<string, PoolIssue[]> = {}) {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const all = [...roots, ...Object.values(children).flat()];
  const tracker = {
    adapter: "github",
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

const read = (f: ReturnType<typeof fake>, repoScope?: RepoScope) =>
  readServedPickups(f.tracker, people, {
    cache: f.cache,
    epic: "epic",
    nowMs: 1,
    headroom: true,
    ...(repoScope === undefined ? {} : { repoScope }),
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

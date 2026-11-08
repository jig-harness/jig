import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import {
  candidateFor,
  DETECTION_TTL_MS,
  detection,
  detectionCacheDir,
  type Evidence,
  fileDetectionCache,
  select,
} from "../scripts/lib/tracker/facets/detect.ts";
import type { Facet } from "../scripts/lib/tracker/port.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import {
  type Call,
  conn,
  gitHubDefaulted,
  issueNode,
  JIG_TAXONOMY,
  oneIssue,
  READ_FAILURES,
  repoLabels,
} from "./github-fixtures.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "jig-facet-cache-"));
  dirs.push(d);
  return d;
};

const ISSUE_TYPES = ["Task", "Bug", "Feature", "Chore", "Docs", "Infra"];
const option = (field: string, name: string) => ({
  id: `${field}_${name}`,
  name,
});
const field = (id: string, name: string, options: string[]) => ({
  __typename: "IssueFieldSingleSelect",
  id,
  name,
  dataType: "SINGLE_SELECT",
  options: options.map((n) => option(id, n)),
});
const PRIORITY = ["Urgent", "High", "Medium", "Low"];

/** A field value node as `issueFieldValues` reads it. */
const selected = (name: string, value: string) => ({
  __typename: "IssueFieldSingleSelectValue",
  id: `IFV_${name}`,
  name: value,
  field: { name },
});

interface Repository {
  /** The facets whose labels some issue carries. */
  labels?: Facet[];
  /** The facets with a value in the tracker's own field on some issue. */
  native?: Facet[];
  /** The Priority field's options; Jig's organization's by default. */
  priority?: string[];
  /** The answers to every other request. */
  other?: (c: Call) => unknown;
}

/** A repository of Jig's organization, as detection and the stores read it. */
function repository(r: Repository = {}) {
  const fields = conn([
    field("IF_priority", "Priority", r.priority ?? PRIORITY),
    field("IF_effort", "Effort", JIG_TAXONOMY.sizes),
  ]);
  const types = conn(ISSUE_TYPES.map((name) => ({ id: `IT_${name}`, name })));
  const count = (yes: boolean) => ({ totalCount: yes ? 3 : 0 });
  return (c: Call): unknown => {
    if (c.op === "TrackerFacetEvidence")
      return {
        repository: {
          issueTypes: types,
          issueFields: fields,
          l_type: count(r.labels?.includes("type") === true),
          l_priority: count(r.labels?.includes("priority") === true),
          l_size: count(r.labels?.includes("size") === true),
        },
      };
    if (c.op === "TrackerFacetNativeEvidence") {
      const out: Record<string, unknown> = {};
      for (const m of c.query.matchAll(/n_(\w+?)_(\d+):/g))
        out[`n_${m[1]}_${m[2]}`] = count(
          m[2] === "0" && r.native?.includes(m[1] as Facet) === true,
        );
      return { repository: out };
    }
    if (c.op === "TrackerFacetStores")
      return { repository: { issueTypes: types, issueFields: fields } };
    if (c.op === "TrackerFacetOwner")
      return {
        repository: { owner: { __typename: "Organization", login: "acme" } },
      };
    if (c.op === "TrackerFacetDiscovery")
      return {
        organization: {
          issueTypes: conn(ISSUE_TYPES.map((name) => ({ name }))),
          issueFields: fields,
        },
      };
    if (r.other !== undefined) return r.other(c);
    throw new Error(`unexpected ${c.op}`);
  };
}

const DETECTION = ["TrackerFacetEvidence", "TrackerFacetNativeEvidence"];

/** Issue #9 as GitHub answers it: `labels`, its issue type, and its field values. */
const issue9 = (labels: string[]) =>
  oneIssue(
    issueNode({
      number: 9,
      labels,
      issueType: "Docs",
      extra: {
        subIssues: conn([]),
        issueFieldValues: conn([
          selected("Priority", "High"),
          selected("Effort", "xl"),
        ]),
      },
    }),
  );

const JIG = { taxonomy: JIG_TAXONOMY };

describe("GitHub's field default: a facet the configuration does not name", () => {
  it("is kept in the issue type and the organization's fields where no issue carries its labels", async () => {
    const { t, calls } = gitHubDefaulted(
      repository({
        other: (c) => {
          if (c.op === "TrackerIssue") return issue9(["area:x"]);
          if (c.op === "TrackerRepository")
            return { repository: { id: "R_1" } };
          if (c.op === "TrackerCreate")
            return {
              createIssue: {
                issue: { number: 40, url: "https://example.test/40" },
              },
            };
          throw new Error(`unexpected ${c.op}`);
        },
      }),
      JIG,
    );
    const issue = await t.getIssue("#9");
    expect(calls.map((c) => c.op)).toEqual([...DETECTION, "TrackerIssue"]);
    expect(calls[2]?.query).toContain("issueType { name }");
    expect(calls[2]?.query).toContain("issueFieldValues(first: 25)");
    expect([issue?.type, issue?.priority, issue?.size]).toEqual([
      "docs",
      2,
      "xl",
    ]);
    await t.createIssue({
      title: "New",
      description: "",
      labels: [],
      type: "bug",
      priority: 1,
      size: "small",
    });
    expect(calls.at(-1)?.variables.input).toMatchObject({
      issueTypeId: "IT_Bug",
      issueFields: [
        { fieldId: "IF_effort", singleSelectOptionId: "IF_effort_small" },
        { fieldId: "IF_priority", singleSelectOptionId: "IF_priority_Urgent" },
      ],
    });
    expect(calls.filter((c) => DETECTION.includes(c.op))).toHaveLength(2);
    const stores = await t.facetStores({ discovery: false });
    expect(
      stores.facets.map((f) => [f.facet, f.store, f.why, f.field ?? null]),
    ).toEqual([
      ["type", "native", "detected", null],
      ["priority", "native", "detected", "Priority"],
      ["size", "field", "detected", "Effort"],
    ]);
    expect(stores.facets[2]?.pin).toBe(
      "issue_tracker.facets.size: { store: field, field: Effort }",
    );
  });

  it("stays in labels where its issues carry them or a key of today names them, reporting where it could move", async () => {
    const { t, calls } = gitHubDefaulted(
      repository({
        labels: ["priority", "size"],
        other: () => issue9(["small", "priority: low", "docs"]),
      }),
      { ...JIG, issue_tracker: { types: { task: ["docs"], bug: ["bug"] } } },
    );
    const issue = await t.getIssue("#9");
    expect(calls.at(-1)?.query).not.toContain("issueFieldValues");
    expect([issue?.type, issue?.priority, issue?.size]).toEqual([
      "docs",
      4,
      "small",
    ]);
    const stores = await t.facetStores();
    expect(
      stores.facets.map((f) => [f.facet, f.store, f.why, f.moveTo]),
    ).toEqual([
      ["type", "label", "kept in labels", { store: "native" }],
      [
        "priority",
        "label",
        "kept in labels",
        { store: "native", field: "Priority" },
      ],
      ["size", "label", "kept in labels", { store: "field", field: "Effort" }],
    ]);
  });

  it("fails closed where its issues carry both its labels and native values, until the configuration names a store", async () => {
    const both = repository({
      labels: ["type", "priority", "size"],
      native: ["type", "priority", "size"],
      other: (c) => {
        if (c.op === "TrackerLabels") return repoLabels("area:x");
        return issue9(["docs", "small", "priority: low"]);
      },
    });
    const { t, calls } = gitHubDefaulted(both, JIG);
    await t.listLabels();
    expect(calls.map((c) => c.op)).toEqual(["TrackerLabels"]);
    const conflict =
      "type is in conflict: issues carry type labels and values in the tracker's own field too, and issue_tracker.facets.type names no store; name one: issue_tracker.facets.type: { store: label }, or { store: native }";
    await expect(t.getIssue("#9")).rejects.toThrow(conflict);
    await expect(t.getIssue("#9")).rejects.toBeInstanceOf(TrackerConfigError);
    await expect(t.openIssues({ withSomeOf: [["area:x"]] })).rejects.toThrow(
      conflict,
    );
    await expect(
      t.createIssue({ title: "x", description: "", labels: [], type: "bug" }),
    ).rejects.toThrow(conflict);
    expect(calls.map((c) => c.op)).not.toContain("TrackerIssue");
    const stores = await t.facetStores({ discovery: false });
    expect(stores.facets.map((f) => [f.facet, f.store, f.why])).toEqual([
      ["type", null, "conflict"],
      ["priority", null, "conflict"],
      ["size", null, "conflict"],
    ]);
    expect(stores.facets[1]?.problem).toContain(
      "issue_tracker.facets.priority: { store: label }, or { store: native }",
    );
    expect(stores.facets[2]?.problem).toContain(
      "{ store: field, field: Effort }",
    );

    // Jig's own case: the stores named, it reads its labels as it always
    // did, with no detection read first.
    const named = gitHubDefaulted(both, {
      ...JIG,
      issue_tracker: {
        facets: {
          type: { store: "label" },
          priority: { store: "label" },
          size: { store: "label" },
        },
      },
    });
    const read = await named.t.getIssue("#9");
    expect(named.calls.map((c) => c.op)).toEqual(["TrackerIssue"]);
    expect([read?.type, read?.priority, read?.size]).toEqual([
      "docs",
      4,
      "small",
    ]);
    const report = await named.t.facetStores();
    expect(report.facets.map((f) => [f.store, f.why, f.moveTo])).toEqual([
      ["label", "configured", { store: "native" }],
      ["label", "configured", { store: "native", field: "Priority" }],
      ["label", "configured", { store: "field", field: "Effort" }],
    ]);
    expect(named.calls.map((c) => c.op)).not.toContain("TrackerFacetEvidence");
  });

  it("refuses a Priority field whose options no longer name the priorities, never falling back to labels", async () => {
    const { t } = gitHubDefaulted(
      repository({
        priority: ["P0", "P1", "P2", "P3"],
        other: () => issue9([]),
      }),
      JIG,
    );
    await expect(t.getIssue("#9")).rejects.toThrow(
      "the Priority field's options (P0, P1, P2, P3) are not the priorities (urgent, high, medium, low)",
    );
  });

  it("asks again after a failed detection read, and reads it as no store", async () => {
    let failures = 1;
    const ok = repository({ other: () => issue9([]) });
    const { t, calls } = gitHubDefaulted(
      (c) =>
        c.op === "TrackerFacetEvidence" && failures-- > 0
          ? READ_FAILURES.timeout
          : ok(c),
      JIG,
    );
    await expect(t.getIssue("#9")).rejects.toThrow(
      "detection read of acme/app with gh with GH_TOKEN: unavailable",
    );
    expect(calls.map((c) => c.op)).toEqual(["TrackerFacetEvidence"]);
    expect((await t.getIssue("#9"))?.type).toBe("docs");
  });

  it("answers from the machine's cache for an hour, and reads again once a write is refused", async () => {
    let now = 1_000_000;
    const cache = fileDetectionCache(scratch(), () => now);
    const answer = repository({
      other: (c) => {
        if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
        return issue9([]);
      },
    });
    const first = gitHubDefaulted(answer, JIG, cache);
    await first.t.getIssue("#9");
    expect(first.calls.map((c) => c.op)).toEqual([
      ...DETECTION,
      "TrackerIssue",
    ]);

    const second = gitHubDefaulted(answer, JIG, cache);
    await second.t.getIssue("#9");
    expect(second.calls.map((c) => c.op)).toEqual(["TrackerIssue"]);
    const stores = await second.t.facetStores({ discovery: false });
    expect(stores.facets[0]?.detection).toMatchObject({ cached: true });

    now += DETECTION_TTL_MS + 1;
    const third = gitHubDefaulted(answer, JIG, cache);
    await third.t.getIssue("#9");
    expect(third.calls.map((c) => c.op)).toEqual([
      ...DETECTION,
      "TrackerIssue",
    ]);

    // An issue type the organization no longer has: the write is refused,
    // and the answer that named the store is dropped.
    const gone = gitHubDefaulted(
      (c) =>
        c.op === "TrackerFacetStores"
          ? { repository: { issueTypes: conn([]), issueFields: conn([]) } }
          : answer(c),
      JIG,
      cache,
    );
    await expect(
      gone.t.createIssue({
        title: "x",
        description: "",
        labels: [],
        type: "bug",
      }),
    ).rejects.toBeInstanceOf(TrackerRequestError);
    const fourth = gitHubDefaulted(answer, JIG, cache);
    await fourth.t.getIssue("#9");
    expect(fourth.calls.map((c) => c.op)).toEqual([
      ...DETECTION,
      "TrackerIssue",
    ]);
  });
});

describe("detection's rules", () => {
  const read = (
    labelEvidence: boolean,
    nativeEvidence: boolean,
    candidate: Evidence["candidate"],
    candidateProblem?: string,
  ) =>
    detection({
      labelEvidence,
      nativeEvidence,
      candidate,
      ...(candidateProblem === undefined ? {} : { candidateProblem }),
    });

  it("selects a store from the evidence, and never guesses between two", () => {
    const native = { store: "native" as const };
    expect(select("type", read(true, false, native))).toEqual({
      kind: "store",
      store: "label",
      why: "kept in labels",
    });
    expect(select("type", read(false, false, null))).toEqual({
      kind: "store",
      store: "label",
      why: "default",
    });
    expect(select("type", read(false, true, native))).toEqual({
      kind: "store",
      store: "native",
      why: "detected",
    });
    expect(select("type", read(true, true, native)).kind).toBe("conflict");
  });

  it("keeps size in labels when the Effort field's options are not the sizes", () => {
    const offered = {
      types: [],
      fields: [
        {
          name: "Effort",
          dataType: "SINGLE_SELECT",
          options: ["High", "Medium", "Low"],
        },
      ],
    };
    const { candidate, problem } = candidateFor(
      "size",
      JIG_TAXONOMY.sizes,
      offered,
    );
    expect(candidate).toBeNull();
    expect(select("size", read(false, false, candidate, problem))).toEqual({
      kind: "store",
      store: "label",
      why: "default",
    });
  });
});

describe("detection's cache", () => {
  it("keeps a salted fingerprint of the credential, never the token, and no failed read", () => {
    const dir = scratch();
    const cache = fileDetectionCache(dir);
    const print = cache.fingerprint("secret-token");
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.fingerprint("secret-token")).toBe(print);
    expect(fileDetectionCache(scratch()).fingerprint("secret-token")).not.toBe(
      print,
    );
    cache.set("k1", {
      type: { status: "failed", error: "timed out", unavailable: true },
    });
    expect(cache.get("k1")).toBeNull();
    cache.set("k2", { type: read() });
    expect(cache.get("k2")).toEqual({ type: read() });
    for (const name of readdirSync(dir))
      expect(readFileSync(join(dir, name), "utf8")).not.toContain(
        "secret-token",
      );
  });

  it("is off when asked, and under a test run unless a folder is named", () => {
    expect(detectionCacheDir({ JIG_FACET_CACHE: "off", HOME: "/h" })).toBe(
      null,
    );
    expect(detectionCacheDir({ NODE_ENV: "test", HOME: "/h" })).toBe(null);
    expect(
      detectionCacheDir({ NODE_ENV: "test", JIG_FACET_CACHE_DIR: "/c" }),
    ).toBe("/c");
    expect(detectionCacheDir({ HOME: "/h" })).toBe(
      "/h/.local/state/jig/facet-detection",
    );
  });

  function read() {
    return detection({
      labelEvidence: true,
      nativeEvidence: false,
      candidate: null,
    });
  }
});

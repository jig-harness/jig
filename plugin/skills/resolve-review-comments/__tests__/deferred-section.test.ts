/**
 * Deferral without a tracker: a finding recorded in the pull request's
 * `## Deferred` section by read-modify-write against the body's `updated_at`,
 * so a person's edit survives, and `file-deferred.ts` filing each entry
 * through a tracker adapter (the GitHub adapter over a fake transport) with
 * the type, priority and size it records, and replacing it with its issue.
 */
import { persistedTracker } from "./persisted-tracker.ts";
import { describe, expect, test } from "bun:test";
import {
  conn,
  gitHub,
  issueNode,
  JIG_TAXONOMY,
  oneIssue,
  repoLabels,
} from "../../do-item/__tests__/github-fixtures.ts";
import {
  facetInputs,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import { resolveFacets } from "../../do-item/scripts/lib/tracker/facets/config.ts";
import type { NewIssue } from "../../do-item/scripts/lib/tracker/port.ts";
import { deferInPr } from "../scripts/defer-in-pr.ts";
import {
  entryFacets,
  fileDeferred,
  identityLine,
  textLine,
} from "../scripts/file-deferred.ts";
import {
  deferredEntries,
  SECTION_END,
  SECTION_START,
  withDeferredEntry,
  withFiledEntry,
} from "../scripts/lib/deferred-section.ts";
import type { PrBody } from "../scripts/lib/pr-body.ts";
import { fakeForge, PR_URL } from "./deferred-forge.ts";

const THREAD = `${PR_URL}#discussion_r1001`;
const FINDING =
  "The retry budget is read without validation.\n\nIt can go negative.";
/** What an entry records to be filed as. */
const REC = { type: "bug", severity: "high", category: "correctness" };
/** Every type and size label of Jig's taxonomy. */
const TYPES_SIZES = [...JIG_TAXONOMY.types, ...JIG_TAXONOMY.sizes];
const PRIORITY_LABELS = ["urgent", "high", "medium", "low"].map(
  (p) => `priority: ${p}`,
);
/** The facets of a GitHub repository with Jig's taxonomy, kept in labels. */
const FACETS = resolveFacets(
  facetInputs(parseTrackerConfig({ issue_tracker: { adapter: "github" } })),
  { path: "label-taxonomy.yaml", ...JIG_TAXONOMY },
);

describe("the deferred section", () => {
  test("is created at the end of the body and read back", () => {
    const { body, added } = withDeferredEntry("## Summary\n\nWhat changed.", {
      source: THREAD,
      finding: FINDING,
      reason: "it needs the configuration rework first",
    });
    expect(added).toBe(true);
    expect(body).toStartWith("## Summary\n\nWhat changed.\n\n## Deferred");
    expect(body).toContain(SECTION_START);
    expect(body).toContain(SECTION_END);
    expect(body).toContain("> The retry budget is read without validation.");
    const [entry] = deferredEntries(body);
    expect(entry?.source).toBe(THREAD);
    expect(entry?.filed).toBeUndefined();
    expect(entry?.text).toContain("it needs the configuration rework first");
  });

  test("does not add the same finding twice", () => {
    const once = withDeferredEntry("", {
      source: THREAD,
      finding: FINDING,
      reason: "later",
    }).body;
    expect(
      withDeferredEntry(once, {
        source: THREAD,
        finding: FINDING,
        reason: "later",
      }).added,
    ).toBe(false);
  });

  test("retries the same CRLF finding without a conflict", () => {
    const finding = "first\r\nsecond";
    const once = withDeferredEntry("", {
      source: THREAD,
      finding,
      reason: "later",
    }).body;
    expect(
      withDeferredEntry(once, { source: THREAD, finding, reason: "later" })
        .added,
    ).toBe(false);
  });

  test("refuses an existing finding with changed text or recorded facets", () => {
    const once = withDeferredEntry("", {
      ...REC,
      source: THREAD,
      finding: FINDING,
      reason: "later",
    }).body;
    expect(() =>
      withDeferredEntry(once, {
        ...REC,
        source: THREAD,
        finding: "corrected finding",
        reason: "later",
      }),
    ).toThrow("differs from this finding");
    expect(() =>
      withDeferredEntry(once, {
        ...REC,
        category: "security",
        source: THREAD,
        finding: FINDING,
        reason: "later",
      }),
    ).toThrow("differs from this finding");
  });

  test("keys a summary finding on its comment and fingerprint", () => {
    const comment = `${PR_URL}#issuecomment-77`;
    let body = withDeferredEntry("", {
      source: comment,
      fingerprint: "fp-a",
      finding: "first",
      reason: "later",
    }).body;
    body = withDeferredEntry(body, {
      source: comment,
      fingerprint: "fp-b",
      finding: "second",
      reason: "later",
    }).body;
    expect(deferredEntries(body).map((e) => e.fingerprint)).toEqual([
      "fp-a",
      "fp-b",
    ]);
  });

  test("a finding or reason carrying the section's own markers closes nothing", () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: `Quoted:\n${SECTION_END}\n<!-- /deferred-entry -->\n<!-- deferred-entry: ${other} -->`,
      reason: `see ${SECTION_END}`,
    }).body;
    body = withDeferredEntry(body, {
      source: other,
      finding: "second",
      reason: "later",
    }).body;
    expect(deferredEntries(body).map((e) => e.source)).toEqual([THREAD, other]);
    const filed = withFiledEntry(
      body,
      { source: THREAD },
      { key: "#7", url: null },
    );
    expect(deferredEntries(filed).map((e) => e.source)).toEqual([
      THREAD,
      other,
    ]);
  });

  test("an entry that loses its closing marker is refused, not merged into the next", () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: "first",
      reason: "later",
    }).body;
    body = withDeferredEntry(body, {
      source: other,
      finding: "second",
      reason: "later",
    }).body;
    const broken = body.replace("<!-- /deferred-entry -->", "");
    expect(() => deferredEntries(broken)).toThrow(/opens another/);
    expect(() =>
      withFiledEntry(broken, { source: THREAD }, { key: "#7", url: null }),
    ).toThrow(/opens another/);
    const last =
      body.slice(0, body.lastIndexOf("<!-- /deferred-entry -->")) +
      body.slice(body.lastIndexOf("<!-- /deferred-entry -->") + 24);
    expect(() => deferredEntries(last)).toThrow(/never ends/);
  });
});

describe("written by read-modify-write against updated_at", () => {
  test("a person's edit within the same second, updated_at unchanged, survives", async () => {
    const forge = fakeForge("## Summary\n\nWhat changed.");
    forge.beforeRead.push(
      (s) => void s,
      (s) => {
        s.body = "## Summary\n\nEdited within the same second.";
      },
    );
    const r = await deferInPr(forge, {
      pr: "42",
      source: THREAD,
      recorded: REC,
      reason: "later",
      finding: FINDING,
    });
    expect(r.added).toBe(true);
    expect(forge.state.body).toContain("Edited within the same second.");
    expect(deferredEntries(forge.state.body)).toHaveLength(1);
  });

  test("a person's edit between the reads survives, and the entry lands", async () => {
    const forge = fakeForge("## Summary\n\nWhat changed.");
    // The second read (just before the write) finds a person's edit.
    forge.beforeRead.push(
      (s) => void s,
      (s) => {
        s.body = "## Summary\n\nWhat changed, and why, edited by a person.";
        s.updatedAt = "2026-10-29T00:00:30Z";
      },
    );
    const r = await deferInPr(forge, {
      pr: "42",
      source: THREAD,
      recorded: REC,
      reason: "it needs the configuration rework first",
      finding: FINDING,
    });
    expect(r.added).toBe(true);
    expect(r.link).toBe(`${PR_URL}#deferred`);
    expect(forge.writes).toBe(1);
    expect(forge.state.body).toContain("edited by a person");
    expect(deferredEntries(forge.state.body)).toHaveLength(1);
  });

  test("a re-run after the entry landed writes nothing", async () => {
    const forge = fakeForge("");
    const args = {
      pr: "42",
      source: THREAD,
      recorded: REC,
      reason: "later",
      finding: FINDING,
    };
    await deferInPr(forge, args);
    const again = await deferInPr(forge, args);
    expect(again.added).toBe(false);
    expect(forge.writes).toBe(1);
  });
});

describe("file-deferred.ts files each entry through the tracker", () => {
  function trackerThatFiles(
    existing: Array<{ number: number; body: string }> = [],
  ) {
    let next = 40;
    const issues = existing.map((issue) => ({
      ...issue,
      labels: [] as string[],
    }));
    const labelNames = [
      "pr-followup",
      "Backlog",
      ...TYPES_SIZES,
      ...PRIORITY_LABELS,
    ];
    const labelName = (id: unknown) =>
      labelNames.find((name, index) => id === `LA_${index}_${name}`);
    const fixture = gitHub(
      (c) => {
        if (c.op === "TrackerSearch")
          return {
            search: {
              issueCount: issues.length,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: issues.map((issue) => issueNode(issue)),
            },
          };
        if (c.op === "TrackerIssue") {
          const n = Number(String(c.variables.number ?? "").replace("#", ""));
          const hit = issues.find((issue) => issue.number === n) ?? issues[0];
          return oneIssue(
            hit === undefined
              ? null
              : issueNode({
                  ...hit,
                  extra: {
                    subIssues: conn([]),
                    blockedBy: conn([]),
                    blocking: conn([]),
                    timelineItems: conn([]),
                    relatesTo: conn([]),
                    duplicateOf: null,
                  },
                }),
          );
        }
        if (c.op === "TrackerRepository") return { repository: { id: "R_1" } };
        if (c.op === "TrackerLabels") return repoLabels(...labelNames);
        if (c.op === "TrackerCreate") {
          next += 1;
          return {
            createIssue: {
              issue: {
                number: next,
                url: `https://github.com/acme/app/issues/${next}`,
              },
            },
          };
        }
        if (c.op === "TrackerUpdate") {
          const input = c.variables.input as { body?: unknown; id?: unknown };
          const issue = issues.find(
            (candidate) => `I_${candidate.number}` === input.id,
          );
          if (issue !== undefined && typeof input.body === "string")
            issue.body = input.body;
          return { updateIssue: { issue: { id: "I_7" } } };
        }
        if (c.op === "TrackerAddLabels") {
          const input = c.variables;
          const issue = issues.find(
            (candidate) => `I_${candidate.number}` === input.id,
          );
          if (issue !== undefined)
            issue.labels.push(
              ...(Array.isArray(input.labelIds)
                ? input.labelIds
                    .map(labelName)
                    .filter((name): name is string => name !== undefined)
                : []),
            );
          return { addLabelsToLabelable: { clientMutationId: null } };
        }
        if (c.op === "TrackerComments")
          return {
            repository: {
              issue: { id: `I_${c.variables.number}`, comments: conn([]) },
            },
          };
        throw new Error(`unexpected ${c.op}`);
      },
      { taxonomy: JIG_TAXONOMY },
    );
    return { ...fixture, t: persistedTracker(fixture.t) };
  }

  test("replaces each entry with its issue, leaving the rest of the body", async () => {
    let body = "## Summary\n\nWhat changed.";
    for (const n of [1, 2])
      body = withDeferredEntry(body, {
        ...REC,
        source: `${PR_URL}#discussion_r${n}`,
        finding: `Finding ${n} is real.`,
        reason: `reason ${n}`,
      }).body;
    const forge = fakeForge(body);
    const { t, calls } = trackerThatFiles();
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.filed.map((f) => f.key)).toEqual(["#41", "#41"]);
    expect(r.remaining).toEqual([]);
    const entries = deferredEntries(forge.state.body);
    expect(entries.map((e) => e.filed?.key)).toEqual(["#41", "#41"]);
    expect(forge.state.body).toStartWith("## Summary\n\nWhat changed.");
    expect(forge.state.body).toContain(
      "filed as [#41](https://github.com/acme/app/issues/41)",
    );
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(created).toHaveLength(1);
    const input = created[0]?.variables.input as {
      title: string;
      body: string;
    };
    expect(input.title).toBe("PR #42 bug review follow-ups");
    expect(input.body).toContain("Filed by `file-deferred.ts`");
    expect(input.body).toContain("reason 1");
  });

  test("a second run files nothing more", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        ...REC,
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    await fileDeferred(forge, trackerThatFiles().t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    const { t, calls } = trackerThatFiles();
    const again = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(again.filed).toEqual([]);
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
  });

  test("an issue an earlier run filed for the entry is reused, not filed twice", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        ...REC,
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    const [entry] = deferredEntries(forge.state.body);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `Filed by file-deferred.ts.\n\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.why).toBeNull();
    expect(r.filed).toEqual([
      expect.objectContaining({ key: "#7", reused: true }),
    ]);
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
    expect(deferredEntries(forge.state.body)[0]?.filed?.key).toBe("#7");
  });

  async function refileCorrectedHeldBatch(
    recordedCategory: string | undefined,
    replacement: [string, string],
  ) {
    const body = withDeferredEntry("", {
      ...REC,
      ...(recordedCategory === undefined ? {} : { category: recordedCategory }),
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    const [entry] = deferredEntries(body);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `<!-- defer-batch-key: repo=acme/app pr=42 type=bug -->\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
      },
    ]);
    forge.beforeRead.push(
      () => undefined,
      (state) => {
        state.body = state.body.replace(...replacement);
      },
    );
    return {
      forge,
      calls,
      result: await fileDeferred(forge, t, "42", {
        label: "pr-followup",
        facets: FACETS,
        reviewVocabulary: { types: ["bug"], categories: ["correctness"] },
      }),
    };
  }

  test("revalidates a corrected held batch entry before recording it", async () => {
    const { forge, calls, result } = await refileCorrectedHeldBatch(undefined, [
      "category=correctness",
      "category=unrecognized",
    ]);
    expect(result.filed).toEqual([]);
    expect(result.forPerson[0]?.why).toContain("--category must be one of");
    expect(deferredEntries(forge.state.body)[0]?.filed).toBeUndefined();
    expect(calls.filter((call) => call.op === "TrackerCreate")).toHaveLength(0);
  });

  test("accepts a corrected held batch entry after an earlier refusal", async () => {
    const { forge, calls, result } = await refileCorrectedHeldBatch(
      "unrecognized",
      ["category=unrecognized", "category=correctness"],
    );
    expect(result.why).toBeNull();
    expect(result.forPerson).toEqual([]);
    expect(result.filed.map(({ key }) => key)).toEqual(["#7"]);
    expect(deferredEntries(forge.state.body)[0]?.filed?.key).toBe("#7");
    expect(calls.filter((call) => call.op === "TrackerUpdate")).toHaveLength(1);
  });

  test("an issue filed from an earlier text of a corrected entry does not replace the correction", async () => {
    const original = withDeferredEntry("", {
      ...REC,
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    const [before] = deferredEntries(original);
    const corrected = original.replace("deferred: r", "deferred: r, corrected");
    const forge = fakeForge(corrected);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `${identityLine({ source: THREAD })}\n${textLine({ text: before?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.filed).toEqual([]);
    expect(r.unrecorded.map((f) => f.key)).toEqual(["#7"]);
    expect(r.why).toContain("earlier text");
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
    expect(forge.state.body).toBe(corrected);
  });

  test("an issue that only mentions the source, or names another fingerprint on it, is not reused", async () => {
    const comment = `${PR_URL}#issuecomment-77`;
    let body = withDeferredEntry("", {
      ...REC,
      source: comment,
      fingerprint: "fp-a",
      finding: "first",
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      ...REC,
      source: comment,
      fingerprint: "fp-b",
      finding: "second",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    const { t, calls } = trackerThatFiles([
      {
        number: 7,
        body: `Filed by file-deferred.ts.\n\n${identityLine({ source: comment, fingerprint: "fp-a" })}\n${textLine({ text: deferredEntries(body)[0]?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.filed.map((f) => [f.key, f.reused])).toEqual([
      ["#7", true],
      ["#41", false],
    ]);
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(created).toHaveLength(1);
    expect(
      String(
        (created[0]?.variables.input as { body?: string } | undefined)?.body,
      ),
    ).toContain(identityLine({ source: comment, fingerprint: "fp-b" }));
  });

  test("an entry a person corrects during the run is filed as corrected", async () => {
    const other = `${PR_URL}#discussion_r2002`;
    let body = withDeferredEntry("", {
      ...REC,
      source: THREAD,
      finding: "first",
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      ...REC,
      source: other,
      finding: "second",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    // The initial read, then the first entry's fresh read and its write's
    // three; the person corrects the second entry before its fresh read.
    forge.beforeRead.push(...Array(5).fill(() => undefined), (st: PrBody) => {
      st.body = st.body.replace("> second", "> second, corrected");
    });
    const { t, calls } = trackerThatFiles();
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.why).toBeNull();
    expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(1);
    expect((await t.getIssue("#41"))?.description).toContain(
      "second, corrected",
    );
  });

  test("an entry removed or changed between filing and recording is reported, not counted as recorded", async () => {
    for (const edit of [
      (st: PrBody) => {
        st.body = st.body.replace(
          /<!-- deferred-entry:[\s\S]*?<!-- \/deferred-entry -->/,
          "",
        );
      },
      (st: PrBody) => {
        st.body = st.body.replace("deferred: r", "deferred: r, and more");
      },
    ]) {
      const forge = fakeForge(
        withDeferredEntry("", {
          ...REC,
          source: THREAD,
          finding: FINDING,
          reason: "r",
        }).body,
      );
      // The initial read and the fresh read, then the person edits.
      forge.beforeRead.push(
        () => undefined,
        () => undefined,
        edit,
      );
      const r = await fileDeferred(forge, trackerThatFiles().t, "42", {
        label: "pr-followup",
        facets: FACETS,
      });
      expect(r.filed).toEqual([]);
      expect(r.unrecorded.map((f) => f.key)).toEqual(["#41"]);
      expect(r.why).toContain(
        "#41 was filed, but its entry could not be replaced",
      );
    }
  });

  test("a filing whose entry cannot be replaced is reported with its key", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        ...REC,
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    forge.failWrites = true;
    const heard: string[] = [];
    const r = await fileDeferred(forge, trackerThatFiles().t, "42", {
      label: "pr-followup",
      facets: FACETS,
      onFiled: (f) => heard.push(f.key),
    });
    expect(heard).toEqual(["#41"]);
    expect(r.unrecorded.map((f) => f.key)).toEqual(["#41"]);
    expect(r.why).toContain(
      "#41 was filed, but its entry could not be replaced",
    );
  });

  test("an issue url carrying = survives the entry's marker", async () => {
    const body = withDeferredEntry("", {
      ...REC,
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    const filed = withFiledEntry(
      body,
      { source: THREAD },
      {
        key: "ENG-9",
        url: "https://tracker.example/issue?id=ENG-9&view=a",
      },
    );
    expect(deferredEntries(filed)[0]?.filed).toEqual({
      key: "ENG-9",
      url: "https://tracker.example/issue?id=ENG-9&view=a",
    });
  });

  test("with no tracker, the entries stay and say why", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        ...REC,
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    const r = await fileDeferred(forge, null, "42", {
      label: "pr-followup",
      noTrackerWhy: "no tracker adapter can file: none configured",
      facets: null,
    });
    expect(r.remaining).toHaveLength(1);
    expect(r.why).toContain("none configured");
    expect(forge.writes).toBe(0);
  });

  /** The tracker, with every issue it is asked to file recorded. */
  function recording() {
    const { t, calls } = trackerThatFiles();
    const asked: NewIssue[] = [];
    const tracker = {
      ...t,
      createIssue: (issue: NewIssue) => {
        asked.push(issue);
        return t.createIssue(issue);
      },
    };
    return { tracker, asked, calls };
  }

  test("files a finding with its type, the priority its severity maps to, and a size", async () => {
    let body = withDeferredEntry("", {
      ...REC,
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      type: "docs",
      severity: "unknown",
      category: "unknown",
      size: "xs",
      source: `${PR_URL}#discussion_r2`,
      finding: "A second finding.",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    const { tracker, asked, calls } = recording();
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.why).toBeNull();
    expect(asked).toEqual([
      expect.objectContaining({
        labels: ["pr-followup"],
        type: "bug",
        priority: 2,
        size: "small",
      }),
      expect.objectContaining({ type: "docs", priority: 3, size: "xs" }),
    ]);
    expect(asked[0]?.description).toContain(
      "Severity: high. Category: correctness.",
    );
    // The facets reach the tracker's store: here, each value's label.
    const labelled = (c: (typeof calls)[number]) =>
      (c.variables.input as { labelIds?: string[] }).labelIds ?? [];
    const created = calls.filter((c) => c.op === "TrackerCreate");
    expect(labelled(created[0] as (typeof calls)[number]).join(" ")).toMatch(
      /_bug\b.*_small\b|_small\b.*_bug\b/,
    );
    expect(labelled(created[0] as (typeof calls)[number]).join(" ")).toContain(
      "_priority: high",
    );
  });

  test("leaves an entry that records no type or severity for a person, and files the rest", async () => {
    let body = withDeferredEntry("", {
      source: THREAD,
      finding: FINDING,
      reason: "r",
    }).body;
    body = withDeferredEntry(body, {
      ...REC,
      source: `${PR_URL}#discussion_r2`,
      finding: "A second finding.",
      reason: "r",
    }).body;
    const forge = fakeForge(body);
    const { tracker, asked } = recording();
    const r = await fileDeferred(forge, tracker, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.why).toBeNull();
    expect(r.filed.map((f) => f.source)).toEqual([`${PR_URL}#discussion_r2`]);
    expect(asked).toHaveLength(1);
    expect(r.forPerson.map((p) => [p.entry.source, p.why])).toEqual([
      [THREAD, expect.stringContaining("records no type or severity")],
    ]);
    const [old] = deferredEntries(forge.state.body);
    expect(old?.source).toBe(THREAD);
    expect(old?.filed).toBeUndefined();
  });

  test.each([
    ["that records no type or severity", {}],
    ["that records its type and severity", REC],
  ])(
    "an entry %s is recorded with its interrupted run's issue without planning it",
    async (_name, recorded) => {
      const forge = fakeForge(
        withDeferredEntry("", {
          ...recorded,
          source: THREAD,
          finding: FINDING,
          reason: "r",
        }).body,
      );
      const [entry] = deferredEntries(forge.state.body);
      const { t, calls } = trackerThatFiles([
        {
          number: 7,
          body: `Filed by file-deferred.ts.\n\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
        },
      ]);
      forge.threadPaths = async () => {
        throw new Error("the review threads were consulted");
      };
      const r = await fileDeferred(forge, t, "42", {
        label: "pr-followup",
        facets: FACETS,
        taxonomy: {
          types: JIG_TAXONOMY.types,
          statuses: [],
          flags: [],
          categories: [],
          groups: [
            {
              id: "repo",
              required: true,
              notRequiredOn: [],
              labels: ["repo:web", "repo:api"],
            },
          ],
        },
        catalog: () => {
          throw new Error("the catalog was consulted");
        },
      });
      expect(r.why).toBeNull();
      expect(r.forPerson).toEqual([]);
      expect(r.filed).toEqual([
        expect.objectContaining({ key: "#7", reused: true }),
      ]);
      expect(calls.filter((c) => c.op === "TrackerCreate")).toHaveLength(0);
      expect(deferredEntries(forge.state.body)[0]?.filed?.key).toBe("#7");
    },
  );

  test("an issue an interrupted run filed does not replace an entry corrected before its fresh read", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    const [entry] = deferredEntries(forge.state.body);
    const { t } = trackerThatFiles([
      {
        number: 7,
        body: `Filed by file-deferred.ts.\n\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
      },
    ]);
    // The initial read, then the person corrects the entry before the fresh one.
    forge.beforeRead.push(
      () => undefined,
      (st: PrBody) => {
        st.body = st.body.replace(
          "It can go negative.",
          "It can go negative, corrected.",
        );
      },
    );
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
    });
    expect(r.why).toContain("earlier text");
    const now = deferredEntries(forge.state.body)[0];
    expect(now?.filed).toBeUndefined();
    expect(now?.text).toContain("corrected");
  });

  test("a dry run does not hand a person an entry whose issue a run already filed", async () => {
    const forge = fakeForge(
      withDeferredEntry("", {
        source: THREAD,
        finding: FINDING,
        reason: "r",
      }).body,
    );
    const [entry] = deferredEntries(forge.state.body);
    const { t } = trackerThatFiles([
      {
        number: 7,
        body: `Filed by file-deferred.ts.\n\n${identityLine({ source: THREAD })}\n${textLine({ text: entry?.text ?? "" })}`,
      },
    ]);
    const r = await fileDeferred(forge, t, "42", {
      label: "pr-followup",
      facets: FACETS,
      dryRun: true,
    });
    expect(r.forPerson).toEqual([]);
    expect(deferredEntries(forge.state.body)[0]?.filed).toBeUndefined();
  });

  test("leaves an entry whose type the repository does not have for a person", () => {
    const entry = { ...REC, source: THREAD, text: "t", type: "spike" };
    expect(entryFacets(entry, FACETS)).toEqual({
      why: "its type 'spike' is no type of this repository (bug, feature, docs, chore, infra)",
    });
    expect(entryFacets({ ...entry, type: "BUG" }, FACETS)).toEqual({
      type: "bug",
      priority: 2,
      size: "small",
    });
  });
});

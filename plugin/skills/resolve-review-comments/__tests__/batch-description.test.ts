/**
 * batch-description.test.ts — the batch KEY and SCAFFOLD in
 * scripts/lib/batch-description.ts: the description marker a round finds a
 * batch by, where in a description it counts, the shape its components must
 * have, the scaffold a new batch starts from and its repair, plus the append
 * loop's guarantee that a confirmed append still carries the key.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
  batchKeyMarker,
  batchTitle,
  descriptionForRepair,
  hasBatchKey,
  initialDescription,
  isSafeKeyComponent,
  noParentRationaleForRepair,
  placementMatchesFreshParent,
  scaffoldPortion,
} from "../scripts/lib/batch-description.ts";
import {
  appendEntry,
  appendWithRetry,
  type Args,
  type LinearClient,
  PROVENANCE_LABEL,
  renderEntry,
  REPO_GROUP,
  SEVERITY_TO_PRIORITY,
  SIZE_GROUP,
  TYPE_GROUP,
} from "../scripts/defer-batch.ts";
import { ExitError } from "../../../shared/cli.ts";
import { SEVERITY_UNKNOWN } from "../scripts/lib/ladder.ts";

/** A workspace label as Linear returns it, with its group in `parent`. */
const label = (name: string, group?: string) => ({
  id: `id-${name}`,
  name,
  parent: group === undefined ? null : { name: group },
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}

describe("batchTitle — the SEED title, no longer the key", () => {
  // `hasBatchKey` takes no title argument at all; the renaming regression
  // test at the `runDeferBatch` level is the behavioural half of this claim.
  it("renders the protocol title and carries no key", () => {
    expect(batchTitle("123", "chore")).toBe("PR #123 chore review follow-ups");
    expect(batchTitle("123", "chore")).not.toContain("defer-batch-key");
  });
});

describe("batchKeyMarker / hasBatchKey", () => {
  const key = (repo: string, pr: string, type: string) =>
    initialDescription(repo, pr, type, "ENG-101");

  it("renders the documented marker, carrying repo, PR and Type", () => {
    expect(batchKeyMarker("project", "4374", "bug")).toBe(
      "<!-- defer-batch-key: repo=project pr=4374 type=bug -->",
    );
  });

  it("matches the marker its own scaffold emits", () => {
    expect(
      hasBatchKey(key("project", "123", "chore"), "project", "123", "chore"),
    ).toBe(true);
  });

  // Each row must NOT read as this batch's key. The repo row is why the
  // repository is in the key at all: consumers share one tracker workspace,
  // so another consumer's PR #123 chore batch was titled identically and only
  // a Repo-LABEL check stood between it and this run's append.
  it.each([
    ["a different Type", key("project", "123", "bug")],
    ["a different repository", key("website", "123", "chore")],
    ["a PR number this one merely prefixes", key("project", "12", "chore")],
    [
      "a case variant of a machine-written marker",
      "<!-- DEFER-BATCH-KEY: REPO=PROJECT PR=123 TYPE=CHORE -->",
    ],
    [
      "a marker that is not a whole line",
      `see ${batchKeyMarker("project", "123", "chore")} for context`,
    ],
    ["an empty description — a wiped batch carries no key", ""],
    [
      "a marker shown in a fenced example",
      `\`\`\`markdown\n${batchKeyMarker("project", "123", "chore")}\n\`\`\``,
    ],
    [
      "a marker in an indented code block",
      `    ${batchKeyMarker("project", "123", "chore")}\n\nprose`,
    ],
    [
      "a marker below the first line",
      `Migration notes.\n\n${batchKeyMarker("project", "123", "chore")}`,
    ],
  ])("does not match %s", (_why, description) => {
    expect(hasBatchKey(description, "project", "123", "chore")).toBe(false);
  });

  it("tolerates leading blank lines, up to three spaces of indentation and trailing whitespace", () => {
    expect(
      hasBatchKey(
        `\n   ${batchKeyMarker("project", "123", "chore")}  \r\n\nprose`,
        "project",
        "123",
        "chore",
      ),
    ).toBe(true);
  });

  it("IGNORES a marker QUOTED inside an entry — only the scaffold counts", () => {
    // Reachable via the server-side `description: { contains }` substring
    // filter, and not hypothetical: a deferral from a pull request touching
    // defer-batch.ts quotes a marker verbatim.
    const foreign = batchKeyMarker("project", "9999", "bug");
    const sourceUrl =
      "https://github.com/example/project/pull/123#discussion_r1";
    const description = appendEntry(
      key("project", "123", "chore"),
      renderEntry({
        sourceUrl,
        finding: `the key marker is ${foreign}\n${foreign}`,
        reason: `should not forge ${foreign}`,
        severity: "low",
        category: "correctness",
        fix: foreign,
      }),
      sourceUrl,
    ).description;

    // Present in the raw text — a bare `includes` would match — yet not this
    // batch's key, while its own key still resolves.
    expect(description).toContain(foreign);
    expect(hasBatchKey(description, "project", "9999", "bug")).toBe(false);
    expect(hasBatchKey(description, "project", "123", "chore")).toBe(true);
  });
});

describe("isSafeKeyComponent", () => {
  // A refusal, not a sanitiser — see the predicate's own doc. Every rejected
  // shape is reachable: the Type and Repo vocabularies are consumer YAML.
  it("accepts the shapes taxonomies use and refuses what breaks the marker", () => {
    for (const ok of [
      "project",
      "bug",
      "agent:meta",
      "codearea:scaffolding",
      "my-repo",
      "repo.v2",
      "a_b",
      "scope/name",
      "team@org",
      "c++",
    ]) {
      expect(isSafeKeyComponent(ok)).toBe(true);
    }
    for (const bad of [
      "", // `repo=` with no value
      "my repo", // runs into the next field
      "a\nb", // defeats the whole-line match
      "a-->b", // closes the comment early
      "<!--x", // opens a nested comment
      "a>b",
      "a=b", // confusable with the key=value separator
      "héllo", // non-ASCII, conservatively out
    ]) {
      expect(isSafeKeyComponent(bad)).toBe(false);
    }
  });
});

describe("initialDescription — the no-parent rationale", () => {
  it("records the reason and names the epic that was rejected", () => {
    const s = initialDescription("project", "123", "chore", "ENG-101", {
      reason: "tooling defect under a compliance epic",
      rejectedEpic: "ENG-100",
    });
    expect(s).toContain("**No epic parent**");
    expect(s).toContain("tooling defect under a compliance epic");
    expect(s).toContain("ENG-100");
    expect(s).toContain("## Entries");
  });

  it("says so plainly when there was no epic to reject", () => {
    const s = initialDescription("project", "123", "chore", "ENG-101", {
      reason: "originating issue is itself an epic",
      rejectedEpic: "",
    });
    expect(s).toContain("no epic to inherit");
  });

  it("omits the block entirely when the follow-up is parented", () => {
    expect(
      initialDescription("project", "123", "chore", "ENG-101"),
    ).not.toContain("**No epic parent**");
  });
});

describe("noParentRationaleForRepair", () => {
  it("drops the rationale when the batch actually HAS a parent", () => {
    // An append never changes or reads a batch's `parentId`, so a
    // wiped-description repair may not describe a parented batch as parentless
    // just because THIS run passed `--no-parent` — that corrupts the placement
    // audit trail.
    expect(noParentRationaleForRepair(true)).toBeUndefined();
  });

  it("always falls back to a generic reason when the batch has no parent — never this run's own rationale", () => {
    // A later append's OWN `--no-parent` rationale describes why THAT append
    // used the flag, never why the batch's first entry was originally
    // placed parentless — those can differ. There is no invocation
    // rationale parameter to reuse, by construction.
    const fallback = noParentRationaleForRepair(false);
    expect(fallback).toBeDefined();
    // NOT '': `''` is `initialDescription`'s rendering for a VERIFIED fact ("no
    // epic to inherit"), which this fallback cannot know (the batch could have
    // rejected a real epic). `null` is the explicit "unknown" state.
    expect(fallback?.rejectedEpic).toBeNull();
    expect(fallback?.reason.length).toBeGreaterThan(0);
  });

  it("renders the fallback without asserting a fact this run never verified", () => {
    // Reusing `''` here rendered "...this repair could not recover it (the
    // originating issue has no epic to inherit)" — a sentence that both admits
    // the reason is lost AND asserts a specific (possibly false) one in the
    // same breath. The rendered description must state neither "no epic to
    // inherit" nor name any epic.
    const fallback = noParentRationaleForRepair(false);
    const rendered = initialDescription(
      "project",
      "123",
      "chore",
      "ENG-1234",
      fallback,
    );
    expect(rendered).toContain("**No epic parent**");
    expect(rendered).not.toContain("no epic to inherit");
    expect(rendered).not.toContain("rejected as unrelated");
  });
});

describe("descriptionForRepair", () => {
  // At the time this comment was first written, `main()`'s own
  // wiped-description rebuild call site was reachable by NO test at all —
  // `main()` was neither exported nor exercised anywhere in this suite, so
  // reverting its rebuild to pass `noParentRationale` straight through (the
  // exact bug this file fixes) failed nothing. These tests exercise the shared
  // `descriptionForRepair` function directly, covering the LOGIC both call
  // sites share — but that is not the same claim as "both call sites are wired
  // to it", which a pure-function test can never make (this file once
  // overclaimed exactly that). `main()` was subsequently extracted into
  // `runDeferBatch` for the same reason `appendWithRetry` already had its own
  // seam — see the `runDeferBatch` and `appendWithRetry` describe blocks in
  // defer-batch.test.ts,
  // which test each call site's actual WIRING against a mock `LinearClient`,
  // not just the helper it delegates to.

  it("returns the live description unchanged when it is non-empty", () => {
    const live = initialDescription("project", "123", "chore", "ENG-101");
    expect(
      descriptionForRepair(live, "project", "123", "chore", "ENG-101", true),
    ).toBe(live);
  });

  it("puts the key line back in front of a non-empty description that lost it", () => {
    const live = "Batch prose.\n\n## Entries\n\n### entry";
    const repaired = descriptionForRepair(
      live,
      "project",
      "123",
      "chore",
      "ENG-101",
      true,
    );
    expect(repaired).toBe(
      `${batchKeyMarker("project", "123", "chore")}\n\n${live}`,
    );
    expect(hasBatchKey(repaired, "project", "123", "chore")).toBe(true);
  });

  it("leaves a description leading with a DIFFERENT batch's key unchanged", () => {
    const live = initialDescription("project", "9999", "bug", "ENG-101");
    expect(
      descriptionForRepair(live, "project", "123", "chore", "ENG-101", true),
    ).toBe(live);
  });

  it("rebuilds a wiped description WITHOUT a no-parent block when the batch actually has a parent", () => {
    const rebuilt = descriptionForRepair(
      "",
      "project",
      "123",
      "chore",
      "ENG-101",
      true,
    );
    expect(rebuilt).not.toContain("**No epic parent**");
    expect(rebuilt).toContain("PR #123");
  });

  it("rebuilds a wiped description with the lost-reason fallback when the batch genuinely has no parent — never this run's own rationale", () => {
    const rebuilt = descriptionForRepair(
      "   ", // whitespace-only counts as wiped
      "project",
      "123",
      "chore",
      "ENG-101",
      false,
    );
    expect(rebuilt).toContain("**No epic parent**");
    expect(rebuilt).not.toContain("no epic to inherit");
    expect(rebuilt).not.toContain("rejected as unrelated");
  });
});

describe("initialDescription", () => {
  it("carries the PR and the originating issue", () => {
    const s = initialDescription("project", "123", "chore", "ENG-101");
    expect(s).toContain("PR #123");
    expect(s).toContain("ENG-101");
    expect(s).toContain("## Entries");
  });

  it("states the no-ticket case instead of a blank", () => {
    expect(initialDescription("project", "123", "chore", "")).toContain(
      "no originating issue",
    );
  });
});

describe("appendWithRetry — the batch key line survives the append", () => {
  const threadUrl = "https://github.com/example/project/pull/123#discussion_r1";
  const entry = renderEntry({
    sourceUrl: threadUrl,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });
  const marker = batchKeyMarker("project", "123", "chore");
  const keyed = appendEntry(
    `${marker}\n\n## Entries`,
    entry,
    threadUrl,
  ).description;
  const unkeyed = appendEntry("## Entries", entry, threadUrl).description;
  const args: Args = {
    pr: "123",
    type: "chore",
    sourceUrl: threadUrl,
    entryKey: threadUrl,
    reason: "r",
    severity: "unknown",
    category: "unknown",
    originating: "ENG-1234",
    team: "",
    fix: "",
    size: "small",
    repoLabel: "project",
    repoSlug: "example/project",
    extraLabels: [],
    noParent: false,
    noParentReason: "",
    dryRun: false,
  };
  const labels = [
    label(PROVENANCE_LABEL),
    label("chore", TYPE_GROUP),
    label("small", SIZE_GROUP),
    label("project", REPO_GROUP),
    label("agent:meta"),
    label("domain:tooling"),
  ];
  const context = ["agent:meta", "domain:tooling"];

  /**
   * A server whose description a concurrent writer replaces with
   * `afterPriming` right after this run's priming read, so the first verify
   * is the read that sees it.
   */
  function server(afterPriming: string) {
    let description = keyed;
    let reads = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueUpdate")) {
        const input = vars.input as { description?: string };
        if (input.description !== undefined) description = input.description;
        return { issueUpdate: { success: true } };
      }
      const read = description;
      reads++;
      if (reads === 1) description = afterPriming;
      return {
        issue: {
          description: read,
          priority: required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
          labels: { pageInfo: { hasNextPage: false }, nodes: labels },
        },
      };
    };
    return { linear, description: () => description, reads: () => reads };
  }

  const run = (linear: LinearClient) =>
    appendWithRetry(
      linear,
      { id: "issue-1", identifier: "ENG-9999" },
      keyed,
      false, // seedWasRepaired
      true, // needsInitialWrite
      [],
      [],
      entry,
      args,
      "small",
      required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
      context,
      context,
      new AbortController().signal,
      async () => undefined,
      true, // needsInitialDescriptionWrite
    );

  it("restores a key line a concurrent writer dropped while keeping the entry", async () => {
    const fake = server(unkeyed);
    const result = await run(fake.linear);
    expect(result.confirmed).toBe(true);
    // Priming, the verify that saw the dropped key, the verify that confirmed.
    expect(fake.reads()).toBe(3);
    expect(hasBatchKey(fake.description(), "project", "123", "chore")).toBe(
      true,
    );
  });

  it("refuses when a concurrent writer replaced the key line with another batch's", async () => {
    const foreign = appendEntry(
      `${batchKeyMarker("project", "9999", "bug")}\n\n## Entries`,
      entry,
      threadUrl,
    ).description;
    const fake = server(foreign);
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(run(fake.linear)).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("different batch key");
    } finally {
      errSpy.mockRestore();
    }
    expect(fake.description()).toBe(foreign);
  });

  it("refuses a label-only repair on a batch whose key line was replaced, before adding any label", async () => {
    const foreign = appendEntry(
      `${batchKeyMarker("project", "9999", "bug")}\n\n## Entries`,
      entry,
      threadUrl,
    ).description;
    const repoLabel = label("project", REPO_GROUP);
    const mutations: string[] = [];
    const linear: LinearClient = async (query) => {
      if (query.includes("mutation")) {
        mutations.push(query);
        return { issueAddLabel: { success: true } };
      }
      return {
        issue: {
          description: foreign,
          priority: required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
          labels: {
            pageInfo: { hasNextPage: false },
            nodes: labels.filter((l) => l.name !== "project"),
          },
        },
      };
    };
    const errSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        appendWithRetry(
          linear,
          { id: "issue-1", identifier: "ENG-9999" },
          keyed,
          false, // seedWasRepaired
          true, // needsInitialWrite: the Repo label is missing
          [repoLabel],
          ["project"],
          entry,
          args,
          "small",
          required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
          context,
          context,
          new AbortController().signal,
          async () => undefined,
          false, // needsInitialDescriptionWrite: the entry is already there
        ),
      ).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("different batch key");
    } finally {
      errSpy.mockRestore();
    }
    expect(mutations).toEqual([]);
  });
});

describe("scaffoldPortion", () => {
  it("returns the whole description when there is no ## Entries heading yet", () => {
    expect(scaffoldPortion("**No epic parent**: reason")).toBe(
      "**No epic parent**: reason",
    );
  });

  it("stops at the FIRST ## Entries heading, excluding it and everything after", () => {
    expect(
      scaffoldPortion("**No epic parent**: reason\n\n## Entries\n\nstuff"),
    ).toBe("**No epic parent**: reason\n\n");
  });

  it("excludes entry content even when an entry quotes the scaffold marker verbatim", () => {
    // A reviewer's finding or a deferral reason is external/model-generated
    // text and can legitimately quote `**No epic parent**` while discussing
    // this very bug.
    const description =
      "## Entries\n\n### Some entry\n\nFinding: quotes **No epic parent** verbatim.";
    expect(scaffoldPortion(description)).toBe("");
  });
});

describe("placementMatchesFreshParent", () => {
  it("agrees when the description claims no parent and the fresh read has none", () => {
    expect(
      placementMatchesFreshParent(
        "**No epic parent**: reason\n\n## Entries",
        false,
      ),
    ).toBe(true);
  });

  it("agrees when the description does not claim no-parent and the fresh read HAS one", () => {
    expect(placementMatchesFreshParent("## Entries", true)).toBe(true);
  });

  it("disagrees when the description claims no parent but the fresh read HAS one", () => {
    // The race this function exists to catch: a reparent landed after a
    // wiped-description repair built its scaffold from a stale, parentless
    // read.
    expect(
      placementMatchesFreshParent(
        "**No epic parent**: reason\n\n## Entries",
        true,
      ),
    ).toBe(false);
  });

  it("disagrees when the description omits the block but the fresh read has NO parent", () => {
    // The reverse race: an unparent landed after the scaffold was built
    // assuming a parent.
    expect(placementMatchesFreshParent("## Entries", false)).toBe(false);
  });

  it("does NOT false-positive when a scaffold-less description has an ENTRY quoting the marker", () => {
    // Regression: the scaffold itself asserts a parent (no `**No epic parent**`
    // block), but an entry below `## Entries` quotes that exact marker while
    // discussing this very bug. An unrestricted `description.includes` would
    // misread this as the scaffold claiming no parent and fire a false
    // placement mismatch against a batch that IS parented.
    const description =
      "Batch of review deferrals from PR #123; originating issue ENG-1.\n\n## Entries\n\n### Some entry\n\nFinding: `description.includes('**No epic parent**')` is too broad.";
    expect(placementMatchesFreshParent(description, true)).toBe(true);
  });

  it("does NOT false-positive the reverse direction either — an entry quoting the marker cannot manufacture a claim the scaffold never made", () => {
    const description =
      "**No epic parent**: reason\n\n## Entries\n\n### Some entry\n\nFinding: quotes **No epic parent** twice for emphasis.";
    // hasParent: false — the scaffold's real claim (no parent) matches the
    // fresh read, and the duplicate mention in the entry must not affect
    // the verdict either way.
    expect(placementMatchesFreshParent(description, false)).toBe(true);
  });
});

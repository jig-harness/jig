/**
 * defer-batch.test.ts — the pure surface of scripts/defer-batch.ts (TASK-6733),
 * plus fail-closed CLI probes.
 *
 * The unit half exercises the helpers the network layer is driven by: the
 * batch-title key, the heading-keyed idempotent description append, the
 * oldest-wins duplicate pick, the page-completeness predicate the connection
 * reads fail closed on, the reconciliation decisions taken against an existing
 * batch (is it this repository's, which single-valued groups are absent versus
 * merely different, which context labels are missing, whether the `related`
 * link exists), the parentless-follow-up rationale, and the argument grammar.
 * The probe half spawns the entry script and asserts its refusal paths — usage
 * (exit 2) and missing credential (exit 1) — neither of which may reach the
 * network.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import {
  APPEND_ATTEMPTS,
  type Args,
  appendEntry,
  appendWithRetry,
  BATCH_REPOS,
  BATCH_SIZES,
  BATCH_TYPES,
  batchContractHolds,
  batchTitle,
  commentUrlPattern,
  contextAfterReconcile,
  contextLabelsToAdd,
  DEFAULT_REPO_SLUG,
  descriptionForRepair,
  entryHeading,
  entryHeadings,
  FINDING_FINGERPRINT,
  groupOf,
  hasEntry,
  hasRelationTo,
  headingEntryKey,
  inheritedContextLabels,
  initialDescription,
  isBatchableSize,
  isBatchTitle,
  isComplete,
  type LinearClient,
  missingSingleValued,
  type NoParentRationale,
  noParentRationaleForRepair,
  ownerDomainMismatches,
  PRIORITY_TO_SEVERITY,
  PROVENANCE_LABEL,
  parseArgs,
  pickBatch,
  placementMatchesFreshParent,
  priorityAfterSeverity,
  priorityReflectsSeverity,
  RELATED_TYPE,
  REPO_GROUP,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  REVIEW_CATEGORIES,
  renderEntry,
  repairableMissingLabels,
  repoVerdict,
  retryBackoffMs,
  runDeferBatch,
  SEVERITY_RANK_ORDER,
  SEVERITY_TO_PRIORITY,
  SIZE_GROUP,
  scaffoldPortion,
  severityRank,
  summaryEntryKey,
  TYPE_GROUP,
  threadUrlPattern,
} from "../scripts/defer-batch.ts";
import { ExitError } from "../scripts/lib/cli.ts";
import {
  CANONICAL_SEVERITIES,
  CATEGORY_UNKNOWN,
  SEVERITY_UNKNOWN,
} from "../scripts/lib/ladder.ts";

/** A workspace label as Linear returns it, with its group in `parent`. */
const label = (name: string, group?: string) => ({
  id: `id-${name}`,
  name,
  parent: group === undefined ? null : { name: group },
});

const SCRIPT = join(import.meta.dir, "..", "scripts", "defer-batch.ts");

// ── Batch-title key ─────────────────────────────────────────────────────────

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}

describe("batchTitle / isBatchTitle", () => {
  it("renders the protocol title with the Type as the lookup key", () => {
    expect(batchTitle("4068", "chore")).toBe(
      "PR #4068 chore review follow-ups",
    );
  });

  it("matches its own rendering", () => {
    expect(isBatchTitle(batchTitle("4068", "chore"), "4068", "chore")).toBe(
      true,
    );
  });

  it("matches case-insensitively and across padding", () => {
    expect(
      isBatchTitle("  PR #4068 Chore review follow-ups ", "4068", "chore"),
    ).toBe(true);
  });

  it("does not match a different Type under the same PR", () => {
    expect(
      isBatchTitle("PR #4068 bug review follow-ups", "4068", "chore"),
    ).toBe(false);
  });

  it("does not match a PR number that merely prefixes this one", () => {
    expect(
      isBatchTitle("PR #406 chore review follow-ups", "4068", "chore"),
    ).toBe(false);
  });
});

// ── Entry rendering + idempotent append ─────────────────────────────────────

describe("renderEntry", () => {
  const base = {
    sourceUrl: "https://github.com/example/project/pull/4068#discussion_r1",
    finding: "line one\nline two",
    reason: "needs the connector refactor first",
    severity: "high",
    category: "correctness",
  };

  it("heads with the thread URL and quotes every finding line", () => {
    const s = renderEntry(base);
    expect(s.startsWith(`### ${base.sourceUrl}`)).toBe(true);
    expect(s).toContain("> line one");
    expect(s).toContain("> line two");
    expect(s).toContain(`**Why deferred**: ${base.reason}`);
  });

  it("omits the fix sketch unless given, includes it when given", () => {
    expect(renderEntry(base)).not.toContain("**Fix sketch**");
    expect(renderEntry({ ...base, fix: "invert the guard" })).toContain(
      "**Fix sketch**: invert the guard",
    );
  });

  it("renders Severity and Category between the finding and Why deferred", () => {
    const s = renderEntry(base);
    expect(s).toContain(`**Severity**: ${base.severity}`);
    expect(s).toContain(`**Category**: ${base.category}`);
    // Order: heading, quoted finding, Severity, Category, Why deferred.
    const severityAt = s.indexOf("**Severity**");
    const categoryAt = s.indexOf("**Category**");
    const whyAt = s.indexOf("**Why deferred**");
    expect(severityAt).toBeGreaterThan(-1);
    expect(categoryAt).toBeGreaterThan(severityAt);
    expect(whyAt).toBeGreaterThan(categoryAt);
  });

  it("renders Severity and Category UNCONDITIONALLY, even when category is unknown", () => {
    // .config/review-triage.yaml's own documented stance: an `unknown`
    // category is deliberate and safe today (emission does not exist yet) —
    // hiding the line would make that indistinguishable from an entry
    // rendered before this field existed.
    const s = renderEntry({
      ...base,
      severity: "unknown",
      category: "unknown",
    });
    expect(s).toContain("**Severity**: unknown");
    expect(s).toContain("**Category**: unknown");
  });

  it("renders a summary finding under its stable key with the comment backlink", () => {
    const sourceUrl =
      "https://github.com/example/project/pull/4068#issuecomment-5649338286";
    const entryKey = summaryEntryKey(sourceUrl, "3b78f436d805f279");
    const s = renderEntry({ ...base, sourceUrl, entryKey });
    expect(s.startsWith(entryHeading(entryKey))).toBe(true);
    expect(s).toContain(`**Source comment**: ${sourceUrl}`);
  });
});

describe("appendEntry", () => {
  const url = "https://github.com/example/project/pull/4068#discussion_r9";
  const entry = renderEntry({
    sourceUrl: url,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });

  it("appends with a blank-line separator", () => {
    const r = appendEntry("## Entries", entry, url);
    expect(r.appended).toBe(true);
    expect(r.description).toBe(`## Entries\n\n${entry}`);
  });

  it("is idempotent on the thread URL — the retry returns byte-identical", () => {
    const first = appendEntry("## Entries", entry, url);
    const second = appendEntry(first.description, entry, url);
    expect(second.appended).toBe(false);
    expect(second.description).toBe(first.description);
  });

  it("an empty description becomes exactly the entry", () => {
    expect(appendEntry("", entry, url).description).toBe(entry);
  });

  it("does NOT treat a URL that merely prefixes another as present", () => {
    // `...#discussion_r1` is a substring of `...#discussion_r10`, so a
    // substring key reports r1 already recorded once r10 has been appended —
    // and its finding is then resolved with nothing tracking it.
    const short = "https://github.com/example/project/pull/4068#discussion_r1";
    const long = `${short}0`;
    const withLong = appendEntry(
      "## Entries",
      renderEntry({
        sourceUrl: long,
        finding: "f",
        reason: "r",
        severity: "unknown",
        category: "unknown",
      }),
      long,
    ).description;
    expect(withLong).toContain(long);
    expect(appendEntry(withLong, entry, short).appended).toBe(true);
  });

  it("does NOT treat a URL quoted inside another finding as present", () => {
    const quoting = renderEntry({
      sourceUrl: "https://github.com/example/project/pull/4068#discussion_r7",
      finding: `see the earlier thread at ${url} for context`,
      reason: "r",
      severity: "unknown",
      category: "unknown",
    });
    expect(quoting).toContain(url);
    expect(appendEntry(quoting, entry, url).appended).toBe(true);
  });

  it("hasEntry is the same predicate the append keys on", () => {
    // The post-write verification and the append must not drift apart.
    const withEntry = appendEntry("## Entries", entry, url).description;
    expect(hasEntry(withEntry, url)).toBe(true);
    expect(hasEntry("## Entries", url)).toBe(false);
  });

  it("survives Linear rewriting the bare URL into a markdown link", () => {
    // MEASURED on TASK-6789, this PR's own first real batch: Linear stores
    // `### <url>` back as `### [<url>](<<url>>)`. The exact line-equality key
    // never matched after that round trip, so every append failed its own
    // verification and the retry loop re-appended — three copies of one entry.
    const linkified = `### [${url}](<${url}>)`;
    expect(headingEntryKey(linkified)).toBe(url);
    expect(hasEntry(linkified, url)).toBe(true);
    expect(appendEntry(linkified, entry, url).appended).toBe(false);
    // The plain markdown-link form too, in case the wrapping ever changes.
    expect(headingEntryKey(`### [${url}](${url})`)).toBe(url);
  });

  it("still refuses a prefix match through the link form", () => {
    // The property the line-equality key was chosen for must survive the fix:
    // `..._r1` inside `..._r10` is still not a match.
    const short = "https://github.com/example/project/pull/4068#discussion_r1";
    expect(hasEntry(`### [${short}0](<${short}0>)`, short)).toBe(false);
  });

  it("rejects an INDENTED code-block heading, accepts a legal 1-3 space one", () => {
    // 4+ spaces is an indented code block in CommonMark, so a Markdown example
    // inside a description must not read as a real entry — that would make the
    // helper skip the append and let the thread resolve with nothing tracking
    // it. 0-3 spaces still parses as a heading and must keep working.
    expect(headingEntryKey(`    ### ${url}`)).toBe(null);
    expect(headingEntryKey(`\t### ${url}`)).toBe(null);
    expect(hasEntry(`    ### ${url}`, url)).toBe(false);
    expect(headingEntryKey(`   ### ${url}`)).toBe(url);
    expect(hasEntry(`   ### ${url}`, url)).toBe(true);
  });

  it("does NOT count a heading inside a FENCED code block", () => {
    // CommonMark renders this as code, not a heading. Counting it makes the
    // append skip a finding that was never recorded, and the thread then
    // resolves with nothing tracking it — the same loss the indented-block
    // bound closed, through its sibling construct.
    const fenced = ["## Entries", "", "```", `### ${url}`, "```"].join("\n");
    expect(entryHeadings(fenced)).toEqual([]);
    expect(hasEntry(fenced, url)).toBe(false);
    expect(appendEntry(fenced, entry, url).appended).toBe(true);

    // tildes too, and a fence carrying an info string
    const tilde = ["~~~markdown", `### ${url}`, "~~~"].join("\n");
    expect(hasEntry(tilde, url)).toBe(false);
    const info = ["```md", `### ${url}`, "```"].join("\n");
    expect(hasEntry(info, url)).toBe(false);
  });

  it("a SHORTER pseudo-closer does not end a longer fence", () => {
    // CommonMark: a closer must be at least as long as its opener. Storing
    // only the fence CHARACTER let ``` close a ```` fence, re-exposing the
    // code beneath as headings — which is how a finding gets skipped.
    const doc = ["````", "```", `### ${url}`, "````"].join("\n");
    expect(entryHeadings(doc)).toEqual([]);
    expect(hasEntry(doc, url)).toBe(false);
  });

  it("a backtick opener carrying a backtick in its info string is not a fence", () => {
    // Not a legal opener, so the heading below it is real content and must be
    // seen — otherwise an illegal fence hides genuine entries forever.
    const doc = ["``` js `x`", `### ${url}`].join("\n");
    expect(entryHeadings(doc)).toEqual([url]);
    expect(hasEntry(doc, url)).toBe(true);
  });

  it("a closer carrying an info string does not close the fence", () => {
    const doc = ["```", "``` still-code", `### ${url}`, "```"].join("\n");
    expect(hasEntry(doc, url)).toBe(false);
  });

  it("a tilde fence is closed by tildes, not by backticks", () => {
    const doc = ["~~~", "```", `### ${url}`, "~~~"].join("\n");
    expect(hasEntry(doc, url)).toBe(false);
  });

  it("still sees a real heading after a fenced block closes", () => {
    // The fix must not swallow everything following a code block.
    const doc = ["```", "code", "```", "", `### ${url}`].join("\n");
    expect(entryHeadings(doc)).toEqual([url]);
    expect(hasEntry(doc, url)).toBe(true);
  });

  it("is not fooled by a non-heading line or a deeper heading", () => {
    expect(headingEntryKey(`> ### ${url}`)).toBe(null);
    expect(headingEntryKey(`text ${url}`)).toBe(null);
    expect(hasEntry(`#### ${url}`, url)).toBe(false);
  });

  it("keys on the heading renderEntry actually emits", () => {
    expect(
      renderEntry({
        sourceUrl: url,
        finding: "f",
        reason: "r",
        severity: "unknown",
        category: "unknown",
      }),
    ).toContain(entryHeading(url));
  });
});

describe("threadUrlPattern", () => {
  it("anchors both ends so a longer URL cannot ride a prefix match", () => {
    const re = threadUrlPattern(DEFAULT_REPO_SLUG, "4068");
    const base = `https://github.com/${DEFAULT_REPO_SLUG}/pull/4068#discussion_r1`;
    expect(re.test(base)).toBe(true);
    expect(re.test(`${base}?x=1`)).toBe(false);
    expect(re.test(` ${base}`)).toBe(false);
  });

  it("escapes the slug rather than letting it act as a pattern", () => {
    // A dot in an owner or repo name is a literal, not "any character".
    const re = threadUrlPattern("acme/my.repo", "7");
    expect(
      re.test("https://github.com/acme/my.repo/pull/7#discussion_r1"),
    ).toBe(true);
    expect(
      re.test("https://github.com/acme/myXrepo/pull/7#discussion_r1"),
    ).toBe(false);
  });
});

describe("summary finding identity", () => {
  const commentUrl =
    "https://github.com/example/project/pull/4068#issuecomment-5649338286";

  it("accepts only a conversation comment on this repository and PR", () => {
    const re = commentUrlPattern(DEFAULT_REPO_SLUG, "4068");
    expect(re.test(commentUrl)).toBe(true);
    expect(
      re.test(
        "https://github.com/example/project/pull/4069#issuecomment-5649338286",
      ),
    ).toBe(false);
    expect(
      re.test("https://github.com/example/project/pull/4068#discussion_r1"),
    ).toBe(false);
  });

  it("keys two findings from one sticky comment independently", () => {
    const first = summaryEntryKey(commentUrl, "3b78f436d805f279");
    const second = summaryEntryKey(commentUrl, "1fdc34934304d731");
    expect(first).not.toBe(second);
    expect(FINDING_FINGERPRINT.test("3b78f436d805f279")).toBe(true);
    // As wide as MARKER_SAFE_FINGERPRINT (summary-findings.ts): a reviewer's
    // reviewer-backlog fingerprint need not be 16-char lowercase hex — a
    // narrower check here rejected a real one.
    expect(FINDING_FINGERPRINT.test("3B78F436D805F279")).toBe(true);
    expect(FINDING_FINGERPRINT.test("reviewer_key-1")).toBe(true);
    expect(FINDING_FINGERPRINT.test("-leading-dash")).toBe(false);
    expect(FINDING_FINGERPRINT.test("has space")).toBe(false);

    const firstEntry = renderEntry({
      sourceUrl: commentUrl,
      entryKey: first,
      finding: "first",
      reason: "r",
      severity: "medium",
      category: "security",
    });
    const secondEntry = renderEntry({
      sourceUrl: commentUrl,
      entryKey: second,
      finding: "second",
      reason: "r",
      severity: "low",
      category: "correctness",
    });
    const withFirst = appendEntry("## Entries", firstEntry, first).description;
    expect(appendEntry(withFirst, firstEntry, first).appended).toBe(false);
    expect(appendEntry(withFirst, secondEntry, second).appended).toBe(true);
  });
});

describe("isBatchableSize", () => {
  it("accepts exactly the batchable sizes and rejects the rest", () => {
    // Shared by the pre-write gate and the post-write contract check, so this
    // one probe covers both sites and stops them drifting apart.
    for (const s of BATCH_SIZES) expect(isBatchableSize(s)).toBe(true);
    for (const s of ["medium", "large", "xl", "Small", ""]) {
      expect(isBatchableSize(s)).toBe(false);
    }
  });
});

// ── Severity → Linear priority (TASK-7491) ───────────────────────────────────

describe("SEVERITY_TO_PRIORITY / PRIORITY_TO_SEVERITY", () => {
  it("matches the issue spec and labels.yaml priority.levels.*.linear_value", () => {
    expect(required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN])).toBe(0); // None
    expect(required(SEVERITY_TO_PRIORITY.low)).toBe(4);
    expect(required(SEVERITY_TO_PRIORITY.medium)).toBe(3);
    expect(required(SEVERITY_TO_PRIORITY.high)).toBe(2);
    expect(required(SEVERITY_TO_PRIORITY.blocker)).toBe(1); // Urgent — not one of
    // Linear's own five levels; mapped to the top of the scale deliberately.
  });

  it("is a bijection onto {0,1,2,3,4} — PRIORITY_TO_SEVERITY is its total inverse", () => {
    const priorities = Object.values(SEVERITY_TO_PRIORITY).sort();
    expect(priorities).toEqual([0, 1, 2, 3, 4]);
    for (const [severity, priority] of Object.entries(SEVERITY_TO_PRIORITY)) {
      expect(PRIORITY_TO_SEVERITY[priority]).toBe(severity);
    }
  });

  // The bijection test above only examines this map's EXISTING entries — it
  // says nothing about whether that entry set equals the accepted severity
  // vocabulary. A canonical severity added to `lib/ladder.ts` with no matching
  // entry here would still pass every assertion above while silently producing
  // `undefined` from `SEVERITY_TO_PRIORITY[token]` at runtime. The module's own
  // import-time assertion (this map's declaration site) is what actually
  // enforces this in production; this test exists so a key-set drift fails in
  // this suite with a readable assertion diff, not only as an import-time throw
  // the very first time the module happens to load in CI.
  it("key set exactly equals the canonical severity vocabulary — CANONICAL_SEVERITIES plus SEVERITY_UNKNOWN, no more and no less", () => {
    expect(Object.keys(SEVERITY_TO_PRIORITY).sort()).toEqual(
      [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN].sort(),
    );
  });
});

describe("severityRank", () => {
  it("ranks unknown lowest, blocker highest, and is NOT the same order as SEVERITY_TO_PRIORITY", () => {
    expect(SEVERITY_RANK_ORDER).toEqual([
      SEVERITY_UNKNOWN,
      "low",
      "medium",
      "high",
      "blocker",
    ]);
    expect(severityRank(SEVERITY_UNKNOWN)).toBe(0);
    expect(severityRank("low")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("blocker"));
    // The trap the issue calls out explicitly: comparing raw
    // SEVERITY_TO_PRIORITY values would rank 'unknown' (priority 0) BELOW
    // every real severity, even though it is the LEAST severe token — the
    // opposite of what severityRank must say.
    expect(required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN])).toBeLessThan(
      required(SEVERITY_TO_PRIORITY.low),
    );
    expect(severityRank(SEVERITY_UNKNOWN)).toBeLessThan(severityRank("low"));
  });
});

describe("priorityReflectsSeverity", () => {
  it("is false when the live priority is None and severity is real", () => {
    expect(priorityReflectsSeverity(0, "high")).toBe(false);
  });

  it("is true when the live priority already implies a MORE severe token", () => {
    // Live priority 1 (Urgent/blocker) already reflects 'high'.
    expect(priorityReflectsSeverity(1, "high")).toBe(true);
  });

  it("is true when the live priority implies EXACTLY this severity", () => {
    expect(priorityReflectsSeverity(2, "high")).toBe(true); // 2 = high
  });

  it("is always true against severity unknown, regardless of live priority", () => {
    for (const p of [0, 1, 2, 3, 4]) {
      expect(priorityReflectsSeverity(p, SEVERITY_UNKNOWN)).toBe(true);
    }
  });
});

describe("priorityAfterSeverity — escalate-never-downgrade", () => {
  it("escalates from None (0) to the severity’s own priority", () => {
    expect(priorityAfterSeverity(0, "high")).toBe(
      required(SEVERITY_TO_PRIORITY.high),
    );
  });

  it("escalates from a LOWER real priority (a weaker earlier finding)", () => {
    // Live priority 4 (Low) with an incoming 'high' finding must escalate to
    // 2 (High), not stay at 4 or land somewhere in between.
    expect(priorityAfterSeverity(4, "high")).toBe(
      required(SEVERITY_TO_PRIORITY.high),
    );
  });

  it("is a no-op when the batch already carries a MORE severe priority", () => {
    // Live priority 1 (Urgent, from an earlier blocker finding) must not be
    // downgraded to 3 (Medium) by a later, weaker 'medium' finding.
    expect(priorityAfterSeverity(1, "medium")).toBe(1);
  });

  it("is a no-op when the live priority already equals the target exactly", () => {
    expect(priorityAfterSeverity(2, "high")).toBe(2);
  });

  it("blocker always forces Urgent (1), even escalating past a real priority", () => {
    expect(priorityAfterSeverity(0, "blocker")).toBe(1);
    expect(priorityAfterSeverity(4, "blocker")).toBe(1);
    expect(priorityAfterSeverity(3, "blocker")).toBe(1);
    // Already Urgent: no-op, not an error.
    expect(priorityAfterSeverity(1, "blocker")).toBe(1);
  });

  it("never demands a priority outside the mutation, for any severity/priority pair", () => {
    for (const severity of [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]) {
      for (const p of [0, 1, 2, 3, 4]) {
        const result = priorityAfterSeverity(p, severity);
        expect([0, 1, 2, 3, 4]).toContain(result);
        // The defining contract: the result's implied severity is always at
        // least as severe as both the input priority's AND the target's.
        expect(priorityReflectsSeverity(result, severity)).toBe(true);
        expect(
          severityRank(required(PRIORITY_TO_SEVERITY[result])),
        ).toBeGreaterThanOrEqual(
          severityRank(required(PRIORITY_TO_SEVERITY[p])),
        );
      }
    }
  });
});

describe("appendEntry onto an EMPTY description", () => {
  const url = "https://github.com/example/project/pull/4068#discussion_r5";
  const entry = renderEntry({
    sourceUrl: url,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });

  it("a bare entry on an empty description records neither PR nor issue", () => {
    // The state the repair path must not leave behind: appending to a
    // hand-filed batch whose description is empty yields a description with
    // no provenance at all. Seeding `initialDescription` first is what the
    // caller does about it.
    const bare = appendEntry("", entry, url).description;
    expect(bare).not.toContain("PR #4068");
    expect(bare).not.toContain("TASK-6727");

    const seeded = appendEntry(
      initialDescription("4068", "TASK-6727"),
      entry,
      url,
    ).description;
    expect(seeded).toContain("PR #4068");
    expect(seeded).toContain("TASK-6727");
    expect(seeded).toContain(entryHeading(url));
  });
});

describe("initialDescription — the no-parent rationale", () => {
  it("records the reason and names the epic that was rejected", () => {
    const s = initialDescription("4068", "TASK-6727", {
      reason: "tooling defect under a compliance epic",
      rejectedEpic: "TASK-6000",
    });
    expect(s).toContain("**No epic parent**");
    expect(s).toContain("tooling defect under a compliance epic");
    expect(s).toContain("TASK-6000");
    expect(s).toContain("## Entries");
  });

  it("says so plainly when there was no epic to reject", () => {
    const s = initialDescription("4068", "TASK-6727", {
      reason: "originating issue is itself an epic",
      rejectedEpic: "",
    });
    expect(s).toContain("no epic to inherit");
  });

  it("omits the block entirely when the follow-up is parented", () => {
    expect(initialDescription("4068", "TASK-6727")).not.toContain(
      "**No epic parent**",
    );
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
    const rendered = initialDescription("4068", "TASK-1234", fallback);
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
  // seam — see the `runDeferBatch` and `appendWithRetry` describe blocks below,
  // which test each call site's actual WIRING against a mock `LinearClient`,
  // not just the helper it delegates to.

  it("returns the live description unchanged when it is non-empty", () => {
    const live = initialDescription("4068", "TASK-6727");
    expect(descriptionForRepair(live, "4068", "TASK-6727", true)).toBe(live);
  });

  it("rebuilds a wiped description WITHOUT a no-parent block when the batch actually has a parent", () => {
    const rebuilt = descriptionForRepair("", "4068", "TASK-6727", true);
    expect(rebuilt).not.toContain("**No epic parent**");
    expect(rebuilt).toContain("PR #4068");
  });

  it("rebuilds a wiped description with the lost-reason fallback when the batch genuinely has no parent — never this run's own rationale", () => {
    const rebuilt = descriptionForRepair(
      "   ", // whitespace-only counts as wiped
      "4068",
      "TASK-6727",
      false,
    );
    expect(rebuilt).toContain("**No epic parent**");
    expect(rebuilt).not.toContain("no epic to inherit");
    expect(rebuilt).not.toContain("rejected as unrelated");
  });
});

describe("initialDescription", () => {
  it("carries the PR and the originating issue", () => {
    const s = initialDescription("4068", "TASK-6727");
    expect(s).toContain("PR #4068");
    expect(s).toContain("TASK-6727");
    expect(s).toContain("## Entries");
  });

  it("states the no-ticket case instead of a blank", () => {
    expect(initialDescription("4068", "")).toContain("no originating issue");
  });
});

// ── Duplicate-key pick + label inheritance ──────────────────────────────────

describe("pickBatch", () => {
  it("picks the OLDEST issue whichever order candidates arrive in", () => {
    const older = {
      id: "a",
      identifier: "TASK-1",
      title: "t",
      url: "u",
      description: "",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    const newer = {
      ...older,
      id: "b",
      identifier: "TASK-2",
      createdAt: "2026-08-10T00:00:00.000Z",
    };
    expect(pickBatch([newer, older]).identifier).toBe("TASK-1");
    expect(pickBatch([older, newer]).identifier).toBe("TASK-1");
  });
});

describe("inheritedContextLabels", () => {
  it("keeps agent:/domain:/codearea: and drops everything else", () => {
    expect(
      inheritedContextLabels([
        "agent:meta",
        "domain:tooling",
        "codearea:scaffolding",
        "bug",
        "small",
        "project",
        "env:staging",
        "pr-followup",
      ]),
    ).toEqual(["agent:meta", "domain:tooling", "codearea:scaffolding"]);
  });
});

// ── Fail-closed page completeness ───────────────────────────────────────────

describe("isComplete", () => {
  it("is true ONLY for a page the API said it did not truncate", () => {
    expect(isComplete({ hasNextPage: false })).toBe(true);
    expect(isComplete({ hasNextPage: true })).toBe(false);
  });

  it("is false for an absent pageInfo — an unreadable answer is not a clear one", () => {
    // The query asks for pageInfo, so its absence means the population size
    // cannot be judged; reading that as "complete" is how a same-key batch
    // sitting past the page becomes a second batch issue.
    expect(isComplete(undefined)).toBe(false);
  });
});

// ── Reconciliation onto an existing batch ───────────────────────────────────

describe("contextLabelsToAdd", () => {
  it("proposes only inherited/extra labels the batch is missing", () => {
    expect(
      contextLabelsToAdd(
        ["pr-followup", "chore", "small", "project", "agent:meta"],
        ["agent:meta", "domain:tooling"],
        ["codearea:scaffolding"],
      ),
    ).toEqual(["domain:tooling", "codearea:scaffolding"]);
  });

  it("dedupes an inherited label repeated in the extras", () => {
    expect(
      contextLabelsToAdd([], ["domain:tooling"], ["domain:tooling"]),
    ).toEqual(["domain:tooling"]);
  });

  it("proposes nothing that is not in inherited or extras", () => {
    // The single-valued Type/Size/repo groups are the reason this is scoped to
    // context labels: unioning a batch created `small` with a later `xs`
    // finding would leave one issue carrying two Size labels.
    const present = ["pr-followup", "chore", "small", "project"];
    const proposed = contextLabelsToAdd(present, ["agent:meta"], ["xs"]);
    expect(proposed).not.toContain("small");
    expect(proposed).not.toContain("chore");
    // `xs` DOES come back, because the caller passed it as an extra and this
    // helper filters only against what the batch already has. That is not the
    // guard — it is why two OTHER guards exist: `assertGroupMembership`
    // refuses a `--labels` entry sitting in a single-valued group, and the
    // Context check uses the prefix filter rather than this helper's length.
    expect(proposed).toEqual(["agent:meta", "xs"]);
    expect(inheritedContextLabels(proposed)).toEqual(["agent:meta"]);
  });

  it("proposes nothing when the batch already carries everything", () => {
    expect(
      contextLabelsToAdd(
        ["agent:meta", "domain:tooling"],
        ["agent:meta"],
        ["domain:tooling"],
      ),
    ).toEqual([]);
  });
});

describe("contextAfterReconcile", () => {
  it("counts a context label the batch already carries", () => {
    expect(contextAfterReconcile(["agent:devops", "small"], [], [])).toEqual([
      "agent:devops",
    ]);
  });

  it("counts one this run can add", () => {
    expect(contextAfterReconcile(["small"], ["domain:tooling"], [])).toEqual([
      "domain:tooling",
    ]);
    expect(contextAfterReconcile([], [], ["codearea:scaffolding"])).toEqual([
      "codearea:scaffolding",
    ]);
  });

  it("is EMPTY when a non-context extra is all that is supplied", () => {
    // `--labels manual-ops` supplies a label but no CONTEXT label, and an
    // earlier revision's "are there labels to apply" test passed it — filing
    // an issue with the mandatory Context group empty. Both paths refuse on
    // this being empty, so the prefix filter is the whole guard.
    expect(
      contextAfterReconcile(["pr-followup", "small"], [], ["manual-ops"]),
    ).toEqual([]);
    expect(contextAfterReconcile([], [], [])).toEqual([]);
  });
});

describe("ownerDomainMismatches", () => {
  it("is empty when the batch has no owner/domain yet — the first entry sets it", () => {
    expect(
      ownerDomainMismatches(["pr-followup", "chore"], ["agent:meta"]),
    ).toEqual([]);
  });

  it("is empty when incoming supplies nothing — an append with no owner/domain to check", () => {
    expect(ownerDomainMismatches(["agent:meta", "domain:tooling"], [])).toEqual(
      [],
    );
  });

  it("is empty when incoming agrees with the batch", () => {
    expect(
      ownerDomainMismatches(
        ["agent:meta", "domain:tooling"],
        ["agent:meta", "domain:tooling"],
      ),
    ).toEqual([]);
  });

  it("flags a DIFFERENT agent — the case the protocol sends to its own issue", () => {
    // deferral-protocol.md § Batching is the default: a finding owned by a
    // different agent/domain than the rest of the batch gets its own issue.
    expect(
      ownerDomainMismatches(
        ["agent:meta", "domain:tooling"],
        ["agent:compliance"],
      ),
    ).toEqual([
      {
        group: "agent",
        batchHas: ["agent:meta"],
        incomingHas: ["agent:compliance"],
      },
    ]);
  });

  it("flags a DIFFERENT domain independently of agent", () => {
    expect(
      ownerDomainMismatches(
        ["agent:meta", "domain:tooling"],
        ["domain:compliance"],
      ),
    ).toEqual([
      {
        group: "domain",
        batchHas: ["domain:tooling"],
        incomingHas: ["domain:compliance"],
      },
    ]);
  });

  it("does NOT flag a batch carrying a SECOND agent/domain label the incoming set overlaps", () => {
    // agent:/domain: are declared `pick: "1-3"` in labels.yaml — multi-valued.
    // Ordinary Linear triage can add a second owner label to an
    // already-filed batch; requiring the incoming set to match EXACTLY would
    // then abort every later append even though the finding shares real
    // ownership. Any overlap is evidence of shared ownership.
    expect(
      ownerDomainMismatches(["agent:meta", "agent:devops"], ["agent:meta"]),
    ).toEqual([]);
    // Same in the other direction: incoming carries an extra label the batch
    // does not yet have, but still overlaps on the one it does.
    expect(
      ownerDomainMismatches(["agent:meta"], ["agent:meta", "agent:devops"]),
    ).toEqual([]);
  });

  it("flags a batch and an incoming set that are COMPLETELY disjoint, even multi-valued", () => {
    expect(
      ownerDomainMismatches(
        ["agent:meta", "agent:devops"],
        ["agent:compliance", "agent:integrations"],
      ),
    ).toEqual([
      {
        group: "agent",
        batchHas: ["agent:devops", "agent:meta"],
        incomingHas: ["agent:compliance", "agent:integrations"],
      },
    ]);
  });

  it("does NOT flag a differing codearea: — that group reconciles additively", () => {
    // One PR+Type batch can legitimately collect findings under the same
    // owner that touch different parts of the codebase.
    expect(
      ownerDomainMismatches(
        ["agent:meta", "domain:tooling", "codearea:scaffolding"],
        ["agent:meta", "domain:tooling", "codearea:linear"],
      ),
    ).toEqual([]);
  });
});

describe("repoVerdict", () => {
  it("names another repository batch sharing the PR number and Type", () => {
    expect(
      repoVerdict(
        [
          label("pr-followup"),
          label("chore", TYPE_GROUP),
          label("website", REPO_GROUP),
        ],
        "project",
      ),
    ).toBe("other-repo");
  });

  it("names this repository batch", () => {
    expect(repoVerdict([label("project", REPO_GROUP)], "project")).toBe(
      "this-repo",
    );
  });

  it("reports a batch with NO Repo label as UNLABELLED, not as ours", () => {
    // The caller fails closed on this. Treating it as ours would claim
    // another repo's batch, append to it, and then stamp it `project` —
    // destructive and silent, where a duplicate is only tracker noise.
    expect(
      repoVerdict(
        [label("pr-followup"), label("chore", TYPE_GROUP)],
        "project",
      ),
    ).toBe("unlabelled");
  });

  it("reports MORE THAN ONE Repo label as ambiguous, not as ours", () => {
    // `[project, website]` CONTAINS the requested label, so a membership
    // test calls it ours — while it is exactly as undecidable as carrying
    // none. Being in a single-valued group means being the only one.
    expect(
      repoVerdict(
        [label("project", REPO_GROUP), label("website", REPO_GROUP)],
        "project",
      ),
    ).toBe("ambiguous");
  });

  it("reads the group from Linear, not from the label name", () => {
    // A context label happens to be ungrouped; it must not be mistaken for a
    // Repo label just because it is present.
    expect(groupOf(label("codearea:scaffolding"))).toBe("");
    expect(groupOf(label("project", REPO_GROUP))).toBe(REPO_GROUP);
    expect(repoVerdict([label("codearea:scaffolding")], "project")).toBe(
      "unlabelled",
    );
  });
});

describe("missingSingleValued", () => {
  const wanted = { type: "chore", size: "small" };

  it("fills a group the batch is missing entirely", () => {
    const r = missingSingleValued(
      [label("pr-followup"), label("project", REPO_GROUP)],
      wanted,
    );
    expect(r.add).toEqual(["chore", "small"]);
    expect(r.conflicts).toEqual([]);
  });

  it("says nothing about Repo — repoVerdict already failed closed on it", () => {
    // Anything reaching reconciliation carries the right Repo label, so a
    // Repo entry here could only ever be unreachable logic.
    const r = missingSingleValued(
      [label("chore", TYPE_GROUP), label("small", SIZE_GROUP)],
      wanted,
    );
    expect(r.add).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("flags DUPLICATE membership even when the wanted value is present", () => {
    // `[chore, bug]` contains the requested `chore`, so a membership test
    // reports no conflict on the very state that most needs one — and the
    // caller cannot treat it as the benign "sized differently" case, because
    // that rests on the group being satisfied, which it is not.
    const r = missingSingleValued(
      [
        label("chore", TYPE_GROUP),
        label("bug", TYPE_GROUP),
        label("small", SIZE_GROUP),
        label("xs", SIZE_GROUP),
      ],
      wanted,
    );
    expect(r.add).toEqual([]);
    expect(r.conflicts).toEqual([
      { group: TYPE_GROUP, has: "chore, bug", duplicate: true },
      { group: SIZE_GROUP, has: "small, xs", duplicate: true },
    ]);
  });

  it("reports a differing TYPE as a conflict for the caller to abort on", () => {
    // Type is the lookup key, not a judgment like Size: a batch titled
    // `... chore ...` carrying `bug` is mislabelled, and appending a chore
    // finding to it misfiles under a Type that decides who may share it.
    const r = missingSingleValued(
      [label("bug", TYPE_GROUP), label("small", SIZE_GROUP)],
      wanted,
    );
    expect(r.add).toEqual([]);
    expect(r.conflicts).toEqual([
      { group: TYPE_GROUP, has: "bug", duplicate: false },
    ]);
  });

  it("KEEPS a differing value rather than adding a second label to the group", () => {
    // One issue carrying two Size labels violates the taxonomy in the name of
    // repairing it; the group is already satisfied, so it is reported instead.
    const r = missingSingleValued(
      [
        label("chore", TYPE_GROUP),
        label("xs", SIZE_GROUP),
        label("project", REPO_GROUP),
      ],
      wanted,
    );
    expect(r.add).toEqual([]);
    expect(r.conflicts).toEqual([
      { group: SIZE_GROUP, has: "xs", duplicate: false },
    ]);
  });

  it("proposes nothing when every group is already correct", () => {
    const r = missingSingleValued(
      [
        label("chore", TYPE_GROUP),
        label("small", SIZE_GROUP),
        label("project", REPO_GROUP),
        label("agent:meta"),
      ],
      wanted,
    );
    expect(r.add).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });
});

describe("batchContractHolds", () => {
  const wanted = { type: "chore", size: "small", repoLabel: "project" };
  const ok = [
    label(PROVENANCE_LABEL),
    label("chore", TYPE_GROUP),
    label("small", SIZE_GROUP),
    label("project", REPO_GROUP),
    label("domain:tooling"),
  ];
  const requiredContext = ["domain:tooling"];

  it("passes a batch that satisfies every mandatory group", () => {
    expect(batchContractHolds(ok, wanted, requiredContext, [])).toEqual([]);
  });

  it("catches a mandatory label a CONCURRENT writer erased", () => {
    // The point of the helper: these labels predate this run, so a check
    // scoped to "did MY additions land" never asks about them.
    for (const dropped of [
      PROVENANCE_LABEL, // losing this makes the batch undiscoverable
      "chore",
      "small",
      "project",
      "domain:tooling",
    ]) {
      const live = ok.filter((l) => l.name !== dropped);
      expect(
        batchContractHolds(live, wanted, requiredContext, []).length,
      ).toBeGreaterThan(0);
    }
  });

  it("catches ONE erased context label even when ANOTHER context label survives", () => {
    // The exact gap a generic "is the Context group non-empty" check misses:
    // dropping `agent:meta` alone still leaves `domain:tooling` present, so a
    // group-membership check would wrongly confirm. `requiredContext` names
    // both labels explicitly, so the specific loss is caught.
    const withTwoOwners = [...ok, label("agent:meta")];
    const bothRequired = ["domain:tooling", "agent:meta"];
    expect(batchContractHolds(withTwoOwners, wanted, bothRequired, [])).toEqual(
      [],
    );
    const erasedOne = withTwoOwners.filter((l) => l.name !== "agent:meta");
    const problems = batchContractHolds(erasedOne, wanted, bothRequired, []);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("agent:meta");
  });

  it("reports nothing missing when requiredContext is EMPTY — nothing was promised", () => {
    expect(batchContractHolds(ok, wanted, [], [])).toEqual([]);
    // Even a batch with NO context label at all is not a "missing context"
    // finding here — this function only checks what the caller named, and an
    // empty requiredContext names nothing. The mandatory-Context-group refusal
    // lives at the call site (`contextAfter.length === 0` in main()), not here.
    const noContext = ok.filter((l) => l.name !== "domain:tooling");
    expect(batchContractHolds(noContext, wanted, [], [])).toEqual([]);
  });

  it("catches an erased non-context `--labels` extra — e.g. manual-ops", () => {
    // Without `requiredExtras`, this function never asks about anything outside
    // the mandatory Type/Size/Repo/Context groups — so a flag label this run
    // added in an EARLIER attempt that a LATER concurrent writer erases is
    // invisible to verification entirely, and the run reports `confirmed` over
    // a batch that silently lost it.
    const withManualOps = [...ok, label("manual-ops")];
    expect(
      batchContractHolds(withManualOps, wanted, requiredContext, [
        "manual-ops",
      ]),
    ).toEqual([]);
    const erased = withManualOps.filter((l) => l.name !== "manual-ops");
    const problems = batchContractHolds(erased, wanted, requiredContext, [
      "manual-ops",
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain("manual-ops");
  });

  it("reports nothing missing when requiredExtras is EMPTY", () => {
    expect(batchContractHolds(ok, wanted, requiredContext, [])).toEqual([]);
  });

  it("tolerates a differing Size only when it is BATCHABLE", () => {
    // `xs` and `small` are both legitimate batch sizes, so neither run's value
    // is authoritative over the other's.
    const xs = ok.map((l) =>
      l.name === "small" ? label("xs", SIZE_GROUP) : l,
    );
    expect(batchContractHolds(xs, wanted, requiredContext, [])).toEqual([]);
    // `medium`/`large` are not: the protocol sends anything above `small` to
    // its own issue, so a batch carrying one must stop collecting entries.
    for (const size of ["medium", "large", "xl"]) {
      const live = ok.map((l) =>
        l.name === "small" ? label(size, SIZE_GROUP) : l,
      );
      expect(
        batchContractHolds(live, wanted, requiredContext, []).length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects a differing Type and a duplicated group", () => {
    const wrongType = ok.map((l) =>
      l.name === "chore" ? label("bug", TYPE_GROUP) : l,
    );
    expect(
      batchContractHolds(wrongType, wanted, requiredContext, []).length,
    ).toBeGreaterThan(0);
    expect(
      batchContractHolds(
        [...ok, label("xs", SIZE_GROUP)],
        wanted,
        requiredContext,
        [],
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe("repairableMissingLabels", () => {
  const wanted = { type: "chore", size: "small", repoLabel: "project" };

  it("agrees with the once-computed set on a fresh read", () => {
    expect(repairableMissingLabels([], wanted, ["agent:meta"], [])).toEqual([
      PROVENANCE_LABEL,
      "chore",
      "small",
      "project",
      "agent:meta",
    ]);
  });

  it("re-detects a label a CONCURRENT writer erased since the last read", () => {
    // The bug this closes: the retry loop's `addLabels` was computed ONCE
    // before the loop, from the snapshot at the start of the run. A label
    // present in that snapshot is never "missing" there, so an erasure a
    // concurrent writer makes mid-retry was undetectable to a set frozen
    // before the loop — the retry kept re-sending the same (possibly empty)
    // addition and the erased label was never restored. Calling this again
    // on the FRESH read is what lets a retry actually repair it.
    const initial = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
    ];
    expect(
      repairableMissingLabels(initial, wanted, ["agent:meta"], []),
    ).toEqual([]);
    // A concurrent whole-set replacement erases `agent:meta` between reads.
    const erased = initial.filter((l) => l.name !== "agent:meta");
    expect(repairableMissingLabels(erased, wanted, ["agent:meta"], [])).toEqual(
      ["agent:meta"],
    );
  });

  it("re-detects an erased PROVENANCE_LABEL the same way", () => {
    const withProvenance = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
    ];
    const erased = withProvenance.filter((l) => l.name !== PROVENANCE_LABEL);
    expect(repairableMissingLabels(erased, wanted, ["agent:meta"], [])).toEqual(
      [PROVENANCE_LABEL],
    );
  });

  it("re-detects an erased single-valued (Type/Size) label", () => {
    const full = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
    ];
    const erased = full.filter((l) => l.name !== "small");
    expect(repairableMissingLabels(erased, wanted, ["agent:meta"], [])).toEqual(
      ["small"],
    );
  });

  it("re-detects an erased REPO label — missingSingleValued excludes it, this does not", () => {
    // `missingSingleValued` deliberately skips Repo (the initial candidate
    // lookup already guarantees it) — but that guarantee only holds at the
    // read the lookup ran against. A CONCURRENT erasure mid-retry breaks it,
    // and `batchContractHolds` checks Repo regardless of who restores it.
    const full = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
    ];
    const erased = full.filter((l) => l.name !== "project");
    expect(repairableMissingLabels(erased, wanted, ["agent:meta"], [])).toEqual(
      ["project"],
    );
  });

  it("re-detects an erased context label that PREDATES this run — not in inherited/extras", () => {
    // A batch can carry a context label filed by an EARLIER finding's
    // originating issue, which is not in THIS run's `inherited` or `--labels`.
    // The caller must pass the batch's FULL required context set
    // (`requiredContext`), not just `inherited` — a label outside that set was
    // never repairable no matter how it was erased, because it was never
    // "wanted" by this function at all.
    const full = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("codearea:legacy"), // predates this run — not in `inherited`
    ];
    const erased = full.filter((l) => l.name !== "codearea:legacy");
    // Passing only this run's inherited set (empty here) can never repair it.
    expect(repairableMissingLabels(erased, wanted, [], [])).toEqual([]);
    // Passing the batch's FULL required context set does.
    expect(
      repairableMissingLabels(erased, wanted, ["codearea:legacy"], []),
    ).toEqual(["codearea:legacy"]);
  });

  it("re-detects an erased NON-CONTEXT `--labels` extra, e.g. manual-ops", () => {
    // `requiredContext` is deliberately prefix-filtered to
    // agent:/domain:/codearea: only (`contextAfterReconcile` ->
    // `inheritedContextLabels`), so a non-context flag label passed via
    // `--labels` (`manual-ops`, `dpa-relevant`, ...) never appears in it.
    // Passing `requiredContext` alone would silently drop such a label from the
    // append path's repair set entirely — the create path adds every
    // `args.extraLabels` value unfiltered, and an append must match that, not
    // report success while never adding it.
    const full = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
      label("manual-ops"),
    ];
    const erased = full.filter((l) => l.name !== "manual-ops");
    // `requiredContext` alone (no `requiredExtras`) can never repair it —
    // `manual-ops` isn't a context label, so it's not IN `requiredContext`.
    expect(repairableMissingLabels(erased, wanted, ["agent:meta"], [])).toEqual(
      [],
    );
    // Passed as `requiredExtras`, it is repaired.
    expect(
      repairableMissingLabels(erased, wanted, ["agent:meta"], ["manual-ops"]),
    ).toEqual(["manual-ops"]);
  });

  it("does not duplicate a name present in BOTH requiredContext and requiredExtras", () => {
    const erased = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
    ];
    expect(
      repairableMissingLabels(
        erased,
        wanted,
        ["agent:meta"],
        ["agent:meta"], // also passed as an extra — e.g. inherited AND --labels
      ),
    ).toEqual(["agent:meta"]);
  });

  it("does not duplicate the PROVENANCE label smuggled in through --labels", () => {
    // `parseArgs` rejects only Type/Size/Repo names in `--labels`, so
    // `--labels pr-followup` is legal and reaches `requiredExtras`. Deduping
    // extras against `requiredContext` ALONE — the only pairing the old code
    // covered — left `pr-followup` in the repair set twice: once from the
    // provenance branch, once from the extras. A repeated name is resolved
    // twice by `fetchLabels` and written twice.
    const erased = [
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
    ];
    const repairs = repairableMissingLabels(
      erased,
      wanted,
      [],
      [PROVENANCE_LABEL],
    );
    expect(repairs).toEqual([PROVENANCE_LABEL]);
    expect(new Set(repairs).size).toBe(repairs.length);
  });

  it("does not duplicate a REPO label that is also passed as an extra", () => {
    // The same class through a different pair: `parseArgs` rejects a Repo
    // name in `--labels`, but `repairableMissingLabels` is a pure function
    // that other callers reach directly, so it must not rely on that guard.
    const erased = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
    ];
    const repairs = repairableMissingLabels(erased, wanted, [], ["project"]);
    expect(repairs).toEqual(["project"]);
  });

  it("does NOT union a second Repo label onto a CONFLICTING value — leaves it unrepaired", () => {
    // A concurrent writer that REPLACES the Repo label with a different
    // Repo-group value (`website`) makes `liveNames.has('project')` false — the
    // same signal as a genuinely absent Repo group. The old code treated both
    // alike and proposed adding 'project', which the retry loop then WROTE via
    // `issueAddLabel`, leaving the live issue holding two Repo labels — an
    // invalid taxonomy mutation that needed manual cleanup even though
    // `batchContractHolds` later caught it as `ambiguous` and the run aborted.
    // The fix is to check `repoVerdict`, not raw membership: 'other-repo' is a
    // conflict, not an absence, so it is left unrepaired here — same treatment
    // a differing Type gets via `missingSingleValued`'s `conflicts`.
    const conflicting = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("website", REPO_GROUP), // NOT 'project' — a real conflict
      label("agent:meta"),
    ];
    expect(
      repairableMissingLabels(conflicting, wanted, ["agent:meta"], []),
    ).toEqual([]);
  });

  it("still repairs a Repo group that is genuinely ABSENT (no Repo label at all)", () => {
    // The sibling case: no Repo label present at all — `repoVerdict` reports
    // 'unlabelled', which stays repairable, matching the pre-existing
    // "re-detects an erased REPO label" test above.
    const absent = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("agent:meta"),
    ];
    expect(repairableMissingLabels(absent, wanted, ["agent:meta"], [])).toEqual(
      ["project"],
    );
  });

  it("does not let requiredExtras/requiredContext re-add a CONFLICTING Repo label around the dedicated gate", () => {
    // The dedicated `repoIsAbsent` branch correctly refuses to repair a Repo
    // group holding a DIFFERENT value — but the generic
    // `requiredContext`/`requiredExtras` filters below it still tested raw
    // `!liveNames.has(n)`, which is equally true for a conflicting value. A
    // caller naming the repo label via `--labels` (legitimate — see "does not
    // duplicate a REPO label that is also passed as an extra" above)
    // reintroduced exactly the two-Repo-label mutation the dedicated gate
    // exists to prevent.
    const conflicting = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("website", REPO_GROUP), // NOT 'project' — a real conflict
      label("agent:meta"),
    ];
    expect(
      repairableMissingLabels(conflicting, wanted, [], ["project"]),
    ).toEqual([]);
    expect(
      repairableMissingLabels(conflicting, wanted, ["project"], []),
    ).toEqual([]);
  });
});

describe("retryBackoffMs", () => {
  it("grows with the attempt and is clamped at RETRY_MAX_MS", () => {
    // `random` injected at its extremes so the bound is asserted exactly
    // rather than sampled: full jitter spans [capped/2, capped].
    const lo = () => 0;
    const hi = () => 1;
    expect(retryBackoffMs(1, hi)).toBe(RETRY_BASE_MS);
    expect(retryBackoffMs(1, lo)).toBe(RETRY_BASE_MS / 2);
    expect(retryBackoffMs(2, hi)).toBe(RETRY_BASE_MS * 2);
    expect(retryBackoffMs(3, hi)).toBe(RETRY_BASE_MS * 4);
  });

  it("never exceeds the ceiling however many attempts are asked for", () => {
    // The bounded-retry-count guarantee is only a bounded WALL-CLOCK one if
    // the per-attempt pause is clamped — an unclamped exponential turns a
    // raised APPEND_ATTEMPTS into a multi-minute stall.
    for (const attempt of [4, 8, 20, 64]) {
      expect(retryBackoffMs(attempt, () => 1)).toBe(RETRY_MAX_MS);
      expect(retryBackoffMs(attempt, () => 0)).toBe(RETRY_MAX_MS / 2);
    }
  });

  it("jitters — two calls at the same attempt need not agree", () => {
    const seen = new Set(
      Array.from({ length: 64 }, () => retryBackoffMs(2)).map(String),
    );
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("appendWithRetry — the actual retry loop, against a mock LinearClient", () => {
  // Every OTHER test in this file drives the pure helpers directly on
  // hand-built snapshots. That is precisely the gap: removing the fix's
  // `missingLabels = repairableMissingLabels(...)` line from the live retry
  // path would not fail any of those assertions, because none of them ever RUN
  // the loop. These tests do — with a stateful fake `LinearClient` that
  // actually applies writes and reflects them back on the next read, not a mock
  // that returns canned responses regardless of what was sent (a canned mock
  // would be vacuous in exactly the same way: it could "pass" a broken
  // `addLabels` computation by returning the right answer anyway). A plain
  // never-aborted signal for every test that is not itself exercising the
  // deadline — see the dedicated `RUN_DEADLINE_MS` describe block below.
  const neverAbort = () => new AbortController().signal;
  const threadUrl =
    "https://github.com/example/project/pull/4068#discussion_r1";
  const entry = renderEntry({
    sourceUrl: threadUrl,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });
  const seedDescription = appendEntry(
    "## Entries",
    entry,
    threadUrl,
  ).description;
  const baseArgs: Args = {
    pr: "4068",
    type: "chore",
    sourceUrl: threadUrl,
    entryKey: threadUrl,
    reason: "r",
    // 'unknown' is deliberate for these fixtures: it makes
    // priorityAfterSeverity/priorityReflectsSeverity a no-op (see their own
    // docs — SEVERITY_RANK_ORDER's 'unknown' is the minimum rank, so it never
    // demands a priority bump), so the priority machinery does not interfere
    // with tests that predate it and are not testing priority themselves.
    // Dedicated severity/priority behavior has its own describe block.
    severity: "unknown",
    category: "unknown",
    originating: "TASK-1234",
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
  const fullLabels = [
    label(PROVENANCE_LABEL),
    label("chore", TYPE_GROUP),
    label("small", SIZE_GROUP),
    label("project", REPO_GROUP),
    label("agent:meta"),
    label("domain:tooling"),
  ];
  const withoutAgentMeta = fullLabels.filter((l) => l.name !== "agent:meta");
  const requiredContext = ["agent:meta", "domain:tooling"];

  /** Nothing in this loop may send a whole-set `labelIds` replacement. */
  function refuseWholeSetLabelWrite(input: { labelIds?: unknown }): void {
    if (input.labelIds !== undefined) {
      throw new Error(
        "appendWithRetry sent a whole-set labelIds replacement — that erases a concurrent writer's ownership change and defeats the mid-loop mismatch guard. Labels must be added with issueAddLabel.",
      );
    }
  }

  /**
   * A tiny fake Linear server: applies writes, reflects them on reads.
   *
   * `seedPriority` defaults to `required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN])` (0,
   * None) — the neutral starting point for every test in this describe block
   * that is not itself testing priority escalation (`baseArgs.severity` is
   * `'unknown'` there, so `priorityAfterSeverity`/`priorityReflectsSeverity`
   * never engage regardless of the seed).
   *
   * `priming`, when given, is what the ONE pre-attempt-1 priming read
   * (TASK-7529) sees instead of `seedLabels`/`''` — modelling a concurrent
   * writer's change landing strictly AFTER that read (never before it: this
   * fake cannot express a race priming itself is meant to close, only one
   * that survives it). Every caller that predates priming, and every
   * existing assertion of theirs, keeps seeing the exact call sequence it
   * always did: the distinction between the labelled `'priming'` and
   * `'verify'` entries in `calls` only matters to a test that reads `calls`
   * at all, and defaulting `priming` to `seedLabels`/`''` makes priming a
   * complete no-op wherever a caller does not ask for anything else.
   */
  function makeFakeServer(
    seedLabels: typeof fullLabels,
    seedPriority: number = required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
    priming: { labels?: typeof fullLabels; description?: string } = {},
  ) {
    const byId = new Map(fullLabels.map((l) => [l.id, l] as const));
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    let serverLabels = seedLabels;
    let serverDescription = "";
    let serverPriority = seedPriority;
    let hasWritten = false;
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        // A mutation, exactly like `issueUpdate` below — the pre-attempt-1
        // priming read (TASK-7529) only ever precedes this run's FIRST
        // mutation of any kind, and a label-only repair (no description or
        // priority change) can reach `issueAddLabel` without ever calling
        // `issueUpdate` at all.
        hasWritten = true;
        const added = byId.get(vars.labelId as string);
        // ADDITIVE, exactly as Linear's own mutation is: it appends to
        // whatever is live now and touches nothing else.
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        hasWritten = true;
        const input = vars.input as {
          description?: string;
          labelIds?: string[];
          priority?: number;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        if (input.priority !== undefined) {
          serverPriority = input.priority;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      // The very first non-mutation read, when it happens before this run's
      // own first write, IS `appendWithRetry`'s TASK-7529 priming — labelled
      // distinctly from an ordinary `verify` so a test can assert it
      // actually ran, and so `priming.*` (when given) can model a
      // concurrent writer's change landing strictly AFTER this read.
      if (!hasWritten) {
        calls.push("priming");
        return {
          issue: {
            description: priming.description ?? serverDescription,
            priority: serverPriority,
            labels: {
              pageInfo: { hasNextPage: false },
              nodes: priming.labels ?? serverLabels,
            },
          },
        };
      }
      calls.push("verify");
      return {
        issue: {
          description: serverDescription,
          priority: serverPriority,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };
    return {
      linear,
      calls,
      labelNames: () => serverLabels.map((l) => l.name),
      priority: () => serverPriority,
    };
  }

  /**
   * Records the retry pauses instead of taking them.
   *
   * Injected at every call site that can retry, so the suite never pays the
   * real backoff — and so one test can assert the loop actually paced itself
   * rather than merely tolerating a `sleep` it never calls.
   */
  function recordingSleeper() {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => void slept.push(ms) };
  }

  it("restores a label a CONCURRENT writer erased, even with another context label surviving", async () => {
    // Reproduces the original defect exactly: a batch carrying TWO pre-existing
    // context labels (`agent:meta`, `domain:tooling`) has had only `agent:meta`
    // erased by a concurrent whole-set replacement before this run's own write
    // lands. `domain:tooling` alone would satisfy a generic "is the Context
    // group non-empty" check — this proves the real loop, with the real
    // `requiredContext` wiring, catches and repairs it.
    //
    // `priming` sees the CORRECT, not-yet-erased state — `fullLabels`, and
    // the bare `'## Entries'` this run's own `seedDescription` was built
    // from — matching what `runDeferBatch`'s own initial read saw (mirrored
    // here by `seedAddLabels`/`seedMissingLabels` both being `[]`). The
    // erasure happens strictly AFTER that read, simulated below as landing
    // together with this run's own first write — TASK-7529's priming closes
    // the window before it, not the one after.
    const server = makeFakeServer(withoutAgentMeta, undefined, {
      labels: fullLabels,
      description: "## Entries",
    });
    const clock = recordingSleeper();
    const result = await appendWithRetry(
      server.linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true, // needsInitialWrite — this run appended the entry
      [], // seedAddLabels — nothing looked missing at the initial read
      [], // seedMissingLabels
      entry,
      baseArgs,
      "small", // originalSize — matches the batch's own Size label
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext, // incomingOwnership — same set, guaranteed overlap
      requiredContext,
      neverAbort(),
      clock.sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(server.labelNames().sort()).toEqual(
      fullLabels.map((l) => l.name).sort(),
    );
    // `priming` (TASK-7529) first — sees the correct label set, so it adds
    // nothing to `addLabels` itself — THEN exactly one repair round-trip:
    // write (misses the erasure, which lands with it), verify (detects it),
    // fetchLabels (resolves the repair id), addLabel (restores it), verify
    // (confirms). No second `write`: the retry's rebuilt description equals
    // what is already live and priority never engages (severity is
    // 'unknown'), so `needsDescriptionWrite || priorityChanged` is false and
    // the label-only repair skips the no-op `issueUpdate` entirely — see
    // `needsDescriptionWrite`'s own doc.
    expect(server.calls).toEqual([
      "priming",
      "write",
      "verify",
      "fetchLabels",
      "addLabel",
      "verify",
    ]);
    // The one retry paused before re-entering the burst, and the pause came
    // from `retryBackoffMs`'s clamped range.
    expect(clock.slept.length).toBe(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(RETRY_BASE_MS / 2);
    expect(clock.slept[0]).toBeLessThanOrEqual(RETRY_MAX_MS);
  });

  it("does not need a retry when nothing was erased", async () => {
    // `priming` (TASK-7529) sees the same bare `'## Entries'` baseline
    // `seedDescription` was built from, so its own rebuild lands on exactly
    // that value — nothing for the loop to repair either before or after
    // its one write.
    const server = makeFakeServer(fullLabels, undefined, {
      description: "## Entries",
    });
    const clock = recordingSleeper();
    const result = await appendWithRetry(
      server.linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      baseArgs,
      "small", // originalSize — matches the batch's own Size label
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext, // incomingOwnership — same set, guaranteed overlap
      requiredContext,
      neverAbort(),
      clock.sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(true);
    // `priming` (TASK-7529) first, then the one write + verify.
    expect(server.calls).toEqual(["priming", "write", "verify"]);
    // The happy path must not pay the retry pause at all.
    expect(clock.slept).toEqual([]);
  });

  it("never unions a second Repo label onto a CONFLICTING value, even under real retries", async () => {
    // A concurrent writer REPLACES the Repo label with a different Repo-group
    // value (`website`) between this run's initial read and its verify. The old
    // code read that as an ordinary erasure (`liveNames.has('project')` false)
    // and proposed — and the loop then WROTE, via `issueAddLabel` — a second
    // `project` label onto the live issue, leaving it holding both `website`
    // and `project` (taxonomy-invalid) before the run eventually gave up. This
    // proves the live retry path, not just the pure `repairableMissingLabels`
    // unit test: `issueAddLabel` for 'project' must never be called.
    const website = label("website", REPO_GROUP);
    const withConflictingRepo = fullLabels
      .filter((l) => l.name !== "project")
      .concat(website);
    const byName = new Map(
      [...fullLabels, website].map((l) => [l.name, l] as const),
    );
    const calls: string[] = [];
    const addedLabelNames: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        const labelId = vars.labelId as string;
        const added = [...byName.values()].find((l) => l.id === labelId);
        if (added !== undefined) addedLabelNames.push(added.name);
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        refuseWholeSetLabelWrite(vars.input as { labelIds?: unknown });
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      calls.push("verify");
      return {
        issue: {
          description: seedDescription, // our entry already landed
          labels: {
            pageInfo: { hasNextPage: false },
            nodes: withConflictingRepo,
          },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    // The conflict is never repairable, so the run exhausts its retries and
    // aborts — but the point of this test is what it must NOT have done
    // along the way.
    expect(result.confirmed).toBe(false);
    expect(result.unconfirmed).toContain("Repo group is other-repo");
    expect(addedLabelNames).not.toContain("project");
    expect(calls.filter((c) => c === "addLabel").length).toBe(0);
  });

  it("aborts after APPEND_ATTEMPTS when a writer keeps re-erasing the label", async () => {
    // A pathological but real case: every verify sees the erasure again
    // (the fake concurrent writer never stops). The loop must give up
    // loudly rather than report success.
    //
    // `agent:meta` is ALREADY missing at the pre-attempt-1 priming read too
    // (TASK-7529) — this fixture's erasure was never "concurrent" in the
    // sense of landing in a specific gap, it is simply permanent — so
    // `attempt` (this test's own count of REAL retry-loop iterations) must
    // only advance once this run has made its own first write; the priming
    // read is one more `fetchLabels` round-trip on top of the mid-loop
    // ones, not an "attempt".
    let attempt = 0;
    let hasWritten = false;
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        // A mutation too — see the pre-attempt-1 priming's own read of
        // `agent:meta` as missing: this run's attempt 1 can reach
        // `issueAddLabel` without ever calling `issueUpdate` (no
        // description change to make), so `hasWritten` must flip here too.
        hasWritten = true;
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        hasWritten = true;
        refuseWholeSetLabelWrite(vars.input as { labelIds?: unknown });
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      calls.push(hasWritten ? "verify" : "priming");
      if (hasWritten) attempt++;
      // ALWAYS missing agent:meta, no matter what this run just wrote.
      return {
        issue: {
          description: seedDescription,
          labels: { pageInfo: { hasNextPage: false }, nodes: withoutAgentMeta },
        },
      };
    };

    const clock = recordingSleeper();
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      baseArgs,
      "small", // originalSize — matches the batch's own Size label
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext, // incomingOwnership — same set, guaranteed overlap
      requiredContext,
      neverAbort(),
      clock.sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(false);
    expect(result.unconfirmed).toContain("agent:meta");
    expect(attempt).toBe(APPEND_ATTEMPTS);
    // One pause per attempt that gets to retry — never one after the
    // exhausted attempt, which would delay the abort message for nothing.
    expect(clock.slept.length).toBe(APPEND_ATTEMPTS - 1);
    // Bounded and non-decreasing in expectation: attempt 2's window starts
    // where attempt 1's ceiling is, so no draw can invert them.
    expect(clock.slept[0]).toBeLessThanOrEqual(RETRY_BASE_MS);
    expect(clock.slept[1]).toBeGreaterThanOrEqual(RETRY_BASE_MS);
    for (const ms of clock.slept) expect(ms).toBeLessThanOrEqual(RETRY_MAX_MS);
    // The LAST attempt's failed verify must not rebuild and re-fetch a repair
    // set nothing will ever use — that is pure waste, and a lookup failure on
    // this dead path would replace the useful "concurrent writer keeps
    // overwriting" result with an unrelated fetch error. One fetchLabels per
    // attempt that gets to retry (2, for APPEND_ATTEMPTS=3), never a 3rd for
    // the exhausted attempt — PLUS one more from the pre-attempt-1 priming read
    // (TASK-7529), which shares this same repair-set computation against the
    // label state it sees.
    expect(calls.filter((c) => c === "fetchLabels").length).toBe(
      APPEND_ATTEMPTS,
    );
  });

  it("reports a label added in an EARLIER attempt even when a LATER attempt only repairs the description", async () => {
    // Attempt 1's write successfully adds `agent:meta`, but a concurrent writer
    // clobbers the DESCRIPTION before this run's verify reads it back — so
    // attempt 1 fails on `entryOk`, not on labels. Attempt 2 recomputes
    // `missingLabels` fresh and finds nothing missing (the label already
    // landed), so `addLabels` resets to `[]` — the confirmed result must still
    // report `agent:meta`, because the OLD code returned the current-attempt
    // `missingLabels` (now empty) rather than everything this run ever actually
    // added.
    const agentMetaLabel = fullLabels.find((l) => l.name === "agent:meta");
    if (agentMetaLabel === undefined)
      throw new Error("fixture missing agent:meta");
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    const byId = new Map(fullLabels.map((l) => [l.id, l] as const));
    let serverLabels = withoutAgentMeta;
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        const added = byId.get(vars.labelId as string);
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: string[];
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      verifyCount++;
      // Attempt 1's verify: a concurrent writer clobbered the description —
      // even though OUR label write (above) already landed in `serverLabels`.
      const description =
        verifyCount === 1 ? "clobbered by someone else" : serverDescription;
      return {
        issue: {
          description,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [agentMetaLabel], // seedAddLabels — identified as missing at the read
      ["agent:meta"], // seedMissingLabels
      entry,
      baseArgs,
      "small", // originalSize — matches the batch's own Size label
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext, // incomingOwnership — same set, guaranteed overlap
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(result.labelsAdded).toContain("agent:meta");
  });

  it("the mid-loop description rebuild uses the lost-reason fallback, never this run's own rationale — batch genuinely has no parent", async () => {
    // The mid-loop rebuild's own `initialDescription(args.pr, args.originating,
    // noParentRationaleForRepair(hasParent))` call must NOT present this run's `--no-parent` reason as though it
    // explained the batch's ORIGINAL placement — this run's rationale describes
    // only why THIS append used the flag, and the batch could have been placed
    // parentless by an unrelated original entry. `parent: null` on the fake's
    // issue means the batch genuinely has no parent, so the rebuild must fall
    // back to the generic lost-reason placeholder rather than reusing
    // `noParentArgs.noParentReason`.
    const rationale: NoParentRationale = {
      reason: "compliance-owned finding, different domain than the batch",
      rejectedEpic: "TASK-1111",
    };
    const noParentArgs: Args = {
      ...baseArgs,
      noParent: true,
      noParentReason: rationale.reason,
    };
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: unknown;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      // First verify: the batch's description reads back EMPTY — a
      // concurrent writer wiped it out from under this run's own initial
      // write — forcing the mid-loop rebuild's empty-description branch.
      return {
        issue: {
          description: verifyCount === 1 ? "" : serverDescription,
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      noParentArgs,
      "small", // originalSize — matches the batch's own Size label
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext, // incomingOwnership — same set, guaranteed overlap
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(serverDescription).toContain("**No epic parent**");
    expect(serverDescription).not.toContain(rationale.reason);
    expect(serverDescription).not.toContain("TASK-1111");
    expect(serverDescription).toContain(
      "the original reason was lost when its description was cleared",
    );
  });

  it('does NOT claim "No epic parent" rebuilding a wiped description for a batch that IS parented', async () => {
    // This run passes `--no-parent` (e.g. it appended to a batch it believes
    // shares no domain with its own originating epic), but the BATCH itself —
    // read fresh, right here — still carries a real `parent`, because an append
    // never changes or reads that field; only the batch's FIRST entry decided
    // it. Rebuilding a wiped description from THIS run's own
    // `noParentRationale` would assert `**No epic parent**` and name this run's
    // rejected epic while the issue's own `parent` field stays set underneath
    // it — a description that contradicts the issue it describes. The rebuild
    // must instead read `issue.parent` and skip the no-parent block entirely.
    const rationale: NoParentRationale = {
      reason: "compliance-owned finding, different domain than the batch",
      rejectedEpic: "TASK-1111",
    };
    const noParentArgs: Args = {
      ...baseArgs,
      noParent: true,
      noParentReason: rationale.reason,
    };
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: unknown;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      return {
        issue: {
          description: verifyCount === 1 ? "" : serverDescription,
          // The batch's FIRST entry selected a normal epic parent — still
          // set, unaffected by this run's own `--no-parent`.
          parent: { id: "epic-uuid-1" },
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      noParentArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(serverDescription).not.toContain("No epic parent");
    expect(serverDescription).not.toContain(rationale.reason);
    expect(serverDescription).not.toContain("TASK-1111");
  });

  it("treats a response with NO `parent` field the same as an explicit null (genuinely no parent)", async () => {
    // `issue.parent !== null` would read a response missing the field entirely
    // (`undefined`, e.g. a hand-built test double, or a future query shape
    // mistake) as "has a parent" — silently DROPPING the no-parent block from a
    // genuinely parentless batch, the opposite corruption from the one this PR
    // fixes. `!= null` treats `undefined` and `null` alike. This fake
    // deliberately omits `parent` from its verify response.
    const rationale: NoParentRationale = {
      reason: "compliance-owned finding, different domain than the batch",
      rejectedEpic: "TASK-1111",
    };
    const noParentArgs: Args = {
      ...baseArgs,
      noParent: true,
      noParentReason: rationale.reason,
    };
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: unknown;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      return {
        // `parent` deliberately absent — not `parent: null`.
        issue: {
          description: verifyCount === 1 ? "" : serverDescription,
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      noParentArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(serverDescription).toContain("**No epic parent**");
    expect(serverDescription).not.toContain(rationale.reason);
    expect(serverDescription).toContain(
      "the original reason was lost when its description was cleared",
    );
  });

  it("aborts rather than repairing when ownership changed mid-append (concurrent owner swap)", async () => {
    // The pre-loop `ownerDomainMismatches` guard (in `main()`) only checks the
    // INITIAL read. A concurrent writer that swaps `agent:meta` for
    // `agent:compliance` between that read and this run's own verify looks, to
    // `repairableMissingLabels`, exactly like an ordinary erased label — so the
    // loop would otherwise silently re-add `agent:meta` into a batch a
    // concurrent writer moved to a different owner. `incomingOwnership`
    // re-checks this on every fresh read INSIDE the loop, not just once before
    // it starts.
    const agentCompliance = label("agent:compliance");
    const swappedLabels = [...withoutAgentMeta, agentCompliance];
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        refuseWholeSetLabelWrite(vars.input as { labelIds?: unknown });
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      calls.push("verify");
      return {
        issue: {
          description: seedDescription, // our entry already landed
          labels: { pageInfo: { hasNextPage: false }, nodes: swappedLabels },
        },
      };
    };
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        seedDescription,
        false, // seedWasRepaired -- these tests seed from a non-empty description
        true,
        [],
        [],
        entry,
        baseArgs,
        "small", // originalSize — matches the batch's own Size label
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext, // incomingOwnership: ['agent:meta', 'domain:tooling']
        requiredContext,
        neverAbort(),
        recordingSleeper().sleep,
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("ownership changed mid-append");
    } finally {
      errSpy.mockRestore();
    }
    // Aborts BEFORE attempting any repair — no fetchLabels call, and (TASK-
    // 7529: this mock's owner swap is visible from the very first read, so
    // the pre-attempt-1 priming read now catches it before ANY write, not
    // only the ORIGINAL initial write this test used to reach) no write at
    // all, never a second one re-adding the erased label.
    expect(calls).not.toContain("fetchLabels");
    expect(calls.filter((c) => c === "write").length).toBe(0);
  });

  it("aborts on a mid-append owner swap even when this run HAS labels to add", async () => {
    // The test above passes `seedAddLabels: []`, so the old code never emitted
    // `labelIds` at all and the whole-set replacement path went unexercised.
    // With ANY label to add, the old write sent
    // `unionLabelIds(seedLiveLabels, addLabels)` — the STALE snapshot, still
    // carrying `agent:meta` — which restored the owner the concurrent writer
    // had just swapped away. The verify then read back `agent:meta` (its own
    // write), found no mismatch, and CONFIRMED an append into a batch that had
    // moved to a different owner.
    //
    // The fake server below is stateful precisely so it can catch that: it
    // applies whatever the loop writes and reflects it back, so a whole-set
    // replacement really would erase `agent:compliance` here rather than
    // being waved through by a canned response.
    const agentCompliance = label("agent:compliance");
    const manualOps = label("manual-ops");
    const universe = [...fullLabels, agentCompliance, manualOps];
    const byId = new Map(universe.map((l) => [l.id, l] as const));
    // The batch as it is NOW: a concurrent writer swapped the owner between
    // this run's initial read (which still saw `agent:meta`) and this write.
    let serverLabels = [...withoutAgentMeta, agentCompliance];
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        const added = byId.get(vars.labelId as string);
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        const input = vars.input as { labelIds?: string[] };
        // Model Linear's real semantics rather than refusing: this test must
        // fail on the CONFIRMATION a whole-set write buys, not on the fake
        // server's own assertion — otherwise it would pass against any
        // rewrite that merely stopped sending `labelIds` while still
        // re-asserting a stale snapshot some other way.
        if (input.labelIds !== undefined) {
          serverLabels = input.labelIds
            .map((id) => byId.get(id))
            .filter((l): l is (typeof universe)[number] => l !== undefined);
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        return { issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] } };
      }
      calls.push("verify");
      return {
        issue: {
          description: seedDescription, // our entry already landed
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        seedDescription,
        false, // seedWasRepaired -- these tests seed from a non-empty description
        true,
        [manualOps], // seedAddLabels — NON-empty: the untested path
        ["manual-ops"], // seedMissingLabels
        entry,
        { ...baseArgs, extraLabels: ["manual-ops"] },
        "small",
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext, // incomingOwnership: ['agent:meta', 'domain:tooling']
        requiredContext,
        neverAbort(),
        recordingSleeper().sleep,
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("ownership changed mid-append");
      expect(messages).toContain("agent:compliance");
    } finally {
      errSpy.mockRestore();
    }
    // The concurrent writer's ownership change survived this run untouched —
    // the property a whole-set write cannot offer.
    expect(serverLabels.map((l) => l.name)).toContain("agent:compliance");
    expect(serverLabels.map((l) => l.name)).not.toContain("agent:meta");
    expect(calls).not.toContain("fetchLabels");
  });

  it("restores the batch's OWN Size when erased, not this run's args.size", async () => {
    // A differing Size is deliberately TOLERATED (both are legitimate batch
    // sizes), so if a concurrent writer erases the Size label ENTIRELY,
    // repairing it with `args.size` (this run's own value, `small`) would
    // silently resize a batch that was legitimately `xs` — and
    // `batchContractHolds` would accept the drift, since it tolerates either
    // batchable size.
    const xsLabel = label("xs", SIZE_GROUP);
    const xsLabels = fullLabels.map((l) => (l.name === "small" ? xsLabel : l));
    const withoutSize = xsLabels.filter((l) => l.name !== "xs");
    const byId = new Map(xsLabels.map((l) => [l.id, l] as const));
    const byName = new Map(xsLabels.map((l) => [l.name, l] as const));
    let serverLabels = withoutSize;
    let serverDescription = "";
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        const added = byId.get(vars.labelId as string);
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: string[];
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof xsLabels)[number] => l !== undefined),
          },
        };
      }
      return {
        issue: {
          description: serverDescription,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      true,
      [],
      [],
      entry,
      baseArgs, // args.size = 'small'
      "xs", // originalSize — the batch's OWN size, frozen at the read
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    const names = serverLabels.map((l) => l.name);
    expect(names).toContain("xs");
    expect(names).not.toContain("small");
  });

  // ── Priority escalation against the real retry loop (TASK-7491) ───────────

  it("escalates an existing batch at None(0) to the new finding’s derived priority", async () => {
    const server = makeFakeServer(
      fullLabels,
      required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
    );
    const highArgs: Args = { ...baseArgs, severity: "high" };
    const result = await appendWithRetry(
      server.linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired -- these tests seed from a non-empty description
      // needsInitialWrite: mirrors runDeferBatch's own third disjunct —
      // priorityReflectsSeverity(0, 'high') is false, so a write is needed.
      !priorityReflectsSeverity(0, "high"),
      [],
      [],
      entry,
      highArgs,
      "small",
      0, // originalPriority — the batch's live priority at the read (None)
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      !priorityReflectsSeverity(0, "high"), // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(server.priority()).toBe(required(SEVERITY_TO_PRIORITY.high));
  });

  it("does NOT downgrade a batch already at a MORE severe priority than the incoming finding", async () => {
    // Live priority 1 (Urgent, from an earlier blocker finding). This run's
    // OWN finding is only 'low' — its priority must be left at Urgent, never
    // pulled down to Low. `needsInitialWrite: true` here mirrors this
    // describe block's own convention (every other test seeds the fake
    // server's description via an initial write, since the fake — unlike
    // real Linear — starts genuinely empty regardless of `seedDescription`);
    // what this test actually isolates is that the write LINEAR receives
    // never carries a `priority` field that would downgrade it — see
    // `sentPriorities` below.
    const byId = new Map(fullLabels.map((l) => [l.id, l] as const));
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    let serverLabels = fullLabels;
    let serverDescription = "";
    let serverPriority = required(SEVERITY_TO_PRIORITY.blocker);
    const sentPriorities: number[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        const added = byId.get(vars.labelId as string);
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as {
          description?: string;
          labelIds?: string[];
          priority?: number;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined)
          serverDescription = input.description;
        if (input.priority !== undefined) {
          sentPriorities.push(input.priority);
          serverPriority = input.priority;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      return {
        issue: {
          description: serverDescription,
          priority: serverPriority,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };

    const lowArgs: Args = { ...baseArgs, severity: "low" };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false,
      true, // needsInitialWrite — this run appended the entry
      [],
      [],
      entry,
      lowArgs,
      "small",
      required(SEVERITY_TO_PRIORITY.blocker), // originalPriority — Urgent, from an earlier finding
      requiredContext,
      requiredContext,
      neverAbort(),
      recordingSleeper().sleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(serverPriority).toBe(required(SEVERITY_TO_PRIORITY.blocker));
    // The write for the entry happened, but it never carried a `priority`
    // field at all — priorityAfterSeverity(1, 'low') is a no-op (1 !== 4's
    // target, it stays 1), so `priorityChanged` is false and the field is
    // omitted, exactly as the "only send it when it differs" contract
    // requires.
    expect(sentPriorities).toEqual([]);
  });

  it("corrects a concurrent writer that LOWERS the priority mid-loop, back up on retry", async () => {
    // Attempt 1's write lands (server priority -> High). A concurrent writer
    // then lowers it back to None before this run's own verify reads it —
    // the scalar-field analogue of the label-erasure races this describe
    // block already covers. The loop must escalate it again on retry rather
    // than reporting `confirmed` over a live priority that no longer
    // reflects the severity this run's reply claims is tracked.
    const byId = new Map(fullLabels.map((l) => [l.id, l] as const));
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    let serverLabels = fullLabels;
    let serverDescription = seedDescription;
    let serverPriority = required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]);
    let hasWrittenOnce = false;
    let downgradeApplied = false;
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        const added = byId.get(vars.labelId as string);
        if (added !== undefined && !serverLabels.some((l) => l.id === added.id))
          serverLabels = [...serverLabels, added];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        const input = vars.input as {
          description?: string;
          labelIds?: string[];
          priority?: number;
        };
        refuseWholeSetLabelWrite(input);
        if (input.description !== undefined)
          serverDescription = input.description;
        if (input.priority !== undefined) serverPriority = input.priority;
        hasWrittenOnce = true;
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        calls.push("fetchLabels");
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      calls.push("verify");
      // Keyed on the first REAL write having landed, not on this being the
      // Nth call to hit this branch — the new priority-priming read
      // (`appendWithRetry`, ahead of attempt 1) also lands here, and keying
      // on call position would let it consume this simulated downgrade
      // before attempt 1 ever wrote anything.
      if (hasWrittenOnce && !downgradeApplied) {
        // The concurrent writer's downgrade — reported on THIS verify, right
        // after attempt 1's own write already landed High.
        serverPriority = required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]);
        downgradeApplied = true;
      }
      return {
        issue: {
          description: serverDescription,
          priority: serverPriority,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };

    const highArgs: Args = { ...baseArgs, severity: "high" };
    const clock = recordingSleeper();
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false,
      !priorityReflectsSeverity(
        required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
        "high",
      ),
      [],
      [],
      entry,
      highArgs,
      "small",
      required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
      requiredContext,
      requiredContext,
      neverAbort(),
      clock.sleep,
      !priorityReflectsSeverity(
        required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
        "high",
      ), // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );

    expect(result.confirmed).toBe(true);
    expect(serverPriority).toBe(required(SEVERITY_TO_PRIORITY.high));
    // Two writes: the first (undone by the concurrent downgrade), the
    // repair on retry.
    expect(calls.filter((c) => c === "write").length).toBe(2);
    expect(clock.slept.length).toBe(1);
  });

  it("does not downgrade a concurrent escalation that lands between the initial read and the first write", async () => {
    // `originalPriority` below is a STALE snapshot: None (0), read at the
    // initial candidate lookup. Before this run's first write, a concurrent
    // writer already escalated the live priority to Urgent (1) — computing
    // attempt 1's write straight from the stale 0 would have computed
    // priorityAfterSeverity(0, 'high') = 2 (High) and downgraded the live
    // Urgent. The only reason this run writes at all IS the (stale-looking)
    // priority bump — labels are complete and the entry is already present —
    // so a correct fix must discover the real live value before ever
    // deciding what to write, and must send NO priority field once it does.
    let serverPriority = required(SEVERITY_TO_PRIORITY.blocker); // 1 — already escalated, live
    const sentPriorities: number[] = [];
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueUpdate")) {
        calls.push("write");
        const input = vars.input as { priority?: number };
        if (input.priority !== undefined) {
          sentPriorities.push(input.priority);
          serverPriority = input.priority;
        }
        return { issueUpdate: { success: true } };
      }
      calls.push("verify");
      return {
        issue: {
          description: seedDescription,
          priority: serverPriority,
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };

    const highArgs: Args = { ...baseArgs, severity: "high" };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired
      // needsInitialWrite — the batch's only outstanding reason to write is
      // the (stale-looking) priority bump; the entry is already present and
      // no label is missing.
      !priorityReflectsSeverity(
        required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
        "high",
      ),
      [], // seedAddLabels
      [], // seedMissingLabels
      entry,
      highArgs,
      "small",
      required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]), // originalPriority — the STALE 0
      requiredContext,
      requiredContext,
      neverAbort(),
      undefined, // sleep
      false, // needsInitialDescriptionWrite — no description change to make
    );

    expect(result.confirmed).toBe(true);
    // Never downgraded: the live Urgent (1) survives untouched, and no
    // priority field was ever sent — the primed read already found it
    // sufficient, so `priorityChanged` was false on every attempt.
    expect(serverPriority).toBe(required(SEVERITY_TO_PRIORITY.blocker));
    expect(sentPriorities).toEqual([]);
    // Zero mutation writes: the primed read discovered the contract was
    // already satisfied before attempt 1 ever decided what to send.
    expect(calls.filter((c) => c === "write").length).toBe(0);
  });

  it("does not clobber a concurrently appended entry when the write is triggered by a missing label alone, not a description change", async () => {
    // This run's OWN read, at the initial candidate lookup, saw a
    // description carrying only its own entry — `seedDescription`. Before
    // this run's first write, a DIFFERENT concurrent invocation appended its
    // own entry, so the LIVE description already carries both. This run's
    // only reason to write at all is a missing label
    // (`needsInitialWrite: true` below, for `addLabels`) — NOT the
    // description, so `needsInitialDescriptionWrite: false` — and it must
    // never resend its own stale snapshot, which would silently erase the
    // concurrent entry.
    const otherThreadUrl =
      "https://github.com/example/project/pull/4068#discussion_r2";
    const otherEntry = renderEntry({
      sourceUrl: otherThreadUrl,
      finding: "a different finding",
      reason: "r",
      severity: "unknown",
      category: "unknown",
    });
    const liveDescriptionWithConcurrentEntry = appendEntry(
      seedDescription,
      otherEntry,
      otherThreadUrl,
    ).description;
    const missingLabel = required(
      fullLabels.find((l) => l.name === "agent:meta"),
    );
    let serverLabels = withoutAgentMeta;
    let serverDescription = liveDescriptionWithConcurrentEntry;
    const calls: string[] = [];
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        calls.push("addLabel");
        if (
          vars.labelId === missingLabel.id &&
          !serverLabels.some((l) => l.id === missingLabel.id)
        )
          serverLabels = [...serverLabels, missingLabel];
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        calls.push("write");
        const input = vars.input as { description?: string };
        refuseWholeSetLabelWrite(input as { labelIds?: unknown });
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      calls.push("verify");
      return {
        issue: {
          description: serverDescription,
          priority: required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };

    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription, // this run's OWN (stale) belief — lacks the concurrent entry
      false, // seedWasRepaired
      true, // needsInitialWrite — a label is missing
      [missingLabel], // seedAddLabels
      ["agent:meta"], // seedMissingLabels
      entry,
      baseArgs,
      "small",
      required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
      requiredContext,
      requiredContext,
      neverAbort(),
      undefined, // sleep
      false, // needsInitialDescriptionWrite — no description change, only a missing label
    );

    expect(result.confirmed).toBe(true);
    // Byte-identical: the description mutation was never sent at all, so the
    // concurrent entry survives exactly as it was.
    expect(serverDescription).toBe(liveDescriptionWithConcurrentEntry);
    expect(serverDescription).toContain(otherEntry);
    expect(calls).not.toContain("write");
    expect(serverLabels.map((l) => l.name)).toContain("agent:meta");
  });
});

// ── Placement claim vs a freshly read parent ────────────────────────────────

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
      "Batch of review deferrals from PR #4068; originating issue TASK-1.\n\n## Entries\n\n### Some entry\n\nFinding: `description.includes('**No epic parent**')` is too broad.";
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

describe("appendWithRetry — the stale-parent placement race, against a mock LinearClient", () => {
  const threadUrl =
    "https://github.com/example/project/pull/4068#discussion_r1";
  const entry = renderEntry({
    sourceUrl: threadUrl,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });
  // A rebuilt scaffold that claims no parent — what `descriptionForRepair`
  // builds when the batch's `parent` looked null at the STALE read this
  // run's seed was built from (`main()`'s initial candidate lookup).
  const rebuiltNoParentDescription = appendEntry(
    initialDescription("4068", "TASK-1234", {
      reason:
        "the batch was filed with no epic parent; the original reason was lost when its description was cleared and this repair could not recover it",
      rejectedEpic: null,
    }),
    entry,
    threadUrl,
  ).description;
  const baseArgs: Args = {
    pr: "4068",
    type: "chore",
    sourceUrl: threadUrl,
    entryKey: threadUrl,
    reason: "r",
    // 'unknown' is deliberate for these fixtures: it makes
    // priorityAfterSeverity/priorityReflectsSeverity a no-op (see their own
    // docs — SEVERITY_RANK_ORDER's 'unknown' is the minimum rank, so it never
    // demands a priority bump), so the priority machinery does not interfere
    // with tests that predate it and are not testing priority themselves.
    // Dedicated severity/priority behavior has its own describe block.
    severity: "unknown",
    category: "unknown",
    originating: "TASK-1234",
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
  const fullLabels = [
    label(PROVENANCE_LABEL),
    label("chore", TYPE_GROUP),
    label("small", SIZE_GROUP),
    label("project", REPO_GROUP),
    label("agent:meta"),
    label("domain:tooling"),
  ];
  const requiredContext = ["agent:meta", "domain:tooling"];

  it("aborts rather than confirming when a concurrent reparent contradicts the rebuilt scaffold's placement claim", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // TASK-7529: `appendWithRetry`'s own pre-attempt-1 priming does a
      // FRESH full read — including `parent` — before ever writing, which
      // closes the window this test used to model (a reparent between the
      // CALLER's stale initial read and attempt 1's write): priming would
      // see the reparent too and rebuild a scaffold that already agrees
      // with it, leaving nothing for the mid-loop check to catch. The race
      // this test proves must still be caught has to land AFTER priming's
      // own read — modelled here as landing together with attempt 1's
      // write, exactly like the mid-loop-rebuild tests elsewhere in this
      // file. `queryCount` distinguishes the ONE priming read (still WIPED
      // and parentless — exactly what `seedWasRepaired: true` below claims
      // this run's OWN seed was built from) from every read after it
      // (reparented).
      let queryCount = 0;
      const linear: LinearClient = async (query) => {
        if (query.includes("issueUpdate")) {
          return { issueUpdate: { success: true } };
        }
        queryCount++;
        if (queryCount === 1) {
          // The priming read: still wiped and parentless — agrees with this
          // run's own seed, so priming's rebuild lands on exactly
          // `rebuiltNoParentDescription` too (the same
          // `descriptionForRepair('', ..., hasParent: false)` construction),
          // and attempt 1 writes that, same as before this fix.
          return {
            issue: {
              description: "",
              parent: null,
              labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
            },
          };
        }
        // Entry and every label are fine — only the placement claim is
        // wrong: a concurrent writer reparented the issue between the
        // priming read and this verify.
        return {
          issue: {
            description: rebuiltNoParentDescription,
            parent: { id: "epic-uuid-1" },
            labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
          },
        };
      };
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        rebuiltNoParentDescription,
        true, // seedWasRepaired — this run's seed WAS a wipe-rebuild
        true, // needsInitialWrite
        [],
        [],
        entry,
        baseArgs,
        "small",
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext,
        requiredContext,
        new AbortController().signal,
        undefined, // sleep — default real timer
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("no epic parent");
      expect(messages).toContain("HAS");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("tells the operator to edit ONLY the scaffold line and preserves every entry — regression for the blank-the-whole-description bug", async () => {
    // A concurrent writer appended a SECOND entry (a different review
    // thread) after this run's own rebuild — exactly the entry the old
    // "blank the whole description" instruction would have destroyed.
    const concurrentEntry = renderEntry({
      sourceUrl: "https://github.com/example/project/pull/4068#discussion_r2",
      finding: "a different, concurrently-filed finding",
      reason: "r2",
      severity: "unknown",
      category: "unknown",
    });
    const liveDescriptionWithConcurrentEntry = appendEntry(
      rebuiltNoParentDescription,
      concurrentEntry,
      "https://github.com/example/project/pull/4068#discussion_r2",
    ).description;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // See the previous test's own comment: the pre-attempt-1 priming read
      // (TASK-7529) must see the UNRACED state — still WIPED and
      // parentless, exactly what `seedWasRepaired: true` below claims —
      // so its rebuild agrees with this run's seed; the reparent AND the
      // concurrent entry both land strictly after it.
      let queryCount = 0;
      const linear: LinearClient = async (query) => {
        if (query.includes("issueUpdate")) {
          return { issueUpdate: { success: true } };
        }
        queryCount++;
        if (queryCount === 1) {
          return {
            issue: {
              description: "",
              parent: null,
              labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
            },
          };
        }
        return {
          issue: {
            description: liveDescriptionWithConcurrentEntry,
            parent: { id: "epic-uuid-1" },
            labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
          },
        };
      };
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        rebuiltNoParentDescription,
        true,
        true,
        [],
        [],
        entry,
        baseArgs,
        "small",
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext,
        requiredContext,
        new AbortController().signal,
        undefined, // sleep — default real timer
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      // The claim in THIS fixture is "no epic parent" against a fresh read
      // that HAS one, so the surgery is a removal.
      expect(messages).toContain('remove the "**No epic parent**');
      expect(messages).toContain("do NOT blank the whole description");
      expect(messages).toContain("## Entries");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("tells the operator to ADD the scaffold line when the reverse race leaves the batch wrongly claiming a parent", async () => {
    // The mirror fixture: this run rebuilt a scaffold that asserts a
    // parent (no `**No epic parent**` block at all — what
    // `noParentRationaleForRepair(true)` / `initialDescription` with no
    // third argument produce), but a concurrent writer has since
    // unparented the issue.
    const rebuiltHasParentDescription = appendEntry(
      initialDescription("4068", "TASK-1234"),
      entry,
      threadUrl,
    ).description;
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // Same TASK-7529 narrowing as the two tests above: the pre-attempt-1
      // priming read must see the UNRACED state — still WIPED, and still
      // parented (matching this run's own seed claim) — so its rebuild
      // lands on exactly `rebuiltHasParentDescription` too, and the
      // unparent race lands strictly after it.
      let queryCount = 0;
      const linear: LinearClient = async (query) => {
        if (query.includes("issueUpdate")) {
          return { issueUpdate: { success: true } };
        }
        queryCount++;
        if (queryCount === 1) {
          return {
            issue: {
              description: "",
              parent: { id: "epic-uuid-1" },
              labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
            },
          };
        }
        return {
          issue: {
            description: rebuiltHasParentDescription,
            parent: null,
            labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
          },
        };
      };
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        rebuiltHasParentDescription,
        true,
        true,
        [],
        [],
        entry,
        baseArgs,
        "small",
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext,
        requiredContext,
        new AbortController().signal,
        undefined, // sleep — default real timer
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain('add a "**No epic parent**');
      expect(messages).toContain("do NOT blank the whole description");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("does NOT abort when the placement claim matches the fresh read", async () => {
    const linear: LinearClient = async (query) => {
      if (query.includes("issueUpdate")) {
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: rebuiltNoParentDescription,
          parent: null, // still genuinely parentless — matches the claim
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      rebuiltNoParentDescription,
      true,
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      new AbortController().signal,
      undefined, // sleep — default real timer
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(true);
  });

  it("does NOT enforce placement for an ordinary append this run never rebuilt", async () => {
    // RECONCILE deliberately never touches placement for a batch this run
    // did not rebuild (`descriptionForRepair`'s own doc) — an unrelated
    // later reparent of an ordinary, untouched batch must not abort an
    // otherwise-healthy append.
    const linear: LinearClient = async (query) => {
      if (query.includes("issueUpdate")) {
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: rebuiltNoParentDescription,
          parent: { id: "epic-uuid-1" },
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      rebuiltNoParentDescription,
      false, // seedWasRepaired — this run's own seed did NOT rebuild it
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      new AbortController().signal,
      undefined, // sleep — default real timer
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(true);
  });

  it("retries through an ordinary concurrent RE-WIPE instead of aborting, even when everRebuiltScaffold is true", async () => {
    // Gating the placement check AHEAD of `entryOk` made this exact scenario —
    // the mid-loop rebuild's bread-and-butter case, already covered (with
    // `seedWasRepaired: false`) by the `appendWithRetry` describe block's "the
    // mid-loop description rebuild uses the lost-reason fallback..." test above
    // — abort instead of self-repairing whenever `seedWasRepaired` happened to
    // be `true`. The correlation is adversarial, not an edge case: a writer
    // that wipes descriptions is exactly the writer `everRebuiltScaffold` was
    // already true for.
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as { description?: string };
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      // First verify: a concurrent writer wiped the description AGAIN,
      // right after this run's own write. The batch genuinely has no
      // parent throughout — there is no real placement mismatch here, only
      // an ordinary wipe the ordinary mid-loop rebuild must repair.
      return {
        issue: {
          description: verifyCount === 1 ? "" : serverDescription,
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      rebuiltNoParentDescription,
      true, // seedWasRepaired — this run's OWN seed also came from a rebuild
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      new AbortController().signal,
      async () => {}, // sleep — this test reaches attempt 2; no real backoff delay
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(true);
    expect(serverDescription).toContain("**No epic parent**");
    // Confirms it actually took the retry path (attempt 2), not a
    // first-attempt fluke.
    expect(verifyCount).toBe(2);
  });

  it("sets everRebuiltScaffold from a MID-LOOP rebuild, not just the seed — a LATER placement race is still caught", async () => {
    // `everRebuiltScaffold`'s mid-loop `||` update (flips to `true` when THIS
    // run's own retry rebuild fires, not only from its seed) had no test whose
    // failure depended on it. This run's OWN seed is NOT a rebuild
    // (`seedWasRepaired: false`, an ordinary append), but a concurrent writer
    // wipes the description mid-loop, forcing the ordinary mid-loop rebuild to
    // fire on attempt 1 — which is what must flip `everRebuiltScaffold` so a
    // SECOND, later race (another concurrent reparent, on attempt 2) is still
    // caught rather than silently confirmed.
    const ordinaryDescription = appendEntry(
      "## Entries",
      entry,
      threadUrl,
    ).description;
    let serverDescription = "";
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        const input = vars.input as { description?: string };
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      if (verifyCount === 1) {
        // A concurrent writer wipes the description — an ordinary wipe,
        // nothing to do with placement yet.
        return {
          issue: {
            description: "",
            parent: null,
            labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
          },
        };
      }
      // Attempt 2's verify: attempt 1's rebuild landed, but ANOTHER
      // concurrent writer has since reparented the issue — a real
      // placement race, reachable only because attempt 1's mid-loop
      // rebuild set `everRebuiltScaffold`.
      return {
        issue: {
          description: serverDescription,
          parent: { id: "epic-uuid-1" },
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const promise = appendWithRetry(
        linear,
        { id: "issue-1", identifier: "TASK-9999" },
        ordinaryDescription,
        false, // seedWasRepaired — this run's OWN seed was ordinary
        true,
        [],
        [],
        entry,
        baseArgs,
        "small",
        0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
        requiredContext,
        requiredContext,
        new AbortController().signal,
        async () => {}, // sleep — this test reaches attempt 2; no real backoff delay
        true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
      );
      await expect(promise).rejects.toBeInstanceOf(ExitError);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("no epic parent");
    } finally {
      errSpy.mockRestore();
    }
    expect(verifyCount).toBe(2);
  });

  it("does NOT clobber a DIFFERENT concurrent writer's entry that landed between the caller's initial read and attempt 1 — the TASK-7529 regression", async () => {
    // The bug this fix closes, proven directly rather than through the
    // placement side-effect the tests above use: `seedDescription` here is
    // built the same way `runDeferBatch`'s own initial read/rebuild would
    // — from a batch that, AT THAT READ, carried only whatever was live
    // then — and contains ONLY this run's own entry. Before this fix,
    // attempt 1 sent this stale, caller-computed value completely
    // unconditionally. A DIFFERENT `defer-batch` invocation — a different
    // finding, a different `threadUrl` — can read, append ITS OWN entry,
    // and write in the exact gap between that caller read and this run's
    // attempt-1 write; since attempt 1 used to send the whole stale
    // `seedDescription` (which never contained the concurrent entry), its
    // write ERASED it. The mid-loop verify only ever checked
    // `hasEntry(liveDescription, args.threadUrl)` for THIS run's OWN
    // thread — nothing there would ever notice a DIFFERENT entry went
    // missing, so the clobber passed silently and `result.confirmed` came
    // back `true` anyway.
    const staleSeedDescription = appendEntry(
      "## Entries",
      entry,
      threadUrl,
    ).description;
    const concurrentThreadUrl =
      "https://github.com/example/project/pull/4068#discussion_r99";
    const concurrentEntry = renderEntry({
      sourceUrl: concurrentThreadUrl,
      finding: "a different, concurrently-filed finding",
      reason: "r2",
      severity: "unknown",
      category: "unknown",
    });
    // The LIVE state by the time THIS run's own priming read (TASK-7529)
    // fires: the concurrent writer's own append already landed, but this
    // run's OWN entry — from `staleSeedDescription`, computed before any
    // of that happened — is NOT there yet.
    let serverDescription = appendEntry(
      "## Entries",
      concurrentEntry,
      concurrentThreadUrl,
    ).description;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueUpdate")) {
        const input = vars.input as { description?: string };
        if (input.description !== undefined) {
          serverDescription = input.description;
        }
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueAddLabel")) {
        return { issueAddLabel: { success: true } };
      }
      return {
        issue: {
          description: serverDescription,
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: fullLabels },
        },
      };
    };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      staleSeedDescription,
      false, // seedWasRepaired — an ordinary append, not a wipe-rebuild
      true, // needsInitialWrite
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      new AbortController().signal,
      undefined, // sleep — default real timer
      true, // needsInitialDescriptionWrite — the exact write this fix's priming closes the clobber window for
    );
    expect(result.confirmed).toBe(true);
    // The clobber this fix closes: whatever this run ultimately wrote must
    // carry BOTH entries — its own AND the concurrent writer's — never just
    // its own at the concurrent writer's expense.
    expect(serverDescription).toContain(threadUrl);
    expect(serverDescription).toContain(concurrentThreadUrl);
  });
});

// ── The run-wide deadline (RUN_DEADLINE_MS) ─────────────────────────────────

describe("appendWithRetry — the run-wide deadline", () => {
  const threadUrl =
    "https://github.com/example/project/pull/4068#discussion_r1";
  const entry = renderEntry({
    sourceUrl: threadUrl,
    finding: "f",
    reason: "r",
    severity: "unknown",
    category: "unknown",
  });
  const seedDescription = appendEntry(
    "## Entries",
    entry,
    threadUrl,
  ).description;
  const baseArgs: Args = {
    pr: "4068",
    type: "chore",
    sourceUrl: threadUrl,
    entryKey: threadUrl,
    reason: "r",
    // 'unknown' is deliberate for these fixtures: it makes
    // priorityAfterSeverity/priorityReflectsSeverity a no-op (see their own
    // docs — SEVERITY_RANK_ORDER's 'unknown' is the minimum rank, so it never
    // demands a priority bump), so the priority machinery does not interfere
    // with tests that predate it and are not testing priority themselves.
    // Dedicated severity/priority behavior has its own describe block.
    severity: "unknown",
    category: "unknown",
    originating: "TASK-1234",
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
  const requiredContext = ["agent:meta", "domain:tooling"];

  it("aborts before making any call when the deadline has already elapsed", async () => {
    const calls: string[] = [];
    const linear: LinearClient = async (query) => {
      calls.push(query);
      throw new Error("must not be called once the deadline has elapsed");
    };
    const controller = new AbortController();
    controller.abort();
    const promise = appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false,
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      controller.signal,
      undefined, // sleep — default real timer
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    await expect(promise).rejects.toBeInstanceOf(ExitError);
    expect(calls).toEqual([]);
  });

  it("aborts mid-loop once the deadline elapses between attempts, rather than exhausting APPEND_ATTEMPTS", async () => {
    // A stalled Linear request pinning the unattended drive loop forever is
    // exactly what a per-call timeout inside ONE implementation cannot
    // prevent on its own — the LOOP itself must also respect the deadline,
    // not just retry APPEND_ATTEMPTS times regardless of how long that takes.
    const controller = new AbortController();
    let verifyCount = 0;
    let labelFetchCount = 0;
    const linear: LinearClient = async (query) => {
      if (query.includes("issueUpdate")) {
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        // Reachable only if the loop proceeds PAST the deadline check that
        // runs right after the retry pause, into the mid-loop label-repair
        // lookup — the exact round-trip that check exists to skip. Without
        // this branch (and the assertion on it below), the test only proved
        // SOME check eventually caught the abort — even a version missing the
        // post-sleep `checkDeadline` call still passed, one wasted
        // `fetchLabels` round-trip later, via the next attempt's top-of-loop
        // check alone.
        labelFetchCount++;
        return {
          issueLabels: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      }
      verifyCount++;
      // The deadline elapses right after the first verify — simulating it
      // firing mid-retry. Every label is ALSO missing here (not just the
      // entry), so a loop that skipped the post-sleep deadline check would
      // go on to look up a repair set for every one of them.
      controller.abort();
      return {
        issue: {
          description: "", // never has the entry — would retry forever otherwise
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      };
    };
    const promise = appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false,
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      controller.signal,
      async () => {}, // sleep — no real backoff delay in this test
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    await expect(promise).rejects.toBeInstanceOf(ExitError);
    // Stopped before attempt 2's verify ever ran.
    expect(verifyCount).toBe(1);
    // And before the mid-loop label-repair lookup — proving the post-sleep
    // `checkDeadline` call itself did the work.
    expect(labelFetchCount).toBe(0);
  });

  it("a signal that aborts DURING the retry pause is caught immediately, not after the full backoff", async () => {
    // `realSleep` is a plain `setTimeout` with no signal awareness, and
    // `checkDeadline` previously ran only BEFORE and AFTER the retry pause,
    // never DURING it — so a deadline that fired while the loop was asleep
    // between attempts waited out the full `retryBackoffMs` pause (up to
    // `RETRY_MAX_MS`, 2s) before being caught, rather than the moment it
    // actually fired. `neverResolvingSleep` never resolves on its own; it
    // aborts the controller as a side effect of being CALLED, before returning
    // its pending promise — so if `appendWithRetry` raced it against
    // `abortedPromise(signal)` correctly (see that function's own doc), the
    // race resolves on the already-aborted signal, not the sleep. If it did
    // not, this promise would hang until the test framework's own timeout.
    const controller = new AbortController();
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        // Reachable now too, alongside `issueLabels` below — the
        // pre-attempt-1 priming read (TASK-7529) finds an empty live label
        // set and repairs it, exactly like the mid-loop retry already did.
        // A no-op response, since this test is about the deadline, not the
        // label contract — and NOT counted in `verifyCount`: that count is
        // specifically the number of `issue { ... }` reads (priming +
        // verify), not every call this mock receives.
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        // Reachable now via the pre-attempt-1 priming (TASK-7529), which
        // reads/repairs labels through the same fresh-read path the
        // mid-loop retry always used — this fixture predates that and
        // otherwise falls through to the generic branch below, whose shape
        // `fetchLabels` cannot parse. `baseArgs.type`/`size`/`repoLabel`'s
        // OWN names get their real group so `assertGroupMembership` (which
        // checks the OTHER direction too — nothing else may sit in one of
        // those three groups) has nothing to disagree with; every other
        // requested name is ungrouped, matching this test's actual concern
        // (the deadline, not the label contract).
        const names = vars.names as string[];
        const groupOfName: Record<string, string> = {
          [baseArgs.type]: TYPE_GROUP,
          [baseArgs.size]: SIZE_GROUP,
          [baseArgs.repoLabel]: REPO_GROUP,
        };
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names.map((n) => label(n, groupOfName[n])),
          },
        };
      }
      verifyCount++;
      return {
        issue: {
          description: "", // never has the entry — forces a retry
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: [] },
        },
      };
    };
    const neverResolvingSleep = () => {
      controller.abort();
      return new Promise<void>(() => {});
    };
    const promise = appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false,
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      controller.signal,
      neverResolvingSleep,
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    await expect(promise).rejects.toBeInstanceOf(ExitError);
    // Aborted during attempt 1's pause, before ever reaching attempt 2's
    // verify — 2, not 1, because the pre-attempt-1 priming read (TASK-7529)
    // is itself one more `issue { ... }` read counted here, ahead of
    // attempt 1's own verify.
    expect(verifyCount).toBe(2);
  });

  it("leaves NO abort listener registered on the signal after an ordinary (non-aborted) retry", async () => {
    // The call-site race's own `'abort'` listener only self-removed via
    // `{ once: true }` when the SIGNAL side won — every ORDINARY retry (the
    // timer winning instead, the common case) left it registered on the shared,
    // run-lifetime `signal` for the rest of the run. This drives one real retry
    // — a concurrent writer erased `agent:meta`, attempt 1 restores it, attempt
    // 2 confirms — entirely through the timer side; the signal never aborts at
    // all. Deliberately a label-repair scenario, NOT a description wipe: a wipe
    // would also exercise the placement-race machinery, which is not what this
    // test is checking.
    const fullLabels = [
      label(PROVENANCE_LABEL),
      label("chore", TYPE_GROUP),
      label("small", SIZE_GROUP),
      label("project", REPO_GROUP),
      label("agent:meta"),
      label("domain:tooling"),
    ];
    const withoutAgentMeta = fullLabels.filter((l) => l.name !== "agent:meta");
    const byId = new Map(fullLabels.map((l) => [l.id, l] as const));
    const byName = new Map(fullLabels.map((l) => [l.name, l] as const));
    let serverLabels = withoutAgentMeta;
    const controller = new AbortController();
    let verifyCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("issueAddLabel")) {
        const added = byId.get(vars.labelId as string);
        if (
          added !== undefined &&
          !serverLabels.some((l) => l.id === added.id)
        ) {
          serverLabels = [...serverLabels, added];
        }
        return { issueAddLabel: { success: true } };
      }
      if (query.includes("issueUpdate")) {
        return { issueUpdate: { success: true } };
      }
      if (query.includes("issueLabels")) {
        const names = vars.names as string[];
        return {
          issueLabels: {
            pageInfo: { hasNextPage: false },
            nodes: names
              .map((n) => byName.get(n))
              .filter((l): l is (typeof fullLabels)[number] => l !== undefined),
          },
        };
      }
      verifyCount++;
      return {
        issue: {
          description: seedDescription,
          parent: null,
          labels: { pageInfo: { hasNextPage: false }, nodes: serverLabels },
        },
      };
    };
    const result = await appendWithRetry(
      linear,
      { id: "issue-1", identifier: "TASK-9999" },
      seedDescription,
      false, // seedWasRepaired — an ordinary append, not a wipe-rebuild
      true,
      [],
      [],
      entry,
      baseArgs,
      "small",
      0, // originalPriority — args.severity is 'unknown', so priorityAfterSeverity/priorityReflectsSeverity never engage
      requiredContext,
      requiredContext,
      controller.signal,
      async () => {}, // resolves instantly — the timer side always wins
      true, // needsInitialDescriptionWrite — mirrors needsInitialWrite above; this test predates the distinction and does not exercise it
    );
    expect(result.confirmed).toBe(true);
    expect(verifyCount).toBe(2);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });
});

// ── main()'s wiring, against a mock LinearClient ────────────────────────────

describe("runDeferBatch — main()'s wiring of the wiped-description rebuild", () => {
  // `main()`'s own wiped-description rebuild call site was reachable by NO test
  // at all — `main()` was neither exported nor exercised anywhere in this
  // suite, so reverting the call site to
  // `initialDescription(args.pr, args.originating, noParentRationale)` (this
  // file's own history's bug) would not have turned any test red.
  // `runDeferBatch` is the extraction that makes this call site testable
  // directly, mirroring `appendWithRetry`'s own seam — these tests exercise it,
  // not just the pure `descriptionForRepair` helper in isolation.
  const pr = "4068";
  const type = "chore";
  const threadUrl = `https://github.com/example/project/pull/${pr}#discussion_r1`;
  const baseArgs: Args = {
    pr,
    type,
    sourceUrl: threadUrl,
    entryKey: threadUrl,
    reason: "out of scope here",
    severity: "unknown",
    category: "unknown",
    originating: "",
    team: "TASK",
    fix: "",
    size: "small",
    repoLabel: "project",
    repoSlug: "example/project",
    extraLabels: [],
    noParent: false,
    noParentReason: "",
    dryRun: false,
  };
  const contextLabels = [label("domain:tooling")];

  /** A hand-filed batch with a WIPED description — `descriptionForRepair`'s scenario. */
  function makeWipedTarget(parent: { id: string } | null) {
    return {
      id: "issue-1",
      identifier: "TASK-9999",
      title: batchTitle(pr, type),
      url: "https://linear.app/project/issue/TASK-9999",
      description: "",
      createdAt: "2020-01-01T00:00:00.000Z",
      parent,
      labels: {
        pageInfo: { hasNextPage: false },
        nodes: [
          label(PROVENANCE_LABEL),
          label(type, TYPE_GROUP),
          label("small", SIZE_GROUP),
          label("project", REPO_GROUP),
          ...contextLabels,
        ],
      },
      relations: { pageInfo: { hasNextPage: false }, nodes: [] },
      inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] },
    };
  }

  it("rebuilds a wiped, PARENTLESS batch through descriptionForRepair — includes the lost-reason fallback, not a bare initialDescription", async () => {
    const target = makeWipedTarget(null);
    let writtenDescription = "";
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("teams(filter")) {
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      if (query.includes("issues(first: 50")) {
        return {
          issues: { pageInfo: { hasNextPage: false }, nodes: [target] },
        };
      }
      if (query.includes("issueUpdate(")) {
        writtenDescription = (vars.input as { description: string })
          .description;
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: writtenDescription,
          parent: null,
          labels: target.labels,
        },
      };
    };

    const code = await runDeferBatch(
      linear,
      baseArgs,
      "the reviewer finding text",
    );

    expect(code).toBe(0);
    // The exact bug this file's history fixed: reverting this call site to
    // `initialDescription(args.pr, args.originating, noParentRationale)` —
    // `noParentRationale` is `undefined` here, since `args.noParent` is
    // false — would OMIT the `**No epic parent**` block entirely. Wiring
    // through `descriptionForRepair` instead uses
    // `noParentRationaleForRepair(target.parent != null)` — the lost-reason
    // fallback — which includes it.
    expect(writtenDescription).toContain("**No epic parent**");
    expect(writtenDescription).toContain(
      "the original reason was lost when its description was cleared",
    );
    expect(writtenDescription).toContain(`PR #${pr}`);
  });

  it("warns loudly when severity is 'blocker' — a deferred blocker is a contradiction, but the finding is still tracked (and filed at Urgent priority)", async () => {
    // The issue's own text (references/deferral-protocol.md § When to
    // defer): deferring a blocker finding is a contradiction, so this must
    // warn — but NOT abort, since the finding still needs to be tracked.
    const target = makeWipedTarget(null);
    let writtenDescription = "";
    let writtenPriority: number | undefined;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("teams(filter")) {
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      if (query.includes("issues(first: 50")) {
        return {
          issues: { pageInfo: { hasNextPage: false }, nodes: [target] },
        };
      }
      if (query.includes("issueUpdate(")) {
        const input = vars.input as { description: string; priority?: number };
        writtenDescription = input.description;
        if (input.priority !== undefined) writtenPriority = input.priority;
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: writtenDescription,
          parent: null,
          priority:
            writtenPriority ?? required(SEVERITY_TO_PRIORITY[SEVERITY_UNKNOWN]),
          labels: target.labels,
        },
      };
    };

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await runDeferBatch(
        linear,
        { ...baseArgs, severity: "blocker" },
        "the reviewer finding text",
      );
      expect(code).toBe(0);
      const messages = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(messages).toContain("deferring a 'blocker' severity finding");
      expect(messages).toContain("A deferred blocker is a contradiction");
    } finally {
      errSpy.mockRestore();
    }
    // The finding is still tracked — the warning is not an abort — and at
    // Urgent priority (required(SEVERITY_TO_PRIORITY.blocker)).
    expect(writtenPriority).toBe(required(SEVERITY_TO_PRIORITY.blocker));
  });

  it("rebuilds a wiped, PARENTED batch WITHOUT the no-parent block", async () => {
    const target = makeWipedTarget({ id: "epic-uuid-1" });
    let writtenDescription = "";
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("teams(filter")) {
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      if (query.includes("issues(first: 50")) {
        return {
          issues: { pageInfo: { hasNextPage: false }, nodes: [target] },
        };
      }
      if (query.includes("issueUpdate(")) {
        writtenDescription = (vars.input as { description: string })
          .description;
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: writtenDescription,
          parent: { id: "epic-uuid-1" },
          labels: target.labels,
        },
      };
    };

    const code = await runDeferBatch(
      linear,
      baseArgs,
      "the reviewer finding text",
    );

    expect(code).toBe(0);
    expect(writtenDescription).not.toContain("**No epic parent**");
    expect(writtenDescription).toContain(`PR #${pr}`);
  });

  it("wires `seedWasRepaired` through to appendWithRetry's placement check — a race is caught, not silently confirmed", async () => {
    // Nothing else in this suite would catch `runDeferBatch` passing a
    // hardcoded `false` for `appendWithRetry`'s `seedWasRepaired` parameter
    // instead of the `existingDescription.trim() === ''` it actually computes —
    // the same untested-call-site class this extraction was meant to fix,
    // reproduced in the fix itself. This test fails (reports `code === 0`
    // instead of rejecting) if that wiring is lost: `target` is WIPED and
    // PARENTLESS at the read `runDeferBatch` seeds from, but the verify's fresh
    // read shows a real parent — a reparent race between the two. Only a
    // correctly wired `seedWasRepaired: true` makes `appendWithRetry` treat
    // this as a placement mismatch and reject.
    const target = makeWipedTarget(null);
    let writtenDescription = "";
    // `appendWithRetry`'s own pre-attempt-1 priming (TASK-7529) does a FRESH
    // full read — including `parent` — before ever writing, which closes
    // the exact window this test used to simulate (a reparent between
    // `runDeferBatch`'s OWN initial `FIND_BATCHES` read and attempt 1's
    // write): priming now sees the reparent too, and rebuilds a scaffold
    // that already matches it, so nothing is left to catch. The race this
    // test proves must still be caught has to land AFTER that priming
    // read — between it and attempt 1's write, or (as modelled here)
    // between attempt 1's write and its own verify — mirroring how the
    // "stale-parent placement race" describe block's own fixtures were
    // narrowed for the same reason. `queryCount` distinguishes the ONE
    // priming read (still parentless, matching `runDeferBatch`'s own seed)
    // from every read after it (reparented).
    let queryCount = 0;
    const linear: LinearClient = async (query, vars) => {
      if (query.includes("teams(filter")) {
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      if (query.includes("issues(first: 50")) {
        return {
          issues: { pageInfo: { hasNextPage: false }, nodes: [target] },
        };
      }
      if (query.includes("issueUpdate(")) {
        writtenDescription = (vars.input as { description: string })
          .description;
        return { issueUpdate: { success: true } };
      }
      queryCount++;
      if (queryCount === 1) {
        // The priming read: still parentless, still wiped — exactly what
        // `runDeferBatch`'s own initial read already found, so priming's
        // own rebuild agrees with the seed and writes the SAME no-parent
        // claim attempt 1 always would have.
        return {
          issue: {
            description: "",
            parent: null,
            labels: target.labels,
          },
        };
      }
      // Every read after the priming one: a concurrent writer reparented
      // the issue between it and attempt 1's write, which already landed
      // with the (now stale) no-parent claim.
      return {
        issue: {
          description: writtenDescription,
          parent: { id: "epic-uuid-1" },
          labels: target.labels,
        },
      };
    };

    await expect(
      runDeferBatch(linear, baseArgs, "the reviewer finding text"),
    ).rejects.toBeInstanceOf(ExitError);
    // The write already landed with the (now stale) no-parent claim — the
    // race is real, not merely refused before touching Linear.
    expect(writtenDescription).toContain("**No epic parent**");
  });

  it("propagates its OWN `signal` parameter through to every Linear call and appendWithRetry's deadline check", async () => {
    // No test in this describe block injects a signal, and every mock
    // `LinearClient` above ignores its third argument — a `runDeferBatch` that
    // built its own `new AbortController().signal` internally, or that passed a
    // FRESH signal to `appendWithRetry` instead of forwarding its own
    // parameter, would still pass every other test here. That is the same
    // untested-call-site class this extraction was meant to close,
    // reproduced by its own fix. The signal starts UN-aborted (a pre-aborted
    // one is covered separately below, by the entry-guard test) and is aborted
    // mid-run, from inside the FIND_BATCHES mock response — proving propagation
    // two ways: (1) every `linear(...)` call up to that point, INCLUDING the
    // ones `runDeferBatch` makes before `appendWithRetry` is ever reached,
    // receives the EXACT SAME signal instance, and (2) the run still rejects
    // via `appendWithRetry`'s own deadline check further downstream, which only
    // fires against the signal it was actually handed.
    const target = makeWipedTarget(null);
    const seenSignals: AbortSignal[] = [];
    const controller = new AbortController();
    const linear: LinearClient = async (query, _vars, signal) => {
      seenSignals.push(signal);
      if (query.includes("teams(filter")) {
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      if (query.includes("issues(first: 50")) {
        // Abort AFTER this call is recorded — proves propagation reaches
        // calls upstream of the retry loop, not merely the loop itself.
        controller.abort();
        return {
          issues: { pageInfo: { hasNextPage: false }, nodes: [target] },
        };
      }
      if (query.includes("issueUpdate(")) {
        return { issueUpdate: { success: true } };
      }
      return {
        issue: {
          description: "",
          parent: null,
          labels: target.labels,
        },
      };
    };

    await expect(
      runDeferBatch(
        linear,
        baseArgs,
        "the reviewer finding text",
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ExitError);
    // The teams lookup AND the FIND_BATCHES lookup both ran before the
    // abort took effect.
    expect(seenSignals.length).toBeGreaterThanOrEqual(2);
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });

  it("rejects immediately, with NO Linear calls, when handed an already-aborted signal", async () => {
    // Nothing upstream of `appendWithRetry`'s own `checkDeadline` checked
    // `signal` at all, so a caller handing `runDeferBatch` an ALREADY
    // aborted signal still let the team/FIND_BATCHES lookups dispatch
    // before anything noticed.
    const calls: string[] = [];
    const linear: LinearClient = async (query) => {
      calls.push(query);
      throw new Error("must not be called — the signal was already aborted");
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      runDeferBatch(
        linear,
        baseArgs,
        "the reviewer finding text",
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ExitError);
    expect(calls).toEqual([]);
  });

  it("rejects before FIND_BATCHES when the signal aborts between the team lookup and it", async () => {
    // A refinement of the entry-point guard above — that guard alone only
    // catches a signal already aborted before this function STARTS, not
    // one that aborts BETWEEN two of its pre-loop calls. `baseArgs.team`
    // reaches the team-lookup branch (`originating: ''`); the signal is
    // aborted from inside that call's own mock response, so the very NEXT
    // dispatch — `FIND_BATCHES` — must be the one that catches it.
    const calls: string[] = [];
    const controller = new AbortController();
    const linear: LinearClient = async (query) => {
      calls.push(query);
      if (query.includes("teams(filter")) {
        controller.abort();
        return { teams: { nodes: [{ id: "team-1", key: "TASK" }] } };
      }
      throw new Error(
        "must not be called — the signal aborted right after the team lookup",
      );
    };
    await expect(
      runDeferBatch(
        linear,
        baseArgs,
        "the reviewer finding text",
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ExitError);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("teams(filter");
  });
});

describe("hasRelationTo", () => {
  const other = "uuid-originating";

  it("finds the link on either end — the inverse counts", () => {
    expect(
      hasRelationTo(
        [{ type: RELATED_TYPE, relatedIssue: { id: other } }],
        other,
      ),
    ).toBe(true);
    expect(
      hasRelationTo([{ type: RELATED_TYPE, issue: { id: other } }], other),
    ).toBe(true);
  });

  it("does NOT accept a blocks/blocked-by edge as the required related link", () => {
    // The protocol requires `related` specifically. An endpoint-only test
    // suppresses creation of the real link and still reports it present.
    expect(
      hasRelationTo([{ type: "blocks", relatedIssue: { id: other } }], other),
    ).toBe(false);
    expect(hasRelationTo([{ relatedIssue: { id: other } }], other)).toBe(false);
  });

  it("is false when no relation names it, so the link gets created", () => {
    expect(
      hasRelationTo(
        [
          {
            type: RELATED_TYPE,
            issue: { id: "uuid-batch" },
            relatedIssue: { id: "uuid-else" },
          },
        ],
        other,
      ),
    ).toBe(false);
    expect(hasRelationTo([], other)).toBe(false);
  });

  it("tolerates a null end rather than throwing mid-reconcile", () => {
    expect(
      hasRelationTo(
        [{ type: RELATED_TYPE, issue: null, relatedIssue: null }],
        other,
      ),
    ).toBe(false);
  });
});

// ── Argument grammar ────────────────────────────────────────────────────────

describe("parseArgs", () => {
  const full = [
    "4068",
    "chore",
    "--thread-url",
    "https://github.com/example/project/pull/4068#discussion_r1",
    "--reason",
    "out of scope here",
    "--severity",
    "unknown",
    "--category",
    "unknown",
    "--originating",
    "TASK-6727",
  ];
  // `full` up through `--category unknown`, excluding `--originating` — the
  // positional/thread-url/reason/severity/category prefix the
  // --originating-focused tests below build on. A NAMED slice rather than a
  // magic `full.slice(0, 10)` at each call site, so inserting another
  // required flag before --originating later needs one edit here, not N at
  // every call site.
  const throughCategory = full.slice(0, 10);

  it("parses the full form", () => {
    const a = parseArgs(full);
    expect(typeof a).not.toBe("string");
    if (typeof a === "string") return;
    expect(a.pr).toBe("4068");
    expect(a.type).toBe("chore");
    expect(a.originating).toBe("TASK-6727");
    expect(a.size).toBe("small");
    expect(a.repoLabel).toBe("project");
    expect(a.severity).toBe("unknown");
    expect(a.category).toBe(CATEGORY_UNKNOWN);
    expect(a.sourceUrl).toBe(required(full[3]));
    expect(a.entryKey).toBe(required(full[3]));
  });

  it("parses a summary-only finding from its comment URL and fingerprint", () => {
    const commentUrl =
      "https://github.com/example/project/pull/4068#issuecomment-5649338286";
    const a = parseArgs([
      "4068",
      "chore",
      "--comment-url",
      commentUrl,
      "--fingerprint",
      "3b78f436d805f279",
      ...full.slice(4),
    ]);
    if (typeof a === "string") throw new Error(a);
    expect(a.sourceUrl).toBe(commentUrl);
    expect(a.entryKey).toBe(
      "ai-review-backlog:issuecomment-5649338286:3b78f436d805f279",
    );
  });

  it("requires exactly one source and a valid fingerprint only for comments", () => {
    const commentUrl =
      "https://github.com/example/project/pull/4068#issuecomment-5649338286";
    expect(
      parseArgs([
        ...full,
        "--comment-url",
        commentUrl,
        "--fingerprint",
        "3b78f436d805f279",
      ]),
    ).toContain("exactly one source");
    expect(parseArgs([...full, "--fingerprint", "3b78f436d805f279"])).toContain(
      "valid only with --comment-url",
    );
    // Widened to MARKER_SAFE_FINGERPRINT's shape: a
    // 16-hex-only check rejected a legitimate reviewer-backlog fingerprint.
    // 'bad' now means empty, or leading with a non-alphanumeric character.
    for (const bad of [
      "",
      "-leading-dash",
      "_leading-underscore",
      "has space",
    ]) {
      const args = [
        "4068",
        "chore",
        "--comment-url",
        commentUrl,
        "--fingerprint",
        bad,
        ...full.slice(4),
      ];
      expect(parseArgs(args)).toContain("--fingerprint");
    }
    expect(
      parseArgs([
        "4068",
        "chore",
        "--comment-url",
        "https://github.com/example/project/pull/4069#issuecomment-1",
        "--fingerprint",
        "3b78f436d805f279",
        ...full.slice(4),
      ]),
    ).toContain("--comment-url");
  });

  it("tolerates the --batch alias prefix", () => {
    expect(typeof parseArgs(["--batch", ...full])).not.toBe("string");
  });

  it("refuses a non-numeric PR, a non-label type, and a bare thread-url", () => {
    expect(typeof parseArgs(["abc", "chore"])).toBe("string");
    expect(typeof parseArgs(["4068", "Chore!"])).toBe("string");
    const noUrl = parseArgs([
      "4068",
      "chore",
      "--reason",
      "r",
      "--originating",
      "TASK-1",
    ]);
    expect(typeof noUrl).toBe("string");
  });

  it("requires --originating and uses the consumer team unless explicitly overridden", () => {
    const noOrig = parseArgs(throughCategory);
    expect(typeof noOrig).toBe("string");
    const noneNoTeam = parseArgs([...throughCategory, "--originating", "none"]);
    expect(typeof noneNoTeam).not.toBe("string");
    if (typeof noneNoTeam !== "string") expect(noneNoTeam.team).toBe("TASK");
    const noneWithTeam = parseArgs([
      ...throughCategory,
      "--originating",
      "none",
      "--team",
      "TASK",
    ]);
    expect(typeof noneWithTeam).not.toBe("string");
    if (typeof noneWithTeam === "string") return;
    expect(noneWithTeam.originating).toBe("");
  });

  it("requires --severity, and accepts every declared token while refusing one outside it", () => {
    // The measured bug (TASK-7491) is severity being silently dropped, so
    // this flag is REQUIRED like --reason/--originating — an omitted flag is
    // a usage error, never a silent fallback to `unknown`.
    const withoutSeverity = [
      "4068",
      "chore",
      "--thread-url",
      "https://github.com/example/project/pull/4068#discussion_r1",
      "--reason",
      "out of scope here",
      "--category",
      "unknown",
      "--originating",
      "TASK-6727",
    ];
    const missing = parseArgs(withoutSeverity);
    expect(missing).toContain("--severity is required");
    for (const sev of [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]) {
      const a = parseArgs([...withoutSeverity, "--severity", sev]);
      if (typeof a === "string") throw new Error(a);
      expect(a.severity).toBe(sev);
    }
    for (const bad of ["Blocker", "urgent", "critical", ""]) {
      expect(typeof parseArgs([...withoutSeverity, "--severity", bad])).toBe(
        "string",
      );
    }
  });

  it("requires --category, like --severity, accepts every declared token, and refuses one outside it", () => {
    // Mirrors --severity's own requiredness (TASK-7527): an omitted flag is
    // indistinguishable from an explicit `unknown` and could silently discard
    // a real parsed value — the same class of bug TASK-7491 measured for
    // severity, closed here for category too.
    const withoutCategory = [
      "4068",
      "chore",
      "--thread-url",
      "https://github.com/example/project/pull/4068#discussion_r1",
      "--reason",
      "out of scope here",
      "--severity",
      "unknown",
      "--originating",
      "TASK-6727",
    ];
    const missing = parseArgs(withoutCategory);
    expect(missing).toContain("--category is required");
    for (const cat of [...REVIEW_CATEGORIES, CATEGORY_UNKNOWN]) {
      const a = parseArgs([...withoutCategory, "--category", cat]);
      if (typeof a === "string") throw new Error(a);
      expect(a.category).toBe(cat);
    }
    expect(
      typeof parseArgs([...withoutCategory, "--category", "made-up"]),
    ).toBe("string");
  });

  it("accepts every declared Type and refuses one outside the taxonomy", () => {
    for (const type of BATCH_TYPES) {
      const a = parseArgs(["4068", type, ...full.slice(2)]);
      if (typeof a === "string") throw new Error(a);
      expect(a.type).toBe(type);
    }
    // `improvement` and `pr-followup` are both plausible lowercase label
    // names; the first may exist in Linear's Type group without this repo
    // having adopted it, the second is a flag label with no group at all.
    // A shape-only check (`/^[a-z][a-z-]*$/`) accepts both.
    for (const type of ["improvement", "pr-followup", "manual-ops", "Bug"]) {
      expect(typeof parseArgs(["4068", type, ...full.slice(2)])).toBe("string");
    }
  });

  it("accepts every declared Repo and refuses one outside the taxonomy", () => {
    for (const repo of BATCH_REPOS) {
      const a = parseArgs([...full, "--repo-label", repo]);
      if (typeof a === "string") throw new Error(a);
      expect(a.repoLabel).toBe(repo);
    }
    // labels.yaml records a `platform` label "detached from the Repo group —
    // do not use it", so this is not hypothetical: a Repo-GROUP check alone
    // accepts whatever the workspace happens to place there.
    for (const repo of ["sandbox", "platform", "Acme"]) {
      expect(typeof parseArgs([...full, "--repo-label", repo])).toBe("string");
    }
  });

  it("accepts every batchable Size and refuses one above small", () => {
    for (const size of BATCH_SIZES) {
      const a = parseArgs([...full, "--size", size]);
      if (typeof a === "string") throw new Error(a);
      expect(a.size).toBe(size);
    }
    // The protocol sends anything sizing above `small` to its OWN issue, so a
    // batch minted at `medium` batches exactly the class that must not batch.
    for (const size of ["medium", "large", "xl", "Small", ""]) {
      expect(typeof parseArgs([...full, "--size", size])).toBe("string");
    }
  });

  it("requires a review-thread URL on THIS repo and THIS PR", () => {
    // The URL is the audit backlink AND the idempotency key, so anything else
    // files the entry under a key no later run for the real thread matches.
    const withUrl = (u: string) =>
      parseArgs(["4068", "chore", "--thread-url", u, ...full.slice(4)]);
    for (const bad of [
      "https://example.com/x",
      "https://github.com/example/project/pull/4069#discussion_r1",
      "https://github.com/other/repo/pull/4068#discussion_r1",
      "https://github.com/example/project/pull/4068",
      "https://github.com/example/project/pull/4068#issuecomment-1",
      "http://github.com/example/project/pull/4068#discussion_r1",
    ]) {
      expect(typeof withUrl(bad)).toBe("string");
    }
    expect(
      typeof withUrl(
        "https://github.com/example/project/pull/4068#discussion_r1",
      ),
    ).not.toBe("string");
  });

  it("lets --repo-slug move the expected host path for a fork", () => {
    const a = parseArgs([
      "4068",
      "chore",
      "--thread-url",
      "https://github.com/acme/fork/pull/4068#discussion_r1",
      ...full.slice(4),
      "--repo-slug",
      "acme/fork",
    ]);
    if (typeof a === "string") throw new Error(a);
    expect(a.repoSlug).toBe("acme/fork");
  });

  it("refuses a line break in reason / fix / no-parent-reason", () => {
    // A newline in a RAW-Markdown field forges the `### <url>` heading the
    // idempotent append trusts, so a later real deferral for that thread
    // reports alreadyPresent and resolves with no entry behind it.
    const forged = `text\n${entryHeading("https://github.com/example/project/pull/4068#discussion_r99")}`;
    expect(
      parseArgs([...full.slice(0, 5), forged, ...full.slice(6)]),
    ).toContain("single line");
    expect(parseArgs([...full, "--fix", forged])).toContain("single line");
    expect(
      parseArgs([...full, "--no-parent", "--no-parent-reason", forged]),
    ).toContain("single line");
    expect(parseArgs([...full, "--fix", "a\rb"])).toContain("single line");
  });

  it("refuses a value-taking flag that would swallow the NEXT option", () => {
    // `--reason --dry-run` set reason='--dry-run', left dryRun false, and
    // proceeded to real Linear mutations under a command written as a preview.
    const swallowed = parseArgs([
      "4068",
      "chore",
      "--thread-url",
      "https://github.com/example/project/pull/4068#discussion_r1",
      "--reason",
      "--dry-run",
      "--originating",
      "TASK-6727",
    ]);
    expect(swallowed).toContain("missing value for --reason");
    expect(parseArgs([...full, "--fix"])).toContain("missing value for --fix");
  });

  it("refuses a single-valued label smuggled through --labels", () => {
    // `--labels xs` against a batch already on `small` is treated as missing
    // by reconciliation, so a real run WRITES a second Size label and only
    // aborts in post-write verification — leaving the issue taxonomy-invalid.
    for (const bad of ["xs", "small", "chore", "bug", "project", "website"]) {
      const r = parseArgs([...full, "--labels", `${bad},domain:tooling`]);
      expect(typeof r).toBe("string");
      expect(r).toContain("single-valued");
    }
    // Context labels and flag labels still pass.
    const ok = parseArgs([
      ...full,
      "--labels",
      "domain:tooling,codearea:scaffolding,manual-ops",
    ]);
    if (typeof ok === "string") throw new Error(ok);
    expect(ok.extraLabels).toEqual([
      "domain:tooling",
      "codearea:scaffolding",
      "manual-ops",
    ]);
  });

  it("rejects an unknown flag instead of silently collecting it", () => {
    // `--no-parrent true` parses cleanly against a permissive collector and
    // leaves noParent false, filing the parented issue the operator refused.
    const typo = parseArgs([...full, "--no-parrent", "true"]);
    expect(typeof typo).toBe("string");
    expect(typo).toContain("unknown option");
  });

  it("rejects a flag given twice rather than keeping the last one", () => {
    expect(parseArgs([...full, "--size", "xs", "--size", "small"])).toContain(
      "more than once",
    );
  });

  it("requires --no-parent-reason with --no-parent, and refuses it alone", () => {
    expect(parseArgs([...full, "--no-parent"])).toContain("--no-parent-reason");
    expect(
      parseArgs([...full, "--no-parent-reason", "no epic shares this domain"]),
    ).toContain("no effect");
    const ok = parseArgs([
      ...full,
      "--no-parent",
      "--no-parent-reason",
      "no epic shares this domain",
    ]);
    if (typeof ok === "string") throw new Error(ok);
    expect(ok.noParent).toBe(true);
    expect(ok.noParentReason).toBe("no epic shares this domain");
  });

  it("splits --labels on commas and drops empties", () => {
    // NB: the original fixture used `reviewer`, which is a REPO-group label —
    // the single-valued guard now rejects it, correctly: passing it here would
    // have added a second Repo label whenever the batch's live value differed.
    const a = parseArgs([...full, "--labels", "dpa-relevant, ,manual-ops"]);
    if (typeof a === "string") throw new Error(a);
    expect(a.extraLabels).toEqual(["dpa-relevant", "manual-ops"]);
  });
});

// ── CLI refusal probes (no network reachable from either path) ──────────────

describe("defer-batch.ts CLI refusals", () => {
  const fullArgs = [
    "4068",
    "chore",
    "--thread-url",
    "https://github.com/example/project/pull/4068#discussion_r1",
    "--reason",
    "out of scope here",
    "--severity",
    "unknown",
    "--category",
    "unknown",
    "--originating",
    "TASK-6727",
  ];

  it("exits 2 with usage when called bare", () => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      input: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  it("exits 2 when the stdin finding is empty", () => {
    const r = spawnSync(process.execPath, [SCRIPT, ...fullArgs], {
      encoding: "utf8",
      input: "",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("stdin");
  });

  it("exits 1 before any network call when no credential is set — empty counts as unset", () => {
    const r = spawnSync(process.execPath, [SCRIPT, ...fullArgs], {
      encoding: "utf8",
      input: "the reviewer finding text",
      env: { ...process.env, LINEAR_API_TOKEN: "", LINEAR_API_KEY: "" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("LINEAR_API_TOKEN");
  });
});

// ── The taxonomy pin ────────────────────────────────────────────────────────

describe("BATCH_TYPES is pinned to the declared taxonomy", () => {
  // Pin the artifact verbatim rather than text-scanning it at runtime — and
  // back the pin with a check that reads the real file through a real YAML
  // parser, so the constant cannot silently drift from the workspace's declared
  // Type group.
  const LABELS_YAML = join(import.meta.dir, "fixtures", "labels.yaml");

  it("equals groups.type.labels in labels.yaml, as a set", () => {
    const doc = parseYaml(readFileSync(LABELS_YAML, "utf8")) as {
      groups?: { type?: { labels?: Record<string, unknown> } };
    };
    const declared = Object.keys(doc.groups?.type?.labels ?? {});
    // Rule 1: assert the population was actually read, so an empty parse
    // cannot read as "all clear".
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...BATCH_TYPES].sort());
  });

  it("BATCH_REPOS equals groups.repo.labels in labels.yaml, as a set", () => {
    const doc = parseYaml(readFileSync(LABELS_YAML, "utf8")) as {
      groups?: { repo?: { labels?: Record<string, unknown> } };
    };
    const declared = Object.keys(doc.groups?.repo?.labels ?? {});
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...BATCH_REPOS].sort());
  });

  it("BATCH_SIZES is a strict subset of the declared Size group", () => {
    const doc = parseYaml(readFileSync(LABELS_YAML, "utf8")) as {
      groups?: { size?: { labels?: Record<string, unknown> } };
    };
    const declared = Object.keys(doc.groups?.size?.labels ?? {});
    expect(declared.length).toBeGreaterThan(0);
    for (const s of BATCH_SIZES) expect(declared).toContain(s);
    // Strict: the protocol batches only the small end, so equality would mean
    // the "above small gets its own issue" rule had stopped being enforced.
    expect(declared.length).toBeGreaterThan(BATCH_SIZES.length);
  });

  it("REVIEW_CATEGORIES equals categories in .config/review-triage.yaml, as a set", () => {
    // Same pin discipline as BATCH_TYPES/BATCH_REPOS/BATCH_SIZES above, but
    // pinned from a different file — `.config/review-triage.yaml`'s own
    // `categories:` key, the same taxonomy `lib/ladder.ts`'s LadderConfig
    // validates `triage-ladder.ts --category` against, NOT a `labels.yaml`
    // group (there is no Linear label side-effect for category — see
    // REVIEW_CATEGORIES's own doc comment).
    const REVIEW_TRIAGE_YAML = join(
      import.meta.dir,
      "fixtures",
      "review-triage.yaml",
    );
    const doc = parseYaml(readFileSync(REVIEW_TRIAGE_YAML, "utf8")) as {
      categories?: unknown;
    };
    const declared = Array.isArray(doc.categories) ? doc.categories : [];
    // Rule 1: assert the population was actually read, so an empty parse
    // cannot read as "all clear".
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...REVIEW_CATEGORIES].sort());
  });
});

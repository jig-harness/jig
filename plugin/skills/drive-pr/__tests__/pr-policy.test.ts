/**
 * The pull-request policy (`scripts/lib/pr-policy.ts`): the declared
 * `pull_requests` fields with their defaults and validation, and the facts
 * derived from the repository instead of declared.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conventionalCommitlintConfig,
  DEFAULT_BRANCH_PATTERN,
  findCodeowners,
  findCommitlintConfig,
  findPrTemplates,
  inferTitleFormat,
  issueLinkLine,
  MAX_CHAIN_WALK,
  markReadyDueAfterRound,
  type OpenPull,
  parseLinkEligibility,
  parseNativeStacks,
  parseOpenPulls,
  parsePrPolicy,
  parseRepoSettings,
  planNativeLink,
  renderBranchName,
  resolveOpenAs,
  SLUG_MAX,
  slugify,
  stackRoot,
  walkChain,
} from "../scripts/lib/pr-policy.ts";

const policy = (section: Record<string, unknown> | undefined) =>
  parsePrPolicy(section === undefined ? {} : { pull_requests: section });

describe("parsePrPolicy", () => {
  it("gives a conservative policy when the section is absent", () => {
    expect(policy(undefined)).toEqual({
      stacking: "none",
      maxStackDepth: null,
      openAs: null,
      markReady: 1,
      branchName: DEFAULT_BRANCH_PATTERN,
      issueLink: "closes",
      sizeBudget: null,
      labels: [],
      titleFormat: null,
    });
  });

  it("reads every declared field", () => {
    expect(
      policy({
        stacking: "branch",
        max_stack_depth: 4,
        open_as: "ready",
        mark_ready: "converged",
        branch_name: "feature/{key_lower}-{slug}",
        issue_link: "refs",
        size_budget: 400,
        labels: ["agent-authored"],
        title_format: "free",
      }),
    ).toEqual({
      stacking: "branch",
      maxStackDepth: 4,
      openAs: "ready",
      markReady: "converged",
      branchName: "feature/{key_lower}-{slug}",
      issueLink: "refs",
      sizeBudget: 400,
      labels: ["agent-authored"],
      titleFormat: "free",
    });
  });

  it("refuses an unknown key rather than ignoring a misspelling", () => {
    expect(() => policy({ stacked: "branch" })).toThrow(
      /pull_requests\.stacked is not a known field/,
    );
  });

  it.each([
    [{ stacking: "graphite" }, /stacking must be one of none, native, branch/],
    [{ open_as: "Draft" }, /open_as must be one of draft, ready/],
    [{ issue_link: "fixes" }, /issue_link must be one of/],
    [{ title_format: "angular" }, /title_format must be one of/],
    [{ size_budget: 0 }, /size_budget must be a whole number of at least 1/],
    [{ size_budget: 2.5 }, /size_budget must be a whole number/],
    [{ size_budget: 2 ** 53 }, /size_budget must be a whole number/],
    [
      { stacking: "branch", max_stack_depth: "3" },
      /max_stack_depth must be a whole number/,
    ],
    [{ max_stack_depth: 3 }, /max_stack_depth needs pull_requests.stacking/],
    [{ labels: "agent" }, /labels must be a list/],
    [{ labels: ["a", "a"] }, /labels must be a list of distinct/],
    [{ labels: [""] }, /labels must be a list of distinct nonempty/],
    [{ branch_name: "" }, /branch_name must be a nonempty string/],
    [{ branch_name: "{slug}" }, /must contain \{key\} or \{key_lower\}/],
    [{ branch_name: "{key}-{title}" }, /unknown placeholder \{title\}/],
    [{ branch_name: "{key}-{slug" }, /unknown placeholder|unbalanced brace/],
  ])("refuses %j", (section, message) => {
    expect(() => policy(section)).toThrow(message);
  });

  it("refuses a section that is not a mapping", () => {
    expect(() => parsePrPolicy({ pull_requests: ["none"] })).toThrow(
      /pull_requests must be a mapping/,
    );
  });
});

describe("mark_ready", () => {
  it("accepts a round number, converged or never", () => {
    expect(policy({ mark_ready: 3 }).markReady).toBe(3);
    expect(policy({ mark_ready: "never" }).markReady).toBe("never");
  });

  it.each([0, 1.5, 2 ** 53, "always", "1"])("refuses %j", (value) => {
    expect(() => policy({ mark_ready: value })).toThrow(
      /mark_ready must be a round number of at least 1, converged or never/,
    );
  });

  it("is due after a round only for a reached round number", () => {
    expect(markReadyDueAfterRound(1, 1)).toBe(true);
    expect(markReadyDueAfterRound(3, 2)).toBe(false);
    expect(markReadyDueAfterRound(3, 4)).toBe(true);
    expect(markReadyDueAfterRound("converged", 9)).toBe(false);
    expect(markReadyDueAfterRound("never", 9)).toBe(false);
  });
});

describe("branch names", () => {
  it("slugs a title to lowercase words", () => {
    expect(slugify("Add Danish law: datasets & news feeds!")).toBe(
      "add-danish-law-datasets-news-feeds",
    );
    expect(slugify("Ünïcödé café")).toBe("unicode-cafe");
  });

  it("cuts a long slug at a word boundary", () => {
    const slug = slugify(
      "one two three four five six seven eight nine ten eleven",
    );
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
    expect(
      "one two three four five six seven eight nine ten eleven"
        .replaceAll(" ", "-")
        .startsWith(slug),
    ).toBe(true);
  });

  it("renders every placeholder", () => {
    expect(
      renderBranchName(DEFAULT_BRANCH_PATTERN, "ENG-12", "Fix the login"),
    ).toBe("eng-12-fix-the-login");
    expect(renderBranchName("feature/{key}/{slug}", "ENG-12", "Fix it")).toBe(
      "feature/ENG-12/fix-it",
    );
  });

  it("drops a trailing separator when the title has no usable characters", () => {
    expect(renderBranchName("{key_lower}-{slug}", "ENG-12", "!!!")).toBe(
      "eng-12",
    );
  });
});

describe("issueLinkLine", () => {
  it("writes the closing or referencing keyword, or nothing", () => {
    expect(issueLinkLine("closes", "ENG-1")).toBe("Closes ENG-1");
    expect(issueLinkLine("refs", "ENG-1")).toBe("Refs ENG-1");
    expect(issueLinkLine("none", "ENG-1")).toBeNull();
  });
});

describe("resolveOpenAs", () => {
  it("lets a declared value win", () => {
    expect(resolveOpenAs(policy({ open_as: "draft" }), false).value).toBe(
      "draft",
    );
  });
  it("opens Ready when the reviewer is declared not to review drafts", () => {
    expect(resolveOpenAs(policy({}), false)).toEqual({
      value: "ready",
      source: "derived: drive.reviews_drafts is false",
    });
  });
  it("opens a draft otherwise", () => {
    expect(resolveOpenAs(policy({}), true).value).toBe("draft");
    expect(resolveOpenAs(policy({}), undefined)).toEqual({
      value: "draft",
      source: "default",
    });
  });
});

describe("inferTitleFormat", () => {
  const conv = [
    "feat: a",
    "fix(x): b",
    "docs: c",
    "chore!: d",
    "refactor(y)!: e",
  ];
  it("reads conventional history as conventional", () => {
    expect(inferTitleFormat(conv)).toBe("conventional");
  });
  it("needs most subjects to follow it", () => {
    expect(inferTitleFormat([...conv, "Update readme", "Fix thing"])).toBe(
      "free",
    );
  });
  it("ignores merge commits and needs enough history", () => {
    expect(
      inferTitleFormat(["feat: a", "Merge pull request #1 from x/y", "fix: b"]),
    ).toBe("free");
    expect(inferTitleFormat([...conv, "Merge branch 'main' into x"])).toBe(
      "conventional",
    );
  });
});

describe("repository settings", () => {
  it("parses GitHub's repository settings", () => {
    expect(parseRepoSettings({ delete_branch_on_merge: false })).toEqual({
      deleteBranchOnMerge: false,
    });
    expect(parseRepoSettings({})).toEqual({ deleteBranchOnMerge: null });
  });
});

describe("walkChain", () => {
  const pull = (
    number: number,
    head: string,
    base: string,
    fork = false,
  ): OpenPull => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: head,
    baseRefName: base,
    isCrossRepository: fork,
  });
  // A six-layer hand-built stack: the bottom targets main, each layer above
  // targets the head branch of the one below.
  const stack = [
    pull(23, "f/a", "main"),
    pull(24, "f/b", "f/a"),
    pull(25, "f/c", "f/b"),
    pull(26, "f/d", "f/c"),
    pull(27, "f/e", "f/d"),
    pull(28, "f/f", "f/e"),
  ];

  it("walks a hand-built stack down to the trunk, nearest layer first", () => {
    expect(walkChain("f/f", "main", stack)).toEqual({
      ok: true,
      layers: [28, 27, 26, 25, 24, 23],
    });
    expect(walkChain("main", "main", stack)).toEqual({ ok: true, layers: [] });
  });

  it("refuses a branch no open pull request owns", () => {
    const r = walkChain("f/x", "main", stack);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no open pull request has f/x");
  });

  it("refuses a chain rooted elsewhere", () => {
    const r = walkChain("f/b", "main", [
      pull(1, "f/a", "release"),
      pull(2, "f/b", "f/a"),
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses an ambiguous owner", () => {
    const r = walkChain("f/a", "main", [
      pull(1, "f/a", "main"),
      pull(2, "f/a", "main"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#1, #2");
  });

  it("refuses a branch owned only by a fork's pull request", () => {
    const r = walkChain("f/a", "main", [pull(1, "f/a", "main", true)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("fork");
  });

  it("ignores a fork's pull request beside the repository's own", () => {
    expect(
      walkChain("f/a", "main", [
        pull(1, "f/a", "main", true),
        pull(2, "f/a", "main"),
      ]),
    ).toEqual({
      ok: true,
      layers: [2],
    });
  });

  it("refuses a cycle", () => {
    const r = walkChain("f/a", "main", [
      pull(1, "f/a", "f/b"),
      pull(2, "f/b", "f/a"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("loops");
  });

  it("parses gh's open pull-request listing, refusing a partial row", () => {
    expect(
      parseOpenPulls([
        {
          number: 1,
          url: "https://github.com/o/r/pull/1",
          headRefName: "a",
          baseRefName: "main",
          isCrossRepository: false,
        },
      ]),
    ).toEqual([pull(1, "a", "main")]);
    expect(() => parseOpenPulls([{ number: 1, headRefName: "a" }])).toThrow();
    expect(() => parseOpenPulls({})).toThrow();
  });
});

describe("stackRoot", () => {
  const pull = (
    number: number,
    head: string,
    base: string,
    fork = false,
  ): OpenPull => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    headRefName: head,
    baseRefName: base,
    isCrossRepository: fork,
  });
  const stack = [
    pull(23, "f/a", "main"),
    pull(24, "f/b", "f/a"),
    pull(25, "f/c", "f/b"),
  ];

  it("walks a layer's base down to the branch the stack lands on", () => {
    expect(stackRoot("f/b", "main", stack)).toEqual({
      ok: true,
      root: "main",
      layers: [24, 23],
    });
  });

  it("returns a base no open pull request owns as its own root", () => {
    expect(stackRoot("release/2", "main", stack)).toEqual({
      ok: true,
      root: "release/2",
      layers: [],
    });
  });

  it("stops at the trunk even when an open pull request has it as its head", () => {
    const withRelease = [...stack, pull(30, "main", "production")];
    expect(stackRoot("f/a", "main", withRelease)).toEqual({
      ok: true,
      root: "main",
      layers: [23],
    });
  });

  it("does not follow a pull request from a fork", () => {
    expect(stackRoot("f/x", "main", [pull(31, "f/x", "f/y", true)])).toEqual({
      ok: true,
      root: "f/x",
      layers: [],
    });
  });

  it("refuses a branch several open pull requests have as their head", () => {
    const r = stackRoot("f/a", "main", [...stack, pull(32, "f/a", "dev")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#23, #32");
  });

  it("reaches a root no pull request owns at the same depth as the trunk", () => {
    const chain = (root: string) =>
      Array.from({ length: MAX_CHAIN_WALK }, (_, i) =>
        pull(100 + i, `l${i}`, i === MAX_CHAIN_WALK - 1 ? root : `l${i + 1}`),
      );
    for (const root of ["main", "release/2"]) {
      const r = stackRoot("l0", "main", chain(root));
      expect(r.ok && r.root).toBe(root);
    }
    const r = stackRoot("l0", "main", [
      ...chain("l-extra"),
      pull(99, "l-extra", "main"),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("longer than");
  });

  it("refuses a loop", () => {
    const r = stackRoot("x", "main", [pull(40, "x", "y"), pull(41, "y", "x")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("loops back");
  });
});

describe("repository files", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pr-policy-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds pull-request templates where GitHub looks", () => {
    expect(findPrTemplates(root)).toEqual([]);
    mkdirSync(join(root, ".github", "PULL_REQUEST_TEMPLATE"), {
      recursive: true,
    });
    writeFileSync(join(root, ".github", "pull_request_template.md"), "x");
    writeFileSync(
      join(root, ".github", "PULL_REQUEST_TEMPLATE", "feature.md"),
      "x",
    );
    writeFileSync(
      join(root, ".github", "PULL_REQUEST_TEMPLATE", "notes.json"),
      "x",
    );
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "PULL_REQUEST_TEMPLATE.md"), "x");
    expect(findPrTemplates(root)).toEqual([
      ".github/PULL_REQUEST_TEMPLATE/feature.md",
      ".github/pull_request_template.md",
      "docs/PULL_REQUEST_TEMPLATE.md",
    ]);
  });

  it("finds CODEOWNERS, .github first", () => {
    expect(findCodeowners(root)).toBeNull();
    writeFileSync(join(root, "CODEOWNERS"), "* @a");
    expect(findCodeowners(root)).toBe("CODEOWNERS");
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".github", "CODEOWNERS"), "* @a");
    expect(findCodeowners(root)).toBe(".github/CODEOWNERS");
  });

  it("finds a commitlint configuration in a file or in package.json", () => {
    expect(findCommitlintConfig(root)).toBeNull();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ commitlint: { extends: [] } }),
    );
    expect(findCommitlintConfig(root)).toBe("package.json (commitlint)");
    writeFileSync(join(root, "commitlint.config.js"), "export default {}");
    expect(findCommitlintConfig(root)).toBe("commitlint.config.js");
  });

  it("derives conventional titles only from a conventional commitlint configuration", () => {
    writeFileSync(join(root, "commitlint.config.js"), "export default {}");
    expect(conventionalCommitlintConfig(root)).toBeNull();
    writeFileSync(
      join(root, "commitlint.config.js"),
      'export default { extends: ["@commitlint/config-conventional"] }',
    );
    expect(conventionalCommitlintConfig(root)).toBe("commitlint.config.js");
  });
});

describe("parseNativeStacks", () => {
  it("flattens pages and keeps members bottom to top", () => {
    expect(
      parseNativeStacks([
        [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [
              { number: 21, state: "closed", merged_at: null },
              {
                number: 22,
                state: "closed",
                merged_at: "2026-10-01T00:00:00Z",
              },
              { number: 23, state: "open", merged_at: null },
            ],
          },
        ],
        [],
      ]),
    ).toEqual([
      {
        number: 7,
        baseRef: "main",
        pulls: [
          { number: 21, state: "closed" },
          { number: 22, state: "merged" },
          { number: 23, state: "open" },
        ],
      },
    ]);
  });

  it("rejects a member without a state", () => {
    expect(() =>
      parseNativeStacks([
        [
          {
            number: 7,
            base: { ref: "main" },
            pull_requests: [{ number: 22, merged_at: null }],
          },
        ],
      ]),
    ).toThrow("state");
  });

  it("rejects a stack without a base", () => {
    expect(() =>
      parseNativeStacks([[{ number: 7, pull_requests: [] }]]),
    ).toThrow("base.ref");
  });
});

describe("planNativeLink", () => {
  const urlOf = (n: number) => `https://x/pull/${n}`;
  /** A stack whose members are open, except those listed in `merged`. */
  const stack = (
    number: number,
    pulls: number[],
    baseRef = "main",
    merged: number[] = [],
  ) => ({
    number,
    baseRef,
    pulls: pulls.map((n) => ({
      number: n,
      state: merged.includes(n) ? ("merged" as const) : ("open" as const),
    })),
  });

  it("starts a new stack from an unstacked chain", () => {
    expect(planNativeLink([24, 23], "main", [], "<PR>", urlOf)).toEqual({
      ok: true,
      linkArgs: [
        "--base",
        "main",
        "https://x/pull/23",
        "https://x/pull/24",
        "<PR>",
      ],
      depth: 3,
      appendsTo: null,
      newlyLinked: [23, 24],
    });
  });

  it("appends to the predecessor's stack by number", () => {
    expect(
      planNativeLink([24, 23], "main", [stack(7, [23, 24])], "<PR>", urlOf),
    ).toEqual({
      ok: true,
      linkArgs: ["7", "<PR>"],
      depth: 3,
      appendsTo: 7,
      newlyLinked: [],
    });
  });

  it("counts merged members the chain omits in the depth", () => {
    expect(
      planNativeLink(
        [24, 23],
        "main",
        [stack(7, [22, 23, 24], "main", [22])],
        "<PR>",
        urlOf,
      ),
    ).toEqual({
      ok: true,
      linkArgs: ["7", "<PR>"],
      depth: 4,
      appendsTo: 7,
      newlyLinked: [],
    });
  });

  it("refuses a stack whose open members run in another order than the chain", () => {
    const r = planNativeLink(
      [24, 23, 22],
      "main",
      [stack(7, [23, 22, 24])],
      "<PR>",
      urlOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#23, #22, #24 bottom to top");
  });

  it("refuses a stack with an open member the chain does not pass through", () => {
    const r = planNativeLink([24], "main", [stack(7, [23, 24])], "<PR>", urlOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("the chain of bases runs #24");
  });

  it("refuses a predecessor below the stack's top", () => {
    const r = planNativeLink(
      [24, 23],
      "main",
      [stack(7, [23, 24, 25])],
      "<PR>",
      urlOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#25 is");
  });

  it("refuses a stack that lands elsewhere", () => {
    const r = planNativeLink(
      [24],
      "main",
      [stack(7, [24], "develop")],
      "<PR>",
      urlOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("lands on develop");
  });

  it("refuses a chain layer outside the predecessor's stack", () => {
    const r = planNativeLink(
      [24, 23],
      "main",
      [stack(7, [24]), stack(8, [23])],
      "<PR>",
      urlOf,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#23");
  });

  it("refuses an unstacked predecessor above a stacked layer", () => {
    const r = planNativeLink([24, 23], "main", [stack(7, [23])], "<PR>", urlOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("#24 is in no native stack");
  });
});

describe("parseLinkEligibility", () => {
  const answer = (repository: Record<string, unknown>) => ({
    data: { repository },
  });
  const pr = (autoMerge: boolean, queued: boolean) => ({
    autoMergeRequest: autoMerge ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
    mergeQueueEntry: queued ? { id: "MQE_1" } : null,
  });

  it("names the pull requests gh-stack refuses, with the reason", () => {
    const r = parseLinkEligibility(
      answer({
        p23: pr(false, false),
        p24: pr(true, false),
        p25: pr(true, true),
      }),
      [23, 24, 25],
    );
    expect([...r]).toEqual([
      [24, "it has auto-merge enabled"],
      [25, "it is queued for merge"],
    ]);
  });

  it("rejects an answer missing a pull request", () => {
    expect(() =>
      parseLinkEligibility(answer({ p23: pr(false, false) }), [23, 24]),
    ).toThrow("#24");
  });

  it("rejects an answer without the eligibility fields", () => {
    expect(() =>
      parseLinkEligibility(answer({ p23: { autoMergeRequest: null } }), [23]),
    ).toThrow("#23");
  });
});

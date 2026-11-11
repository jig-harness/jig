/**
 * The pull-request conventions (`scripts/lib/pr-conventions.ts`): the base an
 * item's labels choose, and the commit prefix, as
 * `pull_requests` declares them and the policy parser refuses them.
 */
import { describe, expect, it } from "bun:test";
import {
  baseSource,
  chooseBase,
  parseBaseRules,
  renderCommitPrefix,
} from "../scripts/lib/pr-conventions.ts";
import { parsePrPolicy } from "../scripts/lib/pr-policy.ts";

const policy = (section: Record<string, unknown>) =>
  parsePrPolicy({ pull_requests: section });

const RULES = [
  {
    when: { labels: ["fixversion:2.4", "fixversion:2.4.1"] },
    base: "release/2.4",
  },
  { when: { labels: ["fixversion:2.3"] }, base: "release/2.3" },
];

describe("base rules", () => {
  it("refuses a dot-leading or .lock component anywhere in a base", () => {
    for (const base of ["release/.hidden", "release.lock/2.4", "a/b.lock"])
      expect(() =>
        parseBaseRules([{ when: { labels: ["x"] }, base }]),
      ).toThrow();
  });

  it("reads the rules in order", () => {
    expect(policy({ base_rules: RULES }).baseRules).toEqual([
      { labels: ["fixversion:2.4", "fixversion:2.4.1"], base: "release/2.4" },
      { labels: ["fixversion:2.3"], base: "release/2.3" },
    ]);
    expect(policy({}).baseRules).toEqual([]);
  });

  it("chooses the first rule one of whose labels the item carries, in any case", () => {
    const rules = parseBaseRules([
      ...RULES,
      { when: { labels: ["HotFix"] }, base: "release/2.3" },
    ]);
    expect(chooseBase(rules, ["hotfix"], "main").rule).toEqual({
      index: 2,
      label: "hotfix",
    });
    const chosen = chooseBase(rules, ["bug", "FixVersion:2.4.1"], "main");
    expect(chosen).toEqual({
      base: "release/2.4",
      rule: { index: 0, label: "FixVersion:2.4.1" },
    });
    expect(baseSource(chosen)).toBe(
      "pull_requests.base_rules[0], for the item's label FixVersion:2.4.1",
    );
    expect(
      chooseBase(rules, ["hotfix", "fixversion:2.3"], "main").rule,
    ).toEqual({ index: 1, label: "fixversion:2.3" });
  });

  it("falls back to the integration branch", () => {
    const chosen = chooseBase(parseBaseRules(RULES), ["bug"], "main");
    expect(chosen).toEqual({ base: "main", rule: null });
    expect(baseSource(chosen)).toBe("the integration branch");
  });

  it.each([
    [{ when: { labels: ["x"] }, base: "release/2.4" }, /must be a list/],
    [[{ base: "release/2.4" }], /base_rules\[0\]\.when must be a mapping/],
    [
      [{ when: { labels: [] }, base: "r" }],
      /when\.labels must be a nonempty list/,
    ],
    [[{ when: { labels: ["x"], paths: ["a"] }, base: "r" }], /labels only/],
    [
      [{ when: { labels: ["x"] }, base: "r", else: "main" }],
      /else is not a known field/,
    ],
    [[{ when: { labels: ["x"] } }], /base must be a branch name/],
    [[{ when: { labels: ["x"] }, base: "-r" }], /base must be a branch name/],
    [
      [{ when: { labels: ["x"] }, base: "release/../x" }],
      /base must be a branch name/,
    ],
    [
      [{ when: { labels: ["x"] }, base: "release 2.4" }],
      /base must be a branch name/,
    ],
    [
      [{ when: { labels: ["x"] }, base: "release/" }],
      /base must be a branch name/,
    ],
  ])("refuses %j", (raw, message) => {
    expect(() => policy({ base_rules: raw })).toThrow(message);
  });
});

describe("commit prefix", () => {
  it("is none by default and read with {key}", () => {
    expect(policy({}).commitPrefix).toBeNull();
    expect(policy({ commit_prefix: "{key}: " }).commitPrefix).toBe("{key}: ");
    expect(renderCommitPrefix("{key}: ", "ENG-12")).toBe("ENG-12: ");
  });

  it.each([
    [{ commit_prefix: "ENG: " }, /must contain \{key\}/],
    [{ commit_prefix: "{slug}: " }, /unknown placeholder \{slug\}/],
    [{ commit_prefix: "{key}\n" }, /one line/],
    [{ commit_prefix: 12 }, /nonempty string/],
  ])("refuses %j", (section, message) => {
    expect(() => policy(section)).toThrow(message);
  });
});

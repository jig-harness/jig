/**
 * The rule matcher: how a rule's values compare with an item's facts, how a
 * field's list of rules resolves, the one wording of why a rule matched,
 * and the rules a configuration fails to load with.
 */
import { describe, expect, it } from "bun:test";
import {
  checkRules,
  FACT_NAMES,
  RULE_FACTS,
  LIST_SEMANTICS,
  lookup,
  matchOne,
  matchRule,
  parseEntryRule,
  parseRule,
  RULE_FIELDS,
  reason,
  resolve,
  ruleList,
  ruleMap,
} from "../rule-matcher.ts";
import { ok } from "../outcome.ts";

describe("comparison", () => {
  it("compares labels and sizes ignoring case and surrounding space", () => {
    expect(matchRule({ labels: ["Bug"] }, { labels: [" bug "] })).toEqual({
      fact: "labels",
      ruleValue: "Bug",
      value: " bug ",
    });
    expect(matchRule({ size: ["large"] }, { size: ["LARGE"] })).not.toBeNull();
    expect(matchRule({ size: ["large"] }, { size: ["L"] })).toBeNull();
  });

  it("finds a title keyword anywhere in the title, ignoring case", () => {
    expect(
      matchRule({ title: ["migration"] }, { title: "Write the Migrations" }),
    ).not.toBeNull();
    expect(
      matchRule({ title: ["migration"] }, { title: "migrate" }),
    ).toBeNull();
  });

  it("matches a path by the shared glob", () => {
    expect(
      matchRule({ paths: ["db/**"] }, { paths: ["db/a/b.sql"] }),
    ).not.toBeNull();
    expect(
      matchRule({ paths: ["db/*"] }, { paths: ["db/a/b.sql"] }),
    ).toBeNull();
  });
});

describe("combination", () => {
  it("matches on any one value of any one fact, labels before paths", () => {
    const rule = { labels: ["a", "b"], paths: ["src/**"] };
    expect(matchRule(rule, { labels: ["b"], paths: [] })).toMatchObject({
      fact: "labels",
      value: "b",
    });
    expect(matchRule(rule, { labels: ["b"], paths: ["src/x"] })).toMatchObject({
      fact: "labels",
    });
    expect(matchRule(rule, { labels: [], paths: ["src/x"] })).toMatchObject({
      fact: "paths",
      value: "src/x",
    });
  });

  it("is unknown when only a fact not known yet could match", () => {
    expect(matchRule({ labels: ["a"], paths: ["x/**"] }, { labels: [] })).toBe(
      "unknown",
    );
    expect(
      matchRule(
        { labels: ["a"], paths: ["x/**"] },
        { labels: [], paths: null },
      ),
    ).toBe("unknown");
    expect(matchRule({ labels: ["a"] }, { labels: [] })).toBeNull();
  });
});

describe("list semantics", () => {
  const rules = [{ labels: ["a"] }, { labels: ["b"] }, { labels: ["A"] }];

  it("first: the first matching rule alone", () => {
    const r = resolve("pull_requests.base_rules", rules, {
      labels: ["b", "a"],
    });
    expect(r.matches.map((m) => m.at)).toEqual([0]);
  });

  it("every: each matching rule, in the order written", () => {
    const r = resolve("do_item.guidance", rules, { labels: ["b", "a"] });
    expect(r.matches.map((m) => m.at)).toEqual([0, 1, 2]);
  });

  it("lookup: each matching key, in the item's order, then the order written", () => {
    const entries = ruleMap(
      "do_item.agents.labels",
      { Front: "web", back: "api", FRONT: "ui" },
      (v) => ok(String(v)),
      "a label to an agent",
    );
    if (!entries.ok) throw new Error(entries.failure.reason);
    expect(entries.value.map((e) => e.result)).toEqual(["api", "ui"]);
    const found = lookup("do_item.agents.labels", entries.value, {
      labels: ["back", "front"],
    });
    expect(found.map((m) => m.result)).toEqual(["api", "ui"]);
  });

  it("one: the field is one rule", () => {
    const m = matchOne(
      "routing.complex_flags",
      { labels: ["x", "y"] },
      {
        labels: ["Y"],
      },
    );
    expect(m).toMatchObject({ at: null, value: "Y" });
  });

  it("names a meaning for every semantics, fact and field", () => {
    for (const s of Object.values(LIST_SEMANTICS))
      expect(s.meaning).not.toBe("");
    for (const f of FACT_NAMES) expect(RULE_FACTS[f].meaning).not.toBe("");
    for (const f of Object.values(RULE_FIELDS)) expect(f.meaning).not.toBe("");
  });
});

describe("reason", () => {
  it("names the field, the rule and what matched, in one wording", () => {
    const [first] = resolve(
      "pull_requests.base_rules",
      [{ labels: ["hotfix"] }],
      { labels: ["Hotfix"] },
    ).matches;
    if (first === undefined) throw new Error("no match");
    expect(reason(first)).toBe(
      "pull_requests.base_rules[0], for the item's label Hotfix",
    );
    const one = matchOne(
      "routing.complex_flags",
      { labels: ["x"] },
      {
        labels: ["x"],
      },
    );
    if (one === null) throw new Error("no match");
    expect(reason(one, "an area the item reaches")).toBe(
      "routing.complex_flags, for the label x of an area the item reaches",
    );
    const [kw] = lookup(
      "do_item.agents.title_keywords",
      [{ key: "fix", result: "a" }],
      { title: "Fix it" },
    );
    if (kw === undefined) throw new Error("no match");
    expect(reason(kw)).toBe(
      "do_item.agents.title_keywords.fix, for the keyword fix in the item's title",
    );
  });
});

describe("reading rules", () => {
  it("refuses an unknown fact and a fact the field does not test, naming the field", () => {
    const unknown = parseRule(
      "pull_requests.base_rules",
      { colour: ["x"] },
      "at",
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.failure.reason).toBe(
        "at.colour is not a fact a rule may test (labels)",
      );
    const untested = parseRule(
      "pull_requests.base_rules",
      { paths: ["x"] },
      "at",
    );
    if (!untested.ok)
      expect(untested.failure.reason).toContain("test labels only");
    else throw new Error("accepted");
  });

  it("refuses a fact an entry's field does not test", () => {
    const title = parseEntryRule(
      "do_item.gates",
      { labels: ["db"], title: ["x"], skill: "s" },
      "do_item.gates[0]",
    );
    if (title.ok) throw new Error("accepted");
    expect(title.failure.reason).toBe(
      "do_item.gates[0].title: the rules of do_item.gates test labels and paths only",
    );
  });

  it("refuses a value of the wrong kind and a glob that does not compile", () => {
    expect(
      parseRule("pull_requests.base_rules", { labels: "x" }, "at").ok,
    ).toBe(false);
    const glob = parseEntryRule("do_item.gates", { paths: ["a/{b"] }, "g[0]");
    if (glob.ok) throw new Error("accepted");
    expect(glob.failure.reason).toContain("g[0].paths");
  });

  it("reads a list field, its words and its distinct values", () => {
    expect(ruleList("routing.raise.flags", "catalog")).toEqual(ok("catalog"));
    expect(ruleList("routing.complex_flags", [])).toEqual(ok({ labels: [] }));
    const twice = ruleList("routing.complex_flags", ["a", "a"]);
    if (twice.ok) throw new Error("accepted");
    expect(twice.failure.reason).toBe(
      "routing.complex_flags must be a list of distinct nonempty label names",
    );
  });
});

describe("checkRules", () => {
  it("accepts every field's simple forms", () => {
    expect(
      checkRules({
        pull_requests: {
          base_rules: [{ when: { labels: ["hotfix"] }, base: "release" }],
          labels_from_issue: { bug: "kind/bug" },
        },
        do_item: {
          gates: [{ labels: ["db"], paths: ["db/**"], skill: "review-db" }],
          agents: { labels: { web: "web-dev" } },
        },
        routing: { complex_flags: [], raise: { flags: "catalog" } },
        work_batch: { solo_flags: ["privacy"] },
      }),
    ).toEqual(ok(null));
  });

  it.each([
    [
      {
        pull_requests: { base_rules: [{ when: { title: ["x"] }, base: "r" }] },
      },
      "pull_requests.base_rules[0].when.title: the rules of pull_requests.base_rules test labels only",
    ],
    [
      { do_item: { gates: [{ skill: "x" }] } },
      "do_item.gates[0] must name labels or paths to match on",
    ],
    [
      { do_item: { guidance: [{ labels: "db", skills: ["x"] }] } },
      "do_item.guidance[0].labels must be a nonempty list of label names",
    ],
    [
      { routing: { raise: { sizes: "large" } } },
      "routing.raise.sizes must be a list of distinct nonempty size names",
    ],
    [
      { work_batch: { solo_flags: [1] } },
      "work_batch.solo_flags must be a list of distinct nonempty label names",
    ],
    [
      { do_item: { agents: { title_keywords: ["x"] } } },
      "do_item.agents.title_keywords must map a value to a result",
    ],
  ])("refuses %j", (config, why) => {
    const checked = checkRules(config);
    if (checked.ok) throw new Error("accepted");
    expect(checked.failure.reason).toBe(why);
  });
});

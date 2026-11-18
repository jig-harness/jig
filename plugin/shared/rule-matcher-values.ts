/**
 * The tables of the rule matcher (`rule-matcher.ts`): the facts a rule in
 * a repository's configuration may test and how each is compared, how a
 * rule's values combine, how a field's list of rules resolves, and every
 * configuration field that selects by an item's or a change's facts. The
 * Protocol chapter *Rule matchers in configuration*
 * (`plugin/protocol/rule-matchers.md`) is generated from these tables, so
 * each entry carries the meaning the chapter prints.
 */
import { type Shape, s } from "./shapes.ts";

/** The facts a rule may test, in the order a rule's facts are tried. */
export const FACT_NAMES = ["labels", "title", "size", "paths"] as const;
export type FactName = (typeof FACT_NAMES)[number];

/** How a rule's value is compared with one of the item's values for a fact. */
export type Comparison =
  | "equal-ignoring-case"
  | "contained-ignoring-case"
  | "glob";

/** One fact a rule may test. */
export interface FactSpec {
  /** What the item or the change holds for the fact. */
  readonly holds: string;
  /** What a rule lists for it. */
  readonly ruleValue: string;
  readonly comparison: Comparison;
  /** How the comparison reads, for the chapter. */
  readonly compared: string;
  readonly meaning: string;
}

export const RULE_FACTS: Readonly<Record<FactName, FactSpec>> = {
  labels: {
    holds: "a list of label names",
    ruleValue: "a list of label names",
    comparison: "equal-ignoring-case",
    compared:
      "Equal, ignoring case and white space around the name: `Bug` matches `bug`.",
    meaning:
      "The labels the tracker item carries; for a flag an area of the change-area catalog declares, the flags of the areas the item's labels reach.",
  },
  title: {
    holds: "one text",
    ruleValue: "a list of keywords",
    comparison: "contained-ignoring-case",
    compared:
      "The keyword appears anywhere in the title, ignoring case: `migration` matches `Write the Migrations`.",
    meaning: "The tracker item's title.",
  },
  size: {
    holds: "a list of size names",
    ruleValue: "a list of size names",
    comparison: "equal-ignoring-case",
    compared:
      "Equal, ignoring case and white space around the name, as a label is; a size is never compared by its step, so `large` does not match `L`.",
    meaning:
      "The item's size: its size facet's value where the repository has a size facet, else its labels.",
  },
  paths: {
    holds: "a list of repository-relative paths",
    ruleValue: "a list of path globs",
    comparison: "glob",
    compared:
      "The glob claims the path, by the glob matching the change-area catalog uses: `**` spans directories, `*` and `?` stay within one, `{a,b}` alternates and `[...]` is a character class.",
    meaning:
      "The paths the change touches. Before the change exists they are the paths the caller says it plans to touch; a rule that could match only by its paths is then listed apart, for whoever plans the change to apply.",
  },
};

/** How a rule's facts and values combine. */
export const RULE_COMBINATION = {
  name: "any",
  meaning:
    "A rule matches when any one value it lists, for any one fact it tests, matches the item: one label of several is enough, and a label or a path is enough. A rule cannot yet say that every value, or none, must match.",
} as const;

/** How a field's list of rules resolves. */
export type ListSemantics = "first" | "every" | "lookup" | "one";

export const LIST_SEMANTICS: Readonly<
  Record<ListSemantics, { readonly meaning: string }>
> = {
  first: {
    meaning:
      "The rules are tried in the order written and the first that matches decides; when none matches, the field's fallback applies.",
  },
  every: {
    meaning: "Every rule that matches applies, in the order written.",
  },
  lookup: {
    meaning:
      "A map from one fact's value to a result: every key that matches one of the item's values applies, in the order of the item's values, then the order written. Keys that differ only in case are one key, the last written.",
  },
  one: {
    meaning:
      "The field is one rule: it applies or not, and names the value that matched.",
  },
};

/**
 * How a field is written: `when`, a list of entries each holding its rule
 * under `when`; `entry`, a list of entries whose own fact keys are the
 * rule; `map`, a map from a fact's value to a result; `list`, a list of
 * values of the field's one fact.
 */
export type RuleForm = "when" | "entry" | "map" | "list";

export const RULE_FORMS: Readonly<
  Record<RuleForm, { readonly meaning: string }>
> = {
  when: {
    meaning:
      "A list of entries, each holding its rule under `when`: `{ when: { labels: [hotfix] }, base: release }`.",
  },
  entry: {
    meaning:
      'A list of entries whose own fact keys are the rule: `{ labels: [db], paths: ["db/**"], skill: migration-review }`.',
  },
  map: {
    meaning:
      "A map from a value of the field's fact to a result: `{ bug: kind/bug }` is the rule `{ labels: [bug] }` for the result `kind/bug`.",
  },
  list: {
    meaning:
      "A list of values of the field's fact: `[has-migration]` is the rule `{ labels: [has-migration] }`.",
  },
};

/** One configuration field that selects by an item's or a change's facts. */
export interface RuleField {
  /** The facts its rules may test. */
  readonly facts: readonly FactName[];
  readonly list: ListSemantics;
  readonly form: RuleForm;
  /** Words the field accepts in place of a list, and what each stands for. */
  readonly words?: Readonly<Record<string, string>>;
  /** An entry-form field's result keys, beside the facts: no other key is allowed. */
  readonly results?: readonly string[];
  /** The skills that read it. */
  readonly readBy: readonly string[];
  readonly meaning: string;
}

export const RULE_FIELDS: Readonly<Record<string, RuleField>> = {
  "pull_requests.base_rules": {
    facts: ["labels"],
    list: "first",
    form: "when",
    readBy: ["do-item", "audit"],
    meaning:
      "The base branch a pull request targets: the first rule's `base`; the integration branch when none matches.",
  },
  "do_item.gates": {
    facts: ["labels", "paths"],
    list: "every",
    form: "entry",
    results: ["skill"],
    readBy: ["do-item", "audit"],
    meaning:
      "The review skills that must approve a change before it is pushed.",
  },
  "do_item.guidance": {
    facts: ["labels", "paths"],
    list: "every",
    form: "entry",
    results: ["skills", "notes"],
    readBy: ["do-item", "audit"],
    meaning: "The skills and notes the implementing agent is given.",
  },
  "do_item.agents.labels": {
    facts: ["labels"],
    list: "lookup",
    form: "map",
    readBy: ["do-item", "work-batch"],
    meaning: "The agent that implements an item carrying the label.",
  },
  "do_item.agents.codearea_areas": {
    facts: ["labels"],
    list: "lookup",
    form: "map",
    readBy: ["do-item", "work-batch", "dispatch"],
    meaning:
      "The change area an item carrying the label reaches, for the area's agent and guidance.",
  },
  "do_item.agents.title_keywords": {
    facts: ["title"],
    list: "lookup",
    form: "map",
    readBy: ["do-item"],
    meaning:
      "The agent that implements an item whose title holds the keyword, beside the agents its labels choose.",
  },
  "pull_requests.labels_from_issue": {
    facts: ["labels"],
    list: "lookup",
    form: "map",
    readBy: ["do-item", "audit"],
    meaning:
      "The label the pull request opens with for an item carrying the label.",
  },
  "pull_requests.reviewers_from_issue": {
    facts: ["labels"],
    list: "lookup",
    form: "map",
    readBy: ["do-item"],
    meaning:
      "The reviewers asked on the pull request for an item carrying the label.",
  },
  "routing.complex_flags": {
    facts: ["labels"],
    list: "one",
    form: "list",
    readBy: ["do-item", "audit"],
    meaning:
      "Makes the item's complexity tier complex at any size, when the item or an area it reaches carries one of the flags.",
  },
  "routing.raise.flags": {
    facts: ["labels"],
    list: "one",
    form: "list",
    words: {
      catalog: "Every flag an area of the change-area catalog declares.",
    },
    readBy: ["do-item", "audit"],
    meaning: "Raises the implementer's effort one step.",
  },
  "routing.raise.sizes": {
    facts: ["size"],
    list: "one",
    form: "list",
    readBy: ["do-item", "audit"],
    meaning:
      "Raises the implementer's effort one step; unset, the sizes `issue_tracker.labels.batch_sizes` leaves out.",
  },
  "work_batch.solo_flags": {
    facts: ["labels"],
    list: "one",
    form: "list",
    readBy: ["work-batch", "dispatch"],
    meaning:
      "Holds an item out of a batch, joined to the flags work-batch derives (the human-in-the-loop label and its facets, `manual-ops`, and every flag the catalog declares).",
  },
};

const factList = s.array(s.string({ minLength: 1, pattern: "\\S" }), {
  minItems: 1,
});

/**
 * A rule written as a mapping of facts, as a `when` holds it: at least one
 * fact, each a nonempty list of values that are not blank, no other key.
 * Written as one alternative per fact that requires it, since the
 * description's vocabulary has no minimum count of keys.
 */
export const RULE_SHAPE: Shape = s.union(
  FACT_NAMES.map((required) =>
    s.object(
      Object.fromEntries(
        FACT_NAMES.map((f) => [
          f,
          f === required ? factList : s.optional(factList),
        ]),
      ),
      { additionalProperties: false },
    ),
  ),
);

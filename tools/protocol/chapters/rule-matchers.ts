/**
 * The chapter on rule matchers in configuration, generated from the rule
 * matcher's tables (`plugin/shared/rule-matcher-values.ts`): the facts a
 * rule may test and how each is compared, how a rule's values combine, how
 * a field's rules resolve, the forms a field is written in, and every field
 * that selects by an item's or a change's facts.
 */
import {
  RULE_COMBINATION,
  FACT_NAMES,
  RULE_FACTS,
  LIST_SEMANTICS,
  type ListSemantics,
  RULE_FIELDS,
  RULE_FORMS,
  RULE_SHAPE,
  type RuleForm,
} from "../../../plugin/shared/rule-matcher-values.ts";
import {
  type Chapter,
  type DataValue,
  type FieldSpec,
  fromRows,
  type TableRow,
} from "../chapter.ts";
import { table } from "../markdown.ts";

const SOURCE_FILE = "plugin/shared/rule-matcher-values.ts";
const source = (name: string) => `${SOURCE_FILE}#${name}`;

/** Entries of the imported tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

const none = {
  holds: null,
  ruleValue: null,
  compared: null,
  comparison: null,
  facts: null,
  list: null,
  form: null,
  words: null,
  readBy: null,
};

const code = (text: string) => `\`${text}\``;

function rows(): TableRow[] {
  return [
    ...FACT_NAMES.map((name) => {
      const f = RULE_FACTS[name];
      return {
        table: "RULE_FACTS",
        value: {
          kind: "fact",
          name,
          ...none,
          holds: f.holds,
          ruleValue: f.ruleValue,
          compared: f.compared,
          comparison: f.comparison,
          meaning: f.meaning,
        },
      };
    }),
    {
      table: "RULE_COMBINATION",
      value: {
        kind: "combination",
        name: RULE_COMBINATION.name,
        ...none,
        meaning: RULE_COMBINATION.meaning,
      },
    },
    ...(Object.keys(LIST_SEMANTICS) as ListSemantics[]).map((name) => ({
      table: "LIST_SEMANTICS",
      value: {
        kind: "list",
        name,
        ...none,
        meaning: LIST_SEMANTICS[name].meaning,
      },
    })),
    ...(Object.keys(RULE_FORMS) as RuleForm[]).map((name) => ({
      table: "RULE_FORMS",
      value: {
        kind: "form",
        name,
        ...none,
        meaning: RULE_FORMS[name].meaning,
      },
    })),
    ...Object.entries(RULE_FIELDS).map(([name, f]) => ({
      table: "RULE_FIELDS",
      value: {
        kind: "field",
        name,
        ...none,
        facts: f.facts.join(", "),
        list: f.list,
        form: f.form,
        words:
          f.words === undefined
            ? null
            : Object.entries(f.words)
                .map(([w, m]) => `${w}: ${m}`)
                .join("; "),
        readBy: f.readBy.join(", "),
        meaning: f.meaning,
      },
    })),
  ].filter(
    (r) => !EXCLUDED.includes(`${source(r.table)}.${String(r.value.name)}`),
  );
}

const ofKind = (kind: string): DataValue[] =>
  rows()
    .map((r) => r.value)
    .filter((v) => v.kind === kind);

function factsTable(): string {
  return table(
    ["Fact", "The item holds", "A rule lists", "Compared", "Meaning"],
    ofKind("fact").map((v) => [
      code(String(v.name)),
      String(v.holds),
      String(v.ruleValue),
      String(v.compared),
      String(v.meaning),
    ]),
  );
}

function combinationTable(): string {
  return table(
    ["Combination", "Meaning"],
    ofKind("combination").map((v) => [code(String(v.name)), String(v.meaning)]),
  );
}

function listTable(): string {
  return table(
    ["List semantics", "Meaning"],
    ofKind("list").map((v) => [code(String(v.name)), String(v.meaning)]),
  );
}

function formsTable(): string {
  return table(
    ["Form", "Meaning"],
    ofKind("form").map((v) => [code(String(v.name)), String(v.meaning)]),
  );
}

function fieldsTable(): string {
  return table(
    ["Field", "Facts", "List", "Form", "Words", "Read by", "Meaning"],
    ofKind("field").map((v) => [
      code(String(v.name)),
      String(v.facts),
      code(String(v.list)),
      code(String(v.form)),
      v.words === null ? "—" : String(v.words),
      String(v.readBy),
      String(v.meaning),
    ]),
  );
}

const text = (description: string, nullable = true): FieldSpec => ({
  type: "string",
  nullable,
  required: true,
  identifies: false,
  description,
});

const prose = (description: string): FieldSpec => ({
  ...text(description),
  comparedAs: "prose",
});

const names = (description: string): FieldSpec => ({
  ...text(description),
  comparedAs: "names",
});

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "fact for a fact a rule may test, combination for how a rule's values combine, list for how a field's rules resolve, form for how a field is written, field for a configuration field that uses the matcher.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The fact, combination, list semantics or form as configuration and the code name it; for a field, its dotted path in .config/jig.yaml.",
  },
  holds: text("For a fact, what the item or change holds for it; else null."),
  ruleValue: text("For a fact, what a rule lists for it; else null."),
  compared: prose(
    "For a fact, how a rule's value is compared with the item's; else null.",
  ),
  comparison: text(
    "For a fact, the comparison's name, for a program that evaluates a rule: equal-ignoring-case (equal after trimming white space and folding case), contained-ignoring-case (the rule's value is a substring of the item's, case folded) or glob (the change-area catalog's glob claims the path); else null.",
  ),
  facts: names(
    "For a field, the facts its rules may test, comma-separated; else null.",
  ),
  list: text(
    "For a field, its list semantics (a list value's name); else null.",
  ),
  form: text(
    "For a field, the form it is written in (a form value's name); else null.",
  ),
  words: text(
    "For a field, the words it accepts in place of a list and what each stands for, as word: meaning separated by semicolons; null where it accepts none, and for the other kinds.",
  ),
  readBy: names(
    "For a field, the skills that read it, comma-separated; else null.",
  ),
  meaning: text("What the value means, or what the field selects.", false),
};

export const RULE_MATCHERS_CHAPTER: Chapter = {
  id: "rule-matchers",
  title: "Rule matchers in configuration",
  summary:
    "The configuration fields that select by an item's or a change's facts: the facts a rule may test, how each is compared, how a rule combines its values, and how a field's rules resolve.",
  version: 1,
  status: "stable",
  planItems: [],
  module: "tools/protocol/chapters/rule-matchers.ts",
  sections: [
    { source: source("RULE_FACTS"), render: factsTable },
    { source: source("RULE_COMBINATION"), render: combinationTable },
    { source: source("LIST_SEMANTICS"), render: listTable },
    { source: source("RULE_FORMS"), render: formsTable },
    { source: source("RULE_FIELDS"), render: fieldsTable },
  ],
  fields: FIELDS,
  ...fromRows(SOURCE_FILE, rows),
  excluded: EXCLUDED,
  schemas: [{ name: "rule", shape: RULE_SHAPE }],
};

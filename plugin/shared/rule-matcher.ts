/**
 * The rule matcher: the one place that decides whether a rule in a
 * repository's configuration matches an item or a change, for every field
 * that selects by their facts (`RULE_FIELDS` in `rule-matcher-values.ts`).
 *
 * A rule maps facts to the values it lists:
 *
 *   { labels: [hotfix, urgent], paths: ["db/**"] }
 *
 * and matches when any one listed value matches the item (`RULE_COMBINATION`).
 * A field's simple forms (a list of labels, a map from a label to a result)
 * are read as such rules by `ruleList` and `ruleMap`, and a field's list of
 * rules resolves as its `RULE_FIELDS` entry says. Each match carries the
 * field, the rule and the value that matched, and `reason` words it the one
 * way every skill prints it.
 *
 * The parsers return an `Outcome`: the reason names the field (and the rule's
 * index) for whichever reader reports it, the shared configuration reader at
 * load or the field's own parser.
 */
import { formatField } from "./config-layers.ts";
import { globProblem, matchesGlob } from "./glob.ts";
import { isRecord } from "./guards.ts";
import { Defect, failed, ok, type Outcome } from "./outcome.ts";
import {
  FACT_NAMES,
  RULE_FACTS,
  type FactName,
  RULE_FIELDS,
  type RuleField,
} from "./rule-matcher-values.ts";

export * from "./rule-matcher-values.ts";

/** A rule: each fact it tests, with the values it lists for it. */
export type Rule = Readonly<Partial<Record<FactName, readonly string[]>>>;

/**
 * What an item or a change holds for each fact. A fact left out, or a
 * `paths` of `null`, is not known yet.
 */
export interface Facts {
  readonly labels?: readonly string[];
  readonly title?: string;
  readonly size?: readonly string[];
  readonly paths?: readonly string[] | null;
}

/** A rule that matched: where, by which fact, and which value. */
export interface Match {
  /** The field's path, `pull_requests.base_rules`. */
  readonly field: string;
  /** The rule's index in a list, or its key in a map; `null` for a field that is one rule. */
  readonly at: number | string | null;
  readonly fact: FactName;
  /** The value the rule lists. */
  readonly ruleValue: string;
  /** The item's value that matched it. */
  readonly value: string;
}

export type RuleFailure = "rule-invalid";

const fold = (text: string) => text.trim().toLowerCase();

/** Whether a rule's value matches one of the item's values for `fact`. */
function compare(fact: FactName, ruleValue: string, value: string): boolean {
  switch (RULE_FACTS[fact].comparison) {
    case "equal-ignoring-case":
      return fold(ruleValue) === fold(value);
    case "contained-ignoring-case":
      return value.toLowerCase().includes(ruleValue.toLowerCase());
    case "glob":
      return matchesGlob(value, ruleValue);
  }
}

/** The item's values for `fact`, or `null` when they are not known. */
function valuesOf(facts: Facts, fact: FactName): readonly string[] | null {
  if (fact === "title") return facts.title === undefined ? null : [facts.title];
  return facts[fact] ?? null;
}

/** The field's entry, which every caller names. */
export function ruleField(field: string): RuleField {
  const entry = RULE_FIELDS[field];
  if (entry === undefined)
    throw new Defect(`${field} is not a field of RULE_FIELDS`);
  return entry;
}

// ---------------------------------------------------------------------------
// Reading rules
// ---------------------------------------------------------------------------

/** One fact's values, checked: a nonempty list of nonempty text, each glob compiling. */
function factValues(
  fact: FactName,
  raw: unknown,
  at: string,
): Outcome<string[], RuleFailure> {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((v) => typeof v !== "string" || v.trim() === "")
  )
    return failed(
      "rule-invalid",
      `${at} must be a nonempty list of ${RULE_FACTS[fact].ruleValue.replace(/^a list of /, "")}`,
    );
  if (fact === "paths")
    for (const glob of raw as string[]) {
      const problem = globProblem(glob);
      if (problem !== null)
        return failed(
          "rule-invalid",
          `${at}: ${JSON.stringify(glob)} does not compile: ${problem}`,
        );
    }
  return ok([...(raw as string[])]);
}

const isFact = (key: string): key is FactName =>
  (FACT_NAMES as readonly string[]).includes(key);

/** A fact the field's rules test, or why `key` is not one. */
function factOf(
  field: string,
  key: string,
  at: string,
): Outcome<FactName, RuleFailure> {
  const tested = ruleField(field).facts;
  if (!isFact(key))
    return failed(
      "rule-invalid",
      `${at}.${formatField([key])} is not a fact a rule may test (${tested.join(", ")})`,
    );
  if (!tested.includes(key))
    return failed(
      "rule-invalid",
      `${at}.${key}: the rules of ${field} test ${tested.join(" and ")} only`,
    );
  return ok(key);
}

/**
 * A rule written as a mapping of facts (`when` of a `pull_requests.base_rules`
 * entry): every key a fact the field's rules test, and at least one.
 */
export function parseRule(
  field: string,
  raw: unknown,
  at: string,
): Outcome<Rule, RuleFailure> {
  if (!isRecord(raw) || Object.keys(raw).length === 0)
    return failed(
      "rule-invalid",
      `${at} must be a mapping of ${ruleField(field).facts.join(" or ")} to a list of values`,
    );
  const rule: Partial<Record<FactName, string[]>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const fact = factOf(field, key, at);
    if (!fact.ok) return fact;
    const values = factValues(fact.value, value, `${at}.${key}`);
    if (!values.ok) return values;
    rule[fact.value] = values.value;
  }
  return ok(rule);
}

/**
 * The rule an entry's own fact keys make (`do_item.gates`, `do_item.guidance`):
 * the keys among the field's facts, each checked; a fact the field does not
 * test is refused, and any key beside the facts and the field's `results` is refused.
 */
export function parseEntryRule(
  field: string,
  entry: Readonly<Record<string, unknown>>,
  at: string,
): Outcome<Rule, RuleFailure> {
  const { facts: tested, results } = ruleField(field);
  const stray = Object.keys(entry).find(
    (k) =>
      results !== undefined &&
      !results.includes(k) &&
      !(FACT_NAMES as readonly string[]).includes(k),
  );
  if (stray !== undefined)
    return failed(
      "rule-invalid",
      `${at}.${formatField([stray])} is not a known field (${[...tested, ...(results ?? [])].join(", ")})`,
    );
  const untested = FACT_NAMES.find((f) => !tested.includes(f) && f in entry);
  if (untested !== undefined)
    return failed(
      "rule-invalid",
      `${at}.${untested}: the rules of ${field} test ${tested.join(" and ")} only`,
    );
  const rule: Partial<Record<FactName, string[]>> = {};
  for (const fact of tested) {
    const raw = entry[fact];
    // An empty list tests nothing, as an absent one does.
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw) && raw.length === 0) continue;
    const values = factValues(fact, raw, `${at}.${fact}`);
    if (!values.ok) return values;
    rule[fact] = values.value;
  }
  if (Object.keys(rule).length === 0)
    return failed(
      "rule-invalid",
      `${at} must name ${ruleField(field).facts.join(" or ")} to match on`,
    );
  return ok(rule);
}

/** The field's one fact, for a field written as a list or a map. */
function onlyFact(field: string): FactName {
  const [fact, ...more] = ruleField(field).facts;
  if (fact === undefined || more.length > 0)
    throw new Defect(`${field} must test exactly one fact`);
  return fact;
}

/**
 * A field written as a list of values of its one fact (`routing.complex_flags`):
 * the rule it stands for. A word the field accepts in place of the list
 * (`catalog`) is returned as the word.
 */
export function ruleList(
  field: string,
  raw: unknown,
): Outcome<Rule | string, RuleFailure> {
  const { words } = ruleField(field);
  if (
    typeof raw === "string" &&
    words !== undefined &&
    Object.hasOwn(words, raw)
  )
    return ok(raw);
  const fact = onlyFact(field);
  if (
    !Array.isArray(raw) ||
    raw.some((v) => typeof v !== "string" || v.trim() === "") ||
    new Set(raw).size !== raw.length
  ) {
    const alternatives = Object.keys(words ?? {})
      .map((w) => `, or ${w}`)
      .join("");
    return failed(
      "rule-invalid",
      `${field} must be a list of distinct nonempty ${RULE_FACTS[fact].ruleValue.replace(/^a list of /, "")}${alternatives}`,
    );
  }
  if (raw.length === 0) return ok({ [fact]: [] });
  const values = factValues(fact, raw, field);
  return values.ok ? ok({ [fact]: values.value }) : values;
}

/** One entry of a field written as a map: its key, and what it maps to. */
export interface MapEntry<T> {
  readonly key: string;
  readonly result: T;
}

/**
 * A field written as a map from a value of its one fact to a result
 * (`do_item.agents.labels`): its entries in the order written, keys that
 * the field's comparison treats as equal kept once, in the first one's place, with the last written value. `result` checks each
 * value; its failure reason is appended to the entry's path.
 */
export function ruleMap<T>(
  field: string,
  raw: unknown,
  result: (value: unknown) => Outcome<T, string>,
  describe: string,
): Outcome<MapEntry<T>[], RuleFailure> {
  if (raw === undefined || raw === null) return ok([]);
  if (!isRecord(raw))
    return failed("rule-invalid", `${field} must map ${describe}`);
  const byKey = new Map<string, MapEntry<T>>();
  // Keys are one entry exactly when the field's comparison says they match.
  const identity =
    RULE_FACTS[onlyFact(field)].comparison === "contained-ignoring-case"
      ? (key: string) => key.toLowerCase()
      : fold;
  for (const [key, value] of Object.entries(raw)) {
    const at = `${field}.${key}`;
    if (key.trim() === "")
      return failed("rule-invalid", `${field} must not have an empty key`);
    const checked = result(value);
    if (!checked.ok)
      return failed("rule-invalid", `${at} ${checked.failure.reason}`);
    byKey.set(identity(key), { key, result: checked.value });
  }
  return ok([...byKey.values()]);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Whether `rule` matches: the first fact (in `FACT_NAMES` order) and the
 * first value the rule lists for it (in the order written) that one of the
 * item's values matches, with that value. `unknown` when nothing known
 * matches and the rule tests a fact the item does not know yet.
 */
export function matchRule(
  rule: Rule,
  facts: Facts,
): Omit<Match, "field" | "at"> | "unknown" | null {
  let unknown = false;
  for (const fact of FACT_NAMES) {
    const listed = rule[fact];
    if (listed === undefined || listed.length === 0) continue;
    const values = valuesOf(facts, fact);
    if (values === null) {
      unknown = true;
      continue;
    }
    for (const ruleValue of listed) {
      const value = values.find((v) => compare(fact, ruleValue, v));
      if (value !== undefined) return { fact, ruleValue, value };
    }
  }
  return unknown ? "unknown" : null;
}

/** What a field's list of rules resolves to: the matches, and the rules only unknown facts could match. */
export interface Resolution {
  readonly matches: Match[];
  /** Indexes of rules that matched nothing known but test a fact not known yet. */
  readonly undecided: number[];
}

/**
 * A field's list of rules against the item's facts, as the field's list
 * semantics say: `first`, the first match alone; `every`, every match;
 * `one`, the field's one rule.
 */
export function resolve(
  field: string,
  rules: readonly Rule[],
  facts: Facts,
): Resolution {
  const { list } = ruleField(field);
  const matches: Match[] = [];
  const undecided: number[] = [];
  for (const [i, rule] of rules.entries()) {
    const m = matchRule(rule, facts);
    if (m === "unknown") {
      undecided.push(i);
      continue;
    }
    if (m === null) continue;
    matches.push({ field, at: list === "one" ? null : i, ...m });
    if (list !== "every") break;
  }
  return { matches, undecided };
}

/** The one rule of a field written as a list, against the item: the match, or `null`. */
export function matchOne(
  field: string,
  rule: Rule,
  facts: Facts,
): Match | null {
  return resolve(field, [rule], facts).matches[0] ?? null;
}

/**
 * A field written as a map, against the item: every entry whose key matches
 * one of the item's values, in the order of the item's values, then the
 * order written.
 */
export function lookup<T>(
  field: string,
  entries: readonly MapEntry<T>[],
  facts: Facts,
): Array<Match & { readonly result: T }> {
  const fact = onlyFact(field);
  const out: Array<Match & { readonly result: T }> = [];
  for (const value of valuesOf(facts, fact) ?? [])
    for (const { key, result } of entries)
      if (compare(fact, key, value))
        out.push({ field, at: key, fact, ruleValue: key, value, result });
  return out;
}

// ---------------------------------------------------------------------------
// Saying why
// ---------------------------------------------------------------------------

/** The rule as a person finds it in the configuration. */
function ruleAt(match: Match): string {
  if (match.at === null) return match.field;
  if (typeof match.at === "number") return `${match.field}[${match.at}]`;
  return `${match.field}.${formatField([match.at])}`;
}

/** What matched, in words. */
function what(match: Match, owner: string | undefined): string {
  switch (match.fact) {
    case "labels":
      return owner === undefined
        ? `the item's label ${match.value}`
        : `the label ${match.value} of ${owner}`;
    case "size":
      return `the item's size ${match.value}`;
    case "title":
      return `the keyword ${match.ruleValue} in the item's title`;
    case "paths":
      return `the changed path ${match.value}`;
  }
}

/**
 * Why a rule chose something, the one wording every skill prints:
 * `pull_requests.base_rules[0], for the item's label hotfix`. `owner` names
 * whose labels matched when they are not the item's own
 * (`an area the item reaches`).
 */
export function reason(match: Match, owner?: string): string {
  return `${ruleAt(match)}, for ${what(match, owner)}`;
}

// ---------------------------------------------------------------------------
// Checking a configuration's rules at load
// ---------------------------------------------------------------------------

/** The value at a dotted field path of the merged configuration, or `undefined`. */
function valueAt(
  values: Readonly<Record<string, unknown>>,
  field: string,
): unknown {
  let at: unknown = values;
  for (const key of field.split(".")) {
    if (!isRecord(at) || !Object.hasOwn(at, key)) return undefined;
    at = at[key];
  }
  return at;
}

/** The entries of a `when` or entry-rule field's list, checked. */
function checkEntries(
  field: string,
  form: "when" | "entry",
  raw: unknown,
): Outcome<null, RuleFailure> {
  if (!Array.isArray(raw))
    return failed("rule-invalid", `${field} must be a list of rules`);
  for (const [i, entry] of raw.entries()) {
    const at = `${field}[${i}]`;
    if (!isRecord(entry))
      return failed("rule-invalid", `${at} must be a mapping`);
    const rule =
      form === "when"
        ? parseRule(field, entry.when, `${at}.when`)
        : parseEntryRule(field, entry, at);
    if (!rule.ok) return rule;
  }
  return ok(null);
}

/** The rule parts of one field's value, checked. */
function checkField(field: string, raw: unknown): Outcome<null, RuleFailure> {
  const { form } = ruleField(field);
  if (form === "list") {
    const rule = ruleList(field, raw);
    return rule.ok ? ok(null) : rule;
  }
  if (form === "map") {
    const entries = ruleMap(field, raw, (v) => ok(v), "a value to a result");
    return entries.ok ? ok(null) : entries;
  }
  return checkEntries(field, form, raw);
}

/**
 * Every rule of every `RULE_FIELDS` field the configuration sets, checked:
 * an unknown fact, a fact the field does not test, or a value of the wrong
 * kind fails, naming the field. The fields' other parts are checked by the
 * skills that read them.
 */
export function checkRules(
  values: Readonly<Record<string, unknown>>,
): Outcome<null, RuleFailure> {
  for (const field of Object.keys(RULE_FIELDS)) {
    const raw = valueAt(values, field);
    if (raw === undefined || raw === null) continue;
    const checked = checkField(field, raw);
    if (!checked.ok) return checked;
  }
  return ok(null);
}

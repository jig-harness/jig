/**
 * The decision source: one JSON document per escalated `/decide` issue, from
 * which every projection is rendered — the HTML decision sheet, the full
 * markdown elaboration, and the short tracker comment. Because all
 * three come from this one document, the text and the visual cannot drift.
 *
 * Validation is strict on purpose. An unknown key is an error, not a field to
 * ignore: a typo such as `obligaton` would otherwise drop a claim from every
 * projection without a trace. Status is derived from the per-call rulings and
 * never stored, so it cannot disagree with them.
 */

import type { GlossaryEntry } from "../sheet-kit/inline.ts";
import {
  ISSUE_ID,
  type Json,
  Checker as KitChecker,
  type SourcedClaim,
} from "../sheet-kit/source.ts";
import { refProblems } from "./refs.ts";

export type { GlossaryEntry, SourcedClaim };

export const SOURCE_SCHEMA = "decision-sheet/v1";

/** The fixed outcome vocabulary of the matrix. Each kind renders as an icon plus a word. */
export const OUTCOME_KINDS = ["safe", "risk", "human", "neutral"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** The `hitl:<stakeholder>` facets: the stakeholder labels an escalation issue carries. */
export const STAKEHOLDER_FACETS = [
  "product",
  "technical",
  "tactical",
  "legal",
  "compliance",
  "commercial",
] as const;
export type StakeholderFacet = (typeof STAKEHOLDER_FACETS)[number];

export interface HiddenBranch {
  title: string;
  text: string;
  action: string;
}

export interface Scenario {
  id: string;
  label: string;
  detail: string;
}

export interface Outcome {
  kind: OutcomeKind;
  text: string;
}

export interface Option {
  id: string;
  name: string;
  tag?: string;
  summary: string;
  keep: string[];
  pay: string[];
  rightWhen: string;
  obligation?: string;
  /** One outcome per scenario of the call, keyed by scenario id. */
  outcomes?: Record<string, Outcome>;
}

export interface SubQuestion {
  title?: string;
  question: string;
  /** One answer per option of the call, keyed by option id. */
  byOption: Record<string, string>;
}

/** Set once a `human-decided` record lands for this call. */
export interface Ruling {
  option: string;
  recordUrl: string;
  ruledAt: string;
}

export interface Call {
  id: string;
  /** Required when the source has two or more calls. */
  title?: string;
  owners?: StakeholderFacet[];
  /** Required when the source has two or more calls. */
  question?: string;
  facts?: SourcedClaim[];
  scenarios?: Scenario[];
  /** What each outcome kind means for this call, shown in the matrix legend. */
  outcomeMeaning?: Partial<Record<OutcomeKind, string>>;
  options: Option[];
  subQuestions?: SubQuestion[];
  notes?: string[];
  recommended?: string;
  why?: string;
  openInput?: string;
  ruling?: Ruling;
}

export interface Interplay {
  /** Free-form: a call id of this source, another decision, an issue or an ADR. */
  from: string;
  to: string;
  text: string;
}

export interface DecisionSource {
  schema: typeof SOURCE_SCHEMA;
  id: string;
  url: string;
  title: string;
  owners: StakeholderFacet[];
  priority: string;
  reversibility: string;
  verifiedAt: { date: string; commit: string };
  question: string;
  currentBehaviour: SourcedClaim[];
  settled?: SourcedClaim[];
  hiddenBranches?: HiddenBranch[];
  calls: Call[];
  interplay?: Interplay[];
  myRead: string;
  glossary?: GlossaryEntry[];
}

export class SourceError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid decision source:\n- ${problems.join("\n- ")}`);
    this.name = "SourceError";
  }
}

/** The kit's checker, plus the stakeholder facets only a decision has. */
class Checker extends KitChecker {
  facets(value: unknown, path: string): string[] {
    if (!this.array(value, path, 1)) return [];
    const out: string[] = [];
    value.forEach((v, i) => {
      if (
        typeof v === "string" &&
        (STAKEHOLDER_FACETS as readonly string[]).includes(v)
      )
        out.push(v);
      else
        this.fail(
          `${path}[${i}]`,
          `must be one of ${STAKEHOLDER_FACETS.join(", ")}`,
        );
    });
    if (new Set(out).size !== out.length)
      this.fail(path, "has a duplicate facet");
    return out;
  }
}

function checkCall(
  c: Checker,
  call: unknown,
  path: string,
  multi: boolean,
  owners: string[],
): void {
  const required = ["id", "options"];
  if (multi) required.push("title", "question");
  const optional = [
    "title",
    "owners",
    "question",
    "facts",
    "scenarios",
    "outcomeMeaning",
    "subQuestions",
    "notes",
    "recommended",
    "why",
    "openInput",
    "ruling",
  ];
  if (!c.object(call, path, required, optional)) return;
  for (const key of ["title", "question", "openInput"])
    c.optionalText(call, key, path);
  if ("owners" in call)
    for (const facet of c.facets(call.owners, `${path}.owners`))
      if (!owners.includes(facet))
        c.fail(`${path}.owners`, `${facet} is not an owner of the decision`);
  if ("facts" in call) c.claims(call.facts, `${path}.facts`, 1);
  if ("notes" in call) c.texts(call.notes, `${path}.notes`, 1);

  let scenarioIds: string[] = [];
  if ("scenarios" in call && c.array(call.scenarios, `${path}.scenarios`, 1)) {
    scenarioIds = c.uniqueIds(call.scenarios, `${path}.scenarios`);
    call.scenarios.forEach((s, i) => {
      const p = `${path}.scenarios[${i}]`;
      if (c.object(s, p, ["id", "label", "detail"], [])) {
        c.text(s.label, `${p}.label`);
        c.text(s.detail, `${p}.detail`);
      }
    });
  }
  if (
    "outcomeMeaning" in call &&
    c.object(
      call.outcomeMeaning,
      `${path}.outcomeMeaning`,
      [],
      [...OUTCOME_KINDS],
    )
  )
    for (const [kind, meaning] of Object.entries(call.outcomeMeaning))
      c.text(meaning, `${path}.outcomeMeaning.${kind}`);

  let optionIds: string[] = [];
  if (c.array(call.options, `${path}.options`, 2)) {
    optionIds = c.uniqueIds(call.options, `${path}.options`);
    call.options.forEach((o, i) => {
      const p = `${path}.options[${i}]`;
      if (
        !c.object(
          o,
          p,
          ["id", "name", "summary", "keep", "pay", "rightWhen"],
          ["tag", "obligation", "outcomes"],
        )
      )
        return;
      for (const key of ["name", "summary", "rightWhen"])
        c.text(o[key], `${p}.${key}`);
      for (const key of ["tag", "obligation"]) c.optionalText(o, key, p);
      c.texts(o.keep, `${p}.keep`, 1);
      c.texts(o.pay, `${p}.pay`, 1);
      if (scenarioIds.length === 0) {
        if ("outcomes" in o)
          c.fail(`${p}.outcomes`, "the call has no scenarios");
      } else if (!("outcomes" in o)) {
        c.fail(`${p}.outcomes`, "is required, because the call has scenarios");
      } else {
        c.keyedBy(o.outcomes, `${p}.outcomes`, scenarioIds, (v, q) => {
          if (!c.object(v, q, ["kind", "text"], [])) return;
          if (!(OUTCOME_KINDS as readonly unknown[]).includes(v.kind))
            c.fail(`${q}.kind`, `must be one of ${OUTCOME_KINDS.join(", ")}`);
          c.text(v.text, `${q}.text`);
        });
      }
    });
  }

  // Every meaning must reach the legend. One for a kind no cell uses would appear in no projection.
  if (
    "outcomeMeaning" in call &&
    typeof call.outcomeMeaning === "object" &&
    call.outcomeMeaning !== null
  ) {
    if (scenarioIds.length === 0)
      c.fail(`${path}.outcomeMeaning`, "the call has no scenarios");
    const used = new Set<unknown>();
    if (Array.isArray(call.options))
      for (const o of call.options) {
        const outcomes = (o as Json | null)?.outcomes;
        if (typeof outcomes === "object" && outcomes !== null)
          for (const x of Object.values(outcomes))
            used.add((x as Json | null)?.kind);
      }
    if (scenarioIds.length > 0)
      for (const kind of Object.keys(call.outcomeMeaning))
        if (!used.has(kind))
          c.fail(
            `${path}.outcomeMeaning.${kind}`,
            "no outcome of this call has this kind",
          );
  }

  if (
    "subQuestions" in call &&
    c.array(call.subQuestions, `${path}.subQuestions`, 1)
  )
    call.subQuestions.forEach((s, i) => {
      const p = `${path}.subQuestions[${i}]`;
      if (!c.object(s, p, ["question", "byOption"], ["title"])) return;
      c.optionalText(s, "title", p);
      c.text(s.question, `${p}.question`);
      c.keyedBy(s.byOption, `${p}.byOption`, optionIds, (v, q) => c.text(v, q));
    });

  if ("recommended" in call) {
    if (!optionIds.includes(call.recommended as string))
      c.fail(`${path}.recommended`, "must name an option id of this call");
    if (!("why" in call))
      c.fail(`${path}.why`, "is required with a recommendation");
  }
  if ("why" in call) {
    c.text(call.why, `${path}.why`);
    if (!("recommended" in call))
      c.fail(`${path}.recommended`, "is required with a why");
  }
  if (
    "ruling" in call &&
    c.object(
      call.ruling,
      `${path}.ruling`,
      ["option", "recordUrl", "ruledAt"],
      [],
    )
  ) {
    const r = call.ruling;
    if (!optionIds.includes(r.option as string))
      c.fail(`${path}.ruling.option`, "must name an option id of this call");
    c.url(r.recordUrl, `${path}.ruling.recordUrl`);
    c.date(r.ruledAt, `${path}.ruling.ruledAt`);
  }
}

/** Validate an unknown JSON value and return it typed, or throw a SourceError listing every problem. */
export function parseSource(value: unknown): DecisionSource {
  const c = new Checker();
  const required = [
    "schema",
    "id",
    "url",
    "title",
    "owners",
    "priority",
    "reversibility",
    "verifiedAt",
    "question",
    "currentBehaviour",
    "calls",
    "myRead",
  ];
  const optional = ["settled", "hiddenBranches", "interplay", "glossary"];
  if (!c.object(value, "$", required, optional))
    throw new SourceError(c.problems);
  if (value.schema !== SOURCE_SCHEMA)
    c.fail("$.schema", `must be "${SOURCE_SCHEMA}"`);
  c.pattern(value.id, ISSUE_ID, "$.id", "an issue key such as ENG-123");
  c.url(value.url, "$.url");
  for (const key of [
    "title",
    "priority",
    "reversibility",
    "question",
    "myRead",
  ])
    c.text(value[key], `$.${key}`);
  const owners = c.facets(value.owners, "$.owners");
  c.verifiedAt(value.verifiedAt, "$.verifiedAt");
  c.claims(value.currentBehaviour, "$.currentBehaviour", 1);
  if ("settled" in value) c.claims(value.settled, "$.settled", 1);
  if (
    "hiddenBranches" in value &&
    c.array(value.hiddenBranches, "$.hiddenBranches", 1)
  )
    value.hiddenBranches.forEach((h, i) => {
      const p = `$.hiddenBranches[${i}]`;
      if (c.object(h, p, ["title", "text", "action"], []))
        for (const k of ["title", "text", "action"]) c.text(h[k], `${p}.${k}`);
    });
  if ("glossary" in value) c.glossary(value.glossary, "$.glossary");

  let multi = false;
  if (c.array(value.calls, "$.calls", 1)) {
    multi = value.calls.length > 1;
    c.uniqueIds(value.calls, "$.calls");
    value.calls.forEach((call, i) => {
      checkCall(c, call, `$.calls[${i}]`, multi, owners);
    });
  }
  if ("interplay" in value && c.array(value.interplay, "$.interplay", 1))
    value.interplay.forEach((x, i) => {
      const p = `$.interplay[${i}]`;
      if (c.object(x, p, ["from", "to", "text"], []))
        for (const k of ["from", "to", "text"]) c.text(x[k], `${p}.${k}`);
    });
  // Format item 5: with several calls, the interplay is stated, never left for the reader to rebuild.
  if (multi && !("interplay" in value))
    c.fail("$.interplay", "is required when the source has two or more calls");

  // Reference tokens name calls and options, so they are checked once the
  // structure holds: an unknown id is a problem only against a valid id set.
  if (c.problems.length === 0)
    for (const p of refProblems(value as unknown as DecisionSource))
      c.fail(p.path, p.message);

  if (c.problems.length > 0) throw new SourceError(c.problems);
  return value as unknown as DecisionSource;
}

export function optionName(call: Call, id: string): string {
  const option = call.options.find((o) => o.id === id);
  if (!option) throw new Error(`call ${call.id}: no option ${id}`);
  return option.name;
}

/**
 * Close a sentence: add a period only when the text has no terminal
 * punctuation of its own, so a source title such as "Does X apply?" never
 * renders as "Does X apply?.".
 */
export const sentence = (text: string) =>
  /(?:[.?!:]|…)["')\]*”’»]*$/.test(text.trimEnd())
    ? text.trimEnd()
    : `${text.trimEnd()}.`;

/** Display form of a facet: `compliance` → `Compliance`. */
export function facetLabel(facet: string): string {
  return facet.charAt(0).toUpperCase() + facet.slice(1);
}

/** Derived from the per-call rulings, so the header can never disagree with them. */
/** Owners shown in a sheet's title block: a lone call may name a subset of the decision's owners. */
export function headlineOwners(source: DecisionSource): StakeholderFacet[] {
  const [only] = source.calls;
  return source.calls.length === 1 && only?.owners
    ? only.owners
    : source.owners;
}

export function decisionStatus(source: DecisionSource): string {
  const ruled = source.calls.filter((call) => call.ruling).length;
  if (ruled === 0) return "Open: needs a human call";
  if (ruled === source.calls.length) return "Decided";
  return `Partly decided: ${ruled} of ${source.calls.length} calls ruled`;
}

export interface TriggerInput {
  /** The `hitl:<stakeholder>` facets on the escalation. */
  stakeholderFacets: string[];
  /** The number of live options in each open call. */
  optionCounts: number[];
  /** A human asked for the sheet. */
  humanAsked: boolean;
}

export interface TriggerResult {
  sheet: boolean;
  reasons: string[];
}

/**
 * The `/decide` trigger rule: an `escalated` call gets a
 * sheet when it has two or more stakeholder facets, or a call with three or
 * more options, or when a human asks. Below that, the text is enough.
 */
export function sheetTrigger(input: TriggerInput): TriggerResult {
  const reasons: string[] = [];
  const facets = new Set(input.stakeholderFacets);
  if (facets.size >= 2) reasons.push(`${facets.size} stakeholder facets`);
  const widest = Math.max(0, ...input.optionCounts);
  if (widest >= 3) reasons.push(`a call with ${widest} options`);
  if (input.humanAsked) reasons.push("a human asked");
  return { sheet: reasons.length > 0, reasons };
}

export function triggerForSource(
  source: DecisionSource,
  humanAsked = false,
): TriggerResult {
  return sheetTrigger({
    stakeholderFacets: source.owners,
    optionCounts: source.calls
      .filter((call) => !call.ruling)
      .map((call) => call.options.length),
    humanAsked,
  });
}

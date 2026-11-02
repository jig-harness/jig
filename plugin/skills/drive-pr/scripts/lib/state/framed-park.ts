/**
 * A park is a framed decision.
 *
 * `drive-state.ts park` records an item whose decision is a person's. It
 * takes the decision class that keeps the agent from deciding (`--class`,
 * one of `autonomy.park_classes`) and a decision record on stdin, so the
 * person who reads the stop gets the question, the options with what each
 * changes and costs, the recommendation, what they must do and what the
 * agent already did, rather than a key and a sentence. A park with no class
 * is refused at every autonomy level: the classes are the whole list of what
 * a person must decide, and a decision outside them is the agent's to take
 * and record.
 *
 * The record is Markdown with these headings, in this order, each once:
 *
 *   ## Question        one sentence on one line, ending with `?`
 *   ## Options         two or more `- **<name>** …` items, each with
 *                      `Changes:` and `Costs:`
 *   ## Recommended     the recommended option's `**<name>**`, and why
 *   ## Class           the `--class` value
 *   ## Steps for a person  `None.`, or `- ` items, each a command or a named action
 *   ## Already done    what the agent did about it so far
 *
 * The sections are checked mechanically; prose quality is the writing rules'
 * (`decide`'s human-call elaboration), which no script can judge.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { parkClasses } from "../../../../../shared/autonomy.ts";
import { fail, readStdinAll } from "../cli.ts";
import { layeredConfig } from "../../../../../shared/consumer.ts";
import type { DriveState, ParkedItem } from "./schema.ts";
import { parkRefusal } from "./rulings.ts";
import type { StateStore } from "./store.ts";

/** The record's headings, in the order it must carry them. */
export const RECORD_SECTIONS = [
  "Question",
  "Options",
  "Recommended",
  "Class",
  "Steps for a person",
  "Already done",
] as const;
type Section = (typeof RECORD_SECTIONS)[number];

/** The record's sections, by heading, each its trimmed text. */
export type DecisionRecord = Record<Section, string>;

/** `- ` items of a section, each with its continuation lines joined. */
function items(text: string): { items: string[]; stray: boolean } {
  const out: string[] = [];
  let stray = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0)
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
    else stray = true;
  }
  return { items: out, stray };
}

/** The bold name an option opens with, or `null`. */
function optionName(item: string): string | null {
  return /^\*\*([^*]+)\*\*/.exec(item)?.[1]?.trim() ?? null;
}

/** Split `text` at its `## ` headings; problems name what is wrong. */
function sections(text: string): {
  found: Partial<DecisionRecord>;
  problems: string[];
} {
  const problems: string[] = [];
  const found: Partial<DecisionRecord> = {};
  const lines = text.replaceAll("\r", "").split("\n");
  const order: string[] = [];
  let current: Section | null = null;
  let body: string[] = [];
  const close = () => {
    if (current !== null) found[current] = body.join("\n").trim();
  };
  for (const line of lines) {
    const heading = /^##\s+(\S.*)$/.exec(line)?.[1]?.trimEnd();
    if (heading !== undefined) {
      close();
      const known = RECORD_SECTIONS.find(
        (s) => s.toLowerCase() === heading.toLowerCase(),
      );
      if (known === undefined) {
        problems.push(`an unknown section '## ${heading}'`);
        current = null;
      } else if (order.includes(known)) {
        problems.push(`'## ${known}' appears twice`);
        current = null;
      } else {
        order.push(known);
        current = known;
      }
      body = [];
      continue;
    }
    if (current === null && line.trim() !== "" && order.length === 0)
      problems.push("text before the first section heading");
    body.push(line);
  }
  close();
  for (const s of RECORD_SECTIONS)
    if (!order.includes(s)) problems.push(`no '## ${s}' section`);
  const expected = RECORD_SECTIONS.filter((s) => order.includes(s));
  if (order.join("\n") !== expected.join("\n"))
    problems.push(
      `the sections are out of order (${RECORD_SECTIONS.join(", ")})`,
    );
  return { found, problems: [...new Set(problems)] };
}

function checkQuestion(q: string, problems: string[]): void {
  // One line, ending with `?`: whether it is one sentence is the writing
  // rules' to judge, since an abbreviation such as "e.g." is punctuation too.
  if (q.includes("\n")) problems.push("Question must be one line");
  else if (!q.endsWith("?")) problems.push("Question must end with '?'");
}

/** The labelled fields an option carries, each once with a value of its own. */
const OPTION_FIELDS = ["Changes", "Costs"] as const;

/**
 * An option's `Changes:` and `Costs:` values, split at the labels: each
 * value runs to the next label or the item's end, so one label cannot stand
 * in for the other's value.
 */
function optionFields(item: string): {
  values: Partial<Record<(typeof OPTION_FIELDS)[number], string>>;
  repeated: string[];
} {
  const labels = [...item.matchAll(/\b(changes|costs):/gi)].map((m) => ({
    field: OPTION_FIELDS.find(
      (f) => f.toLowerCase() === (m[1] ?? "").toLowerCase(),
    ),
    start: m.index,
    end: m.index + m[0].length,
  }));
  const values: Partial<Record<(typeof OPTION_FIELDS)[number], string>> = {};
  const repeated: string[] = [];
  for (const [i, l] of labels.entries()) {
    if (l.field === undefined) continue;
    if (values[l.field] !== undefined) repeated.push(l.field);
    values[l.field] = item
      .slice(l.end, labels[i + 1]?.start ?? item.length)
      .trim();
  }
  return { values, repeated };
}

function checkOptions(text: string, problems: string[]): string[] {
  const { items: options, stray } = items(text);
  if (stray) problems.push("Options must be '- ' items only");
  if (options.length < 2)
    problems.push("Options must list at least two options");
  const names: string[] = [];
  for (const [i, o] of options.entries()) {
    const name = optionName(o);
    if (name === null)
      problems.push(`option ${i + 1} must open with its **name**`);
    else names.push(name);
    const { values, repeated } = optionFields(o);
    if (!values.Changes)
      problems.push(`option ${i + 1} must say what it changes ('Changes: …')`);
    if (!values.Costs)
      problems.push(`option ${i + 1} must say what it costs ('Costs: …')`);
    for (const f of new Set(repeated))
      problems.push(`option ${i + 1} gives '${f}:' more than once`);
  }
  if (new Set(names).size !== names.length)
    problems.push("two options share a name");
  return names;
}

function checkRecommended(
  text: string,
  names: string[],
  problems: string[],
): void {
  const named = names.filter((n) => text.includes(`**${n}**`));
  if (named.length !== 1)
    problems.push(
      "Recommended must name exactly one of the options by its **name**",
    );
  const why = names.reduce((t, n) => t.replaceAll(`**${n}**`, ""), text);
  if (why.split(/\s+/).filter((w) => /\w/.test(w)).length < 3)
    problems.push("Recommended must say why, not only which");
}

function checkSteps(text: string, problems: string[]): void {
  if (/^none\.?$/i.test(text)) return;
  const { items: steps, stray } = items(text);
  if (stray || steps.length === 0 || steps.some((s) => s === ""))
    problems.push(
      "Steps for a person must be 'None.' or '- ' items, each a command or a named action",
    );
}

/**
 * The record `text` holds for a park under `parkClass`, or the problems that
 * make it not one.
 */
export function parseDecisionRecord(
  text: string,
  parkClass: string,
): { record: DecisionRecord } | { problems: string[] } {
  const { found, problems } = sections(text);
  for (const s of RECORD_SECTIONS)
    if (found[s] !== undefined && found[s] === "")
      problems.push(`'## ${s}' is empty`);
  if (problems.length > 0) return { problems };
  const record = found as DecisionRecord;
  checkQuestion(record.Question, problems);
  const names = checkOptions(record.Options, problems);
  checkRecommended(record.Recommended, names, problems);
  if (record.Class !== parkClass)
    problems.push(`Class says '${record.Class}' but --class is '${parkClass}'`);
  checkSteps(record["Steps for a person"], problems);
  return problems.length > 0 ? { problems } : { record };
}

/** The record as stored and printed: its sections, normalized. */
export function renderRecord(record: DecisionRecord): string {
  return RECORD_SECTIONS.map((s) => `## ${s}\n\n${record[s]}`).join("\n\n");
}

/** The parked items of a `drive-state.ts get` JSON, for a reader with no store. */
export function parkedFromStateJson(text: string): ParkedItem[] {
  const state: unknown = JSON.parse(text);
  if (!isRecord(state) || !Array.isArray(state.parked)) return [];
  return state.parked as ParkedItem[];
}

interface ParkArgs {
  key: string;
  kind: string;
  parkClass: string;
  reason: string;
}

/** `park`: validate the class and the record, then record the item. */
export async function framedPark(
  store: StateStore,
  a: ParkArgs,
): Promise<number> {
  if (a.key === "")
    fail(2, "park requires --key (a thread node id or finding fingerprint)");
  // `parked-keys` is a line-delimited channel: a key with a newline would
  // become two match tokens, and the second would suppress work nobody parked.
  if (/[\n\r]/.test(a.key))
    fail(2, "park: --key may not contain a newline or carriage return.");
  if (a.kind !== "thread" && a.kind !== "finding")
    fail(2, `park requires --kind thread|finding (got '${a.kind}')`);
  if (a.reason !== "")
    fail(
      2,
      "park no longer takes --reason: give --class and the decision record on stdin (drive-pr SKILL.md § 4).",
    );
  const classes = parkClasses(layeredConfig());
  if (a.parkClass === "" || !classes.includes(a.parkClass))
    fail(
      2,
      `park ${a.parkClass === "" ? "requires --class" : `--class '${a.parkClass}' is not a park class`}: decide and record it.`,
      `Only these classes are a person's to decide: ${classes.join(", ")}.`,
      "A decision outside them is the agent's to take, and to record where a person can reverse it.",
    );
  const text = await readStdinAll();
  if (text.trim() === "")
    fail(
      2,
      "park requires the decision record on stdin: decide and record it.",
      `Sections, in order: ${RECORD_SECTIONS.map((s) => `## ${s}`).join(", ")}.`,
    );
  const parsed = parseDecisionRecord(text, a.parkClass);
  if ("problems" in parsed)
    fail(
      2,
      "park: the decision record is incomplete:",
      ...parsed.problems.map((p) => `  - ${p}`),
    );
  const record = parsed.record;
  await store.update((s) => {
    const refusal = parkRefusal(s, a.key, a.kind, a.parkClass);
    if (refusal !== null) fail(2, `park: ${refusal}.`);
    return parkedWith(s, a, record);
  });
  return 0;
}

/** `s` with `a.key` parked under its framed decision. */
function parkedWith(
  s: DriveState,
  a: ParkArgs,
  record: DecisionRecord,
): DriveState {
  return {
    ...s,
    parked: [
      ...s.parked.filter((p) => p.key !== a.key),
      {
        key: a.key,
        kind: a.kind as "thread" | "finding",
        reason: record.Question,
        class: a.parkClass,
        record: renderRecord(record),
        round: s.rounds,
        at: new Date().toISOString(),
      },
    ],
  };
}

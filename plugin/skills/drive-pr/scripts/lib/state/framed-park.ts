import type { ParkedDecision } from "../../../../../shared/decisions/park.ts";
import { decisionDigest } from "../../../../../shared/decisions/digest.ts";
import {
  parkAdmissionContext,
  parkAdmissionProblem,
  readParkedDecision,
} from "./park-admission.ts";
/**
 * Checked JSON park authoring and the legacy Markdown decision reader.
 * New parks carry ParkedDecision; parseDecisionRecord and renderRecord keep
 * earlier stored records readable until those parks leave the ledger.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import {
  parkClasses,
  readPolicySnapshot,
} from "../../../../../shared/autonomy.ts";
import { fail, readStdinAll } from "../cli.ts";
import { layeredConfig } from "../../../../../shared/consumer.ts";
import type { DriveState, ParkedItem } from "./schema.ts";
import { parkRefusal } from "./rulings.ts";
import type { StateStore } from "./store.ts";
import { resolveParkPerson } from "./park-person.ts";
import { items, optionFields, optionName } from "./park-frame.ts";
import { currentIso } from "../../../../../shared/time.ts";

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
  paths: string[];
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
  const policy = readPolicySnapshot();
  const classes = parkClasses(layeredConfig(), process.env, policy);
  const unreadablePolicy = policy.from === "unreadable";
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
      "Give parked-decision/v1 JSON with class, call, steps and alreadyDone.",
    );
  const decision = readParkedDecision(text, a.parkClass);
  const refusal = parkRefusal(
    store.read().state,
    a.key,
    a.kind,
    a.parkClass,
    classes,
    unreadablePolicy,
  );
  if (refusal !== null) fail(2, `park: ${refusal}.`);
  const person = await resolveParkPerson(
    String(store.read().state.pr),
    a.key,
    a.kind,
    a.paths[0] ?? "",
  );
  const capacity = await parkAdmissionContext(
    String(store.read().state.pr),
    store.stateDir,
  );
  await store.update((s) => {
    const refusal = parkRefusal(
      s,
      a.key,
      a.kind,
      a.parkClass,
      classes,
      unreadablePolicy,
    );
    if (refusal !== null) fail(2, `park: ${refusal}.`);
    const next = parkedWith(s, a, decision, person);
    const admission = parkAdmissionProblem(next, decision, capacity);
    if (admission !== null) fail(2, `park: ${admission}`);
    return next;
  });
  return 0;
}

/** `s` with `a.key` parked under its framed decision. */
function parkedWith(
  s: DriveState,
  a: ParkArgs,
  decision: ParkedDecision,
  person: string,
): DriveState {
  return {
    ...s,
    parked: [
      ...s.parked.filter((p) => p.key !== a.key),
      {
        key: a.key,
        person,
        kind: a.kind as "thread" | "finding",
        reason: decision.call.question,
        class: a.parkClass,
        decision,
        digest: decisionDigest(decision),
        round: s.rounds,
        at: currentIso(),
      },
    ],
  };
}

/** The portable JSON contract for a decision waiting for a person. */
import { type Call, type Option, optionDetails } from "./model.ts";
import { Checker, type SourcedClaim } from "./source.ts";
import { normalizeAnswerText } from "./answer-normalize.ts";
import { redact } from "../redact.ts";
import { ANSWER_TEXT_MAX } from "./answer-limits.ts";
import { answerTextFault } from "./answer-text.ts";
import { DECISION_LIMITS, PARKED_DECISION_SCHEMA } from "./decision-values.ts";
import {
  fieldLists,
  PARKED_CALL_FIELDS,
  PARKED_DECISION_FIELD_SHAPES,
  PARKED_DECISION_SHAPE,
  PARKED_INTERPLAY_FIELDS,
  PARKED_OPTION_FIELDS,
} from "./park-shape.ts";
import { matches } from "../shapes.ts";

export interface ParkedOption extends Option {
  reversible?: boolean;
}
export interface ParkedDecision {
  schema: typeof PARKED_DECISION_SCHEMA;
  class: string;
  call: Call<ParkedOption> & {
    question: string;
    recommended: string;
    why: string;
  };
  steps: string[];
  alreadyDone: string;
  facts?: SourcedClaim[];
  interplay?: { from: string; to: string; text: string }[];
  sheet?: string;
}

export const DECISION_BYTE_LIMIT = DECISION_LIMITS["decision-bytes"].value;

const [DECISION_REQUIRED, DECISION_OPTIONAL] = fieldLists(
  PARKED_DECISION_FIELD_SHAPES,
);
const [CALL_REQUIRED, CALL_OPTIONAL] = fieldLists(PARKED_CALL_FIELDS);
const [OPTION_REQUIRED, OPTION_OPTIONAL] = fieldLists(PARKED_OPTION_FIELDS);
const [INTERPLAY_FIELDS] = fieldLists(PARKED_INTERPLAY_FIELDS);

/** Strict authoring check; stored readers deliberately tolerate added fields. */
export function checkParkedDecision(
  value: unknown,
  parkClass: string,
): string[] {
  const c = new Checker();
  if (!c.object(value, "$", DECISION_REQUIRED, DECISION_OPTIONAL))
    return c.problems;
  if (value.schema !== PARKED_DECISION_SCHEMA)
    c.fail("$.schema", `must be ${PARKED_DECISION_SCHEMA}`);
  if (value.class !== parkClass) c.fail("$.class", "must match --class");
  c.text(value.alreadyDone, "$.alreadyDone");
  c.texts(value.steps, "$.steps", 0);
  if ("facts" in value) c.claims(value.facts, "$.facts", 0);
  if ("sheet" in value) c.url(value.sheet, "$.sheet");
  if ("interplay" in value && c.array(value.interplay, "$.interplay", 0))
    value.interplay.forEach((entry, i) => {
      const p = `$.interplay[${i}]`;
      if (c.object(entry, p, INTERPLAY_FIELDS, []))
        for (const key of INTERPLAY_FIELDS) c.text(entry[key], `${p}.${key}`);
    });
  checkCall(c, value.call);
  return c.problems;
}

/** The call carries the rules shared by every author of a park. */
function checkCall(c: Checker, call: unknown): void {
  if (!c.object(call, "$.call", CALL_REQUIRED, CALL_OPTIONAL)) return;
  c.uniqueIds([call], "$.call");
  if (
    c.text(call.question, "$.call.question") &&
    (/[\r\n]/.test(call.question) || !call.question.endsWith("?"))
  )
    c.fail("$.call.question", "must be one line ending with '?'");
  if (
    c.text(call.why, "$.call.why") &&
    call.why.split(/\s+/).filter((w) => /\w/.test(w)).length < 3
  )
    c.fail("$.call.why", "must say why in at least three words");
  if (c.array(call.options, "$.call.options", 2)) {
    const ids = c.uniqueIds(call.options, "$.call.options");
    const names: string[] = [];
    call.options.forEach((option, i) => {
      checkOption(c, option, i, names);
    });
    if (new Set(names).size !== names.length)
      c.fail("$.call.options", "two options share a name");
    else if (new Set(names.map(normalizeAnswerText)).size !== names.length)
      c.fail(
        "$.call.options",
        "two option names are the same after answer normalization",
      );
    if (
      !c.text(call.recommended, "$.call.recommended") ||
      !ids.includes(call.recommended)
    )
      c.fail("$.call.recommended", "must name an option id");
  }
}

function checkOptionName(c: Checker, p: string, name: string): void {
  if (/[\r\n]/.test(name)) c.fail(`${p}.name`, "must be one line");
  if (normalizeAnswerText(name) === "")
    c.fail(`${p}.name`, "must remain nonempty after answer normalization");
  if ([...name].length + "choose  [123456abcdef]".length > ANSWER_TEXT_MAX)
    c.fail(
      `${p}.name`,
      `is too long to select: choose plus its name and framing digest must fit the ${ANSWER_TEXT_MAX}-character answer limit`,
    );
  if (redact(name) !== name)
    c.fail(`${p}.name`, "must not contain a value the ledger redacts");
  if (name.toLowerCase().includes("<redacted>"))
    c.fail(`${p}.name`, "must not contain the reserved <redacted> placeholder");
  if (answerTextFault(`choose ${name}`) !== null)
    c.fail(`${p}.name`, "must fit the structured answer grammar");
}

function checkOption(
  c: Checker,
  option: unknown,
  i: number,
  names: string[],
): void {
  const p = `$.call.options[${i}]`;
  if (!c.object(option, p, OPTION_REQUIRED, OPTION_OPTIONAL)) return;
  if (c.text(option.name, `${p}.name`)) {
    names.push(option.name);
    checkOptionName(c, p, option.name);
  }
  c.text(option.summary, `${p}.summary`);
  c.texts(option.pay, `${p}.pay`, 1);
  if ("keep" in option) c.texts(option.keep, `${p}.keep`, 0);
  for (const key of ["tag", "rightWhen", "obligation"])
    c.optionalText(option, key, p);
  if ("reversible" in option && typeof option.reversible !== "boolean")
    c.fail(`${p}.reversible`, "must be a boolean");
}

/**
 * The stored reader: whether `value` fits the decision record's shape
 * (`park-shape.ts`). It tolerates fields added later and checks no text's
 * content, since a stored record may be redacted.
 */
export function isParkedDecision(value: unknown): value is ParkedDecision {
  return matches(PARKED_DECISION_SHAPE, value);
}

/** Human-readable rendering from fields, never a parser's interpretation of prose. */
export function renderParkedDecision(d: ParkedDecision): string {
  const recommended = d.call.options.find((o) => o.id === d.call.recommended);
  const sections = [
    ["Question", d.call.question],
    [
      "Options",
      d.call.options
        .map(
          (o) =>
            `- **${o.name}** — Changes: ${o.summary} Costs: ${o.pay.join(" ")}${optionDetails(
              o,
            )
              .map((detail) => `\n  ${detail.label}: ${detail.text}`)
              .join("")}`,
        )
        .join("\n"),
    ],
    [
      "Recommended",
      `**${recommended?.name ?? d.call.recommended}** — ${d.call.why}`,
    ],
    ["Class", d.class],
    [
      "Steps for a person",
      d.steps.length ? d.steps.map((s) => `- ${s}`).join("\n") : "None.",
    ],
    ["Already done", d.alreadyDone],
  ];
  if (d.facts?.length)
    sections.push([
      "Facts",
      d.facts.map((f) => `- ${f.text} (${f.source})`).join("\n"),
    ]);
  if (d.interplay?.length)
    sections.push([
      "Interplay",
      d.interplay.map((i) => `- ${i.from} → ${i.to}: ${i.text}`).join("\n"),
    ]);
  if (d.sheet) sections.push(["Sheet", d.sheet]);
  return sections
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join("\n\n");
}

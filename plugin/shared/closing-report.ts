/**
 * The closing report, `closing-report/v1`: what a dispatched run concluded,
 * in the words of the agent that did the work, as one JSON record that holds
 * conclusions and never output. `jig dispatch report` stores it; the launch
 * record keeps it whole and the outcome log's `ended` row keeps its fields
 * (`dispatch/lib/closing-report-store.ts`).
 *
 * | Field | Rule |
 * | --- | --- |
 * | `schema` | `closing-report/v1` |
 * | `concluded` | required: at most 600 characters |
 * | `question` | only when a person must decide: one line ending in `?`, at most 1000 characters; with a decision, its `call.question` |
 * | `decision` | only with `question`: a `parked-decision/v1` record, checked as a pass's framed decision is (`decisions/framed.ts`) |
 * | `suggested_next` | required: `step` (at most 300 characters) and `owner` (`line`, `person` or `none`), with `act` from the closed list of acts (`acts.ts`) exactly when the owner is a person |
 * | `cause` | when the run fell short: one class of `REPORT_CAUSES` |
 * | `evidence` | at most 10 references, never contents: `pr:#12`, `commit:<sha>`, `item:<key>`, `path:<path in the repository>`, `run:<CI run address>` |
 *
 * The record names no secret and no person's data: before the check, every
 * string in it has email addresses and account identifiers replaced with
 * `<redacted>`, by the drive ledger's redaction (`redact.ts`), and every
 * token or other credential-shaped value too, by the dispatcher's credential
 * masking (`credentials.ts`).
 */
import { NEED_ACTS, type NeedAct } from "./acts.ts";
import { framedDecisionProblems } from "./decisions/framed.ts";
import { DECISION_BYTE_LIMIT, type ParkedDecision } from "./decisions/park.ts";
import { Checker, COMMIT, type Json } from "./decisions/source.ts";
import { failed, ok, type Outcome } from "./outcome.ts";
import { maskCredentials } from "./credentials.ts";
import { redactStrings } from "./redact.ts";

export const CLOSING_REPORT_SCHEMA = "closing-report/v1";

/** Why a run fell short, from a closed list; `unknown` when nothing else fits. */
export const REPORT_CAUSES = [
  "needs-person",
  "refused",
  "tool-failed",
  "environment",
  "scope",
  "deadline",
  "startup",
  "usage-limit",
  "crashed",
  "unknown",
] as const;
export type ReportCause = (typeof REPORT_CAUSES)[number];

/** Who wrote a run's report; `none` for a run that ended without one. */
export const REPORT_WRITERS = [
  "agent",
  "driver",
  "wrapper",
  "steward",
  "person",
  "none",
] as const;
export type ReportWriter = (typeof REPORT_WRITERS)[number];

/** Who takes the next step the report suggests. */
export const NEXT_OWNERS = ["line", "person", "none"] as const;
export type NextStepOwner = (typeof NEXT_OWNERS)[number];

export const CONCLUDED_MAX = 600;
const QUESTION_MAX = 1000;
export const STEP_MAX = 300;
export const EVIDENCE_MAX = 10;
/** The longest one evidence reference may be: a reference, never contents. */
const REFERENCE_MAX = 300;
/** The largest report the command reads: its fields at their limits, and a decision at its own. */
const REPORT_BYTE_LIMIT = DECISION_BYTE_LIMIT + 8192;

export interface SuggestedNext {
  step: string;
  owner: NextStepOwner;
  /** Present exactly when `owner` is `person`. */
  act?: NeedAct;
}

export interface ClosingReport {
  schema: typeof CLOSING_REPORT_SCHEMA;
  concluded: string;
  question?: string;
  decision?: ParkedDecision;
  suggested_next: SuggestedNext;
  cause?: ReportCause;
  evidence?: string[];
}

/** The forms an evidence reference takes, each a kind and what it names. */
const EVIDENCE_FORMS: ReadonlyArray<[string, RegExp]> = [
  ["pr:#<number>", /^pr:#[1-9][0-9]*$/],
  ["commit:<sha>", new RegExp(`^commit:${COMMIT.source.slice(1, -1)}$`)],
  ["item:<key>", /^item:\S+$/],
  // A path inside the repository: relative, with no `..` step out of it.
  [
    "path:<path in the repository>",
    /^path:(?![/\\])(?!(?:\S*[/\\])?\.\.(?:[/\\]|$))\S+$/,
  ],
  ["run:<CI run address>", /^run:\S+$/],
];

/** The forms, as a refusal and a prompt name them. */
export const EVIDENCE_FORM_NAMES = EVIDENCE_FORMS.map(([name]) => name);

function chars(text: string): number {
  return [...text].length;
}

function bounded(
  c: Checker,
  value: unknown,
  path: string,
  max: number,
): value is string {
  if (!c.text(value, path)) return false;
  if (chars(value) > max) c.fail(path, `must be at most ${max} characters`);
  return true;
}

function oneOf<T extends string>(
  c: Checker,
  value: unknown,
  path: string,
  list: readonly T[],
): value is T {
  if (typeof value === "string" && (list as readonly string[]).includes(value))
    return true;
  c.fail(path, `must be one of ${list.join(", ")}`);
  return false;
}

function checkNext(c: Checker, next: unknown): void {
  if (!c.object(next, "$.suggested_next", ["step", "owner"], ["act"])) return;
  bounded(c, next.step, "$.suggested_next.step", STEP_MAX);
  if (!oneOf(c, next.owner, "$.suggested_next.owner", NEXT_OWNERS)) return;
  if (next.owner === "person") {
    if (!Object.hasOwn(next, "act"))
      c.fail("$.suggested_next.act", "is required when the owner is person");
    else oneOf(c, next.act, "$.suggested_next.act", NEED_ACTS);
  } else if (Object.hasOwn(next, "act"))
    c.fail("$.suggested_next.act", "is only for an owner that is person");
}

function checkQuestionLine(c: Checker, q: unknown): void {
  if (
    bounded(c, q, "$.question", QUESTION_MAX) &&
    (/[\r\n]/.test(q) || !q.endsWith("?"))
  )
    c.fail("$.question", "must be one line ending with '?'");
}

/** A decision is checked as a framed one, and asks the report's question. */
function checkDecision(c: Checker, decision: unknown, question: unknown): void {
  const problems = framedDecisionProblems(decision);
  for (const p of problems) c.problems.push(p.replace(/^\$/, "$.decision"));
  const call = (decision as { call?: { question?: unknown } }).call;
  if (problems.length === 0 && call?.question !== question)
    c.fail("$.question", "must be the decision's call.question");
}

function checkQuestion(c: Checker, value: Json): void {
  const asked = Object.hasOwn(value, "question");
  if (asked) checkQuestionLine(c, value.question);
  if (!Object.hasOwn(value, "decision")) return;
  if (asked) checkDecision(c, value.decision, value.question);
  else c.fail("$.decision", "is only for a report with a question");
}

function checkEvidence(c: Checker, value: unknown): void {
  if (!c.array(value, "$.evidence", 0)) return;
  if (value.length > EVIDENCE_MAX)
    c.fail("$.evidence", `holds at most ${EVIDENCE_MAX} references`);
  value.forEach((ref, i) => {
    const p = `$.evidence[${i}]`;
    if (!bounded(c, ref, p, REFERENCE_MAX)) return;
    if (!EVIDENCE_FORMS.some(([, re]) => re.test(ref)))
      c.fail(
        p,
        `must be a reference of one of the forms ${EVIDENCE_FORM_NAMES.join(", ")}`,
      );
  });
}

/** Every problem with `value` as a closing report, each with its JSON path; none when it passes. */
export function checkClosingReport(value: unknown): string[] {
  const c = new Checker();
  if (
    !c.object(
      value,
      "$",
      ["schema", "concluded", "suggested_next"],
      ["question", "decision", "cause", "evidence"],
    )
  )
    return c.problems;
  if (value.schema !== CLOSING_REPORT_SCHEMA)
    c.fail("$.schema", `must be ${CLOSING_REPORT_SCHEMA}`);
  bounded(c, value.concluded, "$.concluded", CONCLUDED_MAX);
  checkQuestion(c, value);
  checkNext(c, value.suggested_next);
  if (Object.hasOwn(value, "cause"))
    oneOf(c, value.cause, "$.cause", REPORT_CAUSES);
  if (Object.hasOwn(value, "evidence")) checkEvidence(c, value.evidence);
  return c.problems;
}

/**
 * The report `text` holds, redacted and checked, or why it is refused: over
 * the size a report may have, not JSON, or every problem the check names.
 */
export function closingReportOf(
  text: string,
): Outcome<ClosingReport, "invalid"> {
  if (new TextEncoder().encode(text).length > REPORT_BYTE_LIMIT)
    return failed(
      "invalid",
      `the report is over ${REPORT_BYTE_LIMIT} bytes; shorten its text`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failed(
      "invalid",
      `the report is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const value = redactStrings(parsed, (text) =>
    maskCredentials(text, "<redacted>"),
  );
  const problems = checkClosingReport(value);
  return problems.length > 0
    ? failed("invalid", problems.join("; "))
    : ok(value as ClosingReport);
}

/** Whether a stored value reads as a report: a reader tolerates fields added later. */
export function isClosingReport(value: unknown): value is ClosingReport {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const v = value as Json;
  const next = v.suggested_next as Json | null | undefined;
  return (
    v.schema === CLOSING_REPORT_SCHEMA &&
    typeof v.concluded === "string" &&
    typeof next === "object" &&
    next !== null &&
    typeof next.step === "string" &&
    typeof next.owner === "string"
  );
}

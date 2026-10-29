/**
 * One persona's findings: read from what the persona wrote or printed, and
 * checked before the report trusts them.
 */
import { normalise } from "./document.ts";

export const SEVERITIES = ["blocking", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const VERDICTS = ["ready", "revise", "rethink"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** How the persona got its fresh context, weakest last. */
export const CONTEXTS = ["subagent", "fresh-run", "same-session"] as const;
export type Context = (typeof CONTEXTS)[number];

export interface Finding {
  severity: Severity;
  passage: string;
  risk: string;
  question: string;
}

export interface Findings {
  persona: string;
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  context: Context;
}

/**
 * The JSON object in a persona's output: the whole text when it is one, else
 * the last fenced `json` block. Undefined when there is none that parses.
 */
export function extractJson(raw: string): unknown {
  const attempts = [raw.trim()];
  const fences = [...raw.matchAll(/```json[^\n]*\n([\s\S]*?)\n\s*```/g)];
  for (const fence of fences.reverse()) attempts.push(fence[1] ?? "");
  for (const text of attempts) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {
      // Not this one; try the next.
    }
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** A passage as quoted, without the ellipses that open or close an excerpt. */
function quoted(passage: string): string {
  return normalise(passage.replace(/^(\.\.\.|…)\s*|\s*(\.\.\.|…)$/g, ""));
}

function checkFinding(
  value: unknown,
  label: string,
  document: string,
  problems: string[],
): Finding | undefined {
  const entry = (value ?? {}) as Record<string, unknown>;
  const severity = oneOf(entry.severity, SEVERITIES);
  const passage = text(entry.passage);
  const risk = text(entry.risk);
  const question = text(entry.question);
  if (!severity)
    problems.push(`${label}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!passage) problems.push(`${label}: passage is missing`);
  else if (quoted(passage).length < 3 || !document.includes(quoted(passage)))
    problems.push(
      `${label}: the passage is not in the document as quoted (copy it exactly; for something missing, quote the heading of the section it belongs in): ${passage.slice(0, 80)}`,
    );
  if (!risk) problems.push(`${label}: risk is missing`);
  if (!question) problems.push(`${label}: question is missing`);
  else if (!question.endsWith("?"))
    problems.push(`${label}: question must be a question, ending in "?"`);
  if (!severity || !passage || !risk || !question) return undefined;
  return { severity, passage, risk, question };
}

function checkVerdict(
  verdict: Verdict | undefined,
  findings: Finding[],
  problems: string[],
): void {
  if (!verdict) {
    problems.push(`verdict must be one of ${VERDICTS.join(", ")}`);
    return;
  }
  if (verdict === "ready" && findings.some((f) => f.severity === "blocking"))
    problems.push(
      "verdict ready contradicts a blocking finding: a blocking finding means revise or rethink",
    );
  if (verdict !== "ready" && findings.length === 0)
    problems.push(
      `verdict ${verdict} names nothing to answer: add the findings`,
    );
}

/** The findings `value` holds, or every reason they cannot be trusted. */
export function checkFindings(
  value: unknown,
  persona: string,
  document: string,
  context: Context,
): { findings?: Findings; problems: string[] } {
  const problems: string[] = [];
  if (!value || typeof value !== "object")
    return { problems: ["no JSON object with the findings was found"] };
  const object = value as Record<string, unknown>;
  if (object.persona !== undefined && object.persona !== persona)
    problems.push(`persona is ${String(object.persona)}, expected ${persona}`);
  const summary = text(object.summary);
  if (!summary) problems.push("summary is missing");
  if (!Array.isArray(object.findings))
    problems.push("findings must be a list (empty when there are none)");
  const normalised = normalise(document);
  const findings = (Array.isArray(object.findings) ? object.findings : [])
    .map((entry, i) =>
      checkFinding(entry, `finding ${i + 1}`, normalised, problems),
    )
    .filter((entry): entry is Finding => entry !== undefined);
  const verdict = oneOf(object.verdict, VERDICTS);
  checkVerdict(verdict, findings, problems);
  if (problems.length > 0 || !verdict || !summary) return { problems };
  return {
    findings: { persona, verdict, summary, findings, context },
    problems,
  };
}

/**
 * Findings `collect` kept, checked again against the document: a file
 * edited by hand since is refused like any other output.
 */
export function readKept(
  raw: string,
  persona: string,
  document: string,
): { findings?: Findings; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { problems: ["the kept findings are not JSON"] };
  }
  const context = oneOf(
    (value as Record<string, unknown> | null)?.context,
    CONTEXTS,
  );
  if (!context) return { problems: ["the kept findings name no context"] };
  return checkFindings(value, persona, document, context);
}

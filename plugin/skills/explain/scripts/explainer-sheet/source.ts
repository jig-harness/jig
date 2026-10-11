/**
 * The explainer source: one JSON document per explanation of how a
 * part of the system works today. Every projection is rendered from it, the
 * HTML explainer sheet and the markdown text, so the two cannot drift.
 *
 * The shape came from a real explainer written for a decision (the "what the
 * system does now" part of it), not from a guess. Every claim and every flow step carries a citation; open questions
 * are not claims and carry none. Validation is strict: an unknown key is an
 * error, so a typo cannot drop text from every projection without a trace.
 *
 * A text may name a flow step with the token `{step:N}`. It renders as
 * "step N" and links to the step. A token for a step that does not exist,
 * or a malformed one, is an error.
 */

import { citedPaths } from "../../../decide/scripts/sheet-kit/freshness.ts";
import type { GlossaryEntry } from "../../../decide/scripts/sheet-kit/inline.ts";
import {
  Checker,
  type SourcedClaim,
} from "../../../decide/scripts/sheet-kit/source.ts";
import { LABEL } from "./labels.ts";

export type { GlossaryEntry, SourcedClaim };

export const SOURCE_SCHEMA = "explainer-sheet/v1";

export interface FlowStep {
  id: string;
  title: string;
  text: string;
  source: string;
}

export interface Section {
  id: string;
  title: string;
  intro?: string;
  claims: SourcedClaim[];
}

/** A figure drawn by Archify from a diagram source in the repository. */
export interface Figure {
  id: string;
  title: string;
  caption: string;
  /** The Archify diagram source, a repository path: `<dir>/<stem>.<type>.json`. */
  diagram: string;
}

export interface RelatedLink {
  text: string;
  url: string;
}

export interface ExplainerSource {
  schema: typeof SOURCE_SCHEMA;
  id: string;
  title: string;
  /** The issue the explainer serves. Issue ids in the text link to its tracker. */
  url?: string;
  verifiedAt: { date: string; commit: string };
  summary: string;
  scope: { covers: string[]; excludes?: string[] };
  flow?: FlowStep[];
  sections: Section[];
  figures?: Figure[];
  openQuestions?: string[];
  terms?: GlossaryEntry[];
  related?: RelatedLink[];
}

export class SourceError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid explainer source:\n- ${problems.join("\n- ")}`);
    this.name = "SourceError";
  }
}

/** A kebab-case id: the sheet's own id, a section id. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIAGRAM_TYPES = [
  "architecture",
  "workflow",
  "sequence",
  "dataflow",
  "lifecycle",
] as const;
/** A repository-rooted Archify source: `<dir>/<stem>.<type>.json`, no `..`. */
const DIAGRAM = new RegExp(
  `^(?:[A-Za-z0-9_-]+/)+[a-z0-9]+(?:-[a-z0-9]+)*\\.(?:${DIAGRAM_TYPES.join("|")})\\.json$`,
);

// ---------- citations ----------

const CITATION_FILE =
  /^(?:(?:[\w.@$-]+\/)+(?:[\w@$-](?:[\w.@$-]*[\w@$-])?)?|[\w@$-][\w.@$-]*\.[A-Za-z][A-Za-z0-9]*|\.[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)*)$/;
const CITATION_SYMBOL = /^(?:#[\w.$@-]+|:\d+(?:-\d+)?)$/;
/** An ADR, or an issue key such as `ENG-123` (any tracker key but `ADR`). */
const CITATION_ID = /^(?:ADR-\d{3,4}|(?!ADR-)[A-Z][A-Z0-9]*-\d+)$/;

/** A trailing ` (note)`: display text, not part of what is cited. */
const NOTE = /\s+\([^()]*\)$/;

/** The citation segments of a string: separated by `;`, trimmed, never filtered, so an empty one stays visible. */
const segmentsOf = (text: string): string[] =>
  text.split(";").map((segment) => segment.trim());

/**
 * What one segment cites, without its note. A backtick-quoted path is kept
 * quoted: the freshness scanner reads a quoted span as one citation, which is
 * how a path containing a space (`.run/Backend Dev.run.xml`) is named.
 */
const referenceOf = (segment: string): string => segment.replace(NOTE, "");

/**
 * The problem with one citation segment, or undefined when it is a documented
 * form: a repository path (optionally `#symbol` or `:12-40`, optionally
 * backtick-quoted, and only then may it contain spaces), `ADR-NNNN` or an
 * issue key (`ENG-123`), each optionally followed by a ` (note)`. Prose such as
 * "trust me" names nothing the freshness guard could check, so it is refused
 * here instead of passing as a sheet with no checkable citation.
 */
function segmentProblem(segment: string): string | undefined {
  const reference = referenceOf(segment);
  if (CITATION_ID.test(reference)) return undefined;
  const quoted = /^`([^`\n]+)`$/.exec(reference);
  const ref = quoted ? (quoted[1] as string).trim() : reference;
  const at = ref.search(/[#:]/);
  const file = at === -1 ? ref : ref.slice(0, at);
  const suffix = at === -1 ? "" : ref.slice(at);
  // Spaces are legal only inside a quoted path; the shape check treats them as word characters.
  const shape = quoted ? file.replace(/ /g, "_") : file;
  if (
    !CITATION_FILE.test(shape) ||
    (suffix !== "" && !CITATION_SYMBOL.test(suffix)) ||
    citedPaths([quoted ? `\`${ref}\`` : file]).length === 0
  )
    return `${JSON.stringify(segment)} is not a repository path, ADR-NNNN or issue key`;
  return undefined;
}

/** Every problem with a citation string: segments are separated by `;`, and each must be a documented form. */
export function citationProblems(text: string): string[] {
  const problems: string[] = [];
  for (const segment of segmentsOf(text)) {
    const problem =
      segment === "" ? "has an empty citation" : segmentProblem(segment);
    if (problem) problems.push(problem);
  }
  return problems;
}

// ---------- reference tokens ----------

/** A well-formed token. Built fresh each time: a shared `g` regex keeps `lastIndex` between calls. */
const wellFormed = () => /\{step:([A-Za-z0-9]{1,8})\}/g;
/** Anything that starts like a token (any case, spaces), so a malformed one is an error and never literal text. */
const tokenLike = () => /\{\s*step\s*:[^}]*\}?/gi;

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "step"; step: string };

/** Split text into literal runs and step tokens. */
export function splitSteps(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(wellFormed())) {
    if (m.index > last)
      parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({ kind: "step", step: m[1] as string });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export const stepWords = (step: string) => `${LABEL.refStep} ${step}`;

/** Text with every token written out as plain words. */
export const plainText = (text: string) =>
  splitSteps(text)
    .map((p) => (p.kind === "text" ? p.text : stepWords(p.step)))
    .join("");

/**
 * The fields that render a token as a link or as words: the summary, the
 * scope, flow step text, section intros, claim text, figure captions and
 * open questions. A token anywhere else (an id, a title, a citation, a term)
 * would show as raw braces, so it is an error.
 */
const TOKEN_FIELDS = [
  /^\$\.summary$/,
  /^\$\.scope\.(?:covers|excludes)\[\d+\]$/,
  /^\$\.flow\[\d+\]\.text$/,
  /^\$\.sections\[\d+\]\.intro$/,
  /^\$\.sections\[\d+\]\.claims\[\d+\]\.text$/,
  /^\$\.figures\[\d+\]\.caption$/,
  /^\$\.openQuestions\[\d+\]$/,
];

/** Every text value of the source with its JSON path, for the token check. */
function textsOf(value: unknown, path: string, out: [string, string][]): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value))
    value.forEach((v, i) => {
      textsOf(v, `${path}[${i}]`, out);
    });
  else if (typeof value === "object" && value !== null)
    for (const [k, v] of Object.entries(value)) textsOf(v, `${path}.${k}`, out);
}

function checkTokens(c: Checker, source: ExplainerSource): void {
  const steps = new Set((source.flow ?? []).map((s) => s.id));
  const texts: [string, string][] = [];
  textsOf(source, "$", texts);
  for (const [path, text] of texts) {
    const tokenish = text.match(tokenLike()) ?? [];
    if (tokenish.length === 0) continue;
    if (!TOKEN_FIELDS.some((re) => re.test(path))) {
      c.fail(path, "may not hold a {step:N} token");
      continue;
    }
    const good = new Set(
      [...text.matchAll(wellFormed())].map((m) => m[0] as string),
    );
    for (const t of tokenish)
      if (!good.has(t)) c.fail(path, `malformed token ${t}; write {step:N}`);
    for (const p of splitSteps(text))
      if (p.kind === "step" && !steps.has(p.step))
        c.fail(path, `{step:${p.step}} names no flow step`);
  }
}

function checkCitation(c: Checker, value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") return;
  for (const problem of citationProblems(value)) c.fail(path, problem);
}

// ---------- validation ----------

/** Validate an unknown JSON value and return it typed, or throw a SourceError listing every problem. */
export function parseSource(value: unknown): ExplainerSource {
  const c = new Checker();
  const required = [
    "schema",
    "id",
    "title",
    "verifiedAt",
    "summary",
    "scope",
    "sections",
  ];
  const optional = [
    "url",
    "flow",
    "figures",
    "openQuestions",
    "terms",
    "related",
  ];
  if (!c.object(value, "$", required, optional))
    throw new SourceError(c.problems);
  if (value.schema !== SOURCE_SCHEMA)
    c.fail("$.schema", `must be "${SOURCE_SCHEMA}"`);
  c.pattern(value.id, SLUG, "$.id", "kebab-case, such as order-checkout");
  c.text(value.title, "$.title");
  if ("url" in value) c.url(value.url, "$.url");
  c.verifiedAt(value.verifiedAt, "$.verifiedAt");
  c.text(value.summary, "$.summary");
  if (c.object(value.scope, "$.scope", ["covers"], ["excludes"])) {
    c.texts(value.scope.covers, "$.scope.covers", 1);
    if ("excludes" in value.scope)
      c.texts(value.scope.excludes, "$.scope.excludes", 1);
  }

  if ("flow" in value && c.array(value.flow, "$.flow", 2)) {
    c.uniqueIds(value.flow, "$.flow");
    value.flow.forEach((s, i) => {
      const p = `$.flow[${i}]`;
      if (c.object(s, p, ["id", "title", "text", "source"], [])) {
        for (const k of ["title", "text", "source"]) c.text(s[k], `${p}.${k}`);
        checkCitation(c, s.source, `${p}.source`);
      }
    });
  }

  if (c.array(value.sections, "$.sections", 1)) {
    const ids: string[] = [];
    value.sections.forEach((s, i) => {
      const p = `$.sections[${i}]`;
      if (!c.object(s, p, ["id", "title", "claims"], ["intro"])) return;
      c.pattern(s.id, SLUG, `${p}.id`, "kebab-case");
      if (typeof s.id === "string") ids.push(s.id);
      c.text(s.title, `${p}.title`);
      c.optionalText(s, "intro", p);
      c.claims(s.claims, `${p}.claims`, 1);
      if (Array.isArray(s.claims))
        s.claims.forEach((x, j) => {
          checkCitation(
            c,
            (x as { source?: unknown } | null)?.source,
            `${p}.claims[${j}].source`,
          );
        });
    });
    if (new Set(ids).size !== ids.length)
      c.fail("$.sections", "has a duplicate id");
  }

  if ("figures" in value && c.array(value.figures, "$.figures", 1)) {
    const diagrams: string[] = [];
    const ids: string[] = [];
    value.figures.forEach((f, i) => {
      const p = `$.figures[${i}]`;
      if (!c.object(f, p, ["id", "title", "caption", "diagram"], [])) return;
      c.pattern(f.id, SLUG, `${p}.id`, "kebab-case");
      if (typeof f.id === "string") ids.push(f.id);
      c.text(f.title, `${p}.title`);
      c.text(f.caption, `${p}.caption`);
      c.pattern(
        f.diagram,
        DIAGRAM,
        `${p}.diagram`,
        `a repository path to an Archify source, <dir>/<stem>.<${DIAGRAM_TYPES.join("|")}>.json`,
      );
      if (typeof f.diagram === "string") diagrams.push(f.diagram);
    });
    if (new Set(ids).size !== ids.length)
      c.fail("$.figures", "has a duplicate id");
    if (new Set(diagrams.map(diagramStem)).size !== diagrams.length)
      c.fail("$.figures", "shows the same diagram twice");
  }

  if ("openQuestions" in value)
    c.texts(value.openQuestions, "$.openQuestions", 1);
  if ("terms" in value) c.glossary(value.terms, "$.terms");
  if ("related" in value && c.array(value.related, "$.related", 1))
    value.related.forEach((r, i) => {
      const p = `$.related[${i}]`;
      if (c.object(r, p, ["text", "url"], [])) {
        c.text(r.text, `${p}.text`);
        c.url(r.url, `${p}.url`);
      }
    });

  // Tokens name flow steps, so they are checked once the structure holds.
  if (c.problems.length === 0)
    checkTokens(c, value as unknown as ExplainerSource);

  if (c.problems.length > 0) throw new SourceError(c.problems);
  return value as unknown as ExplainerSource;
}

/** The stem of an Archify source path: `docs/diagrams/checkout-flow.workflow.json` → `checkout-flow`. */
export function diagramStem(diagram: string): string {
  const file = diagram.split("/").pop() ?? "";
  return file.split(".")[0] ?? "";
}

/**
 * Every reference the source cites: flow steps, claims and figure diagrams,
 * one per segment and without display notes. The freshness guard checks each
 * one, so a note such as `(Node.js)` is never scanned as a path of its own.
 */
export function citations(source: ExplainerSource): string[] {
  return [
    ...(source.flow ?? []).map((s) => s.source),
    ...source.sections.flatMap((s) => s.claims.map((x) => x.source)),
    ...(source.figures ?? []).map((f) => f.diagram),
  ].flatMap((text) =>
    segmentsOf(text)
      .map(referenceOf)
      .filter((reference) => reference !== ""),
  );
}

#!/usr/bin/env bun
/**
 * resolve-precedent.ts — the mechanical first phase of `/decide`.
 *
 * `/decide` exists because a technical dilemma needs a ruling. This script is
 * the pass that runs BEFORE any ruling, and its job is to answer a cheaper
 * question first: **has this already been decided?** A repository carries a
 * corpus of ADRs (architecture decision records), a block of settled policy in
 * its agent instructions (`AGENTS.md`), a set of conditional rules, and a
 * canonical vocabulary. A meaningful share of "dilemmas" are lookups wearing a
 * dilemma's clothes, and re-deriving a settled answer with an expensive model
 * is both waste and a live risk of contradicting it: settled policy being
 * re-litigated is a measured source of rejected review findings.
 *
 * Where each source lives is the consumer's to say, in
 * `.config/groundwork-overlay.yaml` (`lib/overlay.ts`): `adr.directory`,
 * `decide.policy_files`, `decide.rules_directory` and `decide.glossary_file`,
 * each with a default (`docs/adr`, `AGENTS.md`, `.claude/rules`,
 * `CONTEXT.md`).
 *
 * **This script does not decide anything, and cannot be made to.** It surfaces
 * ranked candidate precedents with file:line evidence; reading them and judging
 * whether they actually settle the question is the skill's judgment phase:
 * everything mechanical is scripted and tested, the judgment is a separate,
 * auditable artifact.
 *
 * A null result is a first-class output, not a failure. `verdict:
 * "no-precedent"` ships with the corpus counts it searched and the terms it
 * searched for, because "I searched N ADRs and M policy sections for
 * [valkey, cache, eviction] and found nothing" is exactly the explicit
 * zero-hit evidence a ruling has to rest on. An empty corpus is NOT that: if
 * every source comes back empty the repo root is wrong, and the script throws
 * rather than reporting a confident "no precedent exists" it never earned.
 * A query that tokenizes to zero terms (all stopwords, or every word below
 * the minimum length) is ALSO not that: `verdict: "no-searchable-terms"`
 * reports it distinctly, because no term ever reached the corpus — treating
 * it as `"no-precedent"` would manufacture zero-hit evidence for a search
 * that never ran.
 *
 * Usage:
 *   resolve-precedent.ts "<the dilemma, in words>" [--top N] [--json]
 *                        [--repo-root DIR]
 *
 * Exit codes: 0 always on a successful search (any verdict); non-zero only
 * on a usage or corpus error. "No precedent found" is a finding, not a failure.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { consumerRoot } from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { load as loadYaml } from "../../resolve-review-comments/scripts/lib/yaml.ts";
import {
  type PrecedentSources,
  precedentSources,
  readOptionalOverlay,
} from "./lib/overlay.ts";

export type { PrecedentSources };

// ---------------------------------------------------------------------------
// Tuning constants. Exported so the suite pins the values rather than
// re-deriving them from a literal that could drift out from under it.
// ---------------------------------------------------------------------------

/**
 * A candidate normally has to match at least this many DISTINCT query terms.
 * One shared word ("api", "data") between a question and a document is
 * coincidence, not precedent, and a corpus this size always supplies one.
 */
export const MIN_DISTINCT_TERMS = 2;

/**
 * ...with one exception: a term appearing in at most this many documents is
 * rare enough that a single hit IS the signal (`uuid7`, `keycloak`,
 * `protobuf`). Requiring two terms would drop exactly the sharpest match.
 */
export const RARE_DF_MAX = 3;

/** Per-field score multipliers. A title hit is worth far more than a body hit. */
export const FIELD_WEIGHTS = { title: 5, tag: 3, heading: 2, body: 1 } as const;

/** Body occurrences of one term stop adding score past this count. */
export const BODY_TF_CAP = 3;

/** Heading occurrences of one term stop adding score past this count. */
export const HEADING_TF_CAP = 2;

/** Default number of candidates reported. */
export const DEFAULT_TOP = 5;

/** Longest excerpt line kept, in characters. */
export const EXCERPT_MAX = 160;

/** Excerpt lines kept per candidate. */
export const EXCERPTS_PER_CANDIDATE = 3;

/**
 * Tokens carrying no retrieval value. Deliberately function words plus the
 * vocabulary of *asking* ("should", "vs", "instead") — not domain words. A
 * stopword list that eats domain terms silently destroys recall, which is the
 * one failure this script cannot detect in itself.
 */
export const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "each",
  "either",
  "for",
  "from",
  "get",
  "give",
  "going",
  "had",
  "has",
  "have",
  "here",
  "how",
  "if",
  "in",
  "instead",
  "into",
  "is",
  "it",
  "its",
  "just",
  "keep",
  "let",
  "make",
  "many",
  "may",
  "might",
  "more",
  "most",
  "much",
  "must",
  "need",
  "no",
  "not",
  "now",
  "of",
  "off",
  "on",
  "one",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "per",
  "put",
  "rather",
  "really",
  "same",
  "shall",
  "should",
  "since",
  "so",
  "some",
  "still",
  "such",
  "take",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "through",
  "to",
  "too",
  "two",
  "under",
  "up",
  "us",
  "use",
  "used",
  "using",
  "very",
  "want",
  "was",
  "way",
  "we",
  "well",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "without",
  "would",
  "you",
  "your",
  "vs",
]);

/** Shortest token kept. Two-letter tokens are noise at this corpus size. */
export const MIN_TERM_LENGTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocKind = "adr" | "policy" | "rule";

export interface CorpusDoc {
  kind: DocKind;
  /** Repo-relative path, for citation. */
  file: string;
  /** 1-indexed line in `file` where this doc's text starts. */
  startLine: number;
  title: string;
  /** ADR lifecycle status where one exists ("accepted", "superseded", …). */
  status?: string;
  tags: string[];
  text: string;
}

export interface GlossaryEntry {
  term: string;
  canonicalLine: number;
  avoid: string[];
}

export interface Excerpt {
  line: number;
  text: string;
}

export interface Candidate {
  kind: DocKind;
  file: string;
  title: string;
  status?: string;
  score: number;
  matchedTerms: string[];
  excerpts: Excerpt[];
}

export interface VocabularyFlag {
  used: string;
  canonical: string;
  file: string;
  line: number;
}

export interface PrecedentReport {
  query: string;
  terms: string[];
  droppedTerms: string[];
  corpus: Record<DocKind | "glossaryTerms", number>;
  /** Where each source was read from, relative to the repository root. */
  sources: PrecedentSources;
  /**
   * Which of `adr`/`policy`/`rule`/`glossary` came back with ZERO entries —
   * a sparse or mispointed `--repo-root` (or source configuration) that
   * `loadCorpus`'s own all-sources-empty check cannot catch, since it only
   * refuses when every document-bearing category is empty at once. `glossary`
   * is tracked separately from the other three: a missing or unreadable
   * glossary never trips the `docs.length === 0` check at all (the glossary
   * isn't part of `docs`), so without this it could silently skip the
   * vocabulary and `_Avoid_`-alias check while the corpus otherwise reads as
   * complete. Non-empty here means the corpus below is a genuine subset, not
   * full coverage, even though the search ran and the verdict is real for
   * what it actually searched.
   */
  incompleteSources: (DocKind | "glossary")[];
  verdict: "precedent-candidates" | "no-precedent" | "no-searchable-terms";
  candidates: Candidate[];
  vocabulary: VocabularyFlag[];
  searchedAt: string;
}

/** Thrown when the corpus itself is unreadable — never for "found nothing". */
export class CorpusError extends Error {}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Split free text into retrieval terms. Hyphens and digits survive so
 * `adr-0039`, `uuid7` and `eng-1234` stay single tokens — they are the highest
 * precision terms in this corpus and splitting them would destroy them.
 */
export function tokenize(text: string): {
  terms: string[];
  dropped: string[];
} {
  const raw = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length > 0);

  const terms: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const token of raw) {
    if (token.length < MIN_TERM_LENGTH || STOPWORDS.has(token)) {
      if (!dropped.includes(token)) dropped.push(token);
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }

  return { terms, dropped };
}

/**
 * Whole-token occurrence count. A substring count would score "record" against
 * "recording" and "api" against "rapid", which at this corpus size is most of
 * the noise budget.
 */
export function countTerm(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = haystack
    .toLowerCase()
    .match(new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "g"));
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

/**
 * Sentinel `status` for an ADR whose frontmatter block exists but could not
 * be parsed. Never confuse this with an absent `status` field (no frontmatter
 * at all, or a frontmatter block with no `status` key) — both of those leave
 * `status` `undefined`, which is a legitimate "no lifecycle status recorded"
 * rather than a lost one.
 */
export const UNREADABLE_FRONTMATTER_STATUS =
  "unreadable frontmatter — lifecycle status unknown, verify before citing";

interface Frontmatter {
  title?: string;
  status?: string;
  tags?: string[];
  /**
   * True whenever a `---`-delimited block is PRESENT but the content inside
   * it does not cleanly resolve to a well-typed `{title?, status?, tags?}`
   * record — the invariant this whole type exists to enforce. Concretely:
   * the closing `---` is missing, the YAML fails to parse, the parsed root
   * is not a plain mapping (null, a scalar, or an array), or a *recognized*
   * key is present with the wrong shape (`status`/`title` not a string,
   * `tags` not an array of strings). A document with no frontmatter block at
   * all, or one whose recognized keys are simply absent, is NOT an error and
   * leaves this unset — those are legitimate "no lifecycle status recorded",
   * and must stay distinguishable from a status that existed and was lost.
   * Every one of these branches silently discarding a `status` is the same
   * bug wearing a different shape: it can make a deprecated or superseded
   * ADR look like an unqualified candidate.
   */
  frontmatterError?: true;
}

/**
 * Parse YAML frontmatter with a real YAML parser rather than a regex over the
 * block: a structured format is parsed, never pattern-matched. A malformed
 * block yields a flagged, empty-ish record rather than throwing:
 * one bad doc must not take the whole corpus down, but the failure must not
 * be swallowed either — `frontmatterError` lets the caller surface it instead
 * of indexing the document as if it simply had no status.
 */
export function parseFrontmatter(content: string): Frontmatter {
  // CRLF line endings would make the exact '---\n' opener never match and
  // fall through to the SAME {} as "no frontmatter block at all", silently
  // losing a CRLF file's status/title exactly like the other
  // present-but-unrecognized shapes above. Normalized locally, for delimiter detection only: the returned fields
  // and any later CorpusDoc.text/scoring stay on the original content.
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  // A prefix search for '\n---' also matches '---suffix' or '----' — a
  // closing delimiter must be a COMPLETE '---' line (newline or EOF right
  // after), same bound bodyStartIndex already enforces with its exact-match
  // check. Without this, a decoy line short-circuits the YAML slice early
  // and the real content after it (including a genuine '---' in prose)
  // leaks into or out of what gets parsed as frontmatter. No leading '\n' precedes the OPENING '---' at index 0, so this
  // full-string search cannot match it.
  const end = normalized.search(/\n---(?:\n|$)/);
  if (end === -1) return { frontmatterError: true };
  let parsed: unknown;
  try {
    parsed = loadYaml(normalized.slice(4, end));
  } catch {
    return { frontmatterError: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { frontmatterError: true };
  }
  const fm = parsed as Record<string, unknown>;

  if ("title" in fm && typeof fm.title !== "string") {
    return { frontmatterError: true };
  }
  if ("status" in fm && typeof fm.status !== "string") {
    return { frontmatterError: true };
  }
  if (
    "tags" in fm &&
    (!Array.isArray(fm.tags) || !fm.tags.every((t) => typeof t === "string"))
  ) {
    return { frontmatterError: true };
  }

  return {
    title: typeof fm.title === "string" ? fm.title : undefined,
    status: typeof fm.status === "string" ? fm.status : undefined,
    tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
  };
}

/**
 * Heading recognition defers to a real CommonMark parser, Bun's built-in
 * `Bun.markdown` (md4c), never to a hand-rolled line model: a text-matching
 * model of a real grammar is defeated one decoy at a time (a heading-shaped
 * line in a fenced block, a fence closed by a shorter run, a Setext
 * underline), and the plugin cache has no `node_modules` for a JavaScript
 * parser. GitHub-flavoured extensions are off, so the grammar is CommonMark.
 */
const COMMONMARK: Bun.markdown.Options = {
  tables: false,
  strikethrough: false,
  tasklists: false,
};

interface HeadingInfo {
  depth: number;
  text: string;
  /** 1-indexed, relative to the `content` string that was parsed. */
  line: number;
}

/** Private-use marker characters the renderer below wraps each heading in; stripped from the input first. */
const MARKERS = /[\uE000-\uE002]/g;
const MARKED_HEADING = /\uE000(\d)\uE001([^\uE000-\uE002]*)\uE002/g;

/**
 * Top-level (document-structure) headings of `content`, in order, with their
 * rendered plain text (inline code and emphasis markup stripped). Container
 * blocks (block quotes, lists) render to nothing, so a heading inside one is
 * not counted.
 */
function topLevelHeadings(content: string): { depth: number; text: string }[] {
  const rendered = Bun.markdown.render(
    content.replace(MARKERS, ""),
    {
      heading: (children, meta) =>
        `\uE000${meta.level}\uE001${children.replace(MARKERS, "")}\uE002`,
      blockquote: () => "",
      list: () => "",
      listItem: () => "",
      paragraph: () => "",
      code: () => "",
      html: () => "",
      hr: () => "",
      table: () => "",
    },
    COMMONMARK,
  );
  return [...rendered.matchAll(MARKED_HEADING)].map((m) => ({
    depth: Number(m[1]),
    text: m[2] as string,
  }));
}

/** A Setext underline: up to three spaces, then a run of `=` or `-`. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*\r?$/;

/**
 * Top-level headings with their 1-indexed start lines — ATX (`#`) and Setext
 * (underlined) alike, since both are real CommonMark headings. The parser
 * reports no positions, so each heading's line is found from the parser
 * alone: the shortest prefix of the document that holds `j` headings ends on
 * the line that completes heading `j` (a binary search per heading). For an
 * ATX heading that is its own line; for a Setext heading it is the underline,
 * and the heading starts as many lines above it as its text has lines.
 */
function collectHeadings(content: string): HeadingInfo[] {
  const lines = content.split("\n");
  const headings = topLevelHeadings(content);
  const countAt = (k: number) =>
    topLevelHeadings(lines.slice(0, k).join("\n")).length;
  const out: HeadingInfo[] = [];
  let from = 1;
  headings.forEach((heading, index) => {
    let lo = from;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (countAt(mid) >= index + 1) hi = mid;
      else lo = mid + 1;
    }
    const end = lo;
    const setext = SETEXT_UNDERLINE.test(lines[end - 1] ?? "");
    out.push({
      depth: heading.depth,
      text: heading.text.trim(),
      line: setext ? end - heading.text.split("\n").length : end,
    });
    from = end + 1;
  });
  return out;
}

/**
 * Headings, parsed from the document BODY only — a YAML frontmatter block's
 * closing `---` reads as a Setext-heading underline for the `title:` line
 * right above it (real CommonMark ambiguity, not a parser bug), which would
 * otherwise fabricate a heading straight out of frontmatter metadata on
 * every document this corpus loads unstripped (the ADR, rule and policy
 * loaders all pass the whole file). Reuses
 * `bodyStartIndex` — already exercised against CRLF and decoy-delimiter
 * frontmatter by `parseFrontmatter`'s own tests — rather than a second,
 * divergent frontmatter boundary check. Line numbers are shifted back to the
 * ORIGINAL `lines` indexing so callers can keep splitting the untouched file.
 */
function collectBodyHeadings(lines: readonly string[]): HeadingInfo[] {
  const skip = bodyStartIndex(lines);
  const body = lines.slice(skip).join("\n");
  return collectHeadings(body).map((h) => ({ ...h, line: h.line + skip }));
}

/**
 * Fallback title for a document with no (or unreadable) frontmatter `title`
 * — the first level-1 heading in the body.
 */
function firstHeading(content: string): string | undefined {
  const headings = collectBodyHeadings(content.split("\n"));
  return headings.find((h) => h.depth === 1)?.text;
}

function readIfPresent(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** Join repository-relative path parts with `/`, so a citation reads the same on every platform. */
const repoPath = (...parts: string[]) => parts.join("/");

function loadAdrs(repoRoot: string, directory: string): CorpusDoc[] {
  const dir = join(repoRoot, directory);
  if (!existsSync(dir)) return [];
  const docs: CorpusDoc[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith("ADR-") || !name.endsWith(".md")) continue;
    const file = repoPath(directory, name);
    const content = readFileSync(join(dir, name), "utf8");
    const fm = parseFrontmatter(content);
    docs.push({
      kind: "adr",
      file,
      startLine: 1,
      title: fm.title ?? firstHeading(content) ?? name,
      status: fm.frontmatterError ? UNREADABLE_FRONTMATTER_STATUS : fm.status,
      tags: fm.tags ?? [],
      text: content,
    });
  }
  return docs;
}

/**
 * Split a policy document into its `##` sections. Sections rather than whole
 * files because `AGENTS.md` is one document holding a dozen unrelated stances:
 * scoring it as a unit would rank it first for every query and cite nothing
 * useful.
 *
 * `frontmatterError` propagates `parseFrontmatter`'s verdict on the WHOLE
 * file into every section this call produces: citing a section from a source
 * whose own metadata could not be parsed, without a caveat, would rank an
 * unreadable input as if it were sound. A scanner flags what it cannot read;
 * it never swallows it.
 */
export function splitSections(
  content: string,
  file: string,
  title: string,
  frontmatterError?: true,
): CorpusDoc[] {
  const lines = content.split("\n");
  const headingsByLine = new Map(
    collectBodyHeadings(lines)
      .filter((h) => h.depth === 2)
      .map((h) => [h.line, h.text] as const),
  );
  const sections: CorpusDoc[] = [];
  // `heading: null` is the PREAMBLE sentinel — content before the first `##`,
  // captured rather than silently dropped (an instruction file's preamble
  // often carries real, actionable policy prose). This must stay distinct
  // from `heading: ''`, which means a genuine (if textless) `##` heading was
  // found: a bare `##` or `## ##` is a valid CommonMark level-2 heading whose
  // rendered text is the empty string, and truthiness-testing it would fold
  // that real section into the preamble bucket, producing a false structural
  // citation.
  let current: {
    heading: string | null;
    start: number;
    body: string[];
  } | null = {
    heading: null,
    start: 1,
    body: [],
  };

  const flush = () => {
    if (!current) return;
    // A genuinely blank preamble (nothing before the first real heading, the
    // common case) must still produce zero sections — only non-blank content
    // earns a citable entry.
    if (current.body.every((l) => l.trim().length === 0)) return;
    sections.push({
      kind: "policy",
      file,
      startLine: current.start,
      title:
        current.heading === null
          ? `${title} (preamble)`
          : current.heading
            ? `${title} § ${current.heading}`
            : `${title} § (untitled)`,
      status: frontmatterError ? UNREADABLE_FRONTMATTER_STATUS : undefined,
      tags: [],
      text: current.body.join("\n"),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const headingText = headingsByLine.get(i + 1);
    if (headingText !== undefined) {
      flush();
      current = { heading: headingText, start: i + 1, body: [lines[i] ?? ""] };
    } else if (current) {
      current.body.push(lines[i] ?? "");
    }
  }
  flush();
  return sections;
}

function loadPolicy(repoRoot: string, files: readonly string[]): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  for (const file of files) {
    const content = readIfPresent(join(repoRoot, file));
    if (content === undefined) continue;
    const fm = parseFrontmatter(content);
    docs.push(...splitSections(content, file, file, fm.frontmatterError));
  }
  return docs;
}

function loadRules(repoRoot: string, directory: string): CorpusDoc[] {
  const dir = join(repoRoot, directory);
  if (!existsSync(dir)) return [];
  const docs: CorpusDoc[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    const content = readFileSync(join(dir, name), "utf8");
    const fm = parseFrontmatter(content);
    docs.push({
      kind: "rule",
      file: repoPath(directory, name),
      startLine: 1,
      title: fm.title ?? firstHeading(content) ?? name,
      status: fm.frontmatterError ? UNREADABLE_FRONTMATTER_STATUS : fm.status,
      tags: fm.tags ?? [],
      text: content,
    });
  }
  return docs;
}

/**
 * Parse the glossary's `**Term**:` / `_Avoid_:` pairs (by default
 * `CONTEXT.md`; `decide.glossary_file`). The glossary is not
 * scored with the rest of the corpus — it answers a different question ("are
 * you using the canonical word?") and would otherwise drown the ADR signal.
 */
export function parseGlossary(content: string): GlossaryEntry[] {
  const lines = content.split("\n");
  const entries: GlossaryEntry[] = [];
  let current: GlossaryEntry | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const term = line.match(/^\*\*(.+?)\*\*:\s*$/);
    if (term) {
      current = {
        term: (term[1] as string).trim(),
        canonicalLine: i + 1,
        avoid: [],
      };
      entries.push(current);
      continue;
    }
    const avoid = line.match(/^_Avoid_:\s*(.+)$/);
    if (avoid && current) {
      current.avoid = (avoid[1] as string)
        .split(",")
        .map((a) => a.replace(/\(.*?\)/g, "").trim())
        .filter((a) => a.length > 0);
      current = null;
    }
  }
  return entries;
}

function loadGlossary(
  repoRoot: string,
  file: string,
): {
  entries: GlossaryEntry[];
  file: string;
} {
  const content = readIfPresent(join(repoRoot, file));
  if (content === undefined) return { entries: [], file };
  return { entries: parseGlossary(content), file };
}

export interface Corpus {
  docs: CorpusDoc[];
  glossary: GlossaryEntry[];
  glossaryFile: string;
  /** Where each source was read from. */
  sources: PrecedentSources;
}

/**
 * Load every precedent source. Throws when `docs` — the ADRs, policy
 * sections and rules that `resolvePrecedent` actually scores — comes back
 * empty, regardless of the glossary: that is a wrong `--repo-root` or a
 * broken checkout, and reporting "no precedent" from zero searchable
 * documents would manufacture exactly the confident null result this script
 * exists to make trustworthy. The glossary is deliberately NOT part of this
 * check on its own — `vocabularyFlags` reads it but no candidate is ever
 * scored from it — so a corpus with entries but no docs is exactly as broken
 * as one with neither, and must fail closed the same way.
 */
export function loadCorpus(
  repoRoot: string,
  sources: PrecedentSources = precedentSources(
    readOptionalOverlay(repoRoot),
    repoRoot,
  ),
): Corpus {
  const docs = [
    ...loadAdrs(repoRoot, sources.adrDirectory),
    ...loadPolicy(repoRoot, sources.policyFiles),
    ...loadRules(repoRoot, sources.rulesDirectory),
  ];
  const { entries, file } = loadGlossary(repoRoot, sources.glossaryFile);
  if (docs.length === 0) {
    throw new CorpusError(
      `no precedent sources found under ${repoRoot} — expected some of ` +
        `${sources.adrDirectory}/ADR-*.md, ${sources.policyFiles.join(", ")}, ` +
        `${sources.rulesDirectory}/*.md. Refusing to report "no precedent" ` +
        "from an empty corpus. Check --repo-root, or point adr.directory and " +
        "decide.* in .config/groundwork-overlay.yaml at the sources.",
    );
  }
  return { docs, glossary: entries, glossaryFile: file, sources };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Document frequency per term across the corpus. Drives the IDF weight, which
 * is what stops ubiquitous words ("api", "backend", the product's own name) from ranking
 * every document equally — at this corpus size that IS the ranking problem.
 */
export function documentFrequencies(
  docs: CorpusDoc[],
  terms: string[],
): Map<string, number> {
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const doc of docs) {
      if (countTerm(doc.text, term) > 0) n++;
    }
    df.set(term, n);
  }
  return df;
}

export function idf(totalDocs: number, docFrequency: number): number {
  return Math.log((totalDocs + 1) / (docFrequency + 1)) + 1;
}

/**
 * Sibling of `splitSections`'s heading recognizer, reusing the same
 * frontmatter-safe, CommonMark-real `collectBodyHeadings` — this scores
 * `doc.text` directly, and for an ADR/rule `CorpusDoc` that IS the whole
 * file, frontmatter and all (`loadAdrs`/`loadRules` store `text: content`
 * unstripped).
 */
function headingLines(text: string): string {
  return collectBodyHeadings(text.split("\n"))
    .map((h) => h.text)
    .join("\n");
}

export function scoreDoc(
  doc: CorpusDoc,
  terms: string[],
  df: Map<string, number>,
  totalDocs: number,
): { score: number; matchedTerms: string[] } {
  const headings = headingLines(doc.text);
  const tagText = doc.tags.join(" ");
  let score = 0;
  const matchedTerms: string[] = [];

  for (const term of terms) {
    const titleHits = countTerm(doc.title, term) > 0 ? 1 : 0;
    const tagHits = countTerm(tagText, term) > 0 ? 1 : 0;
    const headHits = Math.min(countTerm(headings, term), HEADING_TF_CAP);
    const bodyHits = Math.min(countTerm(doc.text, term), BODY_TF_CAP);
    if (titleHits + tagHits + headHits + bodyHits === 0) continue;

    matchedTerms.push(term);
    score +=
      idf(totalDocs, df.get(term) ?? 0) *
      (FIELD_WEIGHTS.title * titleHits +
        FIELD_WEIGHTS.tag * tagHits +
        FIELD_WEIGHTS.heading * headHits +
        FIELD_WEIGHTS.body * bodyHits);
  }

  return { score, matchedTerms };
}

/**
 * A scored document only becomes a candidate if it clears the noise floor:
 * two distinct terms, or one term rare enough across the corpus to stand
 * alone.
 */
export function isCandidate(
  matchedTerms: string[],
  df: Map<string, number>,
): boolean {
  if (matchedTerms.length >= MIN_DISTINCT_TERMS) return true;
  return matchedTerms.some(
    (t) => (df.get(t) ?? Number.MAX_SAFE_INTEGER) <= RARE_DF_MAX,
  );
}

/**
 * Index of the first line AFTER any YAML frontmatter block. Excerpts skip the
 * block: `title:` and `tags:` lines match the query by construction (they are
 * what scored the document) and quoting them back tells a reader nothing the
 * title line above already said.
 */
export function bodyStartIndex(lines: readonly string[]): number {
  // `lines` comes from doc.text.split('\n') on the ORIGINAL, un-normalized
  // content (parseFrontmatter normalizes CRLF only for its own delimiter
  // detection, never the stored text) — so a CRLF file's lines still carry a
  // trailing '\r' here. Without stripping it, this exact-match check would
  // miss the frontmatter block entirely and excerptsFor could cite the raw
  // 'title:'/'status:' YAML lines as if they were substantive policy
  // evidence.
  if (lines[0]?.replace(/\r$/, "") !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.replace(/\r$/, "") === "---") return i + 1;
  }
  // The opener matched but no exact closing '---' exists anywhere in the
  // file — a MALFORMED block, not "no frontmatter". Falling through to 0
  // would hand the raw not-quite-YAML text to collectBodyHeadings as if it
  // were ordinary body: a decoy like `---\nstatus: approved\n----` makes
  // CommonMark read the second line as a real Setext heading, fabricating a
  // phantom section/title straight out of unparseable metadata. Skip the
  // whole document instead — with no closing delimiter there is no reliable
  // boundary to skip TO, and treating unreadable input as unreadable (rather
  // than guessing) is the fail-closed answer.
  return lines.length;
}

export function excerptsFor(doc: CorpusDoc, terms: string[]): Excerpt[] {
  const lines = doc.text.split("\n");
  const out: Excerpt[] = [];
  for (
    let i = bodyStartIndex(lines);
    i < lines.length && out.length < EXCERPTS_PER_CANDIDATE;
    i++
  ) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    if (!terms.some((t) => countTerm(line, t) > 0)) continue;
    const text = line.trim();
    out.push({
      line: doc.startLine + i,
      text: text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text,
    });
  }
  return out;
}

export function vocabularyFlags(
  query: string,
  glossary: GlossaryEntry[],
  file: string,
): VocabularyFlag[] {
  const flags: VocabularyFlag[] = [];
  for (const entry of glossary) {
    for (const alias of entry.avoid) {
      if (countTerm(query, alias) > 0) {
        flags.push({
          used: alias,
          canonical: entry.term,
          file,
          line: entry.canonicalLine,
        });
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  repoRoot: string;
  query: string;
  top?: number;
  /**
   * The instant this search happened, passed in rather than read: the report
   * embeds the date as evidence, so a caller has to be able to pin it.
   */
  now: Date;
  corpus?: Corpus;
}

export function resolvePrecedent(opts: ResolveOptions): PrecedentReport {
  const corpus = opts.corpus ?? loadCorpus(opts.repoRoot);
  const { terms, dropped } = tokenize(opts.query);
  const top = opts.top ?? DEFAULT_TOP;

  const df = documentFrequencies(corpus.docs, terms);
  const totalDocs = corpus.docs.length;

  const candidates: Candidate[] = [];
  if (terms.length > 0) {
    for (const doc of corpus.docs) {
      const { score, matchedTerms } = scoreDoc(doc, terms, df, totalDocs);
      if (score <= 0) continue;
      if (!isCandidate(matchedTerms, df)) continue;
      candidates.push({
        kind: doc.kind,
        file: doc.file,
        title: doc.title,
        status: doc.status,
        score: Math.round(score * 100) / 100,
        matchedTerms,
        excerpts: excerptsFor(doc, matchedTerms),
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const kept = candidates.slice(0, top);

  const counts: Record<DocKind, number> = {
    adr: corpus.docs.filter((d) => d.kind === "adr").length,
    policy: corpus.docs.filter((d) => d.kind === "policy").length,
    rule: corpus.docs.filter((d) => d.kind === "rule").length,
  };
  const incompleteSources: (DocKind | "glossary")[] = (
    Object.keys(counts) as DocKind[]
  ).filter((kind) => counts[kind] === 0 && totalDocs > 0);
  if (corpus.glossary.length === 0) incompleteSources.push("glossary");

  return {
    query: opts.query,
    terms,
    droppedTerms: dropped,
    corpus: { ...counts, glossaryTerms: corpus.glossary.length },
    sources: corpus.sources,
    incompleteSources,
    verdict:
      terms.length === 0
        ? "no-searchable-terms"
        : kept.length > 0
          ? "precedent-candidates"
          : "no-precedent",
    candidates: kept,
    vocabulary: vocabularyFlags(
      opts.query,
      corpus.glossary,
      corpus.glossaryFile,
    ),
    searchedAt: opts.now.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(report: PrecedentReport): string {
  const out: string[] = [];
  out.push("## Precedent resolve pass");
  out.push("");
  out.push(`**Question**: ${report.query}`);
  out.push(`**Terms searched**: ${report.terms.join(", ") || "(none)"}`);
  out.push(
    `**Corpus**: ${report.corpus.adr} ADRs, ${report.corpus.policy} policy ` +
      `sections, ${report.corpus.rule} rules, ${report.corpus.glossaryTerms} ` +
      `glossary terms — searched ${report.searchedAt}`,
  );
  out.push(
    `**Sources**: ${report.sources.adrDirectory}/, ` +
      `${report.sources.policyFiles.join(", ")}, ` +
      `${report.sources.rulesDirectory}/, ${report.sources.glossaryFile}`,
  );
  if (report.incompleteSources.length > 0) {
    out.push(
      `⚠️ **${report.incompleteSources.join(", ")} came back empty** ` +
        "while other sources did not — this corpus is a subset, " +
        "not full coverage. Verify `--repo-root` before citing the verdict " +
        "below as a complete search.",
    );
  }
  out.push("");

  if (report.verdict === "no-searchable-terms") {
    out.push(
      "**Verdict: `no-searchable-terms`** — every word in the query was " +
        "dropped during tokenization (stopwords or below the minimum term " +
        "length), so nothing was actually searched. This is NOT zero-hit " +
        "evidence — no term ever reached the corpus. Rephrase the question " +
        "with concrete, specific terms and search again.",
    );
  } else if (
    report.verdict === "no-precedent" &&
    report.incompleteSources.length > 0
  ) {
    out.push(
      "**Verdict: `no-precedent`, but the corpus above is INCOMPLETE** — " +
        `${report.incompleteSources.join(", ")} came back empty. ` +
        "This is NOT the explicit zero-hit evidence a ruling can " +
        "rest on: those sources were never actually searched. Fix " +
        '`--repo-root` and re-run before treating this as "no precedent ' +
        'exists" — do not proceed to phase 2 on an incomplete search.',
    );
  } else if (report.verdict === "no-precedent") {
    out.push(
      "**Verdict: `no-precedent`** — nothing in the corpus above the noise " +
        "floor. This is the explicit zero-hit evidence a ruling rests on; " +
        'cite the corpus line above, not an unqualified "nothing exists".',
    );
  } else {
    out.push(
      `**Verdict: \`precedent-candidates\`** — ${report.candidates.length} ` +
        "candidate(s). READ them before ruling: a high score means term " +
        "overlap, never that the question is settled.",
    );
    out.push("");
    for (const c of report.candidates) {
      const status = c.status ? ` — _${c.status}_` : "";
      out.push(`### ${c.title}${status}`);
      out.push(
        `\`${c.file}\` · ${c.kind} · score ${c.score} · matched: ` +
          `${c.matchedTerms.join(", ")}`,
      );
      for (const e of c.excerpts)
        out.push(`- \`${c.file}:${e.line}\` ${e.text}`);
      out.push("");
    }
  }

  if (report.vocabulary.length > 0) {
    out.push("");
    out.push("### Vocabulary");
    for (const v of report.vocabulary) {
      out.push(
        `- "${v.used}" is an **_Avoid_** alias — canonical term is ` +
          `**${v.canonical}** (\`${v.file}:${v.line}\`)`,
      );
    }
  }

  out.push("");
  out.push(
    "_This pass ranks precedent; it does not rule. Phase 2 frames the " +
      "options, phase 3 rules._",
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  query: string;
  top: number;
  json: boolean;
  repoRoot: string;
}

export function parseArgs(argv: string[], cwd: string): CliArgs {
  let top = DEFAULT_TOP;
  let json = false;
  let repoRoot = cwd;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--top") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`--top expects a positive integer, got ${argv[i]}`);
      }
      top = value;
    } else if (arg === "--repo-root") {
      const value = argv[++i];
      // A following flag (e.g. `--repo-root --json`) must not be silently
      // consumed as the directory: `!value` alone only catches a MISSING
      // value, so `--repo-root --json` would set repoRoot to the literal
      // string '--json' and swallow the real --json flag, searching the wrong
      // root instead of refusing — the exact failure class this script
      // exists to fail closed on.
      if (!value || value.startsWith("--")) {
        throw new Error("--repo-root expects a directory");
      }
      repoRoot = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const query = positional.join(" ").trim();
  if (query.length === 0) {
    throw new Error(
      'usage: resolve-precedent.ts "<the dilemma>" [--top N] [--json] ' +
        "[--repo-root DIR]",
    );
  }
  return { query, top, json, repoRoot };
}

export function main(argv: string[], cwd: string, now: Date): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv, cwd);
  } catch (err) {
    console.error(`resolve-precedent: ${(err as Error).message}`);
    return 2;
  }

  let report: PrecedentReport;
  try {
    report = resolvePrecedent({
      repoRoot: args.repoRoot,
      query: args.query,
      top: args.top,
      now,
    });
  } catch (err) {
    if (err instanceof CorpusError) {
      console.error(`resolve-precedent: ${err.message}`);
      return 3;
    }
    // A configuration the consumer wrote but that cannot be read is a usage
    // error, reported as such rather than as a crash.
    if (
      err instanceof Error &&
      /groundwork|adr\.|decide\./i.test(err.message)
    ) {
      console.error(`resolve-precedent: ${err.message}`);
      return 2;
    }
    throw err;
  }

  console.log(
    args.json ? JSON.stringify(report, null, 2) : renderMarkdown(report),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2), consumerRoot(), new Date()));
}

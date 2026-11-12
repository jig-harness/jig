/**
 * The findings a review-object reviewer (`review.reviewer_evidence:
 * review_object`) puts only in the body of its pull-request review, never in
 * a thread: CodeRabbit's "Outside diff range comments", "Nitpick comments",
 * "Duplicate comments" and "Follow-up" sections. The thread count never sees them, so
 * `summary-findings.ts` reports them as summary findings, answered with
 * `answer-summary-finding.ts` like the sticky's bullets.
 *
 * A body is read only in a format Jig knows, named by the reviewer's built-in
 * profile (`reviewer-profiles.ts`): another reviewer's body is not parsed
 * until it has a format of its own. Each format was read off that reviewer's
 * real reviews.
 *
 * A section's heading declares how many entries it holds, and CodeRabbit
 * marks each entry with its own `<!-- cr-comment:… -->` id. Fewer entries
 * read than a heading declares, or than the body has ids, means the format
 * moved under the parser, and the shortfall is reported as `unaccounted`
 * findings rather than dropped: an entry the parser cannot see must block
 * convergence, not vanish into it.
 */
import type { SummaryFinding, SummaryReport } from "../summary-findings.ts";
import { fingerprintOf } from "./finding-fingerprint.ts";
import type { ReviewBodyFormat } from "./reviewer-profiles.ts";
import { severityOf } from "./severity-formats.ts";
import type { ReviewObject } from "./status/review-object.ts";

/** The body sections that carry findings. */
export type ReviewBodySection =
  | "outside-diff"
  | "nitpick"
  | "duplicate"
  | "follow-up";

/** One finding in a review body. */
export interface ReviewBodyEntry {
  section: ReviewBodySection;
  path: string;
  /** The lines it names: `31-35`, or `34`. */
  lines: string;
  text: string;
  /** The id the reviewer marks it with, where its format has one. */
  id?: string;
}

export interface ParsedReviewBody {
  entries: ReviewBodyEntry[];
  /** Per section, the entry count its heading declares. */
  declared: Partial<Record<ReviewBodySection, number>>;
  /** Every entry id the body carries outside fenced code; none in a format without them. */
  ids: string[];
}

const SECTION_WORDS: Readonly<Record<string, ReviewBodySection>> = {
  "outside diff range comments": "outside-diff",
  "nitpick comments": "nitpick",
  "duplicate comments": "duplicate",
  "follow-up": "follow-up",
};

/**
 * A section heading: a `<summary>` or a bold line naming the section and its
 * count, `⚠️ Outside diff range comments (2)`, `Nitpick comments: 1` or
 * `Follow-up (1)`.
 */
const HEADING =
  /^(?:<summary>|\*\*).*?(?<![\w./-])(outside diff range comments|nitpick comments|duplicate comments|follow-up)\s*(?:\((\d+)\)|:\s*(\d+))/i;

/** The id CodeRabbit marks each entry with, on a line of its own. */
const ENTRY_ID = /<!--\s*cr-comment:v\d+:([0-9a-f]+)\s*-->/g;

/** A file's group in a section: `<summary>src/a.ts (2)</summary>` or `src/a.ts: 2`. */
const GROUP = /^<summary>([^<>]+?)(?:\s*\(\d+\)|:\s*\d+)<\/summary>/;

/**
 * An entry in a file's group, opening with its lines: `` `31-35`: … ``, or in
 * earlier reviews `` Line range hint `31-35`: … ``.
 */
const RANGE_ENTRY = /^(?:Line range hint )?`(\d+(?:-\d+)?)`:\s*(.*)$/;

/** An entry that names its own file, on a line of its own: `` `src/a.ts:34` ``. */
const LOCATED_ENTRY = /^`([^`\s]+?):(\d+(?:-\d+)?)`$/;

/** Layout lines that are no part of an entry's text. */
const SCAFFOLD =
  /^(?:<\/?(?:dl|dd|blockquote|br)\s*\/?>|<\/blockquote><\/details>|<!--.*-->|---)$/;

/** A code fence: three or more backticks or tildes. */
const FENCE = /^(`{3,}|~{3,})(.*)$/;

/** An inline code span, whose content is never layout. */
const INLINE_CODE = /`[^`]*`/g;

/** A blockquote's markers, which a callout puts before every line. */
const QUOTE = /^\s*(?:>[ \t]?)+/;

interface Section {
  kind: ReviewBodySection;
  /** The `<details>` depth of its heading. */
  depth: number;
  /** A bold heading in a callout, which ends with the callout. */
  byQuote: boolean;
}

interface Open {
  section: ReviewBodySection;
  path: string;
  lines: string;
  depth: number;
  text: string[];
  id?: string;
}

interface ParseState extends ParsedReviewBody {
  /** How many `<details>` blocks enclose the line. */
  depth: number;
  /** The fence the open code block opened with, as CommonMark closes it. */
  fence: string | null;
  section: Section | null;
  group: { path: string; depth: number } | null;
  entry: Open | null;
}

function closeEntry(st: ParseState): void {
  if (st.entry === null) return;
  const { section, path, lines, text, id } = st.entry;
  const entry = { section, path, lines, text: text.join("\n").trim() };
  st.entries.push(id === undefined ? entry : { ...entry, id });
  st.entry = null;
}

function endSection(st: ParseState): void {
  closeEntry(st);
  st.section = null;
  st.group = null;
}

/**
 * A line of fenced code, kept in the entry it belongs to; false for any other.
 * A block closes on a fence of its opener's character, at least as long, with
 * nothing after it, so a shorter fence inside it is code.
 */
function fenced(st: ParseState, line: string, trimmed: string): boolean {
  const m = trimmed.match(FENCE);
  const open = st.fence;
  if (open === null && m === null) return false;
  if (open === null) st.fence = m?.[1] ?? null;
  else if (m && closesFence(open, m[1] ?? "", m[2] ?? "")) st.fence = null;
  if (st.entry?.depth === st.depth) st.entry.text.push(line);
  return true;
}

function closesFence(open: string, fence: string, rest: string): boolean {
  return fence[0] === open[0] && fence.length >= open.length && !rest.trim();
}

/** Opens the section `trimmed` heads; false when it heads none. */
function opensSection(
  st: ParseState,
  trimmed: string,
  byQuote: boolean,
): boolean {
  const m = trimmed.match(HEADING);
  const kind = SECTION_WORDS[(m?.[1] ?? "").toLowerCase()];
  if (m === null || kind === undefined) return false;
  endSection(st);
  st.section = { kind, depth: st.depth, byQuote };
  st.declared[kind] = (st.declared[kind] ?? 0) + Number(m[2] ?? m[3]);
  return true;
}

/**
 * The entry `trimmed` opens: in a file's group, by its lines; outside one,
 * by its own file and lines.
 */
function entryAt(
  st: ParseState,
  trimmed: string,
): Pick<Open, "path" | "lines" | "text"> | null {
  if (st.group !== null) {
    if (st.depth !== st.group.depth) return null;
    const m = trimmed.match(RANGE_ENTRY);
    return m && { path: st.group.path, lines: m[1] ?? "", text: [m[2] ?? ""] };
  }
  const m = trimmed.match(LOCATED_ENTRY);
  return m && { path: m[1] ?? "", lines: m[2] ?? "", text: [] };
}

/** Opens the file group or entry `trimmed` starts; false when it starts neither. */
function opensBlock(
  st: ParseState,
  section: Section,
  trimmed: string,
): boolean {
  const group = st.depth > section.depth ? trimmed.match(GROUP) : null;
  if (group) {
    closeEntry(st);
    st.group = { path: (group[1] ?? "").trim(), depth: st.depth };
    return true;
  }
  const at = entryAt(st, trimmed);
  if (at === null) return false;
  closeEntry(st);
  st.entry = { section: section.kind, ...at, depth: st.depth };
  return true;
}

/** Ends the entry, group and section the line's closing tags left. */
function leaveClosed(st: ParseState): void {
  if (st.entry !== null && st.depth < st.entry.depth) closeEntry(st);
  if (st.group !== null && st.depth < st.group.depth) st.group = null;
  const section = st.section;
  if (section !== null && !section.byQuote && st.depth < section.depth)
    endSection(st);
}

/**
 * Adds a line of the open entry's own block to its text, unless it is layout;
 * the entry's id line names its id.
 */
function appendText(st: ParseState, line: string, trimmed: string): void {
  const entry = st.entry;
  if (entry?.depth !== st.depth) return;
  const id = [...trimmed.matchAll(ENTRY_ID)][0]?.[1];
  if (id !== undefined) entry.id ??= id;
  else if (!SCAFFOLD.test(trimmed)) entry.text.push(line);
}

function step(st: ParseState, raw: string): void {
  const quoted = QUOTE.test(raw);
  const line = raw.replace(QUOTE, "").trimEnd();
  const trimmed = line.trim();
  if (st.section?.byQuote && !quoted) endSection(st);
  if (fenced(st, line, trimmed)) return;
  for (const m of trimmed.matchAll(ENTRY_ID)) {
    if (m[1] !== undefined && !st.ids.includes(m[1])) st.ids.push(m[1]);
  }
  // Tags quoted as inline code are prose, not layout.
  const markup = trimmed.replace(INLINE_CODE, "");
  const opens = markup.match(/<details\b/g)?.length ?? 0;
  st.depth += opens;
  const structural =
    opensSection(st, trimmed, quoted && opens === 0) ||
    (st.section !== null && opensBlock(st, st.section, trimmed));
  if (!structural && opens === 0) appendText(st, line, trimmed);
  st.depth -= markup.match(/<\/details>/g)?.length ?? 0;
  leaveClosed(st);
}

/**
 * CodeRabbit's review body. Each section is a `<details>` block (or, for
 * outside-diff comments, a bold heading inside a `> [!CAUTION]` callout)
 * holding either one `<details>` block per file, whose entries open with
 * their lines, or one `<details>` block per finding, which names its file and
 * lines on a line of its own. Nested blocks (the prompt for AI agents, a
 * suggested fix) and fenced code outside an entry are skipped.
 */
export function parseCodeRabbitBody(body: string): ParsedReviewBody {
  const st: ParseState = {
    entries: [],
    declared: {},
    ids: [],
    depth: 0,
    fence: null,
    section: null,
    group: null,
    entry: null,
  };
  for (const raw of body.split(/\r?\n/)) step(st, raw);
  closeEntry(st);
  return { entries: st.entries, declared: st.declared, ids: st.ids };
}

const PARSERS: Readonly<
  Record<ReviewBodyFormat, (body: string) => ParsedReviewBody>
> = {
  coderabbit: parseCodeRabbitBody,
};

/** `body` read in `format`. */
export function parseReviewBody(
  format: ReviewBodyFormat,
  body: string,
): ParsedReviewBody {
  return PARSERS[format](body);
}

/**
 * The entries of `review` the parser could not read: per section, the count
 * its heading declares beyond the entries read, then every entry id no entry
 * read took. The two signals are not known to name the same entries, so each
 * keeps its own obligation. Keyed by the review,
 * so an answer to one review's unreadable entry never stands for another's.
 */
function unreadSlots(
  review: ReviewObject,
  parsed: ParsedReviewBody,
): { fingerprint: string; text: string }[] {
  const scope = `unaccounted-${review.commit.slice(0, 12)}-${review.id}`;
  const slots: { fingerprint: string; text: string }[] = [];
  for (const [kind, count] of Object.entries(parsed.declared)) {
    const read = parsed.entries.filter((e) => e.section === kind).length;
    for (let i = read; i < count; i++)
      slots.push({
        fingerprint: `${scope}-${kind}-${i + 1}`,
        text: `Review ${review.id} declares ${count} ${kind} comment(s) in its body but only ${read} could be read. Read the review and answer this slot explicitly.`,
      });
  }
  const read = new Set(parsed.entries.map((e) => e.id));
  const unread = parsed.ids.filter((id) => !read.has(id));
  for (let i = 0; i < unread.length; i++)
    slots.push({
      fingerprint: `${scope}-unread-${i + 1}`,
      text: `Review ${review.id} marks ${unread.length} comment(s) in its body that could not be read. Read the review and answer this slot explicitly.`,
    });
  return slots;
}

export interface ReviewBodyInput {
  pr: number;
  /** The reviewer's bot login, whose formats read each entry's severity. */
  login: string;
  format: ReviewBodyFormat;
  /** Every review the reviewer submitted on the pull request, oldest first. */
  reviews: ReviewObject[];
  /** The answered fingerprints, with fix-dependent answers dated against `commit`. */
  addressedAt: (commit: string) => Set<string>;
}

/**
 * The summary-finding report of the reviews' bodies. Every review is read,
 * newest first: a later review does not repeat an earlier one's entries, and
 * an entry several repeat is one finding, dated against the newest review
 * that carries it, so a fix-dependent answer holds until the reviewer raises
 * the finding again on or after the commit it names.
 */
export function reviewBodyReport(input: ReviewBodyInput): SummaryReport {
  const findings: SummaryFinding[] = [];
  const seen = new Set<string>();
  const answered = new Map<string, Set<string>>();
  let declaredTotal = 0;
  const addressedAt = (commit: string): Set<string> => {
    const known = answered.get(commit);
    if (known !== undefined) return known;
    const computed = input.addressedAt(commit);
    answered.set(commit, computed);
    return computed;
  };
  for (const review of input.reviews.toReversed()) {
    const push = (f: Omit<SummaryFinding, "addressed">) => {
      if (seen.has(f.fingerprint)) return;
      seen.add(f.fingerprint);
      const addressed = addressedAt(review.commit).has(f.fingerprint);
      findings.push({ ...f, addressed });
    };
    const parsed = parseReviewBody(input.format, review.body);
    for (const e of parsed.entries) {
      push({
        fingerprint: fingerprintOf(e.path, e.lines, e.text),
        source: "review-body",
        path: e.path,
        line: Number.parseInt(e.lines, 10),
        severity: severityOf(e.text, input.login),
        category: "unknown",
        text: e.text,
      });
    }
    for (const slot of unreadSlots(review, parsed)) {
      push({
        ...slot,
        source: "unaccounted",
        path: "(unknown)",
        line: null,
        severity: "unknown",
        category: "unknown",
      });
    }
    declaredTotal += Object.values(parsed.declared).reduce((a, b) => a + b, 0);
  }
  return {
    pr: input.pr,
    stickyCommentId: null,
    declaredUnanchored: declaredTotal,
    total: findings.length,
    findings,
    unaddressed: findings.filter((f) => !f.addressed),
  };
}

// The voice check: how far each visitor document is from the voice guide
// (docs/VOICE.md), counted so the count can fall and never rise.
//
// The visitor documents are the pages a first-time reader meets: README.md,
// FACTORY.md, FEATURES.md and ROADMAP.md. Each is linted with the decide
// skill's Simplified Technical English linter, imported rather than copied,
// with the guide's caps in place of the linter's own: a sentence counts when
// it has more than 30 words, or more than one semicolon. The linter's other
// hard rules (phrasal verbs, the marketing adjectives it knows,
// nominalizations, a list item that ends on a conjunction) count as the
// linter states them. Its advisory rules, passive voice among them, are
// reported and never counted. The sentences are the linter's: each wrapped
// paragraph joined into one line, table cells apart, code spans left out of
// the words.
//
// The ratchet holds the counts (tools/quality/ratchet.jsonc, run by
// `bun run quality`). `--json` prints them as its counting command expects,
// with each document as a rule and each finding as an entry, so the ratchet
// compares one total per document against the merge base, and a document
// whose total grew is listed with the new findings, each sentence quoted.
// No baseline file is committed. Without a flag, the gates' stage reports
// each document's count. The linter's README admits this one use, a ratchet
// over named documents that never blocks on a single finding, and its tests
// list this script as the ratchet caller.
//
// Usage: check-voice.ts [--json | --list [document…]]
//   (no flag)  each document's count, for the gates
//   --json     the counts for the ratchet; under RATCHET_HISTORICAL=1 (the
//              merge base) a missing document counts zero
//   --list     every finding of the named documents, or of all visitor documents
// The documents are read from the current directory. Exit 0 when every
// document was read, 2 when one is missing or a flag is unknown.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, strictOptions } from "../lib/cli.ts";
import { couldNotCheck } from "../lib/findings.ts";
import {
  CODE_FENCE,
  joinWrapped,
  type JoinedPosition,
  type Finding,
  lint,
  markdownTableCells,
  py,
  pySplit,
  pyStrip,
  splitlines,
} from "../plugin/skills/decide/scripts/ste-lint/ste-lint.ts";

const GATE = "check-voice";

/** The pages a first-time reader meets, whose voice the guide sets. */
export const VISITOR_DOCUMENTS = [
  "README.md",
  "FACTORY.md",
  "FEATURES.md",
  "ROADMAP.md",
] as const;

/** The guide's caps: the most words, and semicolons, one sentence may hold. */
export const MAX_WORDS = 30;
const MAX_SEMICOLONS = 1;

/** The linter's sentence break and code span, compiled as it compiles them. */
const SENTENCE_BREAK = py(String.raw`(?<=[.!?])\s+`, { global: true });
const CODE_SPAN = py("`[^`]*`", { global: true });
const WHITESPACE = py(String.raw`\s+`, { global: true });

/** Use the parser's tab stops before measuring either findings or sentences. */
function normalizeTabs(source: string): string {
  return splitlines(source)
    .map((line) => {
      let column = 0;
      return [...line]
        .map((ch) => {
          const width = ch === "\t" ? 4 - (column % 4) : 1;
          column += width;
          return ch === "\t" ? " ".repeat(width) : ch;
        })
        .join("");
    })
    .join("\n");
}

/** One sentence as the linter measures it, and as it reads on the page. */
interface Sentence {
  /** 1-based: the first line of its paragraph, or its table row. */
  line: number;
  start: number;
  end: number;
  words: number;
  semicolons: number;
  /** The sentence as written, code spans kept, whitespace collapsed. */
  text: string;
}

/** One finding: the line it starts on, and the entry the ratchet counts. */
interface VoiceFinding {
  line: number;
  entry: string;
}

/** A segment without its code spans, and where each kept character was. */
function withoutCode(segment: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  let from = 0;
  const keep = (to: number) => {
    for (let i = from; i < to; i++) {
      text += segment[i];
      at.push(i);
    }
  };
  for (const span of segment.matchAll(CODE_SPAN)) {
    keep(span.index);
    from = span.index + span[0].length;
  }
  keep(segment.length);
  return { text, at };
}

/** The sentences of one segment, split where the linter splits them. */
function segmentSentences(
  segment: string,
  line: number,
  column = 0,
): Sentence[] {
  const { text, at } = withoutCode(segment);
  const out: Sentence[] = [];
  let start = 0;
  let quoteStart = 0;
  const push = (end: number, quoteEnd: number) => {
    const measured = text.slice(start, end);
    out.push({
      line,
      start: column + [...text.slice(0, start)].length,
      end: column + [...text.slice(0, end)].length,
      words: pySplit(measured).length,
      semicolons: measured.split(";").length - 1,
      text: pyStrip(
        segment
          .slice(quoteStart, quoteEnd)
          .replace(WHITESPACE, " ")
          .replaceAll("¦", "|"),
      ),
    });
  };
  for (const gap of text.matchAll(SENTENCE_BREAK)) {
    const quoteEnd = at[gap.index] as number;
    push(gap.index, quoteEnd);
    start = gap.index + gap[0].length;
    quoteStart = quoteEnd + 1;
  }
  push(text.length, segment.length);
  return out;
}

/**
 * Every sentence of `source`, read as the linter reads it for sentence
 * length: the wrapped paragraphs joined, fences skipped, each table cell a
 * segment of its own.
 */
export function sentences(source: string): Sentence[] {
  const lines = splitlines(joinWrapped(normalizeTabs(source)));
  const cells = markdownTableCells(lines);
  const out: Sentence[] = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (CODE_FENCE.test(pyStrip(line))) {
      inFence = !inFence;
      return;
    }
    if (inFence || !pyStrip(line)) return;
    for (const [segment, column] of cells.get(index) ?? [[line, 0]])
      out.push(...segmentSentences(segment, index + 1, column));
  });
  return out;
}

/** Resolve a physical finding through its paragraph's cleaned coordinates. */
function containingSentence(
  f: Finding,
  positions: Map<number, JoinedPosition>,
  allSentences: Sentence[],
): Sentence | undefined {
  const position = positions.get(f.line - 1);
  // This producer anchors at the list marker, but reports the item's end.
  if (f.rule === "dangling-conjunction")
    return allSentences.findLast(
      (s) => s.line === (position?.line ?? f.line - 1) + 1,
    );
  // Source columns lose container prefixes and gain earlier paragraph lines.
  const column = position
    ? position.offset + f.col - 1 - position.prefix
    : f.col - 1;
  const context = allSentences.find(
    (s) =>
      s.line === (position?.line ?? f.line - 1) + 1 &&
      s.start <= column &&
      column < s.end,
  );
  return context;
}

/** The linter's findings on `source` under the guide's caps: what counts, and what is advice. */
export function voiceFindings(source: string): {
  hard: VoiceFinding[];
  advice: VoiceFinding[];
  words: number;
} {
  source = normalizeTabs(source);
  const hard: VoiceFinding[] = [];
  const positions = new Map<number, JoinedPosition>();
  joinWrapped(source, positions);
  const allSentences = sentences(source);
  for (const s of allSentences) {
    if (s.words > MAX_WORDS)
      hard.push({
        line: s.line,
        entry: `long-sentence, ${s.words} words: "${s.text}"`,
      });
    if (s.semicolons > MAX_SEMICOLONS)
      hard.push({
        line: s.line,
        entry: `semicolons, ${s.semicolons} in one sentence: "${s.text}"`,
      });
  }
  const advice: VoiceFinding[] = [];
  const [linted, words] = lint(source);
  for (const f of linted) {
    // Sentence length and semicolons are measured above, under the guide's caps.
    if (f.rule === "long-sentence" || f.rule === "semicolon") continue;
    const context = containingSentence(f, positions, allSentences);
    const quote = f.level === "advisory" ? f.match : context?.text || f.match;
    const finding = { line: f.line, entry: `${f.rule}: "${quote}"` };
    (f.level === "advisory" ? advice : hard).push(finding);
  }
  const byLine = (a: VoiceFinding, b: VoiceFinding) => a.line - b.line;
  return { hard: hard.sort(byLine), advice: advice.sort(byLine), words };
}

type Measured = Map<string, ReturnType<typeof voiceFindings>>;

/** Each visitor document's findings, or the reason one cannot be read. */
function measure(root: string, historical: boolean): Measured | string {
  const out: Measured = new Map();
  for (const doc of VISITOR_DOCUMENTS) {
    const path = join(root, doc);
    if (!existsSync(path)) {
      if (historical) continue;
      return `${doc} is missing under ${root}`;
    }
    out.set(doc, voiceFindings(readFileSync(path, "utf8")));
  }
  return out;
}

/** The counts as the ratchet's counting command prints them: document → entry → count. */
function countsJson(measured: Measured): string {
  const counts: Record<string, Record<string, number>> = {};
  for (const [doc, { hard }] of measured) {
    const entries: Record<string, number> = {};
    for (const { entry } of hard) entries[entry] = (entries[entry] ?? 0) + 1;
    counts[doc] = entries;
  }
  return JSON.stringify({ counts });
}

function report(measured: Measured): void {
  console.log(
    `${GATE}: findings per visitor document under docs/VOICE.md's caps (${MAX_WORDS} words, ${MAX_SEMICOLONS} semicolon per sentence); the ratchet in \`bun run quality\` refuses a rise`,
  );
  for (const [doc, { hard, advice, words }] of measured)
    console.log(
      `  ${doc.padEnd(12)} ${String(hard.length).padStart(4)}  (${words} words; ${advice.length} advisory, not counted)`,
    );
  console.log(
    `  each finding, its sentence quoted: bun scripts/check-voice.ts --list <document>`,
  );
}

function list(measured: Measured, only: string[]): void {
  for (const [doc, { hard, advice }] of measured) {
    if (only.length && !only.includes(doc)) continue;
    for (const f of hard) console.log(`${doc}:${f.line}: ${f.entry}`);
    for (const f of advice) console.log(`${doc}:${f.line}: advice: ${f.entry}`);
  }
}

/** The gates' stage: each visitor document's count, or exit 2 when one cannot be read. */
export function checkVoice(root = "."): number {
  const measured = measure(root, false);
  if (typeof measured === "string") return couldNotCheck(GATE, measured);
  report(measured);
  return 0;
}

const USAGE = "usage: check-voice.ts [--json | --list [document…]]";

type Mode =
  | { kind: "report" }
  | { kind: "json" }
  | { kind: "list"; only: string[] };

/** What the arguments ask for, or why they cannot be run. */
function mode(args: string[]): Mode | string {
  const { values, positionals } = strictOptions(
    {
      args,
      options: { json: { type: "boolean" }, list: { type: "boolean" } },
      allowPositionals: true,
    },
    USAGE,
  );
  const unknown = positionals.filter(
    (p) => !(VISITOR_DOCUMENTS as readonly string[]).includes(p),
  );
  if (unknown.length) return `not a visitor document: ${unknown.join(", ")}`;
  if (values.json && values.list) return "--json and --list exclude each other";
  if (values.list) return { kind: "list", only: positionals };
  if (positionals.length) return "a document is named only after --list";
  return values.json ? { kind: "json" } : { kind: "report" };
}

function main(args: string[]): number {
  const asked = mode(args);
  if (typeof asked === "string") {
    console.error(`${asked}\n${USAGE}`);
    return 2;
  }
  if (asked.kind === "report") return checkVoice(process.cwd());
  const historical =
    asked.kind === "json" && process.env.RATCHET_HISTORICAL === "1";
  const measured = measure(process.cwd(), historical);
  if (typeof measured === "string") return couldNotCheck(GATE, measured);
  if (asked.kind === "json") console.log(countsJson(measured));
  else list(measured, asked.only);
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));

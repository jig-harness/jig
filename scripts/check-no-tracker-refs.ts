// Scope: every tracked/non-ignored text file, including templates and frozen
// material. Excludes fixtures and exactly the active pattern file. Invalid
// patterns, failed listings and unreadable paths are errors (exit 2).
//
// Pattern file: one extended regular expression per line. A leading `(?i)`
// makes that pattern case-insensitive. A line starting with `!` is an allow
// pattern instead: it is tested against `<relative path>:<line>`, and the text
// it matches is exempt, so an exemption can name the file it applies to. Only
// the matched text is exempt: the rest of the line is still checked, so an
// allowed occurrence cannot hide another reference beside it. An allow pattern
// exempts a reference only by blanking that reference's own characters:
// blanking its context alone, or leaving another match over its span, does
// not exempt it, though a later allow pattern still can. Each allow
// pattern sits under `#` comment lines that give its reason; one without a
// reason, or one that exempts no reference the earlier allow patterns left
// unexempted, is itself a finding, so the allowed places cannot outlive what
// they allow.
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli, ere } from "../lib/cli.ts";
import { repoFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  type ReasonedEntry,
  reasonedEntries,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "no-origin-references";
const ALLOW_RULE = "origin-reference-allowlist";

interface Allow extends ReasonedEntry {
  regex: RegExp;
}

/** One rejection-pattern match: its span on the line and the text it matched. */
interface Reference {
  pattern: number;
  start: number;
  end: number;
  text: string;
}

const compile = (line: string) =>
  line.startsWith("(?i)") ? ere(line.slice(4), "i") : ere(line);

/** The rejection patterns and the allow patterns of a pattern file. */
function readPatterns(path: string): { regexes: RegExp[]; allows: Allow[] } {
  const entries = reasonedEntries(readFileSync(path, "utf8"));
  const regexes = entries
    .filter((e) => !e.text.startsWith("!"))
    .map((e) => compile(e.text));
  const allows = entries
    .filter((e) => e.text.startsWith("!"))
    .map((e) => {
      const regex = compile(e.text.slice(1));
      return { ...e, regex: new RegExp(regex.source, `${regex.flags}g`) };
    });
  return { regexes, allows };
}

/**
 * A listed file's bytes, or undefined when it was deleted after listing.
 * Only an observed deletion is skipped: EACCES and broken links throw.
 */
function readListed(file: string): Buffer | undefined {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(file).isSymbolicLink()) throw error;
    } catch (statError) {
      if (
        statError === error ||
        (statError as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw statError;
    }
    assertReachableAncestor(file, error);
    return undefined;
  }
}

/**
 * realpath on the parents distinguishes a missing file from an inaccessible
 * ancestor; EACCES must propagate rather than pass.
 */
function assertReachableAncestor(file: string, missing: unknown): void {
  let parent = dirname(file);
  for (;;) {
    try {
      realpathSync(parent);
      return;
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT")
        throw parentError;
      const next = dirname(parent);
      if (next === parent) throw missing;
      parent = next;
    }
  }
}

/** Findings for the allow patterns that have no reason or exempt nothing. */
function allowFindings(
  allows: Allow[],
  used: Set<number>,
  file: string,
): Finding[] {
  return allows.flatMap((allow, index): Finding[] => {
    if (allow.reason && used.has(index)) return [];
    return [
      {
        rule: ALLOW_RULE,
        file,
        line: allow.line,
        problem: !allow.reason
          ? "allow pattern has no reason"
          : "allow pattern exempts nothing: it removes no reference the earlier allow patterns left",
        remedy: !allow.reason
          ? "put the pattern under a `#` comment that says why the place is allowed"
          : "delete the pattern",
      },
    ];
  });
}

export function checkTracker(
  root = ".",
  patterns = join(import.meta.dir, "tracker-key-patterns.txt"),
): number {
  const patternPath = realpathSync(patterns);
  const { regexes, allows } = readPatterns(patternPath);
  if (!regexes.length) throw new Error(`no patterns in ${patterns}`);
  const used = new Set<number>();
  const globalRegexes = regexes.map(
    (regex) => new RegExp(regex.source, `${regex.flags}g`),
  );
  // Every reference the rejection patterns find in `text`, keyed by pattern
  // and span, with the text it matched.
  const references = (text: string): Map<string, Reference> => {
    const found = new Map<string, Reference>();
    globalRegexes.forEach((regex, pattern) => {
      for (const match of text.matchAll(regex))
        found.set(`${pattern}:${match.index}:${match[0].length}`, {
          pattern,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
        });
    });
    return found;
  };
  // The line with every allowed match blanked out, so a rejection pattern
  // cannot match inside it and the text around it still can. Every reference
  // is tracked by its pattern and span from the text where it is first found
  // (the line, or the text an allow pattern left, since blanking can expose a
  // reference at a new word boundary). An allow pattern exempts a reference
  // when it blanks one of the reference's own characters and the reference is
  // then no longer found; that makes the allow pattern in use. One that
  // matches beside the flagged text, repeats an earlier pattern, blanks a
  // blank, leaves the rejection pattern matching the same span, or covers a
  // reference an earlier pattern already exempted exempts nothing. A
  // reference that disappears because only its context was blanked (a
  // lookahead's text) is not exempted, and no other match over its span
  // stands in for it: it stays a finding until a later allow pattern blanks
  // its own characters. A match that only moved (a run of blanks it can now
  // extend over), or one found again on an exempted span, is a new reference,
  // and is still checked.
  const unallowed = (relative: string, line: string): string[] => {
    const offset = relative.length + 1;
    const tested = `${relative}:${line}`;
    // UTF-16 units, the unit match indexes count in.
    const chars = tested.split("");
    const rest = () => chars.join("").slice(offset);
    const occurrences = new Map<
      string,
      { reference: Reference; exempt: boolean }
    >();
    const record = (found: Map<string, Reference>) => {
      for (const [key, reference] of found)
        if (occurrences.get(key)?.exempt !== false)
          occurrences.set(key, { reference, exempt: false });
    };
    record(references(rest()));
    allows.forEach((allow, index) => {
      const before = rest();
      for (const match of tested.matchAll(allow.regex))
        chars.fill(" ", match.index, match.index + match[0].length);
      const after = rest();
      if (after === before) return;
      const left = references(after);
      for (const [key, occurrence] of occurrences) {
        if (occurrence.exempt || left.has(key)) continue;
        const { start, end } = occurrence.reference;
        for (let i = start; i < end; i++)
          if (before[i] !== after[i]) {
            occurrence.exempt = true;
            used.add(index);
            break;
          }
      }
      record(left);
    });
    return [...occurrences.values()]
      .filter(({ exempt }) => !exempt)
      .map(({ reference }) => reference)
      .sort((a, b) => a.start - b.start || a.pattern - b.pattern)
      .map((reference) => reference.text);
  };
  const lineFinding = (
    relative: string,
    line: string,
    index: number,
  ): Finding | undefined => {
    if (!regexes.some((regex) => regex.test(line))) return undefined;
    const [found] = unallowed(relative, line);
    if (found === undefined) return undefined;
    return {
      rule: RULE,
      file: relative.replaceAll("\\", "/"),
      line: index + 1,
      problem: `origin reference \`${found}\` (an issue-tracker key or the name of an organization Jig learned from)`,
      remedy:
        "state the rationale itself in the document or a code comment (AGENTS.md, Writing conventions)",
    };
  };
  const findings: Finding[] = [];
  let scanned = 0;
  for (const relative of repoFiles(root)) {
    if (relative.split(/[\\/]/).includes("fixtures")) continue;
    const file = resolve(root, relative);
    if (file === patternPath) continue;
    const content = readListed(file);
    if (!content || content.includes(0)) continue;
    scanned++;
    content
      .toString("utf8")
      .split("\n")
      .forEach((line, index) => {
        const finding = lineFinding(relative, line, index);
        if (finding) findings.push(finding);
      });
  }
  if (!scanned)
    return couldNotCheck(
      RULE,
      `no text file under ${root} outside test fixtures and the pattern file`,
    );
  findings.push(
    ...allowFindings(allows, used, repoPath(resolve(root), patternPath)),
  );
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${scanned} text files; no issue-tracker key or origin name outside the ${allows.length} allowed places, each with a reason and in use (test fixtures and the pattern file are skipped)`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkTracker(...process.argv.slice(2)));

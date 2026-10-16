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
//
// A pattern line, rejection or allow, may name a value of the scanned
// repository's configuration, `<root>/.config/jig.yaml`, by placeholder:
// `{{team}}` is `issue_tracker.team` and `{{owner}}` is the owner part of
// `review.repo_slug` (`owner/name`). Each is replaced by its value with the
// regular-expression characters escaped, so a pattern file can forbid an
// organization's name and tracker keys without spelling them out. The
// configuration is read only when a pattern line uses a placeholder. A
// placeholder whose value cannot be read (no configuration, YAML that does
// not parse, a field missing, empty or not text, a slug with no owner), or an
// unknown `{{name}}`, makes the gate exit 2.
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
import { load as loadYaml } from "../lib/vendor/js-yaml.mjs";

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

/** A placeholder that cannot be filled: the gate cannot check (exit 2). */
class Unresolved extends Error {}

/** The configuration file a pattern file's placeholders are read from. */
const CONFIG = ".config/jig.yaml";

/** The value at `keys` in parsed YAML, or undefined where a key is missing. */
function field(doc: unknown, keys: string[]): unknown {
  let value = doc;
  for (const key of keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Each placeholder: the field it reads, how its value is taken from the
 * field's text, and the form that text must have when it is not used whole.
 */
const PLACEHOLDERS: Record<
  string,
  { field: string; value: (text: string) => string | undefined; form?: string }
> = {
  team: { field: "issue_tracker.team", value: (text) => text },
  owner: {
    field: "review.repo_slug",
    value: (text) => /^([^/\s]+)\/[^/\s]+$/.exec(text)?.[1],
    form: "owner/name",
  },
};

/**
 * A function that fills the placeholders of one pattern line. The
 * configuration under `root` is read on the first line that needs it.
 */
function placeholderFiller(root: string, patterns: string) {
  const config = join(root, CONFIG);
  let doc: unknown;
  let loaded = false;
  const load = (): unknown => {
    if (loaded) return doc;
    let raw: string;
    try {
      raw = readFileSync(config, "utf8");
    } catch (error) {
      throw new Unresolved(
        `${patterns} uses placeholders, which are read from ${config}: cannot read it (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      );
    }
    try {
      doc = loadYaml(raw);
    } catch (error) {
      throw new Unresolved(
        `${patterns} uses placeholders, which are read from ${config}: it does not parse as YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      );
    }
    loaded = true;
    return doc;
  };
  return (text: string, line: number): string =>
    text.replace(/\{\{([^{}]*)\}\}/g, (_whole, name: string) => {
      const place = `${patterns}:${line}`;
      const placeholder = Object.hasOwn(PLACEHOLDERS, name)
        ? PLACEHOLDERS[name]
        : undefined;
      if (!placeholder)
        throw new Unresolved(
          `${place}: unknown placeholder {{${name}}}; the known ones are ${Object.keys(
            PLACEHOLDERS,
          )
            .map((known) => `{{${known}}}`)
            .join(", ")}`,
        );
      const raw = field(load(), placeholder.field.split("."));
      const text = typeof raw === "string" ? raw.trim() : "";
      const value = text ? placeholder.value(text) : undefined;
      if (!value)
        throw new Unresolved(
          `${place}: {{${name}}} needs ${placeholder.field} in ${config}${
            text
              ? ` in the form ${placeholder.form}, not ${JSON.stringify(raw)}`
              : " as non-empty text"
          }`,
        );
      return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
}

/**
 * The rejection patterns and the allow patterns of a pattern file, with its
 * placeholders filled from the configuration under `root`. Throws when a
 * pattern does not compile or a placeholder cannot be filled.
 */
export function readPatterns(
  path: string,
  root: string,
): { regexes: RegExp[]; allows: Allow[] } {
  const fill = placeholderFiller(root, path);
  // A line's kind is read before its placeholders are filled, so a filled
  // value can never turn a rejection pattern into an allow pattern.
  const entries = reasonedEntries(readFileSync(path, "utf8")).map((e) => ({
    ...e,
    allow: e.text.startsWith("!"),
    text: fill(e.text, e.line),
  }));
  const regexes = entries.filter((e) => !e.allow).map((e) => compile(e.text));
  const allows = entries
    .filter((e) => e.allow)
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
  let read: { regexes: RegExp[]; allows: Allow[] };
  try {
    read = readPatterns(patternPath, root);
  } catch (error) {
    if (error instanceof Unresolved) return couldNotCheck(RULE, error.message);
    throw error;
  }
  const { regexes, allows } = read;
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

#!/usr/bin/env bun
// Orphans and reverse orphans of the error-code registry.
//
// The rule it holds. The registry is the single source of every code, so it
// and the code that throws, and the documents that name codes, must agree
// in both directions. An ORPHAN is a registered code nothing outside the
// registry references: dead weight in every generated copy, and a code a
// client handles that can never arrive. A REVERSE ORPHAN is a code-shaped
// literal in a hand-written document that no registry entry declares: a
// generated reference cannot hold one, but a hand-written page keeps a
// retired code alive until something checks it.
//
// What it does. Reads the registered codes from a list (one per line: the
// code, then optionally the text a reference uses, such as a constant's
// qualified name), then scans the source paths for a reference to each code
// by that name or by its literal, leaving the registry path(s), tests,
// type declarations and generated copies of the registry out (a file a
// `--generated` glob matches, or one whose opening lines carry `@generated`
// or `DO NOT EDIT`: a copy names every code, so it proves none is used),
// and scans the documentation paths for every match
// of the code format that is not registered. A baseline accepts named
// orphans, one code per line under a `#` comment giving the reason; an
// entry without a reason, for a code that is not registered, or for a code
// that is referenced after all, is a finding, so the baseline only shrinks.
//
// Exit codes: 0 every code referenced (or accepted) and no unregistered
// code in the documents, 1 findings, 2 could not check (a path, the list or
// the baseline missing or unreadable, an empty or malformed list, a code
// that does not match the format, a format that is not a regular
// expression, a source or documentation path that holds no file to scan, a
// bad option).
//
// Usage:
//   audit-error-codes.ts --codes <file> --format <regex>
//     [--registry <path>]... [--docs <path>]... [--generated <glob>]...
//     [--baseline <file>]
//     [--root <dir>] [--ext .ts,...] [--docs-ext .md,.mdx] <source path>...
import { cli } from "../../../../lib/cli.ts";
import {
  type Finding,
  type ReasonedEntry,
  reportFindings,
} from "../../../../lib/findings.ts";
import {
  escapeRegExp,
  existing,
  InputError,
  listFiles,
  optionValue,
  readList,
  readText,
  splitList,
} from "./shared.ts";

const ORPHAN_RULE = "orphan-error-code";
const REVERSE_RULE = "unregistered-error-code";
const BASELINE_RULE = "orphan-baseline";
const usage =
  "usage: audit-error-codes.ts --codes <file> --format <regex> [--registry <path>]... [--docs <path>]... [--generated <glob>]... [--baseline <file>] [--root <dir>] [--ext <list>] [--docs-ext <list>] <source path>...";

export interface Declared {
  code: string;
  /** The text a reference is written as, when the list gives one. */
  name: string | undefined;
  /** 1-based line in the list. */
  line: number;
}

/** A regular expression for `code` as a literal, on its own. */
const literalPattern = (code: string): RegExp =>
  new RegExp(`(?<![\\w-])${escapeRegExp(code)}(?![\\w-])`);

/** A regular expression for `name` as an identifier (dots allowed). */
const namePattern = (name: string): RegExp =>
  new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);

/** The registered codes from the list's text; a line it cannot read throws. */
export function parseDeclared(content: string, format: RegExp): Declared[] {
  const declared: Declared[] = [];
  const seen = new Set<string>();
  content.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const parts = line.split(/\s+/);
    if (parts.length > 2)
      throw new InputError(
        `registry list line ${index + 1}: expected <code> [<name>], got ${parts.length} fields`,
      );
    const [code = "", name] = parts;
    if (!format.test(code))
      throw new InputError(
        `registry list line ${index + 1}: ${code} does not match the code format`,
      );
    if (seen.has(code))
      throw new InputError(
        `registry list line ${index + 1}: ${code} is declared twice`,
      );
    seen.add(code);
    declared.push({ code, name, line: index + 1 });
  });
  return declared;
}

/** The codes `text` references, by name or by literal. */
export function findReferenced(
  text: string,
  declared: readonly Declared[],
): Set<string> {
  const referenced = new Set<string>();
  for (const { code, name } of declared)
    if (
      literalPattern(code).test(text) ||
      (name !== undefined && namePattern(name).test(text))
    )
      referenced.add(code);
  return referenced;
}

/** Each code-shaped literal in `text` that `registered` lacks, by line. */
export function findUnregistered(
  text: string,
  registered: ReadonlySet<string>,
  format: RegExp,
): { line: number; code: string }[] {
  const hits: { line: number; code: string }[] = [];
  text.split("\n").forEach((line, index) => {
    const seen = new Set<string>();
    for (const match of line.matchAll(format)) {
      const code = match[0];
      if (!registered.has(code) && !seen.has(code)) {
        seen.add(code);
        hits.push({ line: index + 1, code });
      }
    }
  });
  return hits;
}

interface Options {
  codes: string | undefined;
  format: string | undefined;
  registry: string[];
  docs: string[];
  generated: string[];
  baseline: string | undefined;
  root: string;
  extensions: string[];
  docsExtensions: string[];
  paths: string[];
}

/** The source extensions scanned for references, by default. */
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
];

/** The documentation extensions searched for code-shaped literals. */
const DOCS_EXTENSIONS = [".md", ".mdx", ".txt", ".html"];

/** What each valued option sets. */
const SETTERS = new Map<string, (options: Options, value: string) => void>([
  [
    "--codes",
    (o, v) => {
      o.codes = v;
    },
  ],
  [
    "--format",
    (o, v) => {
      o.format = v;
    },
  ],
  [
    "--registry",
    (o, v) => {
      o.registry.push(v);
    },
  ],
  [
    "--docs",
    (o, v) => {
      o.docs.push(v);
    },
  ],
  [
    "--generated",
    (o, v) => {
      o.generated.push(v);
    },
  ],
  [
    "--baseline",
    (o, v) => {
      o.baseline = v;
    },
  ],
  [
    "--root",
    (o, v) => {
      o.root = v;
    },
  ],
  [
    "--ext",
    (o, v) => {
      o.extensions = splitList(v);
    },
  ],
  [
    "--docs-ext",
    (o, v) => {
      o.docsExtensions = splitList(v);
    },
  ],
]);

function parseArgs(args: string[]): Options {
  const options: Options = {
    codes: undefined,
    format: undefined,
    registry: [],
    docs: [],
    generated: [],
    baseline: undefined,
    root: process.cwd(),
    extensions: SOURCE_EXTENSIONS,
    docsExtensions: DOCS_EXTENSIONS,
    paths: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const set = SETTERS.get(arg);
    // A format may begin with dashes; every other value may not.
    if (set !== undefined)
      set(options, optionValue(args, ++i, arg, usage, arg === "--format"));
    else if (arg.startsWith("--"))
      throw new InputError(`unknown option ${arg}\n${usage}`);
    else options.paths.push(arg);
  }
  if (options.codes === undefined)
    throw new InputError(`--codes is required\n${usage}`);
  if (options.format === undefined)
    throw new InputError(`--format is required\n${usage}`);
  if (options.paths.length === 0)
    throw new InputError(`no source path to scan\n${usage}`);
  return options;
}

/** The format as the two expressions the audit needs; a bad one throws. */
function compileFormat(format: string): { whole: RegExp; inText: RegExp } {
  try {
    return {
      whole: new RegExp(`^(?:${format})$`),
      inText: new RegExp(`(?<![\\w-])(?:${format})(?![\\w-])`, "g"),
    };
  } catch (error) {
    throw new InputError(`--format is not a regular expression: ${format}`, {
      cause: error,
    });
  }
}

/** A header line that marks a file as written by a generator. */
const GENERATED_HEADER = /@generated\b|\bDO NOT EDIT\b/;

/** How many opening lines are searched for a generated header. */
const HEADER_LINES = 10;

/**
 * Whether the source file is a generated copy of the registry (a client's
 * union, a runtime array, a catalog): it matches one of `globs`, or its
 * opening lines carry a generated header. A copy names every code, so it is
 * no evidence that any code is used.
 */
function isGeneratedCopy(
  root: string,
  file: string,
  globs: readonly Bun.Glob[],
): boolean {
  if (globs.some((glob) => glob.match(file))) return true;
  const head = readText(root, file, "a source file")
    .split("\n", HEADER_LINES)
    .join("\n");
  return GENERATED_HEADER.test(head);
}

/** Every code the source files reference, by name or by literal. */
function referencedIn(
  root: string,
  sources: readonly string[],
  declared: readonly Declared[],
): Set<string> {
  const referenced = new Set<string>();
  for (const file of sources)
    for (const code of findReferenced(
      readText(root, file, "a source file"),
      declared,
    ))
      referenced.add(code);
  return referenced;
}

/** The baseline's findings, and the orphans it accepts. */
function baselineFindings(
  baseline: readonly ReasonedEntry[],
  baselineFile: string,
  registered: ReadonlySet<string>,
  referenced: ReadonlySet<string>,
): { findings: Finding[]; accepted: Set<string> } {
  const findings: Finding[] = [];
  const accepted = new Set<string>();
  const at = (entry: ReasonedEntry, problem: string, remedy: string) =>
    findings.push({
      rule: BASELINE_RULE,
      file: baselineFile,
      line: entry.line,
      problem,
      remedy,
    });
  for (const entry of baseline) {
    const code = entry.text.trim();
    if (entry.reason === "")
      at(
        entry,
        `the entry for ${code} has no reason.`,
        "Open its group with a `#` comment saying why the orphan stays.",
      );
    if (!registered.has(code))
      at(
        entry,
        `stale: ${code} is not a registered code.`,
        "Remove the entry.",
      );
    else if (referenced.has(code))
      at(
        entry,
        `stale: ${code} is referenced, so the entry accepts nothing.`,
        "Remove the entry; the baseline only shrinks.",
      );
    else accepted.add(code);
  }
  return { findings, accepted };
}

/** Each registered code nothing references and the baseline does not accept. */
function orphanFindings(
  declared: readonly Declared[],
  codesFile: string,
  referenced: ReadonlySet<string>,
  accepted: ReadonlySet<string>,
): Finding[] {
  return declared
    .filter(({ code }) => !referenced.has(code) && !accepted.has(code))
    .map(({ code, line }) => ({
      rule: ORPHAN_RULE,
      file: codesFile,
      line,
      problem: `${code} is registered and nothing outside the registry references it.`,
      remedy:
        "Throw it where it belongs, retire it, or accept it in the baseline under a reason.",
    }));
}

/** Each code-shaped literal in the documents that the registry lacks. */
function reverseFindings(
  root: string,
  docs: readonly string[],
  registered: ReadonlySet<string>,
  inText: RegExp,
): Finding[] {
  const findings: Finding[] = [];
  for (const file of docs)
    for (const { line, code } of findUnregistered(
      readText(root, file, "a documentation file"),
      registered,
      inText,
    ))
      findings.push({
        rule: REVERSE_RULE,
        file,
        line,
        problem: `${code} is named here and no registry entry declares it.`,
        remedy:
          "Register the code, or remove it from the document; a page the registry generates cannot carry one.",
      });
  return findings;
}

export function main(args = process.argv.slice(2)): number {
  const options = parseArgs(args);
  const root = existing(process.cwd(), options.root, "--root");
  const format = compileFormat(options.format ?? "");
  const codesFile = options.codes ?? "";
  const declared = parseDeclared(
    readText(root, codesFile, "the registry list"),
    format.whole,
  );
  if (declared.length === 0)
    throw new InputError(`the registry list declares no code: ${codesFile}`);
  for (const path of options.registry) existing(root, path, "the registry");
  const generated = options.generated.map((glob) => new Bun.Glob(glob));
  const sources = listFiles(
    root,
    options.paths,
    options.extensions,
    options.registry,
    "a source path",
    (file) => !isGeneratedCopy(root, file, generated),
  );
  const docs = listFiles(
    root,
    options.docs,
    options.docsExtensions,
    options.registry,
    "a documentation path",
  );
  const baseline =
    options.baseline === undefined
      ? []
      : readList(root, options.baseline, "the baseline");
  const referenced = referencedIn(root, sources, declared);
  const registered = new Set(declared.map((d) => d.code));
  const accepted = baselineFindings(
    baseline,
    options.baseline ?? "",
    registered,
    referenced,
  );
  const findings = [
    ...accepted.findings,
    ...orphanFindings(declared, codesFile, referenced, accepted.accepted),
    ...reverseFindings(root, docs, registered, format.inText),
  ];
  if (findings.length > 0) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `OK — ${declared.length} registered code(s), every one referenced${accepted.accepted.size > 0 ? ` (${accepted.accepted.size} accepted as orphan)` : ""}; ${docs.length} documentation file(s) name no unregistered code`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());

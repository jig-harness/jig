// Every record the plugin keeps is registered in the records registry
// (`plugin/shared/records/registry.ts`, the view a person reads is
// `plugin/RECORDS.md`). The registry declares; this gate derives. Under
// `plugin/`, outside `__tests__/`, `fixtures/` and `vendor/`, it finds:
//
// - every hidden-marker literal in the code: `<!--` followed by a name, in a
//   TypeScript or JavaScript file, on a line that is not a comment line (one
//   that starts with `//`, `/*` or `*`). Between `<!--` and the name it reads
//   spaces and a regular expression's `\s*`, written once or escaped in a
//   string. A name a template splices in (`<!-- ${NAME}`) is read through a
//   constant the same file declares as a string literal; a name assembled at
//   run time any other way is not seen, and neither is a marker on a line of
//   a template string that starts with `*`;
// - every family the drive's state library tags a state-file pattern with
//   (`family: "<name>"` in `plugin/skills/drive-pr/scripts/lib/state/`), so
//   a new pattern either joins a registered family or registers its own;
// - every SQLite table the code creates (`CREATE TABLE <name>`).
//
// Each must be a registered kind's marker, state family or table, or a
// marker the registry lists as not a record (a generated file's banner, a
// waiver a person writes). A marker matches when the literal's text starts
// with it and the next character cannot continue a name. The registry's own
// entries must still be found: a registered marker, family or table that no
// code names any more, or a kind whose owner is not a file under `plugin/`,
// is a finding too, so the registry cannot keep a kind that is gone.
//
// This is a text check, not a parser: nothing is lexed, so a marker in a
// trailing comment after code is reported like one in a string.
//
// Exit 1 on a finding, 2 when it cannot check (no `plugin/` directory, or a
// file in scope unreadable).
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { readRegularFile, repoFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";
import {
  NOT_RECORDS,
  type NotARecord,
  RECORD_KINDS,
  type RecordKind,
} from "../plugin/shared/records/registry.ts";

const RULE = "records-registry";
const REGISTRY = "plugin/shared/records/registry.ts";
const REMEDY = `register the record in ${REGISTRY} (its medium, owner, where it lives and its version) and add it to plugin/RECORDS.md`;

/** The drive's state library, whose patterns carry their family. */
export const STATE_LIBRARY = "plugin/skills/drive-pr/scripts/lib/state/";

const CODE = /\.(?:[cm]?ts|[cm]?js)$/;

/** Whether the gate reads a repository path. */
export function inScope(path: string): boolean {
  if (!path.startsWith("plugin/") || !CODE.test(path)) return false;
  const parts = path.split("/");
  return !["__tests__", "fixtures", "vendor"].some((p) => parts.includes(p));
}

/** What the code names, each where it is named. */
export interface Named {
  what: "marker" | "family" | "table";
  /** The marker's text as written after `<!--`, or the family's or table's name. */
  text: string;
  file: string;
  line: number;
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** `<!--`, then spaces and `\s*` (escaped once in a string), up to the name. */
const MARKER_OPEN = /<!--(?:[ \t]|\\{1,2}s[*+?]?)*/g;
const SPLICE = /^\$\{([A-Za-z_$][\w$]*)\}/;
const FAMILY = /\bfamily:\s*"([a-z][a-z0-9-]*)"/g;
const TABLE = /\bCREATE TABLE\s+(?:IF NOT EXISTS\s+)?([A-Za-z_]\w*)/g;
const NAME_START = /^[A-Za-z]/;

/** The string constants a file declares, by name. */
function constants(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`$\\\n]*)\2/g,
  ))
    found.set(m[1] as string, m[3] as string);
  return found;
}

/**
 * The text after one `<!--` opening, with a spliced constant read through;
 * `null` when it names nothing the gate can read.
 */
function markerText(rest: string, consts: Map<string, string>): string | null {
  const splice = SPLICE.exec(rest);
  let text = rest;
  if (splice !== null) {
    const value = consts.get(splice[1] as string);
    if (value === undefined) return null;
    text = value.replace(/^<!--\s*/, "") + rest.slice(splice[0].length);
  }
  return NAME_START.test(text) ? text : null;
}

/** The marker texts on one source line. */
function markersOn(source: string, consts: Map<string, string>): string[] {
  return [...source.matchAll(MARKER_OPEN)].flatMap((m) => {
    const text = markerText(source.slice((m.index ?? 0) + m[0].length), consts);
    return text === null ? [] : [text];
  });
}

/** The first capture of every match of `pattern` on a line. */
function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((m) => m[1] as string);
}

/** The markers, families and tables one file names. */
export function namedIn(path: string, text: string): Named[] {
  const consts = constants(text);
  const family = path.startsWith(STATE_LIBRARY);
  return text.split("\n").flatMap((source, index): Named[] => {
    if (COMMENT_LINE.test(source)) return [];
    const at = { file: path, line: index + 1 };
    return [
      ...markersOn(source, consts).map((t) => ({
        what: "marker" as const,
        text: t,
        ...at,
      })),
      ...(family ? captures(source, FAMILY) : []).map((t) => ({
        what: "family" as const,
        text: t,
        ...at,
      })),
      ...captures(source, TABLE).map((t) => ({
        what: "table" as const,
        text: t,
        ...at,
      })),
    ];
  });
}

/** Whether marker text `text` opens with `marker`, the next character unable to continue a name. */
export function opensWithMarker(text: string, marker: string): boolean {
  if (!text.startsWith(marker)) return false;
  return !/^(?:[\w-]|:[\w-])/.test(text.slice(marker.length));
}

/** The leading name of marker text, for a finding. */
function nameOf(text: string): string {
  return /^[A-Za-z][\w-]*(?::[\w.-]+)*/.exec(text)?.[0] ?? text;
}

function covers(kind: RecordKind, n: Named): boolean {
  if (n.what === "marker")
    return (kind.markers ?? []).some((m) => opensWithMarker(n.text, m));
  if (n.what === "family") return kind.stateFamily === n.text;
  return kind.table === n.text;
}

/** One finding per name the code uses that the registry does not hold. */
function unregistered(
  named: Named[],
  kinds: readonly RecordKind[],
  notRecords: readonly NotARecord[],
): Finding[] {
  return named
    .filter(
      (n) =>
        !kinds.some((k) => covers(k, n)) &&
        !(
          n.what === "marker" &&
          notRecords.some((r) => opensWithMarker(n.text, r.marker))
        ),
    )
    .map((n) => ({
      rule: RULE,
      file: n.file,
      line: n.line,
      problem:
        n.what === "marker"
          ? `the hidden marker ${JSON.stringify(nameOf(n.text))} is in no registered record kind`
          : n.what === "family"
            ? `the drive state family ${JSON.stringify(n.text)} is in no registered record kind`
            : `the table ${JSON.stringify(n.text)} is in no registered record kind`,
      remedy:
        n.what === "marker"
          ? `${REMEDY}; a marker that is not a record (a generated file's banner, a person's waiver) goes in NOT_RECORDS with why`
          : REMEDY,
    }));
}

/** Whether the code names a marker opening with `marker`. */
function markerNamed(named: Named[], marker: string): boolean {
  return named.some(
    (n) => n.what === "marker" && opensWithMarker(n.text, marker),
  );
}

/** Whether the code names the family or table `text`. */
function nameNamed(
  named: Named[],
  what: "family" | "table",
  text: string | undefined,
): boolean {
  return (
    text === undefined || named.some((n) => n.what === what && n.text === text)
  );
}

/** What one registry entry claims that the code no longer has. */
function goneFrom(root: string, named: Named[], kind: RecordKind): string[] {
  const name = kind.name;
  return [
    ...(kind.markers ?? [])
      .filter((marker) => !markerNamed(named, marker))
      .map(
        (marker) =>
          `${name}'s marker ${JSON.stringify(marker)} is in no code under plugin/`,
      ),
    ...(nameNamed(named, "family", kind.stateFamily)
      ? []
      : [
          `${name}'s state family ${JSON.stringify(kind.stateFamily)} tags no pattern in ${STATE_LIBRARY}`,
        ]),
    ...(nameNamed(named, "table", kind.table)
      ? []
      : [
          `${name}'s table ${JSON.stringify(kind.table)} is created by no code under plugin/`,
        ]),
    ...(existsSync(join(root, "plugin", kind.owner))
      ? []
      : [
          `${name}'s ${kind.foreign === undefined ? "owner" : "reader"} plugin/${kind.owner} does not exist`,
        ]),
  ];
}

/** One finding per registry entry nothing in the code names any more. */
function stale(
  root: string,
  named: Named[],
  kinds: readonly RecordKind[],
  notRecords: readonly NotARecord[],
): Finding[] {
  const problems = [
    ...kinds.flatMap((kind) => goneFrom(root, named, kind)),
    ...notRecords
      .filter((entry) => !markerNamed(named, entry.marker))
      .map(
        (entry) =>
          `the marker ${JSON.stringify(entry.marker)} listed as not a record is in no code under plugin/`,
      ),
  ];
  return problems.map((problem) => ({
    rule: RULE,
    file: REGISTRY,
    problem,
    remedy:
      "remove the entry, or correct it to what the code now names; then update plugin/RECORDS.md",
  }));
}

/** Every finding for the code under `root`, against a registry. */
export function findings(
  root: string,
  named: Named[],
  kinds: readonly RecordKind[] = RECORD_KINDS,
  notRecords: readonly NotARecord[] = NOT_RECORDS,
): Finding[] {
  return [
    ...unregistered(named, kinds, notRecords),
    ...stale(root, named, kinds, notRecords),
  ];
}

export function checkRecordsRegistry(root = "."): number {
  if (
    !existsSync(join(root, "plugin")) ||
    !statSync(join(root, "plugin")).isDirectory()
  )
    return couldNotCheck(RULE, `no plugin/ directory under ${root}`);
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let paths: string[];
  try {
    paths = repoFiles(root).filter(inScope);
  } catch (error) {
    return couldNotCheck(RULE, reason(error));
  }
  const named: Named[] = [];
  for (const path of paths) {
    try {
      named.push(...namedIn(path, readRegularFile(join(root, path))));
    } catch (error) {
      return couldNotCheck(RULE, `${path}: ${reason(error)}`);
    }
  }
  const found = findings(root, named);
  if (found.length) {
    reportFindings(found);
    return 1;
  }
  const count = (what: Named["what"]) =>
    new Set(named.filter((n) => n.what === what).map((n) => n.text)).size;
  console.log(
    `${RULE}: OK — ${paths.length} plugin code files; every hidden marker (${count("marker")} literal forms), drive state family (${count("family")}) and table (${count("table")}) they name is registered, and every registered one is still named`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkRecordsRegistry(process.argv[2]));

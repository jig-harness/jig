#!/usr/bin/env bun
// One version source: every place a toolchain version is repeated equals the
// one place it is declared.
//
// The problem it catches. A runtime or compiler version is declared once (a
// version-manager file, say) and then repeated wherever something installs
// the tool on its own: a CI setup step, a container build argument, a
// package-manager field, a type package that tracks the runtime. Each copy is
// a pin site, and pin sites drift: one is left out and floats to the tool's
// latest release, one is forgotten by an upgrade and stays a version behind.
// Code then runs under one version in CI, another in the container, a third
// on a laptop, and the difference shows up as a failure nobody can reproduce.
//
// The rule. A declaration names, per tool, the one source and every pin
// site, each with how to read it. Every pin read from a site must equal the
// source's value, unless the declaration registers that file's value as an
// exception with a reason. An exception excuses exactly one value in one
// file, and, when it names a `toml:`, `json:` or `yaml:` path, only at the
// site read through that path, so a file's other pins of the same value stay
// checked. It prunes itself: an exception whose value is the source's value
// now, or that no pin holds, is a finding.
//
// Reading a value. A `toml:`, `json:` or `yaml:` dotted path reads one value
// from a structured file, and every file such a site names must hold it. A
// `step:` names a CI setup action and `with:` its version input: every step
// of a workflow (or a composite action) that uses the action is a pin, read
// from the parsed file, so a commented-out step is no step and a step that
// lost its input is one with no version; `with-file:` names the input that
// reads the version from a file instead, used only when the version input
// holds none (the action prefers an explicit version), which agrees when it
// names the source and the action, read the way its own source reads that
// file (by name, then by content), takes the source's value from it. The
// check carries that reader for `actions/setup-node` and `oven-sh/setup-bun`;
// for any other action, and for a file the action reads in a way the check
// does not follow (`mise.toml`, `package.json`), nothing confirms which value
// the action installs, so a step pointed at one sets the version explicitly.
// A `pattern:` is a regular expression whose first capture group is
// the version, applied to the whole text of each file the site names (every
// match is a pin) or, beside a path or step reader, to the value it read
// (`^bun@(.+)$` on `packageManager`). A match whose group did not capture, or
// an empty value, is a pin site with no version, which floats to the tool's
// default. A step or pattern site that matches files but no pin in any of
// them is a finding too, because the pin the declaration knew about is gone.
//
// Fail closed. A declaration that cannot be read or is malformed, a source
// file that is missing or holds no value where the reader looks, a site glob
// that matches nothing, and a site file that cannot be read all exit 2:
// nothing the check could not read passes.
//
// Exit codes: 0 every pin equals its source, 1 at least one finding, 2 could
// not check.
//
// Usage:
//   check-toolchain-pins.ts [--root <dir>] <declaration.yaml>
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile } from "../../../../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { load as loadYaml } from "../../../../lib/vendor/js-yaml.mjs";

const RULE = "toolchain-pins";
const usage =
  "usage: check-toolchain-pins.ts [--root <dir>] <declaration.yaml>";

type Format = "toml" | "json" | "yaml";
const FORMATS: Format[] = ["toml", "json", "yaml"];

/** A CI setup step: the action it uses and the input that holds the version. */
export interface Step {
  /** The action, without its `@ref`: `actions/setup-node`. */
  action: string;
  input: string;
  /** The input that names a version file instead, when the action has one. */
  fileInput?: string | undefined;
}

/** How one value is read from a file: a dotted path or a step, a pattern, or both. */
export interface Reader {
  /** The structured format the path reads, when there is a path. */
  format?: Format | undefined;
  path?: string | undefined;
  step?: Step | undefined;
  /** A regular expression whose first capture group is the version. */
  pattern?: RegExp | undefined;
}

export interface Source extends Reader {
  file: string;
}

export interface Site extends Reader {
  files: string[];
}

export interface Exception {
  file: string;
  value: string;
  reason: string;
  /** The structured format of the site path the exception is limited to. */
  format?: Format | undefined;
  /** The site path the exception is limited to; undefined excuses any site in the file. */
  path?: string | undefined;
}

export interface Tool {
  name: string;
  source: Source;
  sites: Site[];
  exceptions: Exception[];
}

/** A version read from one place in one file. */
export interface Pin {
  file: string;
  line?: number | undefined;
  /** The text or path the version was read from, for the finding. */
  where: string;
  /** The version, or undefined when the place carries none. */
  value: string | undefined;
  /** The pattern that did not read the value a path found, when that is why there is none. */
  unread?: string | undefined;
  /** The version file a setup step reads instead of a version, when it does. */
  versionFile?: string | undefined;
  /** The setup action that reads `versionFile`. */
  action?: string | undefined;
}

class DeclarationError extends Error {}

/** A site, source or usage failure the command line prints as one message. */
class PinCheckError extends Error {}

function malformed(what: string): never {
  throw new DeclarationError(`declaration: ${what}`);
}

const text = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.trim() === "")
    malformed(`${what} must be a non-empty string`);
  return v;
};

function step(raw: Record<string, unknown>, what: string): Step | undefined {
  if (raw.step === undefined) {
    if (raw.with !== undefined || raw["with-file"] !== undefined)
      malformed(`${what}.with names a step input, but there is no step`);
    return undefined;
  }
  const action = text(raw.step, `${what}.step`);
  if (action.includes("@"))
    malformed(`${what}.step names the action without its @ref`);
  return {
    action,
    input: text(raw.with, `${what}.with`),
    fileInput:
      raw["with-file"] === undefined
        ? undefined
        : text(raw["with-file"], `${what}.with-file`),
  };
}

const KINDS = [...FORMATS, "step"] as const;

function pattern(
  raw: Record<string, unknown>,
  what: string,
): RegExp | undefined {
  if (raw.pattern === undefined) return undefined;
  const source = text(raw.pattern, `${what}.pattern`);
  try {
    return new RegExp(source, "gm");
  } catch (error) {
    malformed(
      `${what}.pattern is not a regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function reader(raw: Record<string, unknown>, what: string): Reader {
  const kinds = KINDS;
  if (KINDS.filter((k) => raw[k] !== undefined).length > 1)
    malformed(`${what} names more than one of ${kinds.join(", ")}`);
  const format = FORMATS.find((f) => raw[f] !== undefined);
  const path =
    format === undefined ? undefined : text(raw[format], `${what}.${format}`);
  const steps = step(raw, what);
  const read = pattern(raw, what);
  if (format === undefined && steps === undefined && read === undefined)
    malformed(`${what} needs one of ${kinds.join(", ")} or a pattern`);
  return { format, path, step: steps, pattern: read };
}

function source(raw: unknown, what: string): Source {
  if (!isRecord(raw)) malformed(`${what} must be a map`);
  return { file: text(raw.file, `${what}.file`), ...reader(raw, what) };
}

function site(raw: unknown, what: string): Site {
  if (!isRecord(raw)) malformed(`${what} must be a map`);
  const files = Array.isArray(raw.files) ? raw.files : [raw.files];
  if (files.length === 0) malformed(`${what}.files is empty`);
  return {
    files: files.map((f, i) => text(f, `${what}.files[${i}]`)),
    ...reader(raw, what),
  };
}

const EXCEPTION_KEYS = ["file", "value", "reason", ...FORMATS];

function exception(raw: unknown, what: string): Exception {
  if (!isRecord(raw)) malformed(`${what} must be a map`);
  // An unknown key is most likely a misspelled path, and dropping it would
  // widen the exception to every site in the file.
  const unknown = Object.keys(raw).filter((k) => !EXCEPTION_KEYS.includes(k));
  if (unknown.length > 0)
    malformed(
      `${what} has unknown key(s) ${unknown.join(", ")}; it takes ${EXCEPTION_KEYS.join(", ")}`,
    );
  if (FORMATS.filter((f) => raw[f] !== undefined).length > 1)
    malformed(`${what} names more than one of ${FORMATS.join(", ")}`);
  const format = FORMATS.find((f) => raw[f] !== undefined);
  return {
    file: text(raw.file, `${what}.file`),
    value: text(raw.value, `${what}.value`),
    reason: text(raw.reason, `${what}.reason`),
    format,
    path:
      format === undefined ? undefined : text(raw[format], `${what}.${format}`),
  };
}

/** Where an exception applies, for a finding: its file, and its path when it names one. */
const excepted = (e: Exception) =>
  e.path === undefined ? e.file : `${e.file} (${e.format} path ${e.path})`;

function tool(name: string, raw: unknown): Tool {
  if (!isRecord(raw)) malformed(`tools.${name} must be a map`);
  if (!Array.isArray(raw.sites) || raw.sites.length === 0)
    malformed(`tools.${name}.sites must list at least one pin site`);
  const exceptions = raw.exceptions ?? [];
  if (!Array.isArray(exceptions))
    malformed(`tools.${name}.exceptions must be a list`);
  return {
    name,
    source: source(raw.source, `tools.${name}.source`),
    sites: raw.sites.map((s, i) => site(s, `tools.${name}.sites[${i}]`)),
    exceptions: exceptions.map((e, i) =>
      exception(e, `tools.${name}.exceptions[${i}]`),
    ),
  };
}

/** The declaration's tools; throw a DeclarationError on any malformation. */
export function parseDeclaration(content: string): Tool[] {
  let doc: unknown;
  try {
    doc = loadYaml(content);
  } catch (error) {
    malformed(
      `not YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(doc) || !isRecord(doc.tools)) malformed("has no `tools` map");
  const tools = doc.tools;
  const names = Object.keys(tools);
  if (names.length === 0) malformed("`tools` names no tool");
  return names.map((name) => tool(name, tools[name]));
}

/** The value at a dotted path, as a string; undefined when absent. */
function at(doc: unknown, path: string): string | undefined {
  let node = doc;
  for (const key of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  if (typeof node === "string") return node;
  if (typeof node === "number" && Number.isFinite(node)) return String(node);
  return undefined;
}

function parse(format: Format, content: string, file: string): unknown {
  try {
    if (format === "json") return JSON.parse(content);
    if (format === "toml") return Bun.TOML.parse(content);
    return loadYaml(content);
  } catch (error) {
    throw new PinCheckError(
      `${file} is not ${format.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const lineOf = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

/** A value that holds a version: an empty or blank one holds none. */
const version = (value: string | undefined): string | undefined =>
  value?.trim() ? value : undefined;

/** A path or step pin's value, read through the pattern beside it, if any. */
function throughPattern(reader: Reader, pin: Pin): Pin {
  if (reader.pattern === undefined || pin.value === undefined) return pin;
  reader.pattern.lastIndex = 0;
  const match = reader.pattern.exec(pin.value);
  const read: Pin = {
    ...pin,
    where: `${pin.where} (${pin.value})`,
    value: version(match?.[1]),
  };
  if (match === null) read.unread = reader.pattern.source;
  return read;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The steps of a workflow's jobs, or of a composite action. */
function stepLists(doc: unknown): unknown[][] {
  if (!isRecord(doc)) return [];
  const lists: unknown[] = [];
  if (isRecord(doc.jobs))
    for (const job of Object.values(doc.jobs))
      if (isRecord(job)) lists.push(job.steps);
  if (isRecord(doc.runs)) lists.push(doc.runs.steps);
  return lists.filter((l): l is unknown[] => Array.isArray(l));
}

const scalar = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : undefined;

/** The steps, in document order, whose `uses` names the action at any ref. */
function usingSteps(doc: unknown, action: string): Record<string, unknown>[] {
  const uses = (entry: unknown): entry is Record<string, unknown> =>
    isRecord(entry) &&
    typeof entry.uses === "string" &&
    (entry.uses.split("@")[0] ?? "").toLowerCase() === action.toLowerCase();
  return stepLists(doc).flatMap((list) => list.filter(uses));
}

/**
 * The line of each step's `uses:` in the text, searched in document order so
 * steps that use the same ref get successive lines; a line in a comment is
 * never one.
 */
function useLines(content: string, uses: string[]): (number | undefined)[] {
  let from = 0;
  return uses.map((use) => {
    const at = new RegExp(
      `^[ \\t-]*uses:\\s*["']?${escapeRegExp(use)}`,
      "m",
    ).exec(content.slice(from));
    if (at === null) return undefined;
    const index = from + at.index;
    from = index + at[0].length;
    return lineOf(content, index);
  });
}

/**
 * One step's pin: its version input or, only when that input holds no version,
 * the version file it reads instead. A setup action takes an explicit version
 * over a file, so a file beside a version is never the pin.
 */
function stepPin(
  step: Step,
  entry: Record<string, unknown>,
  file: string,
): Pin {
  const inputs = isRecord(entry.with) ? entry.with : {};
  const value = version(scalar(inputs[step.input]));
  return {
    file,
    where: `uses: ${String(entry.uses)}`,
    value,
    action: step.action,
    versionFile:
      step.fileInput === undefined || value !== undefined
        ? undefined
        : version(scalar(inputs[step.fileInput])),
  };
}

/** Every step in a parsed workflow that uses the action, as a pin. */
function stepPins(step: Step, content: string, file: string): Pin[] {
  const steps = usingSteps(parse("yaml", content, file), step.action);
  const lines = useLines(
    content,
    steps.map((entry) => String(entry.uses)),
  );
  return steps.map((entry, i) => ({
    ...stepPin(step, entry, file),
    line: lines[i],
  }));
}

/** A file's text; a file that is not there says so rather than failing a stat. */
function readText(path: string): string {
  if (!existsSync(path)) throw new PinCheckError("does not exist");
  return readRegularFile(path);
}

/** Every pin the reader finds in one file's content. */
export function readPins(reader: Reader, content: string, file: string): Pin[] {
  if (reader.format !== undefined && reader.path !== undefined) {
    const value = at(parse(reader.format, content, file), reader.path);
    const where = `${reader.format} path ${reader.path}`;
    if (value === undefined) return [];
    return [throughPattern(reader, { file, where, value: version(value) })];
  }
  if (reader.step !== undefined)
    return stepPins(reader.step, content, file).map((pin) =>
      throughPattern(reader, pin),
    );
  if (reader.pattern === undefined) return [];
  const pins: Pin[] = [];
  for (const match of content.matchAll(reader.pattern))
    pins.push({
      file,
      line: lineOf(content, match.index),
      where: match[0].trim(),
      value: version(match[1]),
    });
  return pins;
}

/** The files a site names, relative to the root and sorted; throw when a glob matches none. */
function siteFiles(root: string, site: Site): string[] {
  const found = new Set<string>();
  for (const glob of site.files) {
    const matched = [
      ...new Bun.Glob(glob).scanSync({ cwd: root, dot: true }),
    ].map((path) => path.replaceAll("\\", "/"));
    if (matched.length === 0)
      throw new PinCheckError(
        `no file matches ${glob}: the declaration names a pin site that is not there`,
      );
    for (const path of matched) found.add(path);
  }
  return [...found].sort();
}

function describe(reader: Reader): string {
  const path =
    reader.path !== undefined
      ? `${reader.format} path ${reader.path}`
      : reader.step !== undefined
        ? `step ${reader.step.action}`
        : "";
  const pattern =
    reader.pattern === undefined ? "" : `pattern ${reader.pattern.source}`;
  return [path, pattern].filter(Boolean).join(", ");
}

/** The source's value; throw when the file or the value is not there. */
export function readSource(root: string, tool: Tool): string {
  const { file } = tool.source;
  let content: string;
  try {
    content = readText(join(root, file));
  } catch (error) {
    throw new PinCheckError(
      `${file}, the source of ${tool.name}'s version, ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const [pin, ...more] = readPins(tool.source, content, file);
  if (pin === undefined || pin.value === undefined)
    throw new PinCheckError(
      `${file} holds no ${tool.name} version at ${describe(tool.source)}: the source is gone`,
    );
  if (more.length > 0)
    throw new PinCheckError(
      `${file} holds ${more.length + 1} ${tool.name} versions at ${describe(tool.source)}: a source has one`,
    );
  return pin.value;
}

interface Checked {
  findings: Finding[];
  pins: number;
  files: number;
}

/** What one tool's check carries across its sites. */
interface Scan {
  tool: Tool;
  expected: string;
  declaration: string;
  /** The exceptions a pin used, so an unused one can be reported. */
  excused: Set<Exception>;
  /** The source file's text, which a setup step may read in its place. */
  sourceText: string;
}

function readSiteFile(root: string, tool: Tool, file: string): string {
  try {
    return readText(join(root, file));
  } catch (error) {
    throw new PinCheckError(
      `${file}, a pin site of ${tool.name}, ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const normalPath = (path: string) => path.replace(/^(\.\/)+/, "");

/**
 * What a setup action reads from a version file, for the actions whose reader
 * this check carries: each mirrors the action's own source, file name and
 * parsing alike. Undefined is a file the action reads in a way this check
 * does not follow (`package.json`, `mise.toml`), so nothing confirms which
 * value it takes. An action not listed here is never taken to agree.
 */
function parsesAsTomlTable(content: string): boolean {
  try {
    return Object.keys(Bun.TOML.parse(content)).length > 0;
  } catch (error) {
    // A syntax error is the answer: the text is not TOML. Anything else is not.
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

const VERSION_FILE_READERS: Record<
  string,
  (base: string, content: string) => string | undefined
> = {
  // actions/setup-node, src/util.ts getNodeVersionFromFile: a JSON object is
  // read as a package.json, a TOML table as a mise.toml, any other text by a
  // pattern. Older releases skip the TOML step and the check accepts the
  // action at any ref, so it follows only text that no release reads as
  // structured: every release then takes the same value from it.
  "actions/setup-node": (_base, content) => {
    if (/^\s*[[{]/.test(content) || parsesAsTomlTable(content))
      return undefined;
    return (
      /^(?:node(js)?\s+)?v?(?<version>[^\s]+)$/m.exec(content)?.groups
        ?.version ?? content.trim()
    );
  },
  // oven-sh/setup-bun, src/utils.ts FILE_VERSION_READERS: chosen by base name;
  // any other name reads nothing.
  "oven-sh/setup-bun": (base, content) => {
    if (base === ".bun-version" || base === ".bumrc") return content.trim();
    if (base === ".tool-versions")
      return /^bun\s*(?<version>.*?)$/m.exec(content)?.groups?.version?.trim();
    return undefined;
  },
};

/** The finding for a step that reads its version from a file, or none when that file is the source's version file. */
function versionFileFinding(
  scan: Scan,
  pin: Pin,
  file: string,
): Finding | undefined {
  const { tool, expected } = scan;
  const named = normalPath(file) === normalPath(tool.source.file);
  const reader =
    pin.action === undefined
      ? undefined
      : VERSION_FILE_READERS[pin.action.toLowerCase()];
  if (named && reader === undefined)
    return {
      rule: RULE,
      file: pin.file,
      line: pin.line,
      problem: `${tool.name} is set up here from ${file} (${pin.where}), but this check does not know how ${pin.action} reads a version file, so it cannot confirm the action installs ${expected}.`,
      remedy: `Set the version input to ${expected}.`,
    };
  const read = named
    ? reader?.(basename(tool.source.file), scan.sourceText)
    : undefined;
  if (named && read === expected) return undefined;
  if (named && read !== undefined)
    return {
      rule: RULE,
      file: pin.file,
      line: pin.line,
      problem: `${tool.name} is set up here from ${file} (${pin.where}), from which ${pin.action} reads ${read}; ${tool.source.file} says ${expected} where this check reads it.`,
      remedy: `Keep the version alone in ${tool.source.file}, or set the version input to ${expected}.`,
    };
  if (named)
    return {
      rule: RULE,
      file: pin.file,
      line: pin.line,
      problem: `${tool.name} is set up here from ${file} (${pin.where}), a file holding more than the version this check reads at ${describe(tool.source)}; which value the action reads there is not something this check can confirm.`,
      remedy: `Set the version input to ${expected}, or keep the version in a file of its own that both read.`,
    };
  return {
    rule: RULE,
    file: pin.file,
    line: pin.line,
    problem: `${tool.name} is set up here from ${file} (${pin.where}), not from its source ${tool.source.file}, which says ${expected}.`,
    remedy: `Read the version from ${tool.source.file}, or set it to ${expected}.`,
  };
}

/** The finding for one pin, or none when it agrees or an exception excuses it. */
function pinFinding(scan: Scan, site: Site, pin: Pin): Finding | undefined {
  const { tool, expected, declaration } = scan;
  if (pin.value === undefined && pin.versionFile !== undefined)
    return versionFileFinding(scan, pin, pin.versionFile);
  if (pin.value === expected) return undefined;
  const exception = tool.exceptions.find(
    (e) =>
      e.file === pin.file &&
      e.value === pin.value &&
      (e.path === undefined ||
        (e.format === site.format && e.path === site.path)),
  );
  if (exception !== undefined) {
    scan.excused.add(exception);
    return undefined;
  }
  return {
    rule: RULE,
    file: pin.file,
    line: pin.line,
    problem:
      pin.unread !== undefined
        ? `${tool.name}'s pin site holds a value the pattern ${pin.unread} does not read (${pin.where}); ${tool.source.file} says ${expected}.`
        : pin.value === undefined
          ? `${tool.name} is set up here without a version (${pin.where}), so it floats to the tool's default; ${tool.source.file} says ${expected}.`
          : `${tool.name} is pinned to ${pin.value} here (${pin.where}); ${tool.source.file} says ${expected}.`,
    remedy: `Set it to ${expected}, or register the value with a reason under exceptions in ${declaration}.`,
  };
}

/** The findings for one site; `files` collects every file it read. */
function checkSite(
  root: string,
  scan: Scan,
  site: Site,
  files: Set<string>,
): { findings: Finding[]; pins: number } {
  const { tool, expected, declaration } = scan;
  const findings: Finding[] = [];
  const matched = siteFiles(root, site);
  const gone = (where: string[]): Finding => ({
    rule: RULE,
    file: where[0],
    problem: `${tool.name}'s pin is gone: ${describe(site)} matches nothing in ${where.length === 1 ? where[0] : `${where.length} files`}.`,
    remedy: `Restore the pin as ${expected}, or remove the site from ${declaration} if it no longer pins ${tool.name}.`,
  });
  // A path names one place in each file, so each file must hold it; a step or
  // a pattern scans files of which only some carry the pin.
  const everyFile = site.format !== undefined;
  let pins = 0;
  for (const file of matched) {
    files.add(file);
    const read = readPins(site, readSiteFile(root, tool, file), file);
    if (everyFile && read.length === 0) findings.push(gone([file]));
    for (const pin of read) {
      pins++;
      const finding = pinFinding(scan, site, pin);
      if (finding !== undefined) findings.push(finding);
    }
  }
  if (!everyFile && pins === 0) findings.push(gone(matched));
  return { findings, pins };
}

/** An exception that excuses nothing: the source holds its value, or no pin does. */
function exceptionFinding(scan: Scan, e: Exception): Finding | undefined {
  const { tool, expected, declaration, excused } = scan;
  if (e.value !== expected && excused.has(e)) return undefined;
  const problem =
    e.value === expected
      ? `The exception for ${excepted(e)} allows ${e.value}, which is ${tool.source.file}'s value now (${e.reason}).`
      : `The exception for ${excepted(e)} allows ${e.value}, but no ${tool.name} pin there holds it (${e.reason}).`;
  return {
    rule: RULE,
    file: declaration,
    problem,
    remedy: "Remove the exception: it excuses nothing.",
  };
}

/** The findings for one tool against its source's value. */
export function checkTool(
  root: string,
  tool: Tool,
  expected: string,
  declaration: string,
): Checked {
  const scan: Scan = {
    tool,
    expected,
    declaration,
    excused: new Set(),
    sourceText: readText(join(root, tool.source.file)),
  };
  const files = new Set<string>();
  const findings: Finding[] = [];
  let pins = 0;
  for (const site of tool.sites) {
    const checked = checkSite(root, scan, site, files);
    findings.push(...checked.findings);
    pins += checked.pins;
  }
  for (const e of tool.exceptions) {
    const finding = exceptionFinding(scan, e);
    if (finding !== undefined) findings.push(finding);
  }
  return { findings, pins, files: files.size };
}

interface Options {
  root: string;
  declaration: string;
}

function parseArgs(args: string[]): Options {
  let root = ".";
  let declaration: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--root") {
      const value = args[++i];
      if (value === undefined)
        throw new PinCheckError(`--root needs a directory\n${usage}`);
      root = value;
    } else if (arg.startsWith("--"))
      throw new PinCheckError(`unknown option ${arg}\n${usage}`);
    else if (declaration !== undefined)
      throw new PinCheckError(`more than one declaration\n${usage}`);
    else declaration = arg;
  }
  if (declaration === undefined) throw new PinCheckError(usage);
  return { root, declaration };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The declaration's tools; throw when it is missing, empty or malformed. */
function readTools(declaration: string): Tool[] {
  const content = readText(declaration);
  if (content.trim() === "")
    throw new DeclarationError("declaration: is empty");
  return parseDeclaration(content);
}

/** One tool's pins against its source, and the line that reports a pass. */
function checkOne(
  root: string,
  tool: Tool,
  label: string,
): { checked: Checked; line: string } {
  const expected = readSource(root, tool);
  const checked = checkTool(root, tool, expected, label);
  const excepted = tool.exceptions.length
    ? `, ${tool.exceptions.length} exception(s) registered`
    : "";
  return {
    checked,
    line: `OK — ${tool.name}: ${checked.pins} pin(s) equal ${tool.source.file}'s ${expected} (${checked.files} file(s) read${excepted})`,
  };
}

export function checkToolchainPins(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): number {
  const { root, declaration } = parseArgs(args);
  const label = repoPath(root, declaration) || declaration;
  let tools: Tool[];
  try {
    tools = readTools(declaration);
  } catch (error) {
    return couldNotCheck(RULE, `${label}: ${message(error)}`, env);
  }
  const findings: Finding[] = [];
  const lines: string[] = [];
  for (const tool of tools) {
    try {
      const { checked, line } = checkOne(root, tool, label);
      findings.push(...checked.findings);
      lines.push(line);
    } catch (error) {
      return couldNotCheck(RULE, message(error), env);
    }
  }
  if (findings.length > 0) {
    reportFindings(findings, env);
    console.error(
      `${RULE}: ${findings.length} finding(s) across ${tools.length} tool(s)`,
    );
    return 1;
  }
  for (const line of lines) console.log(line);
  return 0;
}

if (import.meta.main) cli(() => checkToolchainPins(process.argv.slice(2)));

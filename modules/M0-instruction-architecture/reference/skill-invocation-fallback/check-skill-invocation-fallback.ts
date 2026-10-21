#!/usr/bin/env bun
// Prose that names a skill by its slash command also says how to run it
// without one.
//
// `/<skill>` runs a skill only in a runtime that has slash commands and has
// discovered that skill. Every other runtime needs a fallback beside the
// invocation: the runtime's own discovery directory (`.agents/skills/`), or
// the skill's `SKILL.md` read directly. This check finds every bare
// invocation of a named skill and fails the ones with no fallback for that
// skill within --window lines on either side.
//
// The file is read as a CommonMark renderer (`Bun.markdown`) shows it,
// rendered once: invocations and links are both read from that render, line
// by line, so code, containers, reference definitions, escapes and character
// references are what the renderer makes of them, and the window is counted
// in the rendered lines (a link reference definition or an HTML comment
// shows none). A finding names the invocation's line in the file.
//
// A bare invocation is `/<skill>` in the rendered text, preceded by the start
// of a line, a blank, a quote, the edge of code, emphasis, strikethrough, a
// link's text or a table cell, or an opening parenthesis or bracket, and
// followed by a character that cannot continue a skill name, or by the end of
// the line. Not an invocation: a path (`skills/<skill>/SKILL.md`, `/<skill>/`,
// `/<skill>.md`), a link's destination, and a plugin-namespaced command
// (`/<plugin>:<skill>`), whose fallback, the installed skill's SKILL.md, lies
// outside the files this check reads. Code is checked like prose: a command
// in an example is still an instruction, and comment delimiters inside code
// are code. An HTML comment is not read at all.
//
// A fallback names the skill it falls back to: a link whose target, resolved
// from the file's directory, is `<skill>/SKILL.md`; the discovery path
// `.agents/skills/<skill>`; or a link to an interop document (a target
// holding `interop`), the one shared marker, since such a document covers
// every skill. A link is one the render holds, counted on the line where it
// is used, wherever its definition stands; an image is not one, nor link
// syntax inside code or an HTML comment.
//
// A file is exempted as a whole only when all three hold: it is named with
// --exempt, it opens with a generated-file banner (an HTML comment starting
// in its first 5 lines and matching --banner), and that banner carries the
// --file-marker text. A marker alone would be an exemption a file grants
// itself; the allowlist alone would hide a hand-written file. An --exempt
// file that does not carry both is a finding, and its lines are checked. An
// --exempt entry that does not exist, or is not among the files checked, is
// a usage error: a stale list would otherwise pass unnoticed.
//
// Scope: the files named, and the Markdown files (`*.md`) under each
// directory named, `.git` and `node_modules` left out. A symbolic link to a
// directory is followed (a skill mirror is one link per skill), each real
// directory once. A directory named that holds no Markdown file is a usage
// error, so a wrong scan root cannot pass. Skill names come from --skill, or
// from --skills <dir>: each subdirectory holding a SKILL.md.
//
// Usage: bun check-skill-invocation-fallback.ts
//          (--skill <name> | --skills <dir>)... [--marker <regex>]
//          [--window <lines>] [--exempt <file>]... [--banner <regex>]
//          [--file-marker <text>] <path>...
//   --marker       a fallback marker, a regular expression tested on the
//                  window's rendered text, each link followed by its
//                  destination in angle brackets; `{skill}` in it stands for
//                  the invoked skill's name; default: the fallbacks above
//   --window       rendered lines on either side of the invocation searched
//                  for a marker; default 10
//   --banner       a generated-file banner, matched without case; default
//                  `generated|do not edit`
//   --file-marker  the text that, inside the banner, asks for the file-level
//                  exemption; default `skill-invocation-fallback: exempt-file`
// Exit: 0 every invocation names a fallback; 1 a finding; 2 a usage error, a
// path or skills directory that does not exist, a directory with no Markdown,
// an --exempt entry outside the scan, or no skill to check.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { readRegularFile } from "../../../../lib/files.ts";
import { type Finding, reportFindings } from "../../../../lib/findings.ts";
import { unescapeDestination } from "../../../../lib/markdown-links.ts";

/** An input the check cannot run on; the `cli` boundary reports it as exit 2. */
class UsageError extends Error {}

const RULE = "skill-invocation-fallback";
const NAME = /^[A-Za-z0-9_-]+$/;
const SKIPPED = [".git", "node_modules"];
const DEFAULT_WINDOW = 10;
const DEFAULT_BANNER = "generated|do not edit";
const DEFAULT_FILE_MARKER = "skill-invocation-fallback: exempt-file";
const BANNER_LINES = 5;

const USAGE =
  "usage: check-skill-invocation-fallback.ts (--skill <name> | --skills <dir>)... [--marker <regex>] [--window <lines>] [--exempt <file>]... [--banner <regex>] [--file-marker <text>] <path>...";

type Options = {
  skills: string[];
  /** A replacement marker, with `{skill}` still in it; undefined: the default. */
  marker: string | undefined;
  window: number;
  exempt: Set<string>;
  banner: RegExp;
  fileMarker: string;
  paths: string[];
};

function regex(source: string, flag: string, flags = ""): RegExp {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${flag}: ${message}\n${USAGE}`);
  }
}

/** The skills in a directory: each subdirectory that holds a SKILL.md. */
function skillsIn(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new UsageError(`--skills: not a directory: ${dir}`);
  return readdirSync(dir)
    .filter((name) =>
      statSync(join(dir, name, "SKILL.md"), {
        throwIfNoEntry: false,
      })?.isFile(),
    )
    .sort();
}

function parse(argv: string[]): Options {
  const { values, positionals } = strictOptions(
    {
      args: argv,
      options: {
        skill: { type: "string", multiple: true },
        skills: { type: "string", multiple: true },
        marker: { type: "string" },
        window: { type: "string" },
        exempt: { type: "string", multiple: true },
        banner: { type: "string" },
        "file-marker": { type: "string" },
      },
      allowPositionals: true,
    },
    USAGE,
  );
  const named = values.skill ?? [];
  for (const name of named)
    if (!NAME.test(name))
      throw new UsageError(`--skill: not a skill name: ${name}\n${USAGE}`);
  const skills = [
    ...new Set([...named, ...(values.skills ?? []).flatMap(skillsIn)]),
  ];
  if (!skills.length) throw new UsageError(`no skill to check\n${USAGE}`);
  if (!positionals.length) throw new UsageError(`no path to scan\n${USAGE}`);
  const window = Number(values.window ?? DEFAULT_WINDOW);
  if (values.window?.trim() === "" || !Number.isInteger(window) || window < 0)
    throw new UsageError(
      `--window: not a whole number of lines: ${values.window}\n${USAGE}`,
    );
  const fileMarker = values["file-marker"] ?? DEFAULT_FILE_MARKER;
  if (!fileMarker.trim())
    throw new UsageError(`--file-marker: empty\n${USAGE}`);
  if (values.marker !== undefined)
    regex(values.marker.replaceAll("{skill}", "x"), "--marker");
  return {
    skills,
    marker: values.marker,
    window,
    exempt: new Set((values.exempt ?? []).map((file) => resolve(file))),
    banner: regex(values.banner ?? DEFAULT_BANNER, "--banner", "i"),
    fileMarker,
    paths: positionals,
  };
}

/**
 * The Markdown under a directory, following links to directories (a skill
 * mirror is one link per skill) and reading each real directory once.
 */
function markdownUnder(root: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  function visit(dir: string): void {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const name of readdirSync(dir).sort()) {
      if (SKIPPED.includes(name)) continue;
      const path = join(dir, name);
      const target = statSync(path, { throwIfNoEntry: false });
      if (target?.isDirectory()) visit(path);
      else if (target?.isFile() && name.endsWith(".md")) files.push(path);
    }
  }
  visit(root);
  return files;
}

/** The files to read: each file named, and the Markdown under each directory. */
function filesUnder(paths: string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) throw new UsageError(`no such path: ${path}`);
    if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
      const found = markdownUnder(path);
      if (!found.length)
        throw new UsageError(`no Markdown file under: ${path}\n${USAGE}`);
      files.push(...found);
    } else files.push(path);
  }
  return [...new Set(files)];
}

/** Each --exempt entry exists and is among the files checked. */
function checkExemptions(exempt: Set<string>, files: string[]): void {
  const scanned = new Set(files.map((file) => resolve(file)));
  for (const file of exempt) {
    if (!lstatSync(file, { throwIfNoEntry: false }))
      throw new UsageError(`--exempt: no such file: ${file}\n${USAGE}`);
    if (!scanned.has(file))
      throw new UsageError(
        `--exempt: not among the files checked: ${file}\n${USAGE}`,
      );
  }
}

const escapeRegex = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A bare `/<skill>` in rendered text: after the line start, a blank, a quote,
 * an inline element's edge, a delimiter the render kept as text, or an opening
 * parenthesis or bracket; not continued by a name character, a slash, underscores that
 * run on into a name (ones that do not close emphasis, `_` or `__`), or a
 * colon or dot that runs on into a name (a namespace or a file name).
 */
function invocationPattern(skills: string[]): RegExp {
  const names = skills.map(escapeRegex).join("|");
  return new RegExp(
    `(?<=^|[\\s\`"'*_~|(\\[${EDGE}])/(${names})(?![A-Za-z0-9/-]|_+[A-Za-z0-9-]|[:.][A-Za-z0-9_-])`,
    "g",
  );
}

/** The path of a link target, without its fragment, query or origin. */
function targetPath(target: string): string {
  const bare = target.replace(/[#?].*$/, "");
  try {
    return new URL(bare).pathname;
  } catch {
    return bare;
  }
}

/** Whether a link target is a fallback for `skill`, read from `dir`. */
function fallbackTarget(target: string, skill: string, dir: string): boolean {
  const path = targetPath(target);
  if (path.includes("interop")) return true;
  const full = path.startsWith("/") ? path : posix.join(dir, path);
  return posix.normalize(full).endsWith(`/${skill}/SKILL.md`);
}

/**
 * The characters the reading writes into a render: around a text node, at an
 * inline element's edge, and around a link's number. The file's own are
 * replaced before it is rendered, so none is ever read as one of these.
 */
const TEXT_OPEN = "\uE000";
const TEXT_CLOSE = "\uE001";
const EDGE = "\uE002";
const LINK_OPEN = "\uE003";
const LINK_CLOSE = "\uE004";
const RESERVED = /[\uE000-\uE004]/g;
const TEXT = /\uE000([^\uE001]*)\uE001/g;
const LINK = /\uE003(\d+)\uE004/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/** The text with each HTML comment blanked out, its line breaks kept. */
const uncommented = (text: string) =>
  text.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, ""));

/** Each text node's own text, `keep` applied to it. */
const unwrap = (
  text: string,
  keep: (node: string) => string = (node) => node,
) => text.replace(TEXT, (_, node: string) => keep(node));

/**
 * A file as its renderer shows it, line by line: `prose` is what invocations
 * are read from, `shown` is what a marker is tested on (each link followed by
 * its destination in angle brackets), and `links` holds each line's link
 * destinations.
 */
interface Reading {
  prose: string[];
  shown: string[];
  links: string[][];
}

/**
 * The file rendered once (`Bun.markdown`), so code, containers, reference
 * definitions, escapes and character references are read as a renderer reads
 * them. Every block ends its own line, so the lines are the rendered text's.
 * An HTML comment shows nothing: an HTML block has its comments removed, and
 * inline HTML that is a whole comment is dropped; the same text inside code
 * stays, since there it is shown.
 */
function read(markdown: string): Reading {
  const destinations: string[] = [];
  const edged = (children: string | undefined) =>
    `${EDGE}${children ?? ""}${EDGE}`;
  const block = (children: string | undefined) => `${children ?? ""}\n\n`;
  const own = (children: string | undefined) => children ?? "";
  const callbacks = {
    text: (children: string | undefined) =>
      `${TEXT_OPEN}${children ?? ""}${TEXT_CLOSE}`,
    paragraph: block,
    heading: block,
    hr: () => "\n\n",
    code: (children: string | undefined) => {
      const code = unwrap(children ?? "");
      return `${code}${code.endsWith("\n") ? "" : "\n"}\n`;
    },
    html: (children: string | undefined) =>
      `${uncommented(unwrap(children ?? ""))}\n`,
    codespan: (children: string | undefined) => edged(unwrap(children ?? "")),
    strong: edged,
    emphasis: edged,
    strikethrough: edged,
    th: edged,
    td: edged,
    tr: (children: string | undefined) => `${children ?? ""}\n`,
    table: block,
    listItem: (children: string | undefined) => {
      const item = children ?? "";
      return item.endsWith("\n") ? item : `${item}\n`;
    },
    list: own,
    blockquote: own,
    thead: own,
    tbody: own,
    link: (children: string | undefined, meta: { href?: unknown }) => {
      if (typeof meta?.href !== "string") return edged(children);
      destinations.push(unescapeDestination(meta.href));
      return `${edged(children)}${LINK_OPEN}${destinations.length - 1}${LINK_CLOSE}`;
    },
    image: own,
  };
  const rendered = unwrap(
    Bun.markdown.render(
      markdown.replace(/\r\n?/g, "\n").replace(RESERVED, "\uFFFD"),
      callbacks as unknown as Parameters<typeof Bun.markdown.render>[1],
    ),
    (node) =>
      /^<!--[\s\S]*-->$/.test(node) ? node.replace(/[^\n]/g, "") : node,
  );
  const lines = rendered.split("\n");
  return {
    prose: lines.map((line) => line.replace(LINK, "")),
    shown: lines.map((line) =>
      line
        .replace(LINK, (_, id: string) => ` <${destinations[Number(id)]}>`)
        .replaceAll(EDGE, ""),
    ),
    links: lines.map((line) =>
      [...line.matchAll(LINK)].map(([, id]) => destinations[Number(id)] ?? ""),
    ),
  };
}

/** The skill of each invocation in `prose`, with its 0-based line. */
function invocations(
  prose: string[],
  pattern: RegExp,
): { skill: string; line: number }[] {
  return prose.flatMap((text, line) =>
    [...text.matchAll(pattern)].map((match) => ({
      skill: match[1] ?? "",
      line,
    })),
  );
}

/**
 * The 1-based source line of the `nth` invocation of `skill` (0-based): the
 * shortest leading part of the file whose render already holds it. Used for
 * the report only; the window is measured in the rendered lines.
 */
function sourceLine(
  lines: string[],
  pattern: RegExp,
  skill: string,
  nth: number,
): number {
  const holds = (count: number) =>
    invocations(read(lines.slice(0, count).join("\n")).prose, pattern).filter(
      (found) => found.skill === skill,
    ).length > nth;
  let low = 1;
  let high = lines.length;
  if (!holds(high)) return 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (holds(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Whether the rendered lines `from`..`to` (0-based, inclusive) name a
 * fallback for `skill`.
 */
function namesFallback(
  reading: Reading,
  from: number,
  to: number,
  skill: string,
  dir: string,
  options: Options,
): boolean {
  const around = reading.shown.slice(from, to + 1).join("\n");
  if (options.marker !== undefined)
    return regex(
      options.marker.replaceAll("{skill}", escapeRegex(skill)),
      "--marker",
    ).test(around);
  const name = escapeRegex(skill);
  if (
    new RegExp(
      `(?<![A-Za-z0-9_.-])\\.agents/skills/${name}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`,
    ).test(around)
  )
    return true;
  return reading.links
    .slice(from, to + 1)
    .some((targets) =>
      targets.some((target) => fallbackTarget(target, skill, dir)),
    );
}

/** The banner: an HTML comment that opens in the file's first lines. */
function banner(lines: string[]): string | undefined {
  const start = lines
    .slice(0, BANNER_LINES)
    .findIndex((line) => line.includes("<!--"));
  if (start < 0) return undefined;
  const text = lines.slice(start).join("\n");
  const from = text.indexOf("<!--");
  const to = text.indexOf("-->", from);
  return to < 0 ? undefined : text.slice(from, to + 3);
}

function checkFile(file: string, options: Options): Finding[] {
  const shown = relative(process.cwd(), file).replaceAll("\\", "/") || file;
  const text = readRegularFile(file);
  const lines = text.split(/\r?\n/);
  const dir = resolve(dirname(file)).replaceAll("\\", "/");
  const findings: Finding[] = [];
  if (options.exempt.has(resolve(file))) {
    const head = banner(lines);
    if (
      head !== undefined &&
      options.banner.test(head) &&
      head.includes(options.fileMarker)
    )
      return [];
    findings.push({
      rule: RULE,
      file: shown,
      line: 1,
      problem: `on the exemption list, but it does not open with a generated-file banner carrying "${options.fileMarker}", so its lines are checked`,
      remedy:
        "exempt only a generated file: give its generator a banner that carries the marker, or take the file off the list",
    });
  }
  const pattern = invocationPattern(options.skills);
  const reading = read(text);
  const seen = new Map<string, number>();
  for (const { skill, line } of invocations(reading.prose, pattern)) {
    const nth = seen.get(skill) ?? 0;
    seen.set(skill, nth + 1);
    const from = Math.max(0, line - options.window);
    const to = line + options.window;
    if (namesFallback(reading, from, to, skill, dir, options)) continue;
    findings.push({
      rule: RULE,
      file: shown,
      line: sourceLine(lines, pattern, skill, nth),
      problem: `/${skill} names no fallback within ${options.window} lines`,
      remedy: `beside the slash command, link ${skill}/SKILL.md (or name .agents/skills/${skill}/, or link the interop document), so a runtime without /${skill} can still run it`,
    });
  }
  return findings;
}

export function checkSkillInvocationFallback(argv: string[]): number {
  const options = parse(argv);
  const files = filesUnder(options.paths);
  checkExemptions(options.exempt, files);
  const findings = files.flatMap((file) => checkFile(file, options));
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `Skill invocation fallback: ${files.length} file(s) checked for ${options.skills.length} skill(s); every slash command names a fallback`,
  );
  return 0;
}

if (import.meta.main)
  cli(() => checkSkillInvocationFallback(process.argv.slice(2)));

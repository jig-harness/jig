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
// shows none). The text is read as shown: inline formatting adds nothing to
// it, table cells are set off by blanks, raw HTML shows only the text between
// its tags, and an image only its description. A finding names the
// invocation's line in the file, placed by that same render.
//
// A bare invocation is `/<skill>` in the rendered text, preceded by the start
// of a line, a blank, a quote, a delimiter the render kept as text, or an
// opening parenthesis or bracket, and followed by a character that cannot
// continue a skill name, or by the end of the line. Not an invocation: a path
// (`skills/<skill>/SKILL.md`, `/<skill>/`, `/<skill>.md`), a link's
// destination, and a plugin-namespaced command (`/<plugin>:<skill>`), whose
// fallback, the installed skill's SKILL.md, lies outside the files this check
// reads. Code is checked like prose: a command in an example is still an
// instruction, and comment delimiters inside code are code. An HTML comment
// is not read at all.
//
// A fallback names the skill it falls back to: a link whose target, resolved
// from the file's directory, is `<skill>/SKILL.md`; the discovery path
// `.agents/skills/<skill>`; or a link to an interop document (a target
// holding `interop`), the one shared marker, since such a document covers
// every skill. A link is one the render holds, counted on the line where it
// is used, wherever its definition stands; an image is not one, nor a link
// inside an image's description, nor link syntax inside code, an HTML
// comment or an HTML tag.
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

/** The skills named with --skill and found under each --skills directory. */
function skillNames(named: string[], dirs: string[]): string[] {
  for (const name of named)
    if (!NAME.test(name))
      throw new UsageError(`--skill: not a skill name: ${name}\n${USAGE}`);
  const skills = [...new Set([...named, ...dirs.flatMap(skillsIn)])];
  if (!skills.length) throw new UsageError(`no skill to check\n${USAGE}`);
  return skills;
}

/** The --window value: a whole number of lines. */
function windowOf(value: string | undefined): number {
  const window = Number(value ?? DEFAULT_WINDOW);
  if (value?.trim() === "" || !Number.isInteger(window) || window < 0)
    throw new UsageError(
      `--window: not a whole number of lines: ${value}\n${USAGE}`,
    );
  return window;
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
  const skills = skillNames(values.skill ?? [], values.skills ?? []);
  if (!positionals.length) throw new UsageError(`no path to scan\n${USAGE}`);
  const window = windowOf(values.window);
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
 * a delimiter the render kept as text, or an opening parenthesis or bracket;
 * not continued by a name character, a slash, underscores that run on into a
 * name (ones that do not close emphasis, `_` or `__`), or a colon or dot that
 * runs on into a name (a namespace or a file name).
 */
function invocationPattern(skills: string[]): RegExp {
  const names = skills.map(escapeRegex).join("|");
  return new RegExp(
    `(?<=^|[\\s\`"'*_~|(\\[])/(${names})(?![A-Za-z0-9/-]|_+[A-Za-z0-9-]|[:.][A-Za-z0-9_-])`,
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
 * The characters the reading writes into a render: around a text node's
 * number and around a link's number. The file's own are replaced before it
 * is rendered, so none is ever read as one of these.
 */
const NODE_OPEN = "";
const NODE_CLOSE = "";
const LINK_OPEN = "";
const LINK_CLOSE = "";
const RESERVED = /[-]/g;
const NODE = /(\d+)/g;
const LINK = /(\d+)/g;
const PIECE = /(\d+)|(\d+)|[^]+/g;
/** Raw HTML: a tag, a comment, a processing instruction or a declaration. */
const TAG =
  /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>/g;
const WHOLE_TAG = new RegExp(`^(?:${TAG.source})$`);
/** A character reference, which the renderer shows as a text node of its own. */
const REFERENCE =
  /&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;

/** Text with, for each of its characters, its offset in the file. */
interface Placed {
  text: string;
  origin: number[];
}

/** `placed` with the characters `hidden` matches removed, line breaks kept. */
function without(placed: Placed, hidden: RegExp): Placed {
  const out: Placed = { text: "", origin: [] };
  let at = 0;
  const keep = (to: number, breaksOnly: boolean) => {
    for (; at < to; at++) {
      const char = placed.text[at] ?? "";
      if (breaksOnly && char !== "\n") continue;
      out.text += char;
      out.origin.push(placed.origin[at] ?? 0);
    }
  };
  for (const match of placed.text.matchAll(new RegExp(hidden.source, "g"))) {
    keep(match.index, false);
    keep(match.index + match[0].length, true);
  }
  keep(placed.text.length, false);
  return out;
}

/**
 * A file as its renderer shows it, line by line: `prose` is what invocations
 * are read from, `origin` gives each of its characters' offset in the file,
 * `shown` is what a marker is tested on (each link followed by its
 * destination in angle brackets), and `links` holds each line's link
 * destinations.
 */
interface Reading {
  prose: string[];
  origin: number[][];
  shown: string[];
  links: string[][];
}

/**
 * Places text nodes in the file in the order the render walks them: each is
 * searched for from where the last one ended. A node of one or two characters
 * may be a character reference the renderer decoded, so the nearer of the
 * text and the next reference is taken.
 */
class Locator {
  private cursor = 0;
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  /** Each character's offset in the file, for `text`, the next text node. */
  place(text: string): number[] {
    const origin: number[] = [];
    text.split("\n").forEach((part, line) => {
      const start = this.find(part);
      if (line) origin.push(start);
      for (let i = 0; i < part.length; i++) origin.push(start + i);
    });
    return origin;
  }

  private find(part: string): number {
    if (!part) return this.cursor;
    const at = this.source.indexOf(part, this.cursor);
    const reference = part.length <= 2 ? this.nextReference() : undefined;
    if (reference && (at < 0 || reference.index < at)) {
      this.cursor = reference.index + reference[0].length;
      return reference.index;
    }
    if (at < 0) return this.cursor;
    this.cursor = at + part.length;
    return at;
  }

  private nextReference(): RegExpExecArray | null {
    REFERENCE.lastIndex = this.cursor;
    return REFERENCE.exec(this.source);
  }
}

type Node = Placed & { shown: boolean };

/**
 * The render of `source`, each text node written as its number in `nodes`
 * and each link's destination as its number in `destinations`.
 */
function render(source: string): {
  rendered: string;
  nodes: Node[];
  destinations: string[];
} {
  const nodes: Node[] = [];
  const destinations: string[] = [];
  const locator = new Locator(source);
  const node = (placed: Placed, shown: boolean) => {
    nodes.push({ ...placed, shown });
    return `${NODE_OPEN}${nodes.length - 1}${NODE_CLOSE}`;
  };
  /** The text nodes in `children`, joined. */
  const joined = (children: string | undefined): Placed => {
    const out: Placed = { text: "", origin: [] };
    for (const [, id] of (children ?? "").matchAll(NODE)) {
      const found = nodes[Number(id)];
      if (!found) continue;
      out.text += found.text;
      out.origin.push(...found.origin);
    }
    return out;
  };
  const block = (children: string | undefined) => `${children ?? ""}\n\n`;
  const own = (children: string | undefined) => children ?? "";
  const cell = (children: string | undefined) => ` ${children ?? ""} `;
  const callbacks = {
    text: (children: string | undefined) => {
      const text = children ?? "";
      return node({ text, origin: locator.place(text) }, false);
    },
    paragraph: block,
    heading: block,
    hr: () => "\n\n",
    code: (children: string | undefined) => {
      const code = joined(children);
      return `${node(code, true)}${code.text.endsWith("\n") ? "" : "\n"}\n`;
    },
    html: (children: string | undefined) =>
      `${node(without(joined(children), TAG), true)}\n`,
    codespan: (children: string | undefined) => node(joined(children), true),
    strong: own,
    emphasis: own,
    strikethrough: own,
    th: cell,
    td: cell,
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
      if (typeof meta?.href !== "string") return own(children);
      destinations.push(unescapeDestination(meta.href));
      return `${children ?? ""}${LINK_OPEN}${destinations.length - 1}${LINK_CLOSE}`;
    },
    image: (children: string | undefined) => (children ?? "").replace(LINK, ""),
  };
  const rendered = Bun.markdown.render(
    source,
    callbacks as unknown as Parameters<typeof Bun.markdown.render>[1],
  );
  return { rendered, nodes, destinations };
}

/** What a text node shows: raw inline HTML shows only its line breaks. */
const visible = (node: Node): Placed =>
  node.shown || !WHOLE_TAG.test(node.text) ? node : without(node, /[\s\S]+/);

/** A reading built a character at a time. */
class Lines {
  readonly reading: Reading = {
    prose: [""],
    origin: [[]],
    shown: [""],
    links: [[]],
  };
  private last = 0;

  /** `char`, from `at` in the file (default: where the last one was). */
  add(char: string, at = this.last): void {
    const { prose, origin, shown, links } = this.reading;
    if (char === "\n") {
      prose.push("");
      origin.push([]);
      shown.push("");
      links.push([]);
      return;
    }
    const line = prose.length - 1;
    prose[line] += char;
    origin[line]?.push(at);
    shown[line] += char;
    this.last = at;
  }

  addPlaced(placed: Placed): void {
    for (let i = 0; i < placed.text.length; i++)
      this.add(placed.text[i] ?? "", placed.origin[i]);
  }

  addLink(target: string): void {
    const line = this.reading.shown.length - 1;
    this.reading.shown[line] += ` <${target}>`;
    this.reading.links[line]?.push(target);
  }
}

/** The rendered text split into the reading's lines. */
function assemble(
  rendered: string,
  nodes: Node[],
  destinations: string[],
): Reading {
  const lines = new Lines();
  for (const [piece, id, link] of rendered.matchAll(PIECE)) {
    const found = id === undefined ? undefined : nodes[Number(id)];
    if (link !== undefined) lines.addLink(destinations[Number(link)] ?? "");
    else if (found) lines.addPlaced(visible(found));
    else if (id === undefined) for (const char of piece) lines.add(char);
  }
  return lines.reading;
}

/**
 * The file rendered once (`Bun.markdown`), so code, containers, reference
 * definitions, escapes and character references are read as a renderer reads
 * them. Every block ends its own line, so the lines are the rendered text's.
 * What the reader sees is contiguous: inline formatting adds nothing to the
 * text, a table cell is set off by blanks, raw HTML shows only the text
 * between its tags (no tag, attribute or comment), and an image shows its
 * description as plain text, links inside it included. Code shows as it
 * stands. Each text node is placed in the file as the render walks it, so a
 * character's line in the file comes from this same render.
 */
function read(markdown: string): Reading {
  const source = markdown.replace(/\r\n?/g, "\n").replace(RESERVED, "�");
  const { rendered, nodes, destinations } = render(source);
  return assemble(rendered, nodes, destinations);
}

/** The skill of each invocation in `prose`, with its 0-based line and column. */
function invocations(
  prose: string[],
  pattern: RegExp,
): { skill: string; line: number; column: number }[] {
  return prose.flatMap((text, line) =>
    [...text.matchAll(pattern)].map((match) => ({
      skill: match[1] ?? "",
      line,
      column: match.index,
    })),
  );
}

/** The 1-based line of the file at each offset, from its line starts. */
function lineAt(source: string): (offset: number) => number {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1))
    starts.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
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
  const lineOf = lineAt(text.replace(/\r\n?/g, "\n"));
  for (const { skill, line, column } of invocations(reading.prose, pattern)) {
    const from = Math.max(0, line - options.window);
    const to = line + options.window;
    if (namesFallback(reading, from, to, skill, dir, options)) continue;
    findings.push({
      rule: RULE,
      file: shown,
      line: lineOf(reading.origin[line]?.[column] ?? 0),
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

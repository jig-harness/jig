// Consumer actions: what a change asks of the repositories that use the
// released artifact, declared in the change-note entry that describes it.
// After the entry's description, `**Consumer action:**` names a strength, the
// levels it acts at and an instruction, optionally followed by
// `**Detect:**` and the hints that tell a repository it is affected:
//
//   - **Breaking:** A stopped drive is re-armed by the dispatcher.
//     **Consumer action:** required at instructions, machine. Remove the
//     manual restart step. **Detect:** `text:restart the drive`.
//
// `**Consumer action:** none.` says the entry asks nothing, and
// `**Consumer action:** retracts <id>.` withdraws an action an earlier
// release declared. This file reads and validates one entry's declaration,
// computes an action's id, and holds the rules that span a release's notes;
// consumer-actions-record.ts derives the record a release ships from the
// changelog. Failures are values (ADR-0012): a malformed declaration is a
// failure with its reason, never a throw.
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { codeSpans } from "./markdown-blocks.ts";

/** How strongly an action asks: the repository is wrong until it acts, or better for acting. */
export const STRENGTHS = ["required", "advised"] as const;
export type Strength = (typeof STRENGTHS)[number];

/** Where a consumer acts, in the order an id lists them. */
export const LEVELS = ["machine", "configuration", "instructions"] as const;
export type Level = (typeof LEVELS)[number];

/** The kinds of hint a `**Detect:**` list holds. */
export const HINT_KINDS = ["config", "text", "file", "plugin-source"] as const;
export type HintKind = (typeof HINT_KINDS)[number];

/** The kinds of plugin source a `plugin-source:` hint names. */
export const PLUGIN_SOURCES = ["old", "path", "project-scope"] as const;

/** The longest instruction, in characters, after whitespace is collapsed. */
export const INSTRUCTION_MAX = 400;

/** One hint: its kind and value; a `config:` hint also says whether the key must be absent. */
export interface Hint {
  kind: HintKind;
  value: string;
  /** `config:` only: the repository is affected when the key is absent (`config:!key`). */
  absent?: boolean;
}

/** An action a change asks of a consumer. */
export interface Action {
  kind: "action";
  strength: Strength;
  /** Distinct, in `LEVELS` order. */
  levels: Level[];
  /** Plain language, whitespace collapsed. */
  instruction: string;
  hints: Hint[];
}

/** What an entry's `**Consumer action:**` declares. */
export type Declaration =
  | Action
  | { kind: "none" }
  | { kind: "retracts"; id: string };

/** An entry that carries a declaration. */
export interface Declared {
  /** The entry's text before the declaration, list marker dropped and whitespace collapsed. */
  description: string;
  declaration: Declaration;
  /** The declaration exactly as written, from its marker to the entry's end. */
  written: string;
}

/** The markers, as written in prose; one after an odd run of backslashes (`\\**`) is escaped text. */
const UNESCAPED = String.raw`(?<=(?:^|[^\\])(?:\\\\)*)`;
const MARKER = new RegExp(`${UNESCAPED}\\*\\*Consumer\\s+action:\\*\\*`, "g");
const DETECT = new RegExp(`${UNESCAPED}\\*\\*Detect:\\*\\*`, "g");
const BREAKING = new RegExp(`${UNESCAPED}\\*\\*breaking[:.]?\\*\\*`, "i");

/**
 * A marker nearly written: the words in bold, but in another case, with the
 * colon outside the emphasis or with underscores. Read only where
 * `changelog.consumer_actions` is on.
 */
const NEAR_MARKER =
  /(\*\*|__)\s*consumer[\s_-]*actions?\s*(?::\s*(\*\*|__)|(\*\*|__)\s*:)/gi;

/**
 * A marker written with single emphasis or the colon outside it, followed
 * by what a declaration says next (`**Consumer action** required at …`,
 * `none.`, `retracts …`), unescaped: an ordinary bold term in prose does not
 * read that way.
 */
const NEAR_DECLARATION = new RegExp(
  `${UNESCAPED}(\\*{1,2}|_{1,2})\\s*consumer[\\s_-]*actions?\\s*:?\\s*\\1\\s*:?\\s+(?:(?:required|advised)\\s+at\\s+\\S|none(?:\\.|\\s*$)|retracts\\s+\\S)`,
  "gi",
);

/** An action's id: a released version, `#` and eight hexadecimal digits. */
export const ACTION_ID = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?#[0-9a-f]{8}$/;

/** A configuration key in dotted form, optionally after `!`. */
const CONFIG_KEY = /^(!?)([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The entry without its list marker. */
const unlisted = (entry: string): string => entry.replace(/^\s*[-*]\s+/, "");

/** Where `marker` matches in `text`'s prose, outside its code spans: each match's start and end. */
function proseMatches(
  text: string,
  marker: RegExp,
): { at: number; end: number }[] {
  const found: { at: number; end: number }[] = [];
  let at = 0;
  codeSpans(text).forEach((part, i) => {
    if (i % 2 === 0)
      for (const m of part.matchAll(marker))
        found.push({ at: at + m.index, end: at + m.index + m[0].length });
    at += part.length;
  });
  return found;
}

const malformed = (reason: string) => failed("malformed-declaration", reason);

/** The most alternatives a `file:` glob's braces may expand to. */
const MAX_ALTERNATIVES = 256;

/** The longest `file:` glob, and the most brace groups it holds, that expansion is attempted for. */
const MAX_GLOB = 1000;
const MAX_BRACE_GROUPS = 32;

/** Where the brace group opening at `open` closes, and its top-level commas; null when it never closes. */
function braceGroup(
  glob: string,
  open: number,
): { close: number; commas: number[] } | null {
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < glob.length; i++) {
    const c = glob[i];
    if (c === "{") depth++;
    if (c === "," && depth === 1) commas.push(i);
    if (c === "}") depth--;
    if (depth === 0) return { close: i, commas };
  }
  return null;
}

/**
 * The paths a glob's braces stand for (`{a,b}/x` is `a/x` and `b/x`), nested
 * braces included; null past `MAX_ALTERNATIVES`.
 */
function alternatives(glob: string): string[] | null {
  const open = glob.indexOf("{");
  const group = open === -1 ? null : braceGroup(glob, open);
  if (group === null) return [glob];
  const cuts = [open, ...group.commas, group.close];
  const out: string[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const part = glob.slice((cuts[k] ?? 0) + 1, cuts[k + 1]);
    const each = alternatives(
      `${glob.slice(0, open)}${part}${glob.slice(group.close + 1)}`,
    );
    if (each === null || out.push(...each) > MAX_ALTERNATIVES) return null;
  }
  return out;
}

/**
 * What is wrong with a `file:` glob's reach: it can leave the repository
 * (any path its braces stand for is absolute, from a home directory, a drive
 * or a network share, or holds a backslash or a `..` segment), or its braces
 * are too many to expand; null when it is fine.
 */
function globProblem(glob: string): string | null {
  if (glob.length > MAX_GLOB || glob.split("{").length - 1 > MAX_BRACE_GROUPS)
    return `a file: hint is at most ${MAX_GLOB} characters with ${MAX_BRACE_GROUPS} brace groups, and \`${glob.slice(0, 40)}…\` is more`;
  const paths = alternatives(glob);
  if (paths === null)
    return `a file: hint's braces expand to at most ${MAX_ALTERNATIVES} paths: split \`${glob}\` into several hints`;
  return paths.some(
    (path) =>
      /^[/~]/.test(path) ||
      path.includes("\\") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").includes(".."),
  )
    ? `a file: hint is a glob relative to the repository root, and \`${glob}\` leaves the repository`
    : null;
}

/** One hint, from a code span's content. */
function readHint(text: string): Outcome<Hint> {
  const m = /^([A-Za-z-]+):(.*)$/.exec(text);
  if (!m)
    return malformed(
      `a hint is a kind and a value, \`kind:value\` (${HINT_KINDS.join(", ")}), not \`${text}\``,
    );
  const [, kind = "", raw = ""] = m;
  const value = raw.trim();
  if (!(HINT_KINDS as readonly string[]).includes(kind))
    return malformed(
      `unknown hint kind \`${kind}\` (${HINT_KINDS.join(", ")})`,
    );
  if (kind === "config") {
    const key = CONFIG_KEY.exec(value);
    return key
      ? ok({ kind, value: key[2] ?? "", absent: key[1] === "!" })
      : malformed(
          `a config: hint names a dotted key, \`config:dispatch.labels\` or \`config:!new.key\`, not \`${value}\``,
        );
  }
  if (!value) return malformed(`a ${kind}: hint has a value`);
  const reach = kind === "file" ? globProblem(value) : null;
  if (reach !== null) return malformed(reach);
  if (
    kind === "plugin-source" &&
    !(PLUGIN_SOURCES as readonly string[]).includes(value)
  )
    return malformed(
      `a plugin-source: hint is one of ${PLUGIN_SOURCES.join(", ")}, not \`${value}\``,
    );
  return ok({ kind: kind as HintKind, value });
}

/** The hints after `**Detect:**`: code spans separated by commas, an optional full stop after the last. */
function readHints(text: string): Outcome<Hint[]> {
  const parts = codeSpans(text);
  if (parts.length < 3)
    return malformed(
      "**Detect:** lists hints, each a code span `kind:value`, separated by commas",
    );
  const hints: Hint[] = [];
  for (const [i, part] of parts.entries()) {
    if (i % 2 === 1) {
      const hint = readHint(part.replace(/^`+|`+$/g, "").trim());
      if (!hint.ok) return hint;
      hints.push(hint.value);
      continue;
    }
    const between = part.trim();
    const expected = i === 0 ? "" : i === parts.length - 1 ? "." : ",";
    if (between !== expected && !(i === parts.length - 1 && between === ""))
      return malformed(
        `**Detect:** lists hints, each a code span \`kind:value\`, separated by commas: \`${between}\` sits between them`,
      );
  }
  // Normalized: each hint once, in one order, so the id does not depend on
  // how the author listed them.
  const unique = new Map(hints.map((hint) => [hintText(hint), hint]));
  return ok([...unique.keys()].sort().map((key) => unique.get(key) as Hint));
}

/** The levels a declaration names, distinct and known, in `LEVELS` order. */
function readLevels(text: string): Outcome<Level[]> {
  const named = text.split(/\s*,\s*/);
  const unknown = named.find(
    (level) => !(LEVELS as readonly string[]).includes(level),
  );
  if (unknown !== undefined)
    return malformed(`unknown level \`${unknown}\` (${LEVELS.join(", ")})`);
  if (new Set(named).size !== named.length)
    return malformed("a declaration names each level once");
  return ok(LEVELS.filter((level) => named.includes(level)));
}

/** `<strength> at <levels>. <instruction>`, then optionally `**Detect:**` and its hints. */
function readAction(body: string): Outcome<Action> {
  const word = body.split(" ")[0] ?? "";
  const strength = word.replace(/\.$/, "");
  if (!(STRENGTHS as readonly string[]).includes(strength))
    return malformed(
      `unknown strength \`${strength}\` (${STRENGTHS.join(", ")}; or \`none.\`, or \`retracts <id>.\`)`,
    );
  const m = /^\S+ at (.+?)\. (.+)$/.exec(body);
  if (!m || word !== strength)
    return malformed(
      "write `<strength> at <level>[, <level>]. <instruction>`, such as `required at configuration. Rename the key.`",
    );
  const levels = readLevels(m[1] ?? "");
  if (!levels.ok) return levels;
  const rest = m[2] ?? "";
  const detect = proseMatches(rest, DETECT);
  if (detect.length > 1) return malformed("an entry has one **Detect:** list");
  const at = detect[0]?.at ?? rest.length;
  const instruction = rest.slice(0, at).trim();
  if (!instruction) return malformed("an action says what to do");
  const length = [...instruction].length;
  if (length > INSTRUCTION_MAX)
    return malformed(
      `the instruction is ${length} characters; keep it to ${INSTRUCTION_MAX} and link to the detail`,
    );
  const hints =
    detect[0] === undefined
      ? ok([])
      : readHints(rest.slice(detect[0].end).trim());
  if (!hints.ok) return hints;
  return ok({
    kind: "action",
    strength: strength as Strength,
    levels: levels.value,
    instruction,
    hints: hints.value,
  });
}

/** What follows the marker: `none.`, `retracts <id>.` or an action. */
function readBody(body: string): Outcome<Declaration> {
  if (/^none\.?$/.test(body)) return ok({ kind: "none" });
  if (body.split(" ")[0] === "retracts") {
    const id = /^retracts (`?)([^`\s]+?)\1\.?$/.exec(body)?.[2];
    return id !== undefined && ACTION_ID.test(id)
      ? ok({ kind: "retracts", id })
      : malformed(
          "`retracts` names one action id, a version, # and eight hexadecimal digits, such as `retracts 0.157.0#3fa9c2b1.`",
        );
  }
  return readAction(body);
}

/**
 * Whether the marker at `at` belongs to a nested list item rather than the
 * entry itself: it sits on the line of a nested bullet, or sits on a
 * later line indented into the content of a nested bullet above it.
 */
function nested(raw: string, at: number): boolean {
  const lineStart = raw.lastIndexOf("\n", at) + 1;
  if (
    lineStart > 0 &&
    /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw.slice(lineStart, at))
  )
    return true;
  // The content columns of the nested bullets enclosing each line.
  const enclosing: number[] = [];
  const leave = (indent: number): void => {
    while ((enclosing.at(-1) ?? 0) > indent) enclosing.pop();
  };
  for (const line of raw.slice(0, lineStart).split("\n").slice(1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    leave(indent);
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
    if (bullet) enclosing.push(bullet[0].length);
  }
  const markerLine = raw.slice(lineStart);
  leave(markerLine.length - markerLine.trimStart().length);
  return lineStart > 0 && enclosing.length > 0;
}

/**
 * The declaration a change-note or changelog entry carries: null when it
 * carries none, a failure naming what is wrong when it is malformed. A
 * marker inside a code span, or escaped (`\\**Consumer action:**`), is text,
 * not a declaration, and so is a `**Detect:**` with no declaration before it.
 */
export function readDeclaration(entry: string): Outcome<Declared | null> {
  const raw = unlisted(entry);
  const text = collapse(raw);
  const marks = proseMatches(text, MARKER);
  if (!marks.length) return ok(null);
  if (marks.length > 1)
    return malformed("an entry declares one **Consumer action:**");
  const [mark] = marks;
  const [rawMark] = proseMatches(raw, MARKER);
  if (mark === undefined || rawMark === undefined)
    return malformed("an entry declares one **Consumer action:**");
  if (nested(raw, rawMark.at))
    return malformed(
      "a **Consumer action:** follows the entry's own description, not a nested list item",
    );
  const description = text.slice(0, mark.at).trim();
  if (!description)
    return malformed(
      "a **Consumer action:** follows the entry's description of the change",
    );
  const declaration = readBody(text.slice(mark.end).trim());
  if (!declaration.ok) return declaration;
  return ok({
    description,
    declaration: declaration.value,
    written: raw.slice(rawMark.at).trimEnd(),
  });
}

/**
 * What only a repository with `changelog.consumer_actions` on is held to: a
 * `**Detect:**` with no declaration before it, and a marker nearly written
 * (another case, the colon outside the bold, underscores), which would
 * otherwise leave an action out of the record unseen.
 */
function strictProblem(entry: string): string | null {
  const text = collapse(unlisted(entry));
  const prose = codeSpans(text)
    .filter((_, i) => i % 2 === 0)
    .join(" ")
    .replace(MARKER, "")
    .replace(/\\\*\*Consumer\s+action:\*\*/g, "");
  if (
    [...prose.matchAll(NEAR_MARKER)].length ||
    [...prose.matchAll(NEAR_DECLARATION)].length
  )
    return "write the marker exactly `**Consumer action:**`, in bold with the colon inside";
  const marker = proseMatches(text, MARKER)[0];
  const detect = proseMatches(text, DETECT)[0];
  return detect !== undefined && (marker === undefined || detect.at < marker.at)
    ? "a **Detect:** list follows a **Consumer action:**"
    : null;
}

/** A hint as written, `kind:value`, for an id. */
export const hintText = (hint: Hint): string =>
  `${hint.kind}:${hint.absent ? "!" : ""}${hint.value}`;

/** What an action's id is computed from: its description and its normalized declaration. */
function identity(description: string, action: Action): string {
  return JSON.stringify([
    description,
    action.strength,
    action.levels,
    action.instruction,
    action.hints.map(hintText),
  ]);
}

/**
 * An action's id: the release's version, `#` and the first eight hexadecimal
 * digits of the SHA-256 of its description and normalized declaration. It
 * does not depend on the entry's position.
 */
export function actionId(
  version: string,
  description: string,
  action: Action,
): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(identity(description, action))
    .digest("hex");
  return `${version}#${digest.slice(0, 8)}`;
}

/** An entry for a message: its first words. */
const shown = (entry: string): string => {
  const text = collapse(unlisted(entry));
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
};

/** What is wrong with the declarations of a note's entries, one finding per entry. */
export function declarationProblems(file: string, items: string[]): string[] {
  return items.flatMap((item) => {
    const read = readDeclaration(item);
    return read.ok
      ? []
      : [`${file}: \`${shown(item)}\` — ${read.failure.reason}`];
  });
}

/**
 * Whether an entry's prose marks it as breaking: `**Breaking:**`,
 * `**Breaking**`, `**Breaking.**` or `**Breaking**:`, in any case, anywhere
 * in the entry, since a mid-entry `**Breaking** for …` marks the part that
 * breaks.
 */
export function isBreakingEntry(item: string): boolean {
  return codeSpans(item).some((part, i) => i % 2 === 0 && BREAKING.test(part));
}

/** A note's file with its entries, as the release-wide rules read them. */
export interface NoteEntries {
  file: string;
  items: string[];
}

/**
 * Two entries of one release that declare the same action, written
 * differently (in whitespace, or in the order of their levels or hints): they
 * would be one action under one id, so the author writes them alike or makes
 * them differ.
 */
export function twinDeclarations(notes: NoteEntries[]): string[] {
  const seen = new Map<string, { file: string; written: string }>();
  const findings: string[] = [];
  for (const { file, items } of notes)
    for (const item of items) {
      const read = readDeclaration(item);
      if (!read.ok || read.value?.declaration.kind !== "action") continue;
      const { description, declaration, written } = read.value;
      const key = identity(description, declaration);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, { file, written });
      else if (first.written !== written)
        findings.push(
          `${first.file === file ? file : `${first.file} and ${file}`}: two entries of one release declare the same action, \`${shown(item)}\`, written differently (in whitespace, or the order of levels or hints): write them alike to declare one action, or make them differ`,
        );
    }
  return findings;
}

/** What `branchRules` holds a branch's notes to. */
export interface BranchRules {
  /** `changelog.consumer_actions`: a breaking entry must declare a consumer action. */
  required: boolean;
  /** The ids of the released actions, when the repository derives a record; null when it does not. */
  released: Set<string> | null;
  /** The format's released entries cannot be read for ids, so no retraction can be checked and none is accepted. */
  unverifiable?: boolean;
}

/** What one entry of a branch's note is refused for under `rules`; null when nothing. */
function branchProblem(item: string, rules: BranchRules): string | null {
  const strict = rules.required ? strictProblem(item) : null;
  if (strict !== null) return `${strict} (changelog.consumer_actions is on)`;
  const read = readDeclaration(item);
  if (!read.ok) return null;
  if (read.value === null)
    return rules.required && isBreakingEntry(item)
      ? "a breaking entry says what a consumer does: add `**Consumer action:**` after its description, `none.` included (changelog.consumer_actions is on)"
      : null;
  const { declaration } = read.value;
  if (declaration.kind === "retracts" && rules.unverifiable)
    return `retracts ${declaration.id}, which this changelog format cannot confirm: its released entries carry no readable consumer-action ids`;
  return declaration.kind === "retracts" &&
    rules.released !== null &&
    !rules.released.has(declaration.id)
    ? `retracts ${declaration.id}, which no released consumer action has`
    : null;
}

/**
 * The rules for the notes a branch adds: with `required`, a breaking entry
 * carries a declaration and no marker is nearly written; where the released
 * ids are known, a retraction names one of them.
 */
export function branchRules(
  notes: NoteEntries[],
  rules: BranchRules,
): string[] {
  return notes.flatMap(({ file, items }) =>
    items.flatMap((item) => {
      const problem = branchProblem(item, rules);
      return problem === null
        ? []
        : [`${file}: \`${shown(item)}\` — ${problem}`];
    }),
  );
}

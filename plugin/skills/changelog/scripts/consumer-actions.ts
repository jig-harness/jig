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

const MARKER = "**Consumer action:**";
const DETECT = "**Detect:**";

/** An action's id: a released version, `#` and eight hexadecimal digits. */
export const ACTION_ID = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?#[0-9a-f]{8}$/;

/** A configuration key in dotted form, optionally after `!`. */
const CONFIG_KEY = /^(!?)([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/;

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The entry without its list marker. */
const unlisted = (entry: string): string => entry.replace(/^\s*[-*]\s+/, "");

/** Where `marker` sits in `text`'s prose, outside its code spans. */
function proseOffsets(text: string, marker: string): number[] {
  const offsets: number[] = [];
  let at = 0;
  codeSpans(text).forEach((part, i) => {
    if (i % 2 === 0)
      for (
        let found = part.indexOf(marker);
        found !== -1;
        found = part.indexOf(marker, found + marker.length)
      )
        offsets.push(at + found);
    at += part.length;
  });
  return offsets;
}

const malformed = (reason: string) => failed("malformed-declaration", reason);

/** Whether a `file:` glob leaves the repository: absolute, from a home or drive, or through `..`. */
function leavesRepository(glob: string): boolean {
  return (
    /^[/~]/.test(glob) ||
    glob.includes("\\") ||
    /^[A-Za-z]:/.test(glob) ||
    glob.split("/").includes("..")
  );
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
  if (kind === "file" && leavesRepository(value))
    return malformed(
      `a file: hint is a glob relative to the repository root, and \`${value}\` leaves the repository`,
    );
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
  return ok(hints);
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
  const strength = (body.split(" ")[0] ?? "").replace(/\.$/, "");
  if (!(STRENGTHS as readonly string[]).includes(strength))
    return malformed(
      `unknown strength \`${strength}\` (${STRENGTHS.join(", ")}; or \`none.\`, or \`retracts <id>.\`)`,
    );
  const m = /^\S+ at (.+?)\. (.+)$/.exec(body);
  if (!m)
    return malformed(
      "write `<strength> at <level>[, <level>]. <instruction>`, such as `required at configuration. Rename the key.`",
    );
  const levels = readLevels(m[1] ?? "");
  if (!levels.ok) return levels;
  const rest = m[2] ?? "";
  const detect = proseOffsets(rest, DETECT);
  if (detect.length > 1) return malformed("an entry has one **Detect:** list");
  const at = detect[0] ?? rest.length;
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
      : readHints(rest.slice(at + DETECT.length).trim());
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
 * The declaration a change-note or changelog entry carries: null when it
 * carries none, a failure naming what is wrong when it is malformed. Markers
 * inside a code span are text, not a declaration.
 */
export function readDeclaration(entry: string): Outcome<Declared | null> {
  const text = collapse(unlisted(entry));
  const marks = proseOffsets(text, MARKER);
  if (!marks.length)
    return proseOffsets(text, DETECT).length
      ? malformed("a **Detect:** list follows a **Consumer action:**")
      : ok(null);
  if (marks.length > 1)
    return malformed("an entry declares one **Consumer action:**");
  const at = marks[0] ?? 0;
  const description = text.slice(0, at).trim();
  if (!description)
    return malformed(
      "a **Consumer action:** follows the entry's description of the change",
    );
  const declaration = readBody(text.slice(at + MARKER.length).trim());
  if (!declaration.ok) return declaration;
  const raw = unlisted(entry);
  return ok({
    description,
    declaration: declaration.value,
    written: raw.slice(proseOffsets(raw, MARKER)[0] ?? 0).trimEnd(),
  });
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

/** Whether an entry's prose marks it as breaking: `**Breaking:**` or `**Breaking**`. */
export function isBreakingEntry(item: string): boolean {
  return codeSpans(item).some(
    (part, i) => i % 2 === 0 && /\*\*Breaking[:.]?\*\*/.test(part),
  );
}

/** A note's file with its entries, as the release-wide rules read them. */
export interface NoteEntries {
  file: string;
  items: string[];
}

/**
 * Two entries of one release that declare the same action, written with
 * different whitespace: they would be one action under one id, so the author
 * writes them alike or makes them differ.
 */
export function whitespaceTwins(notes: NoteEntries[]): string[] {
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
          `${first.file === file ? file : `${first.file} and ${file}`}: two entries of one release declare \`${shown(item)}\` with declarations that differ only in whitespace: write them alike to declare one action, or make them differ`,
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
}

/**
 * The rules for the notes a branch adds: with `required`, a breaking entry
 * carries a declaration; where the released ids are known, a retraction
 * names one of them.
 */
export function branchRules(
  notes: NoteEntries[],
  rules: BranchRules,
): string[] {
  return notes.flatMap(({ file, items }) =>
    items.flatMap((item) => {
      const read = readDeclaration(item);
      if (!read.ok) return [];
      if (read.value === null)
        return rules.required && isBreakingEntry(item)
          ? [
              `${file}: \`${shown(item)}\` is breaking, so it says what a consumer does: add \`**Consumer action:**\` after it (changelog.consumer_actions is on)`,
            ]
          : [];
      const { declaration } = read.value;
      return declaration.kind === "retracts" &&
        rules.released !== null &&
        !rules.released.has(declaration.id)
        ? [
            `${file}: \`${shown(item)}\` retracts ${declaration.id}, which no released consumer action has`,
          ]
        : [];
    }),
  );
}

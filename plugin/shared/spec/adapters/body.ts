/**
 * The `body` adapter: requirements, acceptance criteria and tasks written in
 * the work item's own body. Every repository has it.
 *
 * The resolver hands it one recognised section at a time: the section the
 * configuration names (`## Spec` by default), `## Requirements` or
 * `## Acceptance criteria`. It reads the ids the text's own conventions give:
 *
 * - a leading id of capital letters, a hyphen and a number (`FR-001`,
 *   `AC-1`, `NFR-2.1`), bare or wrapped in `**`, `` ` `` or `[]`; `FR`, `NFR`
 *   and `REQ` mark a requirement and `AC` a criterion wherever they stand;
 * - a number right after a checkbox (`- [ ] 1.2 Write the exporter`), the
 *   id of a task.
 *
 * In the Requirements section every list item is a requirement, and in the
 * Acceptance criteria section a criterion, unless its id says otherwise. In
 * the Spec section only a line that carries a requirement or criterion id,
 * or a checkbox (a task), counts; the rest is prose and the references the
 * resolver follows. An item without an id gets a derived one: the kind
 * (`req`, `ac`, `task`) and the first eight hexadecimal digits of the
 * SHA-256 of its text, lowercased with runs of white space made one and
 * trailing `.`, `;` or `:` dropped (`ac-3f2a9c1b`). It is stable while the
 * text is: moving or adding other items does not change it. Two items that
 * would share an id within a section get `~2`, `~3`, … in the order written.
 *
 * A criterion serves a requirement when its text names exactly one
 * requirement id (`AC-2 exports every row (FR-001)`).
 */
import { createHash } from "node:crypto";
import { Defect } from "../../errors.ts";
import type {
  AdapterRead,
  BodySectionKind,
  SpecAdapter,
  SpecReference,
} from "../adapter.ts";
import { type MarkdownLine, trimEndOf } from "../markdown.ts";

const ID = "[A-Z][A-Z0-9]*-\\d+(?:\\.\\d+)*";
const REQUIREMENT_ID = /^(?:FR|NFR|REQ)-\d+(?:\.\d+)*$/;
const CRITERION_ID = /^AC-\d+(?:\.\d+)*$/;
const REQUIREMENT_MENTION = /\b(?:FR|NFR|REQ)-\d+(?:\.\d+)*\b/g;
const LEADING_ID = new RegExp(
  `^(?:\\*\\*|__|\`|\\[)?(${ID})(?:\\*\\*|__|\`|\\])?(?=$|[\\s:.)\\u2013\\u2014-])[\\s:.)\\u2013\\u2014-]*(.*)$`,
);
const NUMBER_ID = /^(\d+(?:\.\d+)*)\.?(?:\s(.*))?$/;
const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])\s(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s(.*)$/;
const HEADING = /^ {0,3}#{1,6}\s/;

/**
 * One list item or id-led line, with the lines that continue it. `depth` is
 * the scanner's: how many open list items enclose the item, 0 for a new list.
 */
interface Block {
  indent: number;
  list: boolean;
  depth: number;
  checkbox: boolean;
  done: boolean;
  id: string | null;
  numeric: boolean;
  text: string;
}

/** The id an entry's text opens with: a lettered id, or after a checkbox a number. */
function leadingId(
  text: string,
  afterCheckbox: boolean,
): { id: string | null; numeric: boolean; rest: string } {
  const lettered = LEADING_ID.exec(text);
  if (lettered)
    return { id: lettered[1] ?? null, numeric: false, rest: lettered[2] ?? "" };
  const numbered = afterCheckbox ? NUMBER_ID.exec(text) : null;
  if (numbered)
    return {
      id: numbered[1] ?? null,
      numeric: true,
      rest: (numbered[2] ?? "").trimStart(),
    };
  return { id: null, numeric: false, rest: text };
}

function block(indent: number, depth: number | null, content: string): Block {
  const list = depth !== null;
  const box = list ? CHECKBOX.exec(content) : null;
  const { id, numeric, rest } = leadingId(
    box ? (box[2] ?? "").trimStart() : content,
    box !== null,
  );
  return {
    indent,
    list,
    depth: depth ?? 0,
    checkbox: box !== null,
    done: box !== null && box[1] !== " ",
    id,
    numeric,
    text: rest,
  };
}

/**
 * The section's lines outside code, tabs as four spaces; `null` stands
 * where code opens, closes or continues, and at a boundary (a thematic
 * break, a block quote outside the item), since each ends the entry above
 * it. The classification is the resolver's, made over the whole body, and
 * so is which lines open a list item: only a line the scanner marked with a
 * `depth` does. A line it marked `quoted` opens no id-led entry: it is the
 * quote's text.
 */
function* unfenced(
  lines: readonly MarkdownLine[],
): Generator<MarkdownLine | null> {
  for (const line of lines)
    yield line.kind === "text" && !line.boundary ? line : null;
}

/** A new block the line opens, `"end"` when it ends the one above, or `"continue"`. */
function opens(
  { line, depth, quoted }: MarkdownLine,
  current: Block | null,
  afterBlank: boolean,
): Block | "end" | "continue" {
  const indent = line.length - line.trimStart().length;
  const item = depth === undefined ? null : LIST_ITEM.exec(line);
  if (item) return block(indent, depth ?? 0, (item[2] ?? "").trimStart());
  if (HEADING.test(line)) return "end";
  if (!quoted && indent < 4 && LEADING_ID.test(line.trim()))
    return block(indent, null, line.trim());
  const continues = current && (!afterBlank || indent > current.indent);
  return continues ? "continue" : "end";
}

/** The list items and id-led lines of a section, continuation lines joined on. */
function blocks(lines: readonly MarkdownLine[]): Block[] {
  const out: Block[] = [];
  let current: Block | null = null;
  let afterBlank = false;
  for (const marked of unfenced(lines)) {
    if (marked !== null && marked.line.trim() === "") {
      afterBlank = true;
      continue;
    }
    const next: Block | "end" | "continue" =
      marked === null ? "end" : opens(marked, current, afterBlank);
    if (next === "end") current = null;
    else if (next !== "continue") {
      current = next;
      out.push(next);
    } else if (current && marked !== null)
      current.text += ` ${marked.line.trim()}`;
    afterBlank = false;
  }
  return out;
}

/**
 * Nested items without an id or a checkbox belong to the item above them.
 * Nesting is the scanner's `depth`, so an item after a block that ended the
 * list is the first of a new list, however far it is indented.
 */
function entries(all: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of all) {
    const own = !b.list || b.depth === 0 || b.checkbox || b.id !== null;
    const parent = out.at(-1);
    if (own || parent === undefined) out.push({ ...b });
    else parent.text += ` ${b.text}`;
  }
  return out;
}

type Kind = "requirement" | "criterion" | "task";

function kindOf(b: Block, section: BodySectionKind): Kind | null {
  if (b.id !== null && !b.numeric) {
    if (REQUIREMENT_ID.test(b.id)) return "requirement";
    if (CRITERION_ID.test(b.id)) return "criterion";
  }
  if (section === "requirements") return "requirement";
  if (section === "acceptance") return "criterion";
  return b.checkbox ? "task" : null;
}

const DERIVED_PREFIX: Record<Kind, string> = {
  requirement: "req",
  criterion: "ac",
  task: "task",
};

/** The id of an item that carries none: see the header. */
function derivedId(kind: Kind, text: string): string {
  const normal = trimEndOf(
    text.toLowerCase().replace(/\s+/g, " ").trim(),
    ".;:",
  );
  const digest = createHash("sha256").update(normal).digest("hex");
  return `${DERIVED_PREFIX[kind]}-${digest.slice(0, 8)}`;
}

/** The one requirement id a criterion's text names, if exactly one. */
function servedRequirement(text: string): string | null {
  const named = new Set(text.match(REQUIREMENT_MENTION) ?? []);
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

/** Read one section's classified lines into the three lists. */
function readSection(
  lines: readonly MarkdownLine[],
  section: BodySectionKind,
): AdapterRead {
  const read: AdapterRead = { requirements: [], acceptance: [], tasks: [] };
  const taken = new Set<string>();
  const all = blocks(lines);
  if (all.length === 0) return read;
  for (const b of entries(all)) {
    const kind = kindOf(b, section);
    const body = b.text.replace(/\s+/g, " ").trim();
    if (kind === null || body === "") continue;
    const base = b.id ?? derivedId(kind, body);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
    taken.add(id);
    if (kind === "requirement") read.requirements.push({ id, text: body });
    else if (kind === "criterion")
      read.acceptance.push({
        id,
        text: body,
        requirement: servedRequirement(body),
      });
    else read.tasks.push({ id, text: body, done: b.done });
  }
  return read;
}

export const bodyAdapter: SpecAdapter = {
  name: "body",
  // It reads the issue body the resolver hands it, never a file.
  patterns: [],
  detect: () => Promise.resolve(true),
  read(ref: SpecReference): Promise<AdapterRead> {
    if (ref.kind !== "body")
      throw new Defect(`the body adapter reads only the body, not ${ref.ref}`);
    return Promise.resolve(readSection(ref.lines, ref.section));
  },
};

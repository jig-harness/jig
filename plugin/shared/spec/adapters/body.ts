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

const ID = "[A-Z][A-Z0-9]*-\\d+(?:\\.\\d+)*";
const REQUIREMENT_ID = /^(?:FR|NFR|REQ)-\d+(?:\.\d+)*$/;
const CRITERION_ID = /^AC-\d+(?:\.\d+)*$/;
const REQUIREMENT_MENTION = /\b(?:FR|NFR|REQ)-\d+(?:\.\d+)*\b/g;
const LEADING_ID = new RegExp(
  `^(?:\\*\\*|__|\`|\\[)?(${ID})(?:\\*\\*|__|\`|\\])?(?=$|[\\s:.)\\u2013\\u2014-])[\\s:.)\\u2013\\u2014-]*(.*)$`,
);
const NUMBER_ID = /^(\d+(?:\.\d+)*)\.?(?=\s|$)\s*(.*)$/;
const LIST_ITEM = /^( *)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const HEADING = /^ {0,3}#{1,6}\s/;

/** One list item or id-led line, with the lines that continue it. */
interface Block {
  indent: number;
  list: boolean;
  checkbox: boolean;
  done: boolean;
  id: string | null;
  numeric: boolean;
  text: string;
}

function block(indent: number, list: boolean, content: string): Block {
  const box = list ? CHECKBOX.exec(content) : null;
  let rest = box ? (box[2] ?? "") : content;
  let id: string | null = null;
  let numeric = false;
  const lettered = LEADING_ID.exec(rest);
  if (lettered) {
    id = lettered[1] ?? null;
    rest = lettered[2] ?? "";
  } else if (box) {
    const numbered = NUMBER_ID.exec(rest);
    if (numbered) {
      id = numbered[1] ?? null;
      numeric = true;
      rest = numbered[2] ?? "";
    }
  }
  return {
    indent,
    list,
    checkbox: box !== null,
    done: box !== null && box[1] !== " ",
    id,
    numeric,
    text: rest,
  };
}

/** The list items and id-led lines of a section, continuation lines joined on. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  let current: Block | null = null;
  let afterBlank = false;
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "    ");
    if (FENCE.test(line)) {
      inFence = !inFence;
      current = null;
      continue;
    }
    if (inFence) continue;
    if (line.trim() === "") {
      afterBlank = true;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const item = LIST_ITEM.exec(line);
    if (item) {
      current = block(indent, true, item[2] ?? "");
      out.push(current);
    } else if (HEADING.test(line)) {
      current = null;
    } else if (indent < 4 && LEADING_ID.test(line.trim())) {
      current = block(indent, false, line.trim());
      out.push(current);
    } else if (current && (!afterBlank || indent > current.indent)) {
      current.text += ` ${line.trim()}`;
    } else {
      current = null;
    }
    afterBlank = false;
  }
  return out;
}

/** Nested items without an id or a checkbox belong to the item above them. */
function entries(all: Block[]): Block[] {
  const top = Math.min(...all.filter((b) => b.list).map((b) => b.indent));
  const out: Block[] = [];
  for (const b of all) {
    const own = !b.list || b.indent <= top || b.checkbox || b.id !== null;
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
  const normal = text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:]+$/, "");
  const digest = createHash("sha256").update(normal).digest("hex");
  return `${DERIVED_PREFIX[kind]}-${digest.slice(0, 8)}`;
}

/** The one requirement id a criterion's text names, if exactly one. */
function servedRequirement(text: string): string | null {
  const named = new Set(text.match(REQUIREMENT_MENTION) ?? []);
  return named.size === 1 ? ([...named][0] ?? null) : null;
}

/** Read one section's text into the three lists. */
function readSection(text: string, section: BodySectionKind): AdapterRead {
  const read: AdapterRead = { requirements: [], acceptance: [], tasks: [] };
  const taken = new Set<string>();
  const all = blocks(text);
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
    return Promise.resolve(readSection(ref.text, ref.section));
  },
};

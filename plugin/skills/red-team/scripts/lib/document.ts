/**
 * The document under review: what kind it is, what to call it, and a hash
 * that shows whether it changed while the personas read it.
 */
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, relative } from "node:path";

export const KINDS = ["requirements", "architecture"] as const;
export type Kind = (typeof KINDS)[number];

/** Frontmatter `type:` values, as M6's templates and common schemas write them. */
const TYPE_KINDS: Record<string, Kind> = {
  prd: "requirements",
  requirements: "requirements",
  "product-requirements": "requirements",
  "requirements-document": "requirements",
  architecture: "architecture",
  "architecture-document": "architecture",
  "technical-architecture": "architecture",
};

/** The `##` headings of M6's PRD and architecture templates. */
const HEADINGS: Record<Kind, string[]> = {
  requirements: [
    "problem statement",
    "users and personas",
    "requirements",
    "functional requirements",
    "non-functional requirements",
    "success metrics",
    "scope",
  ],
  architecture: [
    "architecture overview",
    "key decisions",
    "components",
    "data model",
    "interfaces and contracts",
    "security and privacy",
    "scale and cost",
    "traceability",
  ],
};

export interface Detected {
  kind: Kind;
  from: string;
}

/** The kind a `--kind` value names (`prd` is accepted for requirements). */
export function kindOption(value: string): Kind | undefined {
  return kindOfType(value.trim().toLowerCase());
}

/** The kind a `type:` or `--kind` key names; inherited properties are not keys. */
function kindOfType(key: string): Kind | undefined {
  return Object.hasOwn(TYPE_KINDS, key) ? TYPE_KINDS[key] : undefined;
}

/** The frontmatter block's lines, or none when the document has none. */
function frontmatter(text: string): string[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end > 0 ? lines.slice(1, end) : [];
}

function frontmatterType(text: string): string | undefined {
  for (const line of frontmatter(text)) {
    const match = /^type:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/\s+#.*$/, "").trim();
    return value.replace(/^["']|["']$/g, "").toLowerCase();
  }
  return undefined;
}

/**
 * Text outside fenced code blocks, so a heading in an example is not read. A
 * fence closes only on a line of the same character, at least as long as the
 * one that opened it.
 */
function unfenced(text: string): string[] {
  let open: { char: string; length: number } | undefined;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const fence = marker?.[1] ?? "";
    if (!open) {
      if (marker) open = { char: fence[0] ?? "`", length: fence.length };
      else out.push(line);
    } else if (
      marker &&
      fence[0] === open.char &&
      fence.length >= open.length &&
      (marker[2] ?? "").trim() === ""
    )
      open = undefined;
  }
  return out;
}

function headings(text: string): string[] {
  return unfenced(text).flatMap((line) => {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    return match
      ? [
          (match[1] ?? "")
            .toLowerCase()
            .replace(/[:.]+$/, "")
            .trim(),
        ]
      : [];
  });
}

/**
 * The document's kind: its frontmatter `type:` when that names one, else the
 * M6 template headings it carries. Undefined when neither decides.
 */
export function detectKind(text: string): Detected | undefined {
  const type = frontmatterType(text);
  const typed = type === undefined ? undefined : kindOfType(type);
  if (typed) return { kind: typed, from: `frontmatter type: ${type}` };
  const found = new Set(headings(text));
  const score = (kind: Kind) =>
    HEADINGS[kind].filter((heading) => found.has(heading));
  const requirements = score("requirements");
  const architecture = score("architecture");
  for (const [kind, hits, other] of [
    ["requirements", requirements, architecture],
    ["architecture", architecture, requirements],
  ] as const)
    if (hits.length >= 2 && hits.length > other.length)
      return { kind, from: `headings: ${hits.join(", ")}` };
  return undefined;
}

/** The document's title: frontmatter `title:`, else its first `#` heading. */
export function titleOf(text: string, fallback: string): string {
  for (const line of frontmatter(text)) {
    const match = /^title:\s*(.+)$/.exec(line);
    if (match) return (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  for (const line of unfenced(text)) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) return match[1] ?? fallback;
  }
  return fallback;
}

/**
 * A file-name-safe name for the document, from its path in the repository,
 * with a short hash of that path so two paths that read alike (`a-b.md`,
 * `a/b.md`) never share a review folder.
 */
export function slugFor(path: string, root: string): string {
  const inside = relative(root, path);
  const within =
    inside !== "" && !isAbsolute(inside) && inside.split(/[\\/]/)[0] !== "..";
  const name = within ? inside : basename(path);
  const stem = name.slice(0, name.length - extname(name).length);
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "document"}-${sha256(within ? inside : path).slice(0, 8)}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Text reduced to what a quotation must keep: no emphasis or code marks (an
 * asterisk or underscore inside a word, as in `user_id` or `a*b`, is part of
 * the text and stays), no list, quote or heading markers (nor a lone dash a
 * quotation joined lines with), typographic quotes made plain, and every run
 * of whitespace one space.
 */
export function normalise(text: string): string {
  return text
    .replace(/`/g, "")
    .replace(/(?<![\p{L}\p{N}])[*_]+(?=[^\s*_])/gu, "")
    .replace(/(?<=[^\s*_])[*_]+(?![\p{L}\p{N}])/gu, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, " ")
    .replace(/^\s*>\s?/gm, " ")
    .replace(/^\s*#+\s*/gm, " ")
    .replace(/(^|\s)[-+>](?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

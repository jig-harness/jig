/**
 * Small readers shared by the de-scarring scripts: a document's frontmatter,
 * the Markdown files under a directory, and the archaeological-layer (scar
 * class S4) reading-list pattern.
 *
 * The frontmatter reader is deliberately minimal: top-level `key: value`
 * scalars only, which is all the scripts consult (`status`, `descar_allow`).
 * It is not a YAML parser and must not grow into one.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wording that often marks a superseded layer kept beside the current one.
 * A hit is a line to read, not a verdict: the same words appear in sentences
 * that must stay (a guardrail, live drift). The last alternative catches an
 * issue-tracker key used as a version marker ("as of ABC-123 this was
 * renamed", "as of #123").
 */
export const S4_PATTERN =
  /previously|formerly|no longer|used to |originally|historically|earlier version|^\*\*Update|as of (?:[A-Z][A-Z0-9]*-|#)[0-9]+/i;

/** Top-level scalar fields of a document's frontmatter, or null if it has none. */
export function frontmatter(text: string): Record<string, string> | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return fields;
    const match = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key = "", raw = ""] = match;
    const quoted = raw.match(/^(["'])(.*)\1\s*(#.*)?$/);
    fields[key] = quoted
      ? (quoted[2] ?? "")
      : raw.replace(/\s+#.*$/, "").trim();
  }
  return null;
}

/**
 * Every `*.md` file under `dir`, recursively, sorted; [] when `dir` is absent.
 *
 * Only a missing directory counts as empty. Any other read failure (a
 * permission error, an I/O error) throws with the directory's path, because
 * ranking a partial tree as if it were whole would mislead the pass.
 *
 * Symbolic links are not followed: a linked directory is skipped and a linked
 * file is skipped. This keeps the walk inside `dir` (a link to an unrelated
 * tree would pull in documents the pass does not own) and keeps it finite (a
 * link to an ancestor would otherwise recurse without end).
 */
export function markdownFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `could not read ${dir}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const files: string[] = [];
  for (const name of entries.sort()) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) files.push(...markdownFiles(path));
    else if (stats.isFile() && name.endsWith(".md")) files.push(path);
  }
  return files;
}

/** The lines of `text` that match the S4 reading-list pattern, 1-based. */
export function s4Lines(text: string): { line: number; text: string }[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text }) => S4_PATTERN.test(text));
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

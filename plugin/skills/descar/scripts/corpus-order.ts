#!/usr/bin/env bun
/**
 * Rank the subtrees of a docs tree by the density of archaeological-layer
 * wording (scar class S4 reading-list hits per thousand lines), highest
 * first: the order in which to work a corpus.
 *
 * Usage: bun corpus-order.ts [--docs-dir <dir>] [--exclude-dir <name>]...
 *                            [--allow <path>]... [--promoted <status>]...
 *
 *   --docs-dir     the docs root (default: docs)
 *   --exclude-dir  a top-level subdirectory to leave out, added to the
 *                  defaults: archive (superseded material), retrospection
 *                  and scratch (raw sources, not compiled wiki)
 *   --allow        a path the repository's scar lint exempts; any document
 *                  whose path contains it is not counted (repeatable)
 *   --promoted     a status that counts as promoted, replacing the default
 *                  `approved` (repeatable)
 *
 * The subtrees are read from the filesystem, so a new top-level folder is
 * ranked without editing anything. Documents directly under the docs root
 * form the `(root)` bucket. A document counts when it is a draft (it may be
 * promoted tomorrow) or promoted, is not exempted by `--allow`, and does not
 * opt out with `descar_allow: true`. Archived material is left out by path,
 * not by status: a document moved into `archive/` does not reliably get its
 * `status:` changed at the same time.
 *
 * A bucket with no countable document prints no line at all, which is not the
 * same as zero density. Exit 0; 2 on a usage error.
 */
import { statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { frontmatter, markdownFiles, readText, s4Lines } from "./lib/docs.ts";

export const DEFAULT_EXCLUDED_DIRS = ["archive", "retrospection", "scratch"];

export interface CorpusOptions {
  docsDir: string;
  excludeDirs: string[];
  allow: string[];
  promoted: string[];
}

export interface Bucket {
  name: string;
  hits: number;
  lines: number;
  perThousand: number;
}

export function rankable(
  path: string,
  text: string,
  options: Pick<CorpusOptions, "allow" | "promoted">,
): boolean {
  const fields = frontmatter(text);
  if (!fields) return false;
  const status = fields.status ?? "";
  if (status !== "draft" && !options.promoted.includes(status)) return false;
  if (fields.descar_allow === "true") return false;
  const normalized = path.split(sep).join("/");
  return !options.allow.some((pattern) => normalized.includes(pattern));
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

export function corpusOrder(options: CorpusOptions): Bucket[] {
  const excluded = new Set(options.excludeDirs);
  const groups = new Map<string, string[]>();
  for (const file of markdownFiles(options.docsDir)) {
    const parts = relative(options.docsDir, file).split(sep);
    const name = parts.length === 1 ? "(root)" : (parts[0] ?? "");
    if (parts.length > 1 && excluded.has(name)) continue;
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  const buckets: Bucket[] = [];
  for (const [name, files] of groups) {
    let hits = 0;
    let lines = 0;
    for (const file of files) {
      const text = readText(file);
      if (!rankable(file, text, options)) continue;
      lines += lineCount(text);
      hits += s4Lines(text).length;
    }
    if (lines > 0)
      buckets.push({ name, hits, lines, perThousand: (hits * 1000) / lines });
  }
  return buckets.sort(
    (a, b) => b.perThousand - a.perThousand || a.name.localeCompare(b.name),
  );
}

export function parseArgs(argv: string[]): CorpusOptions {
  const options: CorpusOptions = {
    docsDir: "docs",
    excludeDirs: [...DEFAULT_EXCLUDED_DIRS],
    allow: [],
    promoted: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag} needs a value`);
    i++;
    if (flag === "--docs-dir") options.docsDir = value;
    else if (flag === "--exclude-dir") options.excludeDirs.push(value);
    else if (flag === "--allow") options.allow.push(value);
    else if (flag === "--promoted") options.promoted.push(value);
    else throw new Error(`unknown option: ${flag}`);
  }
  if (options.promoted.length === 0) options.promoted = ["approved"];
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!statSync(join(options.docsDir)).isDirectory())
      throw new Error(`${options.docsDir} is not a directory`);
    for (const bucket of corpusOrder(options))
      console.log(
        `${bucket.name.padEnd(16)} per1k=${bucket.perThousand.toFixed(1)} (${bucket.hits} hits / ${bucket.lines} lines)`,
      );
  } catch (error) {
    console.error(
      `corpus-order: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}

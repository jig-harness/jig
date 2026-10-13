// Scope: the AI reviewer's high-risk paths (`high_risk_path_patterns` in
// .config/ai-review.yaml), a projection of the change-area catalog
// (.config/change-areas.yaml, module M3): one pattern per path glob of every
// area marked `reviewRisk: high`, in catalog order. `--write` regenerates the
// block in place; `--check` (the gate) exits 1 when the committed block
// differs from the projection, and 2 when a file cannot be read or a glob
// cannot be translated. The reviewer reads the file itself, so the
// projection is committed rather than derived at run time.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { isRecord } from "../lib/record.ts";
import { CATALOG, type Catalog, validCatalog } from "./change-areas.ts";

export const REVIEW_CONFIG = ".config/ai-review.yaml";
const KEY = /^high_risk_path_patterns:/;
/** Glob wildcards and their regular expressions; any other match is escaped. */
const GLOB_TOKENS: Record<string, string> = {
  "**/": "(?:[\\s\\S]*/)?",
  "**": "[\\s\\S]*",
  "*": "[^/]*",
  "?": "[^/]",
};

/**
 * The reviewer's regular expression for one catalog glob, anchored at the
 * repository root. A glob ending in `/**` becomes a folder prefix; `**`
 * elsewhere matches across folders, `*` and `?` within one. Braces,
 * character classes, negation (`!`) and escapes (`\`) have no translation
 * here, so they are refused rather than guessed at.
 */
export function globToRegex(glob: string): string {
  if (/[[\]{}!\\]/.test(glob))
    throw new Error(
      `cannot translate glob \`${glob}\`: braces, classes, negation and escapes are not supported`,
    );
  const prefix = glob.endsWith("/**");
  const body = (prefix ? glob.slice(0, -2) : glob).replace(
    /\*\*\/|\*\*|\*|\?|[.+^$()|\\]/g,
    (token) => GLOB_TOKENS[token] ?? `\\${token}`,
  );
  return `^${body}${prefix ? "" : "$"}`;
}

/** The high-risk patterns the catalog projects, in catalog order, once each. */
export function projectPatterns(catalog: Catalog): string[] {
  const patterns = Object.values(catalog)
    .filter((area) => area.reviewRisk === "high")
    .flatMap((area) => area.paths.map(globToRegex));
  return [...new Set(patterns)];
}

/** The committed block's patterns, in file order. */
export function committedPatterns(config: string): string[] {
  const doc = Bun.YAML.parse(config);
  const list = isRecord(doc) ? doc.high_risk_path_patterns : undefined;
  if (!Array.isArray(list))
    throw new Error(`${REVIEW_CONFIG}: no high_risk_path_patterns list`);
  return list.map((entry) =>
    isRecord(entry) && typeof entry.source === "string" ? entry.source : "",
  );
}

/**
 * The configuration with its high-risk block replaced by `patterns`. The
 * block runs from its key to the next top-level key: indented lines, list
 * items written at the margin, and comments among them belong to it, while
 * blank and comment lines just before the next key stay with that key. The
 * result is read back, so a block this cannot replace fails instead of
 * leaving old entries behind.
 */
export function renderBlock(config: string, patterns: string[]): string {
  const lines = config.split("\n");
  const start = lines.findIndex((line) => KEY.test(line));
  if (start < 0)
    throw new Error(`${REVIEW_CONFIG}: no high_risk_path_patterns key`);
  const inBlock = (line: string) => line === "" || /^(\s|- |-$|#)/.test(line);
  let end = start + 1;
  while (end < lines.length && inBlock(lines[end] as string)) end++;
  while (end > start + 1 && /^(#|$)/.test(lines[end - 1] as string)) end--;
  const block = patterns.length
    ? [
        "high_risk_path_patterns:",
        ...patterns.map((p) => `  - source: '${p.replaceAll("'", "''")}'`),
      ]
    : ["high_risk_path_patterns: []"];
  const rendered = [
    ...lines.slice(0, start),
    ...block,
    ...lines.slice(end),
  ].join("\n");
  if (JSON.stringify(committedPatterns(rendered)) !== JSON.stringify(patterns))
    throw new Error(`${REVIEW_CONFIG}: the rewritten block does not read back`);
  return rendered;
}

/** The gate: the committed high-risk block is the catalog's projection. */
export function checkReviewRisk(root = "."): number {
  let expected: string[];
  let committed: string[];
  try {
    expected = projectPatterns(validCatalog(root));
    committed = committedPatterns(
      readFileSync(join(root, REVIEW_CONFIG), "utf8"),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (JSON.stringify(expected) === JSON.stringify(committed)) return 0;
  console.error(
    `${REVIEW_CONFIG}: high_risk_path_patterns differs from the areas marked reviewRisk: high in ${CATALOG}; regenerate it with \`bun scripts/review-risk.ts --write\``,
  );
  for (const p of expected.filter((x) => !committed.includes(x)))
    console.error(`  missing: ${p}`);
  for (const p of committed.filter((x) => !expected.includes(x)))
    console.error(`  not in the catalog: ${p}`);
  return 1;
}

if (import.meta.main)
  cli(() => {
    const root = join(import.meta.dir, "..");
    const flag = process.argv[2];
    if (flag === "--check") return checkReviewRisk(root);
    if (flag !== "--write") {
      console.error("usage: review-risk.ts --check | --write");
      return 2;
    }
    const path = join(root, REVIEW_CONFIG);
    const config = readFileSync(path, "utf8");
    writeFileSync(
      path,
      renderBlock(config, projectPatterns(validCatalog(root))),
    );
    return 0;
  });

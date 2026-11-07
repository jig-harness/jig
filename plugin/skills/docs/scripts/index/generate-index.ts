#!/usr/bin/env bun
// Derive navigation from the docs tree; --check compares without committing it.
// Writes two files: INDEX.md, and an orphan report listing the documents no
// other document names in its `related:` list.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  cli,
  documentFields,
  frontmatterValue,
  GENERATED_INDEX as GENERATED,
  generatedIndexPath,
  markdownFiles,
  readDocument,
} from "../lib/docs.ts";
import {
  stampLastUpdated,
  stickyDate,
  utcToday,
} from "../stamp/frontmatter-stamp.ts";

/**
 * The documents the index and the orphan report cover, docs-relative: every
 * Markdown file in the tree except the ones named in `exclude`, which are the
 * generated index and report themselves.
 */
function documents(directory: string, exclude: string[]): string[] {
  const skip = new Set(exclude.map((path) => resolve(path)));
  return markdownFiles(directory)
    .filter((file) => !skip.has(resolve(file)))
    .map((file) => relative(directory, file).split(sep).join("/"));
}

/** A value as one table cell: whitespace, line breaks included, collapsed and `|` escaped. */
const cell = (text: string) =>
  text.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

export function generateIndex(directory: string, exclude: string[]): string {
  const rows = documents(directory, exclude)
    .map((relativePath) => {
      const category = relativePath.includes("/")
        ? (relativePath.split("/")[0] ?? "")
        : "(root)";
      const text = readDocument(join(directory, relativePath));
      const title =
        frontmatterValue(text, "title", relativePath) ||
        basename(relativePath, ".md")
          .replace(/[-_]/g, " ")
          .split(/\s+/)
          .filter(Boolean)
          .map((word) => word[0]?.toUpperCase() + word.slice(1))
          .join(" ");
      return [
        category,
        relativePath,
        cell(title),
        cell(frontmatterValue(text, "description", relativePath)),
      ];
    })
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.join("\t")), Buffer.from(b.join("\t"))),
    );
  let result = `${GENERATED}\n\n# Documentation index\n\n`;
  for (const category of new Set(rows.map((row) => row[0]))) {
    result += `## ${category}\n\n| Doc | Title | Description |\n|-----|-------|-------------|\n`;
    for (const row of rows.filter((row) => row[0] === category))
      result += `| [${row[1]}](${row[1]}) | ${row[2]} | ${row[3]} |\n`;
    result += "\n";
  }
  return result;
}

/** The repository root: the nearest ancestor of `directory` holding `.git`, else the working directory. */
export function repositoryRoot(directory: string): string {
  let current = resolve(directory);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export interface OrphanOptions {
  /** Files left out of the documents (the index and the report themselves). */
  exclude?: string[];
  /** Where an entry starting with `/` resolves from; default: the repository root. */
  root?: string;
}

/**
 * Where a `related:` entry points, docs-relative; "" for an empty entry or one
 * outside the docs tree. A relative entry resolves from the document that
 * lists it; one starting with `/` from the repository root, as a link on a
 * forge does, so `/docs/a.md` names `a.md` in a `docs/` tree.
 */
function resolveRelated(
  doc: string,
  entry: string,
  dirs: { docs: string; root: string },
): string {
  const target = entry.split("#")[0] ?? "";
  if (!target) return "";
  if (!target.startsWith("/"))
    return posix.normalize(posix.join(posix.dirname(doc), target));
  const path = relative(dirs.docs, resolve(dirs.root, target.slice(1)))
    .split(sep)
    .join("/");
  return path.startsWith("..") ? "" : path;
}

/** The documents a document's `related:` names, itself left out. */
function relatedTargets(
  directory: string,
  doc: string,
  dirs: { docs: string; root: string },
): string[] {
  const text = readDocument(join(directory, doc));
  const related = documentFields(text, doc).get("related") ?? [];
  return [related]
    .flat()
    .map((entry) => resolveRelated(doc, entry, dirs))
    .filter((target) => target && target !== doc);
}

/**
 * The documents no other document lists under `related:` (an inline or block
 * list). A document listing itself does not count.
 */
export function findOrphans(
  directory: string,
  options: OrphanOptions = {},
): string[] {
  const docs = documents(directory, options.exclude ?? []);
  const dirs = {
    docs: resolve(directory),
    root: resolve(options.root ?? repositoryRoot(directory)),
  };
  const referenced = new Set(
    docs.flatMap((doc) => relatedTargets(directory, doc, dirs)),
  );
  return docs
    .filter((doc) => !referenced.has(doc))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/**
 * The report's frontmatter values. The defaults fit the M4 template schema; a
 * repository whose vocabulary differs sets its own.
 */
export interface ReportFields {
  type: string;
  status: string;
  lifecycle: string;
  owner: string;
  tags: string;
}
export const REPORT_DEFAULTS: ReportFields = {
  type: "reference",
  status: "active",
  lifecycle: "temporary",
  owner: "docs",
  tags: "[navigation]",
};

/**
 * The orphan report for a date. Each entry is named docs-relative and linked
 * from `base`, the docs tree as seen from the report's own directory.
 */
export function renderOrphans(
  orphans: string[],
  date: string,
  fields: Partial<ReportFields> = {},
  base = "",
): string {
  const f = { ...REPORT_DEFAULTS, ...fields };
  const list = orphans.length
    ? orphans.map((path) => `- [${path}](${posix.join(base, path)})`).join("\n")
    : "None: every document is listed in another document's `related:`.";
  return `---
title: Orphaned documents
type: ${f.type}
status: ${f.status}
lifecycle: ${f.lifecycle}
last_updated: ${date}
owner: ${f.owner}
tags: ${f.tags}
description: Documents that no other document lists under related
---

${GENERATED}

# Orphaned documents

A warning, never a failure: no other document lists these under \`related:\`.
Link each from a document that relates to it, or retire it.

${list}
`;
}

/**
 * The report as the generator writes it: dated with the sticky date, its
 * links relative to `report`, where it is written (default: the docs tree).
 */
export function generateOrphans(
  directory: string,
  existing: string | null,
  today: string,
  options: OrphanOptions & {
    fields?: Partial<ReportFields>;
    report?: string;
  } = {},
): { content: string; count: number } {
  const orphans = findOrphans(directory, options);
  const report = options.report ?? join(directory, ".orphans.md");
  const base = relative(dirname(resolve(report)), resolve(directory))
    .split(sep)
    .join("/");
  const draft = renderOrphans(orphans, today, options.fields, base);
  return {
    content: stampLastUpdated(draft, stickyDate(existing, draft, today)),
    count: orphans.length,
  };
}

/** Report fields set through ORPHANS_TYPE, ORPHANS_STATUS, … in the environment. */
function reportFields(
  env: Record<string, string | undefined>,
): Partial<ReportFields> {
  const fields: Partial<ReportFields> = {};
  for (const key of Object.keys(REPORT_DEFAULTS) as (keyof ReportFields)[]) {
    const value = env[`ORPHANS_${key.toUpperCase()}`];
    if (value) fields[key] = value;
  }
  return fields;
}

function write(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  console.log(`Wrote ${path}`);
}

function fresh(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return true;
  console.log(
    `ERROR: ${path} is stale — regenerate with bun generate-index.ts`,
  );
  return false;
}

function check(files: [string, string][]): number {
  // Every file is checked before returning, so one run names each stale one.
  const stale = files.filter(([path, content]) => !fresh(path, content));
  if (stale.length) return 1;
  console.log(`OK — ${files.map(([path]) => path).join(" and ")} are fresh`);
  return 0;
}

function orphanOptions(
  exclude: string[],
  env: Record<string, string | undefined>,
): OrphanOptions & { fields: Partial<ReportFields> } {
  const fields = reportFields(env);
  return env.REPO_ROOT
    ? { exclude, root: env.REPO_ROOT, fields }
    : { exclude, fields };
}

/** The docs tree and the two files written from it, from the environment. */
function outputs(env: Record<string, string | undefined>) {
  const directory = env.DOCS_DIR || "docs";
  if (!existsSync(directory)) throw new Error(`no such dir: ${directory}`);
  const output = generatedIndexPath(env);
  const report = env.ORPHANS || join(directory, ".orphans.md");
  if (resolve(output) === resolve(report))
    throw new Error(
      `OUT and ORPHANS both name ${output}; the index and the orphan report need two files`,
    );
  return { directory, output, report };
}

/** Whether to check rather than write: `--check`, or nothing for write. */
function checkMode(args: string[]): boolean {
  const unknown = args.filter((arg) => arg !== "--check");
  if (unknown.length)
    throw new Error(`unknown argument: ${unknown.join(" ")} (use --check)`);
  return args.length > 0;
}

export function runIndex(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const checking = checkMode(args);
  const { directory, output, report } = outputs(env);
  const exclude = [output, report];
  const existing = existsSync(report) ? readFileSync(report, "utf8") : null;
  const orphans = generateOrphans(directory, existing, utcToday(), {
    ...orphanOptions(exclude, env),
    report,
  });
  if (orphans.count)
    console.log(
      `WARN — ${orphans.count} orphaned doc(s), listed in ${report} (a warning, not a failure)`,
    );
  const files: [string, string][] = [
    [output, generateIndex(directory, exclude)],
    [report, orphans.content],
  ];
  if (checking) return check(files);
  for (const [path, content] of files) write(path, content);
  return 0;
}
if (import.meta.main) cli(() => runIndex());

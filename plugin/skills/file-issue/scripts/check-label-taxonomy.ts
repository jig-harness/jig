#!/usr/bin/env bun
// Label-taxonomy lint: the tasks-&-memory invariant made mechanical.
//
// A label taxonomy (`label-taxonomy.yaml`) is the single source of truth for
// how work is classified and which process each flag label fires. This gate
// keeps it a closed vocabulary of process triggers rather than folksonomy:
//   1. every label name (types, statuses, flags, group labels, and category
//      labels as prefix + id) is UNIQUE across the file;
//   2. `types:` and `statuses:` are CLOSED, NON-EMPTY lists;
//   3. every flag declares a NON-EMPTY `fires:` (a flag that fires nothing is
//      folksonomy), `scope:` as exactly `shipping-item` or `container`, and a
//      NON-EMPTY `apply_when:`; a `do_not_apply_when:`, when present, is
//      non-empty;
//   4. every group declares a non-empty `labels:`; `required:` is a boolean;
//   5. every category declares a non-empty `prefix:`, no prefix begins
//      another's, and it has `labels:`, an `open:` pattern that compiles, or
//      both; `max:` is a positive integer and `recommended:` a boolean;
//   6. group and category ids are unique and differ from types, statuses and
//      flags;
//   7. every `requires:` (on a flag or a category) names a type, group label,
//      flag or closed category label of the file, never itself; every
//      `requires_category:` names a category;
//   8. no UNKNOWN top-level keys, and no mapping repeats a key.
//
// Exit 0 on pass, 1 on a violation (reported), 2 on a usage error or a file
// that cannot be read.
//
// Usage (from the repository root):
//   check-label-taxonomy.ts [label-taxonomy.yaml]
// Without a path: TAXONOMY, else the repository's `issue_tracker.taxonomy`,
// else `label-taxonomy.yaml` at the repository root.
import { existsSync } from "node:fs";
import { taxonomyPath } from "./lib/config.ts";
import { lintTaxonomyFile, type TaxonomyLint } from "./lib/taxonomy.ts";

/** The lint of the taxonomy the command line names, or why it has none. */
function lintInput(
  argv: string[],
  env: NodeJS.ProcessEnv,
): TaxonomyLint | string {
  let path = "";
  try {
    path = argv[0] || env.TAXONOMY || taxonomyPath();
    if (!existsSync(path)) return `taxonomy not found: ${path}`;
    return { ...lintTaxonomyFile(path), path };
  } catch (e) {
    return `${path ? `taxonomy not readable: ${path}: ` : ""}${e instanceof Error ? e.message : String(e)}`;
  }
}

export function main(argv: string[], env = process.env): number {
  if (argv.length > 1 || argv[0]?.startsWith("-")) {
    console.error("usage: check-label-taxonomy.ts [label-taxonomy.yaml]");
    return 2;
  }
  const lint = lintInput(argv, env);
  if (typeof lint === "string") {
    console.error(`ERROR: ${lint}`);
    return 2;
  }
  const { problems, count, path } = lint;
  if (problems.length) {
    console.log(
      `${problems.map((p) => `  - ${p}\n`).join("")}\nLabel-taxonomy lint FAILED: ${problems.length} problem(s) in ${path}`,
    );
    return 1;
  }
  const counted = ["types", "statuses", "flags", "groups", "categories"]
    .map((section) => `${section}=${count[section] || 0}`)
    .join(", ");
  console.log(`\nOK — labels valid (${counted})`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));

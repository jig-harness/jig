/**
 * `jig dispatch check [--repo <path>]`: check the configuration a tick reads
 * from a repository with the tick's own readers (`lib/config-check.ts`), for
 * the repository's CI. Each reading the tick would refuse is printed with
 * the tick's sentence, and the command exits 1; a configuration the tick
 * reads whole exits 0.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkConfiguration } from "./lib/config-check.ts";

/** Exit when the tick would refuse a reading. */
const CHECK_FAILED_EXIT = 1;

/**
 * Text for a line of output: control characters, line breaks included, are
 * written as escapes. A configuration-controlled value can then neither
 * start a workflow command on a line of its own nor forge another line.
 */
export function printable(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\r") return "\\r";
    if (c === "\t") return "\\t";
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/** Why `root` is not a checkout the check can read, or `null` when it is one. */
function checkoutProblem(root: string): string | null {
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    // Not there, or not inspectable: both read as no checkout.
  }
  if (!isDirectory) return `${root} is not a directory`;
  if (!existsSync(join(root, ".git"))) return `${root} is not a git checkout`;
  return null;
}

export function checkMain(root: string): number {
  const problem = checkoutProblem(root);
  if (problem !== null) {
    console.error(
      `jig dispatch check: ${printable(problem)}, so there is no configuration to check`,
    );
    return CHECK_FAILED_EXIT;
  }
  const findings = checkConfiguration(root);
  if (findings.length === 0) {
    console.log(
      `jig dispatch check: the tick reads the configuration in ${printable(root)} whole: its dispatch section, its tracker and issue facets, and its change-area catalog`,
    );
    return 0;
  }
  for (const finding of findings)
    console.error(
      `jig dispatch check: ${finding.part}: ${printable(finding.message)}`,
    );
  return CHECK_FAILED_EXIT;
}

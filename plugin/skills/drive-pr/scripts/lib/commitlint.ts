/**
 * The repository's commitlint configuration: whether it exists and whether it
 * names the Conventional Commits rules, which `detectTitleFormat` reads as the
 * title convention.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../../shared/guards.ts";

const COMMITLINT_FILES = [
  ".commitlintrc",
  ".commitlintrc.json",
  ".commitlintrc.yaml",
  ".commitlintrc.yml",
  ".commitlintrc.js",
  ".commitlintrc.cjs",
  ".commitlintrc.mjs",
  ".commitlintrc.ts",
  ".commitlintrc.cts",
  "commitlint.config.js",
  "commitlint.config.cjs",
  "commitlint.config.mjs",
  "commitlint.config.ts",
  "commitlint.config.cts",
];

/** A commitlint configuration at the repository root, or `null`. */
export function findCommitlintConfig(root: string): string | null {
  const file = COMMITLINT_FILES.find((f) => existsSync(join(root, f)));
  if (file !== undefined) return file;
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (isRecord(pkg) && pkg.commitlint !== undefined)
      return "package.json (commitlint)";
  } catch {
    // no package.json, or not JSON: no commitlint configuration there
  }
  return null;
}

/**
 * The commitlint configuration when it names the Conventional Commits rules
 * (`@commitlint/config-conventional` or a preset built on it), else `null`.
 * A commitlint configuration alone proves commits are linted, not which
 * convention they follow.
 */
export function conventionalCommitlintConfig(root: string): string | null {
  const found = findCommitlintConfig(root);
  if (found === null) return null;
  let text: string;
  try {
    if (found === "package.json (commitlint)") {
      const pkg = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      text = JSON.stringify(pkg.commitlint);
    } else {
      text = readFileSync(join(root, found), "utf8");
    }
  } catch {
    return null;
  }
  return /conventional/i.test(text) ? found : null;
}

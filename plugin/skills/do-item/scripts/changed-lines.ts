#!/usr/bin/env bun
/** Count added and removed non-test lines without a shell pipeline. */
import { defaultGitRunner } from "../../change-areas/scripts/lib/resolve.ts";

export function changedLineCount(diff: string): number {
  return diff.split("\n").filter((line) => /^[+-][^+-]/.test(line)).length;
}

if (import.meta.main) {
  const [base, ...excludes] = process.argv.slice(2);
  if (!base || base.startsWith("-")) {
    console.error(
      "Usage: changed-lines.ts <base-ref> [excluded git pathspec ...]",
    );
    process.exitCode = 2;
  } else {
    try {
      const patterns = excludes.length
        ? excludes
        : [
            ":!*.test.ts",
            ":!*.spec.ts",
            ":!*.test.tsx",
            ":!*.spec.tsx",
            ":!**/__tests__/**",
          ];
      console.log(
        changedLineCount(
          defaultGitRunner(["diff", `${base}...HEAD`, "--", ...patterns]),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}

// Require the configured review tag when protected paths are staged.
import { readFileSync } from "node:fs";
import { cli, ere } from "../../../../lib/cli.ts";
export function checkMarker(message = process.argv[2]): number {
  if (!message)
    throw new Error("usage: check-review-marker.ts <commit-msg-file>");
  const content = readFileSync(message, "utf8");
  const paths = ere(process.env.REVIEW_PATHS_RE || "^db/migrations/.*\\.sql$");
  const staged = Bun.spawnSync([
    "git",
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACM",
    "-z",
  ]);
  if (staged.exitCode) throw new Error(staged.stderr.toString());
  const protectedFiles = staged.stdout
    .toString()
    .split("\0")
    .filter((name) => name && paths.test(name));
  const marker = process.env.REVIEW_MARKER || "[reviewed:db-migration]";
  if (!protectedFiles.length || content.includes(marker)) return 0;
  console.error(
    `ERROR: commit touches protected files but is missing the review marker.\n${protectedFiles.join("\n")}\nAfter review, add this tag to the commit message:\n${marker}`,
  );
  return 1;
}
if (import.meta.main) cli(() => checkMarker());

import { test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["accepted-anchor-only.md", 1, "token"],
  ["accepted-comment-faked-review.md", 1, "token"],
  ["accepted-duplicate-status.md", 2, "token"],
  ["accepted-empty-fence-review.md", 1, "token"],
  ["accepted-empty-review.md", 1, "token"],
  ["accepted-fenced-content-review.md", 0, "token"],
  ["accepted-html-comment-review.md", 1, "token"],
  ["accepted-no-review.md", 1, "token"],
  ["accepted-ref-only.md", 1, "token"],
  ["accepted-review-section.md", 0, "token"],
  ["accepted-reviewed-bare.md", 1, "token"],
  ["accepted-reviewed.md", 0, "token"],
  ["accepted-reviewer-substring.md", 0, "token"],
  ["draft.md", 0, "token"],
  ["malformed.md", 2, "token"],
  ["no-frontmatter.md", 0, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-stage-accepted.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expectSpawnExit(run, code);
  });

import { test, expect } from "bun:test";
import { join } from "node:path";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["bad-prd.md", 1, "token"],
  ["frontmatter-heading.md", 1, "token"],
  ["good-prd.md", 0, "token"],
  ["html-comment-heading.md", 1, "token"],
  ["indented-heading.md", 1, "token"],
];
for (const [name, code, _encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    args.push(fixture("sections.txt"));
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "check-required-sections.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expect(run.exitCode).toBe(code);
  });

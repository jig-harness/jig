import { test, expect } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
const fixture = (name: string) => join(import.meta.dir, "fixtures", name);
const cases: [string, number, string][] = [
  ["raw/bad-resolved.tsv", 2, "token"],
  ["raw/open.tsv", 0, "token"],
  ["raw/token.tsv", 0, "token"],
  ["raw/trailer.tsv", 0, "trailer"],
  ["raw/undeclared.tsv", 0, "token"],
  ["raw/verdict-then-ack.tsv", 0, "token"],
];
for (const [name, code, encoding] of cases)
  test(name, () => {
    const args = [fixture(name)];
    const env: Record<string, string> = {};
    env.VERDICT_ENCODING = encoding;
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "normalize-thread-states.ts"),
        ...args,
      ],
      { env: { ...process.env, ...env } },
    );
    expectSpawnExit(run, code);
    if (code === 0)
      expect(run.stdout.toString()).toBe(
        require("node:fs")
          .readFileSync(fixture(name.replace(/\.tsv$/, ".expected")), "utf8")
          .replace(/\r\n/g, "\n"),
      );
  });

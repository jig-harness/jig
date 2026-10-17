/**
 * The README and CONFIGURATION.md describe the built-in tables; these tests
 * keep them in step with the data the classifier reads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_TOOLS } from "../scripts/lib/build-tools.ts";
import { DEFAULT_AREAS } from "../scripts/lib/config.ts";
import { CONVENTIONS } from "../scripts/lib/conventions.ts";
import { DATABASE_TOOLS } from "../scripts/lib/database-tools.ts";

const skill = join(import.meta.dir, "..");
const readme = readFileSync(join(skill, "README.md"), "utf8");
const configuration = readFileSync(
  join(skill, "..", "..", "CONFIGURATION.md"),
  "utf8",
);

describe("the README", () => {
  test("lists every default area with its description and paths", () => {
    for (const area of DEFAULT_AREAS) {
      expect(readme).toContain(`| \`${area.name}\` | ${area.description} |`);
      for (const path of area.paths) expect(readme).toContain(`\`${path}\``);
    }
  });

  test("lists every build tool and database convention with its paths", () => {
    for (const row of [...BUILD_TOOLS, ...DATABASE_TOOLS]) {
      expect(readme).toContain(`| ${row.tool} | ${row.ecosystem} | `);
      for (const path of row.paths) expect(readme).toContain(`\`${path}\``);
    }
  });

  test("lists every built-in convention, its emphasis characters escaped", () => {
    // An unescaped `*.test.*` or `__tests__/` renders as italic or bold.
    const escaped = (rule: string) => rule.replace(/[*_]/g, "\\$&");
    for (const c of CONVENTIONS)
      expect(readme).toContain(
        `| ${c.kind} | ${c.ecosystem} | ${escaped(c.rule)} |`,
      );
  });
});

test("CONFIGURATION.md lists the default areas in order", () => {
  const rows = DEFAULT_AREAS.map(
    (a) => `| \`${a.name}\` | ${a.description} |`,
  ).join("\n");
  expect(configuration).toContain(rows);
});

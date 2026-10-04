// Neutral example: TODO comments need an issue or a justified suppression.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../../../../lib/cli.ts";
import { walk } from "../../../../lib/files.ts";
export function checkTodo(root = process.env.SRC_DIR || "src"): number {
  if (!existsSync(root)) {
    console.log(`OK — ${root} does not exist (nothing to check)`);
    return 0;
  }
  const violations: string[] = [];
  for (const name of walk(root, [".git"])) {
    const content = readFileSync(join(root, name));
    if (content.includes(0)) continue;
    content
      .toString()
      .split("\n")
      .forEach((line, index) => {
        if (
          line.includes("TODO") &&
          !/TODO\((#[0-9]+|[A-Za-z][A-Za-z0-9]*-[0-9]+)\)/.test(line) &&
          !/todo-exempt:\s*\S/.test(line)
        )
          violations.push(`${name}:${index + 1}:${line}`);
      });
  }
  if (violations.length) {
    console.error(
      `ERROR: TODO without an issue reference found under ${root}\n${violations.join("\n")}`,
    );
    return 1;
  }
  console.log(`OK — every TODO under ${root} references an issue`);
  return 0;
}
if (import.meta.main) cli(() => checkTodo());

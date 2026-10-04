#!/usr/bin/env bun
// Detect colliding ADR numbers; gaps are valid and missing directories pass.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
export function checkAdrNumbers(env = process.env): number {
  const directory = env.ADR_DIR || "docs/adr";
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    console.log(`OK — ${directory} does not exist (no ADRs to check)`);
    return 0;
  }
  const files = readdirSync(directory).filter((name) =>
    /^ADR-.*\.md$/.test(name),
  );
  const numbers = files.map((file) => file.replace(/^(ADR-[0-9]+).*/, "$1"));
  const duplicates = [
    ...new Set(
      numbers.filter((number, index) => numbers.indexOf(number) !== index),
    ),
  ].sort();
  if (duplicates.length) {
    const offending = duplicates.flatMap((number) =>
      files
        .filter((file) => file.startsWith(`${number}-`))
        .map((file) => `  ${join(directory, file)}`),
    );
    console.log(
      `ERROR: duplicate ADR numbers found in ${directory}\n\nTwo files claim the same number. Renumber one to the next free number.\nDuplicated numbers:\n${duplicates.map((number) => `  ${number}`).join("\n")}\n\nOffending files:\n${offending.join("\n")}`,
    );
    return 1;
  }
  console.log(`OK — ADR numbers unique in ${directory}`);
  return 0;
}
if (import.meta.main) {
  try {
    process.exitCode = checkAdrNumbers();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}

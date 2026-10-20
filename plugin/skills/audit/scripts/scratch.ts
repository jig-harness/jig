/** Create one audit's private scratch directory and print its absolute path. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { failFrom, runMain } from "../../../shared/cli.ts";

function directory(argv: string[]): string {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { directory: { type: "string" } },
      allowPositionals: false,
    });
    return resolve(values.directory ?? tmpdir());
  } catch (error) {
    failFrom(error, 2, "Usage: scratch.ts [--directory <parent>]");
  }
}

async function main(argv: string[]): Promise<number> {
  const parent = directory(argv);
  mkdirSync(parent, { recursive: true });
  console.log(mkdtempSync(join(parent, "jig-audit-")));
  return 0;
}

if (import.meta.main) runMain("scratch.ts", () => main(process.argv.slice(2)));

/** Create one audit's private scratch directory and print its absolute path. */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fail, failFrom, runMain } from "../../../shared/cli.ts";

const usage =
  "Usage: scratch.ts [--directory <parent inside the working directory>]";

function directory(argv: string[]): string {
  let requested: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { directory: { type: "string" } },
      allowPositionals: false,
    });
    requested = values.directory;
  } catch (error) {
    failFrom(error, 2, usage);
  }
  if (requested === undefined) return tmpdir();
  // A named parent stays inside the working directory: the argument comes
  // from an agent, and a scratch folder has no reason to be anywhere else.
  const cwd = process.cwd();
  const parent = resolve(cwd, requested);
  const inside = relative(cwd, parent);
  const escapes = inside === ".." || inside.startsWith(`..${sep}`);
  if (inside === "" || escapes || isAbsolute(inside))
    fail(
      2,
      `--directory must name a folder inside ${cwd}: ${requested}`,
      usage,
    );
  return parent;
}

async function main(argv: string[]): Promise<number> {
  const parent = directory(argv);
  mkdirSync(parent, { recursive: true });
  console.log(mkdtempSync(join(parent, "jig-audit-")));
  return 0;
}

if (import.meta.main) runMain("scratch.ts", () => main(process.argv.slice(2)));

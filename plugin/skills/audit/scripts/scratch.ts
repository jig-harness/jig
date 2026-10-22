/** Create one audit's private scratch directory and print its absolute path. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  // Lexically inside is not enough: a symbolic link among the existing
  // components would let the folder be created wherever it points.
  if (!within(cwd, parent) || !within(realpathSync(cwd), existingReal(parent)))
    fail(
      2,
      `--directory must name a folder inside ${cwd}: ${requested}`,
      usage,
    );
  return parent;
}

/** True when `path` is strictly below `root`. */
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  const escapes = part === ".." || part.startsWith(`..${sep}`);
  return part !== "" && !escapes && !isAbsolute(part);
}

/** The real location `path` would be created at: its deepest existing
 *  ancestor resolved through links, with the missing components appended. */
function existingReal(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing)
    existing = dirname(existing);
  return join(realpathSync(existing), relative(existing, path));
}

async function main(argv: string[]): Promise<number> {
  const parent = directory(argv);
  mkdirSync(parent, { recursive: true });
  console.log(mkdtempSync(join(parent, "jig-audit-")));
  return 0;
}

if (import.meta.main) runMain("scratch.ts", () => main(process.argv.slice(2)));

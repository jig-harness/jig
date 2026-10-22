/** Create one audit's private scratch directory and print its absolute path. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  const root = below(cwd);
  const parent = spelledLike(root, resolve(cwd, requested));
  // The created path itself passes a plain prefix test, the containment
  // check taint analysers recognise. Lexically inside is not enough: a
  // symbolic link among the existing components would let the folder be
  // created wherever it points.
  if (
    !parent.startsWith(root) ||
    !hasPrefix(existingReal(parent), below(realpathSync(cwd)))
  )
    fail(
      2,
      `--directory must name a folder inside ${cwd}: ${requested}`,
      usage,
    );
  return parent;
}

/** The prefix every path strictly below `root` starts with. */
function below(root: string): string {
  return root.endsWith(sep) ? root : root + sep;
}

/** True when `path` starts with `prefix` as the platform compares paths:
 *  Windows paths are case-insensitive, the same rule `path.relative` applies
 *  there. Only the leading `prefix.length` characters are folded, so a case
 *  mapping that changes a string's length cannot shift the comparison. */
export function hasPrefix(
  path: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return path.startsWith(prefix);
  return path.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/** `path` with its leading `root` spelled as `root` is, when the platform
 *  treats the two spellings as one path; otherwise `path` unchanged. */
export function spelledLike(
  root: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return hasPrefix(path, root, platform)
    ? root + path.slice(root.length)
    : path;
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

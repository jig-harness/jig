/** A development checkout must use isolated state, never the operator's live databases. */
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { attempt, failed, ok, type Outcome } from "../outcome.ts";

let operatorHome: string | undefined;
function systemHome(): Outcome<string, "source-state"> {
  if (operatorHome !== undefined) return ok(operatorHome);
  // Bun's userInfo honours HOME. Resolve the OS account's home in a bounded
  // child without the development process's home overrides.
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"].includes(
        key.toUpperCase(),
      )
    )
      delete env[key];
  const read = attempt<unknown, "source-state">(
    "source-state",
    "cannot resolve the operating-system user's home",
    () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--no-env-file",
            "--eval",
            "console.log(JSON.stringify(require('node:os').userInfo().homedir))",
          ],
          {
            env,
            timeout: 5000,
            maxBuffer: 8192,
            encoding: "utf8",
            windowsHide: true,
          },
        ),
      ),
  );
  if (!read.ok) return read;
  if (
    typeof read.value !== "string" ||
    read.value.length === 0 ||
    !isAbsolute(read.value)
  )
    return failed(
      "source-state",
      "the operating-system user's home was not an absolute path",
    );
  operatorHome = read.value;
  return ok(operatorHome);
}

/** An impossible descendant of a file is absent, just like a missing component. */
function entryAt(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR")
      return undefined;
    throw error;
  }
}

/** Resolve existing ancestors as well, so a symlink cannot alias the live state directory. */
function canonical(path: string, links = new Set<string>()): string {
  // Preserve parent segments until the operating system has followed links:
  // lexical normalization of alias/../file can name a different database.
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const entry = entryAt(absolute);
  if (entry?.isSymbolicLink()) {
    const parent = canonical(dirname(absolute), links);
    const identity = `${parent}${sep}${basename(absolute)}`;
    // Delegate a repeated link to the platform's cycle detection; its I/O
    // error is caught by the caller's isolation check.
    if (links.has(identity)) return realpathSync.native(absolute);
    links.add(identity);
    const target = readlinkSync(absolute);
    return canonical(
      isAbsolute(target) ? target : `${parent}${sep}${target}`,
      links,
    );
  }
  // Bun's non-native realpath normalizes parent segments before following links.
  if (entry !== undefined) return realpathSync.native(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : `${canonical(parent, links)}${sep}${basename(absolute)}`;
}

export function sourceDatabaseRefusal(
  path: string,
  home?: string,
): Outcome<never, "source-state"> | null {
  // Published artifacts contain plugin/ alone. A source checkout has Git's
  // directory or linked-worktree file beside that plugin directory.
  if (!existsSync(resolve(import.meta.dir, "../../..", ".git"))) return null;
  const operator = home === undefined ? systemHome() : ok(home);
  if (!operator.ok) return operator;
  const checked = attempt(
    "source-state",
    `${path}: cannot verify development state isolation`,
    () =>
      relative(
        canonical(`${operator.value}${sep}.local${sep}state${sep}jig`),
        canonical(path),
      ),
  );
  if (!checked.ok) return checked;
  const inside = checked.value;
  if (
    !isAbsolute(inside) &&
    inside !== ".." &&
    !inside.startsWith(`..${sep}`)
  ) {
    return failed(
      "source-state",
      `${path}: a development checkout cannot open the operator's live Jig state; run an installed release, or give the development process an isolated home or database path`,
    );
  }
  return null;
}

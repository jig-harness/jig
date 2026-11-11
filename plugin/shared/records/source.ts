/** A development checkout must use isolated state, never the operator's live databases. */
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
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

/** Resolve existing ancestors as well, so a symlink cannot alias the live state directory. */
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : join(canonical(parent), basename(absolute));
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
        canonical(join(operator.value, ".local", "state", "jig")),
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

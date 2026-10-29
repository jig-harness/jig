/**
 * The files of a checked reference, as an adapter reads them.
 *
 * A folder reference passes its checks as a folder; what it holds does not
 * pass with it. A file under it may be ignored by Git, a symbolic link out
 * of the repository or out of the folder, or a pipe, so every file is
 * checked on its own (`checkFilePath`) before it is listed and again before
 * it is read, and its real location, not the name it was asked for by, must
 * be the reference or under it. These are file names, taken as written: a
 * `#` or a `%` in one is part of it. A file reached by two names (a link
 * beside its target) is listed once, by the first name in order. Nothing is
 * left out silently: each file or folder the checks refuse is recorded in
 * `refused`, which the resolver reports as unresolved. Listing, checking and
 * reading never block and stop when the adapter's signal aborts, so the
 * resolver's deadline bounds them.
 */
import { readdir, readFile } from "node:fs/promises";
import type { CheckedFiles } from "./adapter.ts";
import { type CheckedPath, checkFilePath } from "./references.ts";

/** A reader that also records what its checks refused. */
export interface ReportingFiles extends CheckedFiles {
  /** Each file or folder left out, as `<reference> (<reason>)`. */
  readonly refused: readonly string[];
}

/** A read the checks refused: the reference and why. */
class RefusedRead extends Error {
  override name = "RefusedRead";
}

const reasonOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Whether the checked `file` is `scope` itself or, for a folder, under it. */
function within(file: CheckedPath, scope: CheckedPath): boolean {
  return scope.directory
    ? file.ref.startsWith(scope.ref)
    : file.ref === scope.ref;
}

interface Walk {
  scope: CheckedPath;
  root: string;
  seen: Set<string>;
  refused: string[];
  signal: AbortSignal | undefined;
}

/**
 * Every file under the checked folder `dir` that passes the checks, named
 * through `named` (the folder as the reference writes it, ending in `/`).
 */
async function filesUnder(
  named: string,
  dir: CheckedPath,
  walk: Walk,
): Promise<string[]> {
  if (walk.seen.has(dir.path)) return [];
  walk.seen.add(dir.path);
  let names: string[];
  try {
    names = (await readdir(dir.path)).sort();
  } catch (err) {
    walk.refused.push(`${named} (could not be listed: ${reasonOf(err)})`);
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    walk.signal?.throwIfAborted();
    const ref = `${named}${name}`;
    const child = await checkFilePath(ref, walk.root, walk.signal);
    if (!child.ok) walk.refused.push(`${ref} (${child.reason})`);
    else if (!within(child, walk.scope))
      walk.refused.push(`${ref} (symbolic link out of ${walk.scope.ref})`);
    else if (child.directory)
      found.push(...(await filesUnder(`${ref}/`, child, walk)));
    else if (!walk.seen.has(child.path)) {
      walk.seen.add(child.path);
      found.push(ref);
    }
  }
  return found;
}

/** The reader an adapter gets for the checked reference `checked`. */
export function checkedFiles(
  checked: CheckedPath,
  root: string,
): ReportingFiles {
  const refused: string[] = [];
  return {
    refused,
    async list(signal) {
      if (!checked.directory) return [checked.ref];
      return filesUnder(checked.ref, checked, {
        scope: checked,
        root,
        seen: new Set(),
        refused,
        signal,
      });
    },
    async read(ref, signal) {
      const file = await checkFilePath(ref, root, signal);
      if (!file.ok) throw new RefusedRead(`${ref} (${file.reason})`);
      if (!within(file, checked))
        throw new RefusedRead(`${ref} is not ${checked.ref} or under it`);
      if (file.directory)
        throw new RefusedRead(`${ref} is a folder, not a file`);
      return readFile(file.path, { encoding: "utf8", signal });
    },
  };
}

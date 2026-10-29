/**
 * The files of a checked reference, as an adapter reads them.
 *
 * A folder reference passes its checks as a folder; what it holds does not
 * pass with it. A file under it may be ignored by Git or a symbolic link out
 * of the repository, so every file is checked on its own (`checkPath`)
 * before it is listed and again before it is read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { swallow } from "../errors.ts";
import type { CheckedFiles } from "./adapter.ts";
import { type CheckedPath, checkPath } from "./references.ts";

/**
 * Every file under the checked folder `dir` that passes the checks, named
 * through `named` (the folder as the reference writes it, ending in `/`).
 */
function filesUnder(
  named: string,
  dir: CheckedPath,
  root: string,
  seen: Set<string>,
): string[] {
  if (seen.has(dir.path)) return [];
  seen.add(dir.path);
  let names: string[];
  try {
    names = readdirSync(dir.path).sort();
  } catch (err) {
    swallow(err, "a folder that cannot be listed holds no readable file");
    return [];
  }
  const found: string[] = [];
  for (const name of names) {
    const child = checkPath(`${named}${name}`, root);
    if (!child.ok) continue;
    if (child.directory)
      found.push(...filesUnder(`${named}${name}/`, child, root, seen));
    else found.push(`${named}${name}`);
  }
  return found;
}

/** The reader an adapter gets for the checked reference `checked`. */
export function checkedFiles(checked: CheckedPath, root: string): CheckedFiles {
  const within = (ref: string) => {
    const normal = posix.normalize(ref);
    return checked.directory
      ? normal.startsWith(checked.ref)
      : normal === checked.ref;
  };
  return {
    list: () =>
      Promise.resolve(
        checked.directory
          ? filesUnder(checked.ref, checked, root, new Set())
          : [checked.ref],
      ),
    read(ref: string) {
      if (!within(ref))
        return Promise.reject(
          new Error(`${ref} is not ${checked.ref} or under it`),
        );
      const file = checkPath(ref, root);
      if (!file.ok) return Promise.reject(new Error(`${ref} (${file.reason})`));
      if (file.directory)
        return Promise.reject(new Error(`${ref} is a folder, not a file`));
      return Promise.resolve(readFileSync(file.path, "utf8"));
    },
  };
}

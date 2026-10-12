/**
 * Replace a file whole: a reader sees the old contents or the new ones, never a
 * truncated mix, and an interrupted write leaves the old file in place.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/**
 * Write `text` to a new file beside `path` with `mode` set before any content
 * lands, then rename it over `path`. A symbolic link at `path` is followed, so
 * a managed dotfile keeps pointing where it did. A link whose target does not
 * exist is refused: renaming over it would replace the link with a file.
 */
export function writeFileAtomic(
  path: string,
  text: string,
  mode: number,
): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  let target = path;
  if (entry?.isSymbolicLink()) {
    try {
      target = realpathSync(path);
    } catch {
      throw new Error(
        `${path} is a symbolic link to a missing file; create its target or remove the link`,
      );
    }
  }
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    // `wx` creates the file, so `mode` applies; chmod then undoes the umask.
    writeFileSync(temp, "", { mode, flag: "wx" });
    chmodSync(temp, mode);
    writeFileSync(temp, text);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

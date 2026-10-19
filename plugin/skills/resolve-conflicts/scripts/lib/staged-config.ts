/**
 * The declarations that classify a conflicted path (the repository's
 * configuration and the change-area catalog), as the commit will carry them:
 * read from the index. A file a command or an editor changed on disk and
 * staged nothing of decides nothing.
 *
 * Outside the index by design: the user and environment layers, a
 * configuration file `JIG_OVERLAY` names, and a catalog outside the repository.
 * None of them is part of the commit.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import {
  consumerRoot,
  layeredConfig,
  OVERLAY_RELPATH,
} from "../../../../shared/consumer.ts";
import {
  type CatalogArea,
  loadCatalogFile,
  loadCatalogText,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { readIndexFile } from "./index-files.ts";

/** A declaration that cannot be read from the index. */
export class StagedDeclarationError extends Error {}

/** A declaration the index holds only as conflict stages. */
export class UnmergedDeclarationError extends StagedDeclarationError {}

/** A staged declaration's text, or why it cannot be had; `null` when absent. */
function stagedText(root: string, path: string): string | null {
  const read = readIndexFile(root, path);
  switch (read.found) {
    case "file":
      return read.text;
    case "absent":
      return null;
    case "unmerged":
      throw new UnmergedDeclarationError(
        `${read.path} is unmerged: resolve and stage it first (the check reads what is staged)`,
      );
    case "unreadable":
      throw new StagedDeclarationError(
        `${path} cannot be read from the index: ${read.reason}`,
      );
  }
}

/** A disk path's components: on Windows either separator divides them. */
function diskComponents(path: string): string[] {
  return path.split(sep === "/" ? "/" : /[\\/]/);
}

/** Where `path` really is, or `path` as given when it cannot be resolved. */
function located(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `path` (absolute, or relative to `root`) as git names a path below the
 * repository (`/` separated), or `null` when it does not lead into it. Only
 * the leading components that reach the repository are resolved on disk, so
 * an alias of it (a symlinked parent, `/var` for `/private/var`) is still the
 * repository. The components after them are kept as written, links and `..`
 * included, for the index walk to follow: a link inside the repository leads
 * where the index says, whatever the disk holds.
 */
function insideRoot(root: string, path: string): string | null {
  const realRoot = located(root);
  const parts = isAbsolute(path)
    ? diskComponents(path)
    : [...diskComponents(root), ...diskComponents(path)];
  for (let reach = 1; reach < parts.length; reach++) {
    const rest = parts
      .slice(reach)
      .filter((name) => name !== "" && name !== ".");
    if (rest.length === 0) return null;
    // A `..` straight after the repository climbs out of it on disk.
    if (rest[0] === "..") continue;
    // The first component alone is the file-system root (`/`, `C:\\`).
    const prefix = parts.slice(0, reach).join(sep) + (reach === 1 ? sep : "");
    if (located(prefix) === realRoot) return rest.join("/");
  }
  return null;
}

/**
 * The merged configuration with the repository's own file read from the
 * index, a file `JIG_OVERLAY` names inside the repository included. Throws
 * what `layeredConfig` throws, and `UnmergedDeclarationError` while the file
 * is unmerged.
 */
export function stagedConfig(): Record<string, unknown> {
  const root = consumerRoot();
  const named = process.env.JIG_OVERLAY;
  const inIndex =
    named === undefined || named.trim() === ""
      ? OVERLAY_RELPATH
      : insideRoot(root, named);
  if (inIndex === null) return layeredConfig(root).values;
  return layeredConfig(root, process.env, stagedText(root, inIndex)).values;
}

/**
 * The change-area catalog at `configured` (absolute, or relative to the
 * repository, as configured), read from the index when it lies inside the
 * repository. Throws with the path and the reason.
 */
export function stagedCatalog(configured: string): Map<string, CatalogArea> {
  const root = consumerRoot();
  const inIndex = insideRoot(root, configured);
  if (inIndex === null)
    return loadCatalogFile(
      isAbsolute(configured) ? configured : `${root}${sep}${configured}`,
    );
  let text: string | null;
  try {
    text = stagedText(root, inIndex);
  } catch (err) {
    throw new StagedDeclarationError(
      `the change-area catalog ${inIndex} could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (text === null)
    throw new StagedDeclarationError(
      `the change-area catalog ${inIndex} could not be read (it is not staged)`,
    );
  return loadCatalogText(text, inIndex);
}

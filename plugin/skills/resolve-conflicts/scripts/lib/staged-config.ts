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
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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

/** A staged declaration's text, or why it cannot be had; `null` when absent. */
function stagedText(root: string, path: string): string | null {
  const read = readIndexFile(root, path);
  switch (read.found) {
    case "file":
      return read.text;
    case "absent":
      return null;
    case "unmerged":
      throw new StagedDeclarationError(
        `${read.path} is unmerged: resolve and stage it first (the check reads what is staged)`,
      );
    case "unreadable":
      throw new StagedDeclarationError(
        `${path} cannot be read from the index: ${read.reason}`,
      );
  }
}

/**
 * `path` below `root` as git names it (`/` separated), or `null` when it lies
 * outside. Both are compared by real location, the parent directory resolved
 * and the name itself left alone, so an alias of the repository (a symlinked
 * parent, `/var` for `/private/var`) is still the repository, and a link at
 * the path itself stays the link the index holds.
 */
function insideRoot(root: string, path: string): string | null {
  const located = (file: string): string => {
    try {
      return join(realpathSync(dirname(file)), basename(file));
    } catch {
      return file;
    }
  };
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // A root that cannot be resolved is compared as given.
  }
  const relativePath = relative(realRoot, located(path));
  return relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
    ? null
    : relativePath.split(sep).join("/");
}

/**
 * The merged configuration with the repository's own file read from the
 * index, a file `JIG_OVERLAY` names inside the repository included. Throws
 * what `layeredConfig` throws, and when the file is unmerged.
 */
export function stagedConfig(): Record<string, unknown> {
  const root = consumerRoot();
  const named = process.env.JIG_OVERLAY?.trim();
  const inIndex =
    named === undefined || named === ""
      ? OVERLAY_RELPATH
      : insideRoot(root, resolve(root, named));
  if (inIndex === null) return layeredConfig(root).values;
  return layeredConfig(root, process.env, stagedText(root, inIndex)).values;
}

/**
 * The change-area catalog at `path` (absolute), read from the index when it
 * lies inside the repository. Throws with the path and the reason.
 */
export function stagedCatalog(path: string): Map<string, CatalogArea> {
  const root = consumerRoot();
  const inIndex = insideRoot(root, path);
  if (inIndex === null) return loadCatalogFile(path);
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

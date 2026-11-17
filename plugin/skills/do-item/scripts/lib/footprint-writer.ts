/**
 * Build the footprint an upstream writer records: `do-item`'s pickup after
 * it read the code, its footprint scout, and `file-issue` filing from a
 * diff or from paths a person named. The prediction is the writer's
 * judgment; this module turns the paths it chose into the record's payload:
 * the paths normalized, the areas their files match directly in the
 * change-area catalog (seeds only, never the `impliedBy` closure), the
 * commit of the base the prediction read, and, for a pickup, its session.
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FOOTPRINT_MAX_PATHS,
  FOOTPRINT_PATH,
} from "../../../../shared/footprint.ts";
import { JigError } from "../../../../shared/outcome.ts";
import { matches } from "../../../../shared/shapes.ts";
import {
  areasOf,
  type ChangeAreaCatalog,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  changedFilesFromWorktree,
  type GitRunner,
} from "../../../change-areas/scripts/lib/resolve.ts";

export type WriterSource = "pickup" | "scout" | "filing";
export const WRITER_SOURCES: readonly WriterSource[] = [
  "pickup",
  "scout",
  "filing",
];

/**
 * A prediction refused before anything is written: `nothing` when there is
 * no path to record, `input` when a path or the base is unusable.
 */
export class PredictionError extends JigError<"nothing" | "input"> {
  override name = "PredictionError";
}

export interface PredictionOptions {
  key: string;
  source: WriterSource;
  /** The ref the prediction read, as `<remote>/<branch>`; its commit becomes `base`. */
  baseRef: string;
  /** The paths the writer chose (a `--paths` file's lines), or `diff` for the workspace's change against `baseRef`. */
  paths: { list: string } | "diff";
}

export interface PredictionDeps {
  /** Runs git in the repository root; throws on a failed command. */
  git: GitRunner;
  /** The repository's catalog, `null` when it declares none. */
  catalog: () => ChangeAreaCatalog | null;
  /** The session a pickup runs in, `unknown` when no agent session is named. */
  session: () => string;
  /** The repository root, for telling a directory from a file. */
  root: string;
}

export interface Prediction {
  key: string;
  source: WriterSource;
  base: string;
  paths: string[];
  areas: string[];
  pickup?: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The lines of a paths file: blank lines and `#` comments skipped, `./`
 * dropped. A path line is kept as written; one with whitespace at either
 * end could name another file than the one meant, so it is refused.
 */
export function pathLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line !== line.trim())
      throw new PredictionError(
        "input",
        `a path with leading or trailing whitespace is ambiguous: ${JSON.stringify(line)}`,
      );
    out.push(line.replace(/^(?:\.\/)+/, ""));
  }
  return out;
}

/** Whether `path` is a directory in the working tree; a path not there yet is a file to come. */
function isDirectory(root: string, path: string): boolean {
  try {
    return (
      statSync(join(root, path), { throwIfNoEntry: false })?.isDirectory() ===
      true
    );
  } catch (cause) {
    throw new PredictionError(
      "input",
      `not a path in the working tree: ${JSON.stringify(path)} (${messageOf(cause)})`,
      { cause },
    );
  }
}

/**
 * A directory a footprint names, with a trailing slash the caller may have
 * written: no component of it that exists may be a file, though the
 * directory itself may be one the change will create.
 */
function assertUsableDirectory(root: string, directory: string): void {
  const parts = directory.split("/").filter((part) => part !== "");
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(join(root, prefix), { throwIfNoEntry: false });
    } catch (cause) {
      throw new PredictionError(
        "input",
        `not a path in the working tree: ${JSON.stringify(directory)} (${messageOf(cause)})`,
        { cause },
      );
    }
    if (stat === undefined) return;
    if (!stat.isDirectory())
      throw new PredictionError(
        "input",
        `not a directory in the working tree: ${JSON.stringify(prefix)}`,
      );
  }
}

/** Each path once, sorted; a directory that exists ends in `/`, and each is checked against the record's path shape. */
export function normalizePaths(raw: readonly string[], root: string): string[] {
  const out = new Set<string>();
  const refuse = (path: string) =>
    new PredictionError(
      "input",
      `not a repository path a footprint can carry: ${JSON.stringify(path)} (relative, no '..', no glob characters, at most 1,024 characters)`,
    );
  for (const path of raw) {
    if (!matches(FOOTPRINT_PATH, path)) throw refuse(path);
    const named = path.endsWith("/")
      ? path
      : isDirectory(root, path)
        ? `${path}/`
        : path;
    if (!matches(FOOTPRINT_PATH, named)) throw refuse(path);
    if (named.endsWith("/")) assertUsableDirectory(root, named);
    out.add(named);
  }
  if (out.size > FOOTPRINT_MAX_PATHS)
    throw new PredictionError(
      "input",
      `${out.size} paths is more than a footprint carries (${FOOTPRINT_MAX_PATHS}): name their directories instead`,
    );
  return [...out].sort();
}

/**
 * A changed file whose name a footprint cannot carry (a glob character, a
 * colon) stands as its nearest parent directory that it can, so one such
 * name does not cost the whole footprint; one at the top level has no such
 * directory, so it is `null` and the caller refuses it.
 */
export function carriedPath(path: string): string | null {
  const carries = (p: string): boolean => matches(FOOTPRINT_PATH, p);
  let current = path;
  while (!carries(current)) {
    const parent = dirname(current.replace(/\/$/, ""));
    if (parent === "." || parent === "/" || `${parent}/` === current)
      return null;
    current = `${parent}/`;
  }
  return current;
}

function splitNul(out: string): string[] {
  return out.split("\0").filter((p) => p !== "");
}

/**
 * The areas the paths match directly, in catalog order. A directory
 * reaches the areas whose globs match it and those of the files under it,
 * tracked or not yet added, and `changed` names the files a diff changed
 * before any was stood for by its directory.
 */
export function seedAreas(
  paths: readonly string[],
  catalog: ChangeAreaCatalog | null,
  git: GitRunner,
  changed: readonly string[] = [],
): string[] {
  if (catalog === null) return [];
  const reached = new Set<string>();
  const files = [
    ...changed,
    ...paths.flatMap((path) =>
      path.endsWith("/")
        ? [
            path,
            ...splitNul(
              git([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                path,
              ]),
            ),
          ]
        : [path],
    ),
  ];
  for (const file of files)
    for (const area of areasOf(file, catalog)) reached.add(area);
  return [...catalog.keys()].filter((key) => reached.has(key));
}

/** The commit `ref` names, full length; refused when it names none. */
export function baseCommit(ref: string, git: GitRunner): string {
  if (ref === "" || ref.startsWith("-") || /[\s\0]/.test(ref))
    throw new PredictionError(
      "input",
      `not a base ref: ${JSON.stringify(ref)}`,
    );
  let sha: string;
  try {
    sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch (cause) {
    throw new PredictionError(
      "input",
      `the base ${ref} names no commit here, or git could not read it (fetch it first): ${messageOf(cause)}`,
      { cause },
    );
  }
  if (!/^[0-9a-f]{40,64}$/.test(sha))
    throw new PredictionError("input", `the base ${ref} names no commit here`);
  return sha;
}

/**
 * The payload the writer records. Refuses, with nothing written, a
 * prediction with no path (`nothing`: a filing from a description alone
 * writes no footprint) and one whose paths or base are unusable (`input`).
 */
export function predictFootprint(
  options: PredictionOptions,
  deps: PredictionDeps,
): Prediction {
  const base = baseCommit(options.baseRef, deps.git);
  const changed =
    options.paths === "diff"
      ? changedFilesFromWorktree(options.baseRef, deps.git)
      : [];
  const raw =
    options.paths === "diff"
      ? changed.map((file) => {
          const carried = carriedPath(file);
          if (carried === null)
            throw new PredictionError(
              "input",
              `a changed top-level file a footprint cannot name: ${JSON.stringify(file)}`,
            );
          return carried;
        })
      : pathLines(options.paths.list);
  const paths = normalizePaths(raw, deps.root);
  if (paths.length === 0)
    throw new PredictionError(
      "nothing",
      options.paths === "diff"
        ? `the workspace has no change against ${options.baseRef}: no footprint written`
        : "no path was named: no footprint written",
    );
  const session = options.source === "pickup" ? deps.session() : "unknown";
  return {
    key: options.key,
    source: options.source,
    base,
    paths,
    areas: seedAreas(paths, deps.catalog(), deps.git, changed),
    ...(session === "unknown" || session === "" ? {} : { pickup: session }),
  };
}

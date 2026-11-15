/** Repository-relative ignored paths that can be rebuilt from tracked inputs. */
import { failed, ok, type Outcome } from "../shared/outcome.ts";

/** Caches made by the tools Jig's gates run, without requiring cache tags. */
export const DEFAULT_REGENERABLE_PATHS = [".fallow"];

/** A literal worktree path; no normalization may broaden its authority. */
export function regenerablePaths(
  value: unknown,
): Outcome<string[], "configuration"> {
  if (value === undefined) return ok([...DEFAULT_REGENERABLE_PATHS]);
  const refused = () =>
    failed(
      "configuration",
      "gc.regenerable_paths must be distinct literal relative paths, without traversal, glob characters, or .context content outside .context/scratch",
    );
  if (!Array.isArray(value)) return refused();
  const paths: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !entry ||
      entry.trim() !== entry ||
      /[\\:*?[\]{}]/.test(entry) ||
      [...entry].some((character) => character.charCodeAt(0) < 32)
    )
      return refused();
    const path = entry.replace(/\/$/, "");
    const protectedPath = path.toLowerCase();
    if (
      path
        .split("/")
        .some(
          (part) =>
            !part || part === "." || part === ".." || /[. ]$/.test(part),
        ) ||
      protectedPath === ".git" ||
      protectedPath.startsWith(".git/") ||
      ((protectedPath === ".context" ||
        protectedPath.startsWith(".context/")) &&
        protectedPath !== ".context/scratch" &&
        !protectedPath.startsWith(".context/scratch/"))
    )
      return refused();
    if (paths.includes(path)) return refused();
    paths.push(path);
  }
  return ok(paths);
}

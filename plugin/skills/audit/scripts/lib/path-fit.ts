import { existsSync } from "node:fs";
import { posix } from "node:path";
import { configuredAt, repoRelativeAt, trackedFiles } from "./repo.ts";
import type { Field, Finding } from "./schema.ts";

/**
 * Whether the repository tracks `path`: the follow-up reads a repository
 * arm's files from the integration branch, where an untracked or ignored
 * file does not exist.
 */
function trackedFromRoot(root: string, path: string): boolean {
  const name = posix
    .normalize(path.trim().replace(/\\/g, "/"))
    .replace(/^\.\//, "");
  return trackedFiles(root).includes(name);
}

/** A configured path that does not exist, when the field expects it to. */
export function pathFindings(
  field: Field,
  value: unknown,
  root: string,
  fromRoot = false,
): Finding[] {
  if (!field.exists || field.exists === "machine") return [];
  if (typeof value !== "string" || value.trim() === "") return [];
  if (!fromRoot && value.startsWith("~")) return [];
  const at = fromRoot ? repoRelativeAt : configuredAt;
  if (
    existsSync(at(root, value)) &&
    (!fromRoot || trackedFromRoot(root, value))
  )
    return [];
  const required = field.exists === "required";
  return [
    {
      id: `derivation:${field.path}`,
      severity: required ? "error" : "warning",
      message: `${field.path}: ${value} does not exist${
        required ? `; ${field.read_by.join(", ")} refuse(s) to run` : ""
      }`,
    },
  ];
}

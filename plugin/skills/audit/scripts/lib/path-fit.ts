import { existsSync } from "node:fs";
import { configuredAt, repoRelativeAt } from "./repo.ts";
import type { Field, Finding } from "./schema.ts";

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
  if (existsSync(at(root, value))) return [];
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

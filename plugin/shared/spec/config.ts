/**
 * The `specs` section of the repository's configuration: which spec
 * adapters the resolver runs, in which order, and the heading of the body
 * section that names an item's spec. Read through the shared configuration
 * reader, so every layer applies; both fields describe one repository, so the
 * user file refuses them (`config-layers.ts`). A field set to `null` reads
 * as not set, as elsewhere in the configuration.
 */
import { layeredConfig, withSource } from "../consumer.ts";
import { isRecord } from "../guards.ts";
import { headingKey, INLINE_HEADINGS } from "./markdown.ts";

/** The fields of `specs`; any other key is refused. */
export const SPECS_FIELDS = ["adapters", "body_section"] as const;

/** The heading of the body section that names an item's spec. */
export const DEFAULT_BODY_SECTION = "Spec";

export interface SpecsConfig {
  /** The adapters to run, in order; `null` runs every one whose layout is present. */
  adapters: string[] | null;
  /** The heading text of the body section that names the spec. */
  bodySection: string;
}

/** A `specs` value the resolver cannot use. */
class SpecConfigError extends Error {
  override name = "SpecConfigError";
}

function adapterList(value: unknown, known: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((v) => typeof v !== "string" || v.trim() === "") ||
    new Set(value).size !== value.length
  )
    throw new SpecConfigError(
      "specs.adapters must be a list of distinct adapter names",
    );
  for (const name of value as string[])
    if (!known.includes(name))
      throw new SpecConfigError(
        `specs.adapters names an unknown adapter ${name} (known: ${known.join(", ")})`,
      );
  return value as string[];
}

function heading(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    /[\r\n]/.test(value) ||
    value.trim().startsWith("#")
  )
    throw new SpecConfigError(
      "specs.body_section must be a heading's text on one line, without the leading #",
    );
  const builtIn = Object.values(INLINE_HEADINGS).find(
    (h) => headingKey(h) === headingKey(value),
  );
  if (builtIn !== undefined)
    throw new SpecConfigError(
      `specs.body_section must differ from the ${builtIn} heading, which is read on its own`,
    );
  return value.trim();
}

/** The `specs` section, checked; `known` are the adapter names there are. */
export function parseSpecsConfig(
  section: unknown,
  known: readonly string[],
): SpecsConfig {
  if (section === undefined || section === null)
    return { adapters: null, bodySection: DEFAULT_BODY_SECTION };
  if (!isRecord(section)) throw new SpecConfigError("specs must be a mapping");
  for (const key of Object.keys(section))
    if (!(SPECS_FIELDS as readonly string[]).includes(key))
      throw new SpecConfigError(
        `specs.${key} is not a field (known: ${SPECS_FIELDS.join(", ")})`,
      );
  return {
    adapters:
      section.adapters === undefined || section.adapters === null
        ? null
        : adapterList(section.adapters, known),
    bodySection:
      section.body_section === undefined || section.body_section === null
        ? DEFAULT_BODY_SECTION
        : heading(section.body_section),
  };
}

/**
 * The `specs` section of the repository at `root`, every layer merged. An
 * error names the file or variable that set the field at fault.
 */
export function readSpecsConfig(
  root: string,
  known: readonly string[],
  env: Record<string, string | undefined> = process.env,
): SpecsConfig {
  const values = layeredConfig(root, env).values;
  try {
    return parseSpecsConfig(values.specs, known);
  } catch (err) {
    throw withSource(values, "specs", err);
  }
}

/**
 * The plugin's one reader of the consumer's change-area catalog
 * (`drive.change_areas_catalog`): a YAML file whose `areas` map names each
 * area of the repository by key. Every skill that reads the catalog, or
 * matches a path glob, imports this module by sibling path.
 *
 * It reads the part of the catalog the plugin acts on:
 *
 *   areas:
 *     <area key>:
 *       paths: ["src/api/**"]          # globs that define membership
 *       generated: [{ source: [...] }] # optional: generator sources, also members
 *       labels: [delivery]             # optional: the area's own labels
 *       tracker:                       # optional; `linear:` is the older spelling
 *         labels: [area:api]           #   tracker labels for the area
 *         flags: [security]            #   flag labels every change there carries
 *
 * Matching is direct: a path belongs to the areas whose own globs match it.
 * The areas a change implies through other areas are the full resolver's
 * business, not this reader's. Every other field stays available as written
 * (`fields`), for the consumer's own tooling and for skills that read one
 * more field, such as `agent`.
 */
import { readFileSync } from "node:fs";
import { load as loadYaml } from "../../../../shared/yaml.ts";
import { isRecord } from "../../../../shared/guards.ts";

export interface CatalogArea {
  /** `paths` and every `generated[].source`, in that order. */
  globs: string[];
  /** `labels`, then `trackerLabels`. */
  labels: string[];
  /** `tracker.labels`, then `linear.labels`. */
  trackerLabels: string[];
  /** `tracker.flags`, then `linear.flags`. */
  flags: string[];
  /** The area as the catalog writes it. */
  fields: Readonly<Record<string, unknown>>;
}

/** The catalog's areas by key, in the catalog's order. */
export type ChangeAreaCatalog = ReadonlyMap<string, CatalogArea>;

// Only an omitted field reads as empty. A present one, `null` included, must
// have its shape: read as empty, a malformed area would silently drop its
// paths, its labels or its flags.
function stringList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

// A list of globs, each compiled: a bad one is named by its field and index.
function globList(v: unknown, where: string): string[] {
  const globs = stringList(v, where);
  globs.forEach((glob, i) => {
    const problem = globProblem(glob);
    if (problem !== null) throw new Error(`${where}[${i}]: ${problem}`);
  });
  return globs;
}

// The tracker block in both spellings, each checked for its shape.
const TRACKER_BLOCKS = ["tracker", "linear"] as const;

function trackerLists(
  area: Record<string, unknown>,
  key: string,
  field: "labels" | "flags",
): string[] {
  return TRACKER_BLOCKS.flatMap((block) => {
    const b = area[block];
    if (b === undefined) return [];
    if (!isRecord(b))
      throw new Error(`catalog area ${key}.${block}: not a mapping`);
    return stringList(b[field], `catalog area ${key}.${block}.${field}`);
  });
}

/** Validate a parsed catalog into its areas. Throws with the field at fault. */
export function parseCatalog(raw: unknown): Map<string, CatalogArea> {
  if (!isRecord(raw) || !isRecord(raw.areas))
    throw new Error("the change-area catalog has no `areas` mapping");
  const out = new Map<string, CatalogArea>();
  for (const [key, area] of Object.entries(raw.areas)) {
    if (!isRecord(area)) throw new Error(`catalog area ${key}: not a mapping`);
    const generated = area.generated === undefined ? [] : area.generated;
    if (!Array.isArray(generated))
      throw new Error(`catalog area ${key}.generated: expected a list`);
    const globs = [
      ...globList(area.paths, `catalog area ${key}.paths`),
      ...generated.flatMap((g, i) => {
        if (!isRecord(g))
          throw new Error(`catalog area ${key}.generated[${i}]: not a mapping`);
        return globList(g.source, `catalog area ${key}.generated[${i}].source`);
      }),
    ];
    const trackerLabels = trackerLists(area, key, "labels");
    const labels = [
      ...stringList(area.labels, `catalog area ${key}.labels`),
      ...trackerLabels,
    ];
    const flags = trackerLists(area, key, "flags");
    out.set(key, { globs, labels, trackerLabels, flags, fields: area });
  }
  return out;
}

/** Read and validate the consumer's catalog. Throws with the path and the reason. */
export function loadCatalogFile(path: string): Map<string, CatalogArea> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `the change-area catalog ${path} could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    return parseCatalog(loadYaml(text));
  } catch (err) {
    throw new Error(
      `the change-area catalog ${path} is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const globCache = new Map<string, RegExp>();

// Each helper reads the token starting at `i` and returns its regular
// expression source and how many glob characters it used.

function starToken(glob: string, i: number): [string, number] {
  if (glob.charAt(i + 1) !== "*") return ["[^/]*", 1];
  return glob.charAt(i + 2) === "/" ? ["(?:[^]*/)?", 3] : ["[^]*", 2];
}

// An unclosed `[` is a literal bracket. A leading `!` or `^` negates the
// class; a `]` first among the members (`[]]`, `[!]]`, `[^]]`) is a member,
// not its end. A class never matches `/`, which separates segments, negated
// or not.
function classToken(glob: string, i: number): [string, number] {
  const negated = glob.charAt(i + 1) === "!" || glob.charAt(i + 1) === "^";
  const first = negated ? i + 2 : i + 1;
  const end = glob.indexOf("]", glob.charAt(first) === "]" ? first + 1 : first);
  if (end === -1) return ["\\[", 1];
  const members = glob.slice(first, end).replace(/[\\\]^]/g, "\\$&");
  return [`(?!/)[${negated ? "^" : ""}${members}]`, end - i + 1];
}

/**
 * A path glob as a regular expression over a repository-relative path: `**`
 * spans directories, `*` and `?` stay within one segment, `{a,b}` alternates
 * and `[...]` is a character class (`[!...]` or `[^...]` negates). Dotfiles
 * match like any other name (catalogs list paths such as `.github/**`). Throws
 * on a glob that compiles to no pattern, such as an unclosed `{` or a range
 * like `[z-a]`; `globProblem` says why without throwing. A class never matches
 * `/`, and `**` spans every character a path can hold, newlines included.
 */
export function globToRegExp(glob: string): RegExp {
  const hit = globCache.get(glob);
  if (hit !== undefined) return hit;
  const compiled = compileGlob(glob);
  globCache.set(glob, compiled);
  return compiled;
}

// One token outside a character class or `*`: braces open, separate and
// close an alternation; anything else is a literal.
function plainToken(c: string, depth: number): [string, number] {
  if (c === "?") return ["[^/]", 0];
  if (c === "{") return ["(?:", 1];
  if (c === "}" && depth > 0) return [")", -1];
  if (c === "," && depth > 0) return ["|", 0];
  return [c.replace(/[.+^${}()|\\/\]]/g, "\\$&"), 0];
}

function compileGlob(glob: string): RegExp {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; ) {
    const c = glob.charAt(i);
    let token: string;
    let width = 1;
    if (c === "*") [token, width] = starToken(glob, i);
    else if (c === "[") [token, width] = classToken(glob, i);
    else {
      let change: number;
      [token, change] = plainToken(c, depth);
      depth += change;
    }
    re += token;
    i += width;
  }
  if (depth > 0) throw new Error(`"${glob}" is not a valid glob: unclosed {`);
  try {
    return new RegExp(`^${re}$`);
  } catch (err) {
    throw new Error(
      `"${glob}" is not a valid glob: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Why `glob` cannot be compiled, or `null` when it can. */
export function globProblem(glob: string): string | null {
  try {
    globToRegExp(glob);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file);
}

/** The keys of the areas whose own globs claim `file`, in catalog order. */
export function areasOf(file: string, catalog: ChangeAreaCatalog): string[] {
  const out: string[] = [];
  for (const [key, area] of catalog)
    if (area.globs.some((g) => matchesGlob(file, g))) out.push(key);
  return out;
}

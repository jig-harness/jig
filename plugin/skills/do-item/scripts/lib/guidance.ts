/**
 * Implementation guidance: the skills and notes an item's kind of change
 * brings to whichever agent implements it.
 *
 *   do_item:
 *     guidance:
 *       - labels: [kind:db-migration]     # the issue carries one of these
 *         paths: ["db/migrations/**"]     # or the change touches one of these
 *         skills: [migration-safety]
 *         notes: "Add a rollback script beside every forward migration."
 *
 * An entry matches the way a `do_item.gates` entry does: by one of its
 * labels (any case), or by one of its paths. A change-area catalog adds the
 * same per area (`implementation: {skills, notes}`) for the areas the item
 * reaches, and the area's own `notes` with it. The guidance is the union of
 * the matching entries, in entry order, then the matched areas in catalog
 * order.
 *
 * Paths are known before the change exists only when the caller passes the
 * files it plans to touch. Without them, an entry or an area that has paths
 * and no matching label is printed apart (`byPath`), for the orchestrator to apply
 * when the change plausibly touches those paths, as it does a gate.
 */
import { formatField } from "../../../../shared/config-layers.ts";
import { JigError } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  type ChangeAreaCatalog,
  globProblem,
  matchesGlob,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";

export interface GuidanceEntry {
  /** Lowercased: labels match in any case. */
  labels: string[];
  paths: string[];
  skills: string[];
  notes: string | null;
}

const ENTRY_KEYS = ["labels", "paths", "skills", "notes"];

function textList(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) ||
    v.some((x) => typeof x !== "string" || x.trim() === "")
  )
    throw new JigError(
      "guidance-invalid",
      `${where} must be a list of nonempty strings`,
    );
  return v as string[];
}

function noteText(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.trim() === "")
    throw new JigError("guidance-invalid", `${where} must be nonempty text`);
  return v;
}

/** Validate `do_item.guidance` from the `do_item` section. */
export function parseGuidance(
  section: Record<string, unknown>,
): GuidanceEntry[] {
  const raw = section.guidance;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new JigError(
      "guidance-invalid",
      "do_item.guidance must be a list of {labels, paths, skills, notes}",
    );
  return raw.map(parseEntry);
}

/** One `do_item.guidance` entry, validated. */
function parseEntry(entry: unknown, i: number): GuidanceEntry {
  const at = `do_item.guidance[${i}]`;
  if (!isRecord(entry))
    throw new JigError("guidance-invalid", `${at} must be a mapping`);
  for (const key of Object.keys(entry))
    if (!ENTRY_KEYS.includes(key))
      throw new JigError(
        "guidance-invalid",
        `${at}.${formatField([key])} is not a known field (${ENTRY_KEYS.join(", ")})`,
      );
  const labels = textList(entry.labels, `${at}.labels`);
  const paths = globList(entry.paths, `${at}.paths`);
  const skills = textList(entry.skills, `${at}.skills`);
  const notes = noteText(entry.notes, `${at}.notes`);
  if (labels.length === 0 && paths.length === 0)
    throw new JigError(
      "guidance-invalid",
      `${at} must name labels or paths to match on`,
    );
  if (skills.length === 0 && notes === null)
    throw new JigError("guidance-invalid", `${at} must give skills or notes`);
  return { labels: labels.map((l) => l.toLowerCase()), paths, skills, notes };
}

/** A list of globs, each one that compiles. */
function globList(v: unknown, where: string): string[] {
  const globs = textList(v, where);
  for (const glob of globs) {
    const problem = globProblem(glob);
    if (problem !== null)
      throw new JigError(
        "guidance-invalid",
        `${where}: ${JSON.stringify(glob)} does not compile: ${problem}`,
      );
  }
  return globs;
}

/** An area's `implementation` block, or `null` when it declares none. */
export function areaImplementation(
  key: string,
  fields: Readonly<Record<string, unknown>>,
): { skills: string[]; notes: string | null } | null {
  const raw = fields.implementation;
  if (raw === undefined) return null;
  const at = `change area ${key}: implementation`;
  if (!isRecord(raw))
    throw new JigError(
      "guidance-invalid",
      `${at} must be a mapping of {skills, notes}`,
    );
  for (const k of Object.keys(raw))
    if (k !== "skills" && k !== "notes")
      throw new JigError(
        "guidance-invalid",
        `${at}.${formatField([k])} is not a known field (skills, notes)`,
      );
  const skills = textList(raw.skills, `${at}.skills`);
  const notes = noteText(raw.notes, `${at}.notes`);
  if (skills.length === 0 && notes === null)
    throw new JigError("guidance-invalid", `${at} must give skills or notes`);
  return { skills, notes };
}

/** One source of guidance that matched, and what it brings. */
export interface GuidanceSource {
  /** `do_item.guidance[<i>]`, or `area <key>`. */
  from: string;
  /** Why it matched: `label <label>`, `path <path>`, or for an area how the area was reached. */
  by: string;
  skills: string[];
  notes: string[];
}

export interface Guidance {
  /** Every matched source's skills, each once, in source order. */
  skills: string[];
  /** Every matched source's notes, in source order. */
  notes: Array<{ from: string; text: string }>;
  sources: GuidanceSource[];
  /** Entries with paths and no matching label, when no planned paths were given. */
  byPath: Array<{
    from: string;
    paths: string[];
    skills: string[];
    notes: string[];
  }>;
}

/** An area the item reaches, and how. */
export interface MatchedArea {
  key: string;
  by: string;
}

/**
 * The areas the item reaches: by a label `do_item.agents.codearea_areas`
 * maps to it, by one of the area's own tracker labels, or by a planned path
 * its globs claim; in catalog order.
 */
export function matchedAreas(
  labels: readonly string[],
  codeareaAreas: Record<string, string>,
  catalog: ChangeAreaCatalog,
  paths: readonly string[] | null,
): MatchedArea[] {
  const lower = labels.map((l) => l.toLowerCase());
  const out: MatchedArea[] = [];
  for (const [key, area] of catalog) {
    const viaMap = lower.find(
      (l) => Object.hasOwn(codeareaAreas, l) && codeareaAreas[l] === key,
    );
    const viaTracker = lower.find((l) =>
      area.trackerLabels.some((t) => t.toLowerCase() === l),
    );
    const viaPath = paths?.find((p) =>
      area.globs.some((g) => matchesGlob(p, g)),
    );
    const by =
      viaMap !== undefined
        ? `label ${viaMap}`
        : viaTracker !== undefined
          ? `label ${viaTracker}`
          : viaPath !== undefined
            ? `path ${viaPath}`
            : null;
    if (by !== null) out.push({ key, by });
  }
  return out;
}

/** What an area brings: its implementation skills and notes, and its own notes. */
function areaGuidance(
  key: string,
  catalog: ChangeAreaCatalog | null,
): { skills: string[]; notes: string[] } {
  const fields = catalog?.get(key)?.fields ?? {};
  const impl = areaImplementation(key, fields);
  const own =
    typeof fields.notes === "string" && fields.notes.trim() !== ""
      ? [fields.notes]
      : [];
  return {
    skills: impl?.skills ?? [],
    notes: [...(impl?.notes == null ? [] : [impl.notes]), ...own],
  };
}

/** Add `entry` to `sources` when it matches, or to `byPath` when only its paths could and none are known. */
function matchEntry(
  entry: GuidanceEntry,
  from: string,
  lower: ReadonlySet<string>,
  paths: readonly string[] | null,
  sources: GuidanceSource[],
  byPath: Guidance["byPath"],
): void {
  const notes = entry.notes === null ? [] : [entry.notes];
  const label = entry.labels.find((l) => lower.has(l));
  if (label !== undefined) {
    sources.push({ from, by: `label ${label}`, skills: entry.skills, notes });
    return;
  }
  if (entry.paths.length === 0) return;
  if (paths === null) {
    byPath.push({ from, paths: entry.paths, skills: entry.skills, notes });
    return;
  }
  const path = paths.find((p) => entry.paths.some((g) => matchesGlob(p, g)));
  if (path !== undefined)
    sources.push({ from, by: `path ${path}`, skills: entry.skills, notes });
}

const hasGuidance = (g: { skills: string[]; notes: string[] }): boolean =>
  g.skills.length > 0 || g.notes.length > 0;

/** The areas no label reached that bring guidance, for when the planned paths are not known. */
function unreachedAreas(
  catalog: ChangeAreaCatalog | null,
  areas: readonly MatchedArea[],
): Guidance["byPath"] {
  const reached = new Set(areas.map((a) => a.key));
  const out: Guidance["byPath"] = [];
  for (const [key, area] of catalog ?? []) {
    const g = areaGuidance(key, catalog);
    if (!reached.has(key) && area.globs.length > 0 && hasGuidance(g))
      out.push({ from: `area ${key}`, paths: area.globs, ...g });
  }
  return out;
}

/** The guidance for an item with `labels`, planned `paths` (`null`: not known yet) and the areas it reaches. */
export function resolveGuidance(
  entries: readonly GuidanceEntry[],
  labels: readonly string[],
  paths: readonly string[] | null,
  areas: readonly MatchedArea[],
  catalog: ChangeAreaCatalog | null,
): Guidance {
  const lower = new Set(labels.map((l) => l.toLowerCase()));
  const sources: GuidanceSource[] = [];
  const byPath: Guidance["byPath"] = [];
  for (const [i, entry] of entries.entries())
    matchEntry(entry, `do_item.guidance[${i}]`, lower, paths, sources, byPath);
  for (const { key, by } of areas) {
    const g = areaGuidance(key, catalog);
    if (hasGuidance(g)) sources.push({ from: `area ${key}`, by, ...g });
  }
  if (paths === null) byPath.push(...unreachedAreas(catalog, areas));
  return {
    skills: [...new Set(sources.flatMap((s) => s.skills))],
    notes: sources.flatMap((s) =>
      s.notes.map((text) => ({ from: s.from, text })),
    ),
    sources,
    byPath,
  };
}

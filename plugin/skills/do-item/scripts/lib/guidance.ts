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
 * An entry is a rule over the item's labels and the change's paths, which
 * the shared rule matcher reads (`do_item.guidance` in its `RULE_FIELDS`):
 * every matching entry applies, as every matching `do_item.gates` entry does. A change-area catalog adds the
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
  matchRule,
  parseEntryRule,
  resolve,
  type Rule,
} from "../../../../shared/rule-matcher.ts";
import type { ChangeAreaCatalog } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";

const GUIDANCE = "do_item.guidance";

export interface GuidanceEntry {
  /** The entry's `labels` and `paths`, as the rule matcher reads them. */
  rule: Rule;
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
  return raw.map((entry, i) => parseEntry(entry, i));
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
  const rule = parseEntryRule(GUIDANCE, entry, at);
  if (!rule.ok) throw new JigError("guidance-invalid", rule.failure.reason);
  const skills = textList(entry.skills, `${at}.skills`);
  const notes = noteText(entry.notes, `${at}.notes`);
  if (skills.length === 0 && notes === null)
    throw new JigError("guidance-invalid", `${at} must give skills or notes`);
  return { rule: rule.value, skills, notes };
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
 * maps to it (`areaOf`, the rule matcher's lookup), by one of the area's own
 * tracker labels, or by a planned path its globs claim; in catalog order.
 */
export function matchedAreas(
  labels: readonly string[],
  areaOf: (label: string) => string | undefined,
  catalog: ChangeAreaCatalog,
  paths: readonly string[] | null,
): MatchedArea[] {
  const out: MatchedArea[] = [];
  for (const [key, area] of catalog) {
    const viaMap = labels.find((l) => areaOf(l) === key);
    const own = matchRule(
      { labels: area.trackerLabels, paths: area.globs },
      { labels, paths: paths ?? [] },
    );
    const by =
      viaMap === undefined ? ownReach(own) : `label ${viaMap.toLowerCase()}`;
    if (by !== null) out.push({ key, by });
  }
  return out;
}

/** How an area's own labels or globs reached the item, or `null`. */
function ownReach(own: ReturnType<typeof matchRule>): string | null {
  if (own === null || own === "unknown") return null;
  return own.fact === "labels"
    ? `label ${own.value.toLowerCase()}`
    : `path ${own.value}`;
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
  const sources: GuidanceSource[] = [];
  const byPath: Guidance["byPath"] = [];
  const { matches, undecided } = resolve(
    GUIDANCE,
    entries.map((e) => e.rule),
    { labels, paths },
  );
  const notesOf = (e: GuidanceEntry) => (e.notes === null ? [] : [e.notes]);
  // Matches and undecided entries, each in entry order.
  for (const [i, entry] of entries.entries()) {
    const from = `${GUIDANCE}[${i}]`;
    const m = matches.find((x) => x.at === i);
    if (m !== undefined)
      sources.push({
        from,
        by: `${m.fact === "labels" ? "label" : "path"} ${m.fact === "labels" ? m.value.toLowerCase() : m.value}`,
        skills: entry.skills,
        notes: notesOf(entry),
      });
    else if (undecided.includes(i))
      byPath.push({
        from,
        paths: [...(entry.rule.paths ?? [])],
        skills: entry.skills,
        notes: notesOf(entry),
      });
  }
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

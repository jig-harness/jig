/**
 * The projections of one resolution, so every consumer reads the catalog
 * instead of restating its globs:
 *
 *   - GitHub Actions outputs: `key=true|false` per area;
 *   - a dorny/paths-filter spec: each area's globs, a static projection;
 *   - JSON, for tooling and agents, with the validation plan the change owes;
 *   - a post-deploy checklist and a review-gate table, as Markdown.
 *
 * Which projection reads the seed areas and which reads the closure is a
 * decision per projection. The closure answers "what are the consequences":
 * the flags, post-deploy actions and mandatory reviews read it, because an
 * under-triggered review is a missed defect and an extra one costs a run.
 * The seeds answer "what did this change touch": the validation plan, the
 * generated checks and the tracker labels read them, because a label is a
 * lasting claim about the change itself.
 *
 * The validation plan's building blocks are exported so a composer can
 * rebuild its own policy from them, in its own order.
 */
import { dump } from "../../../../shared/yaml.ts";
import {
  type Catalog,
  deepestProfile,
  type PostDeployAction,
  profileOf,
  profileOrder,
  trackerOf,
} from "./catalog.ts";
import { matchSeedAreas, seedGlobs, transitiveImpliedBy } from "./resolve.ts";

/** One resolution: what changed, what it seeded, what the closure reached. */
export interface ResolutionContext {
  changedFiles: string[];
  seed: Set<string>;
  resolved: Set<string>;
  catalog: Catalog;
}

/** The checks a change owes, before commit and when verifying. */
export interface CheckLists {
  localChecks: string[];
  verificationChecks: string[];
}

/** The validation plan: the `validation` block of the JSON. */
export interface ValidationPlan extends CheckLists {
  /** The seed areas the plan derives from, sorted. */
  sourceAreas: string[];
  /** The selected profiles, in declared order. */
  profiles: string[];
  /**
   * The plan's remote-runner half: whether the change must also run its
   * verification on a heavier, CI-identical machine before a push. The
   * generic plan never requires one; a composer whose repository uses such
   * a runner supplies its own plan. drive-pr's round plan reads this block.
   */
  testbox: {
    required: boolean;
    command: string | null;
    warmupCommand: string | null;
    reason: string | null;
    /** The files that made `required` true, by the area each seeded. */
    requiredBy: Array<{ area: string; files: string[] }>;
  };
  /** The repository's hooks run for every profile. */
  repositoryHooksRequired: true;
  /** Required CI runs for every profile. */
  githubCiRequired: true;
}

export interface ResolutionJson {
  changedFiles: string[];
  /** Areas a changed file matches directly. */
  seedAreas: string[];
  /** The seed areas and what the `impliedBy` closure adds. */
  areas: string[];
  /** Every area, affected or not: the GitHub outputs as an object. */
  flags: Record<string, boolean>;
  /** Post-deploy actions of the affected areas. */
  postDeploy: Array<{ area: string; action: PostDeployAction }>;
  /** Mandatory review skills by affected area. */
  review: Array<{ area: string; skills: string[] }>;
  /** `review[].skills` flattened without repeats: the skills to invoke. */
  reviewSkills: string[];
  /**
   * The tracker labels and flags of the seed areas, sorted. The key keeps
   * its established name: drive-pr's round plan reads it.
   */
  linear: { labels: string[]; flags: string[] };
  /** The validation plan; `null` when the caller asked for none (`--no-validation`). */
  validation: ValidationPlan | null;
  /** The generators of the seed areas. */
  generated: Array<{
    area: string;
    outputs: string[];
    source: string[];
    command: string;
    check: string;
  }>;
}

/**
 * A validation plan the generic policy cannot make: the change selects a
 * profile the catalog names but does not define, so the plan would list no
 * checks for it. The catalog defines `profiles:`, or its composer supplies
 * the plan.
 */
export class ValidationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationPlanError";
  }
}

/** Sorted area keys: every format lists areas in this order. */
function areaKeys(catalog: Catalog): string[] {
  return Object.keys(catalog.areas).sort();
}

/**
 * GitHub Actions outputs: `key=true|false` per area for the resolved set,
 * then `key-seed=true|false` per area for the direct match only (a job that
 * stands in for a path filter of its own gates on the seed, or every area
 * in its fan-in would trigger it too), then the composer's own lines.
 */
export function toGhaOutputs(
  ctx: ResolutionContext,
  extraLines: string[] = [],
): string {
  const keys = areaKeys(ctx.catalog);
  return [
    ...keys.map((key) => `${key}=${ctx.resolved.has(key)}`),
    ...keys.map((key) => `${key}-seed=${ctx.seed.has(key)}`),
    ...extraLines,
  ].join("\n");
}

/**
 * A dorny/paths-filter spec: each area's seed globs plus those of every area
 * that implies it, so the filter matches exactly when the resolver would
 * call the area affected. Static: it reads no changed files.
 */
export function toDornyFilter(catalog: Catalog): string {
  const filter: Record<string, string[]> = {};
  for (const key of areaKeys(catalog))
    filter[key] = triggerGlobs(catalog, key).sort();
  return dump(filter, { sortKeys: true, lineWidth: -1 });
}

/**
 * The globs whose change makes `key` affected: its own seed globs, then
 * those of every area that implies it, transitively, each once.
 */
export function triggerGlobs(catalog: Catalog, key: string): string[] {
  const globs = new Set(seedGlobs(catalog, key));
  for (const implier of transitiveImpliedBy(key, catalog))
    for (const glob of seedGlobs(catalog, implier)) globs.add(glob);
  return [...globs];
}

/**
 * The post-deploy actions of the affected areas as a Markdown checklist,
 * each naming its area and envs. Empty when there are none.
 */
export function toPostDeployChecklist(ctx: ResolutionContext): string {
  const entries: Array<{ title: string; action: PostDeployAction }> = [];
  for (const key of areaKeys(ctx.catalog)) {
    const area = ctx.catalog.areas[key];
    if (!ctx.resolved.has(key) || !area?.postDeploy?.length) continue;
    for (const action of area.postDeploy)
      entries.push({ title: area.title, action });
  }
  if (entries.length === 0) return "";
  const lines = [
    "## Post-Deploy Actions Required",
    "",
    "> Run the following **after** the new image is rolled in each env. Order matters.",
    "",
  ];
  for (const { title, action } of entries) {
    lines.push(`- [ ] **[${title}]** ${action.action}`);
    lines.push(`  - _When_: ${action.when}`);
    lines.push(`  - _Envs_: ${action.envs.join(", ")}`);
    if (action.notes)
      lines.push(
        ...action.notes
          .trim()
          .split("\n")
          .map((l) => `  > ${l.trim()}`),
      );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** The repository's own lines around the review-gate table. */
export interface ReviewTableOptions {
  /** The generated-file comment at the top. */
  comment?: string[];
  /** Lines between the title and the table. */
  preamble?: string[];
  /** Lines after the table. */
  footer?: string[];
  /** How the key column names the catalog. */
  catalogLabel?: string;
}

/**
 * The review gates as a Markdown table: one row per area with
 * `review.skills`, in key order. Its trigger paths are every glob that makes
 * the area affected, as the resolver reads it: the area's seed globs (a
 * generator's source triggers the same review as its own paths), then those
 * of each area that implies it, so a change to a library lists the reviews
 * of every area it reaches.
 */
export function toReviewGateTable(
  catalog: Catalog,
  options: ReviewTableOptions = {},
): string {
  const label = options.catalogLabel ?? "catalog.yaml";
  const comment = options.comment ?? [
    `<!-- Generated from ${label} (each area's review.skills): do not edit by hand. -->`,
  ];
  const headers = [
    "Area",
    `\`${label}\` key`,
    "Trigger paths",
    "Review skills",
  ];
  const rows: string[] = [];
  for (const key of areaKeys(catalog)) {
    const area = catalog.areas[key];
    if (!area?.review) continue;
    const skills = area.review.skills.map((s) => `\`/${s}\``).join(", ");
    const paths = triggerGlobs(catalog, key)
      .map((p) => `\`${p}\``)
      .join("<br>");
    const notes = area.review.notes?.trim().replace(/\s+/g, " ") ?? "";
    rows.push(
      `| ${area.title} | \`${key}\` | ${paths} | ${skills}${notes ? ` — ${notes}` : ""} |`,
    );
  }
  const preamble = options.preamble ?? [];
  const footer = options.footer ?? [];
  return [
    ...comment,
    "",
    "# Area → Review-Skill Gate Table",
    "",
    ...(preamble.length ? [...preamble, ""] : []),
    `| ${headers.join(" | ")} |`,
    `|${headers.map((h) => "-".repeat(h.length + 2)).join("|")}|`,
    ...rows,
    ...(footer.length ? ["", ...footer] : []),
  ].join("\n");
}

// ── the validation plan ────────────────────────────────────────────────────

/** The groups' entries in order, each once. */
export function orderedUnion(groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

/** One single-quoted shell word, so only the shell that runs it expands it. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Whether any one changed file matches no area: a coverage gap, which fails
 * closed to the deepest profile even when other files match narrow areas.
 */
export function hasUnmatchedFile(
  changedFiles: string[],
  catalog: Catalog,
): boolean {
  return changedFiles.some(
    (file) => matchSeedAreas([file], catalog).size === 0,
  );
}

/**
 * The profiles a change selects, in declared order: each seed area's own
 * (the deepest when it declares none), and the deepest when a changed file
 * matches no area. The profile is read from the seeds, never the closure: a
 * docs change that implies a downstream area does not take on that area's
 * depth.
 */
export function selectedProfiles(ctx: ResolutionContext): string[] {
  const { catalog } = ctx;
  const selected = new Set<string>();
  for (const key of ctx.seed) {
    const area = catalog.areas[key];
    const profile = area ? profileOf(area, catalog) : undefined;
    if (profile !== undefined) selected.add(profile);
  }
  const deepest = deepestProfile(catalog);
  if (deepest !== undefined && hasUnmatchedFile(ctx.changedFiles, catalog))
    selected.add(deepest);
  const order = profileOrder(catalog);
  return order.length
    ? order.filter((p) => selected.has(p))
    : [...selected].sort();
}

/**
 * Fold the seed areas' generators into the lists: each `command` goes before
 * the profile's local checks (a regenerated file must be formatted, tested
 * and built in its fresh state, not regenerated after them), moved there
 * when a profile already lists it later, and each `check` after the
 * verification checks; none is listed twice.
 */
export function foldGenerated(
  lists: CheckLists,
  sourceAreas: string[],
  catalog: Catalog,
): CheckLists {
  const localChecks = [...lists.localChecks];
  const verificationChecks = [...lists.verificationChecks];
  const commands: string[] = [];
  for (const key of sourceAreas)
    for (const gen of catalog.areas[key]?.generated ?? []) {
      if (!commands.includes(gen.command)) commands.push(gen.command);
      if (!verificationChecks.includes(gen.check))
        verificationChecks.push(gen.check);
    }
  return {
    localChecks: [
      ...commands,
      ...localChecks.filter((c) => !commands.includes(c)),
    ],
    verificationChecks,
  };
}

/**
 * Fold each seed area's `validation.ownTests` into both lists, after what
 * is there: the area's own suite serves before commit and in verification
 * alike, and depends on nothing that runs before it.
 */
export function foldOwnTests(
  lists: CheckLists,
  sourceAreas: string[],
  catalog: Catalog,
): CheckLists {
  const localChecks = [...lists.localChecks];
  const verificationChecks = [...lists.verificationChecks];
  for (const key of sourceAreas) {
    const command = catalog.areas[key]?.validation?.ownTests;
    if (!command) continue;
    if (!localChecks.includes(command)) localChecks.push(command);
    if (!verificationChecks.includes(command)) verificationChecks.push(command);
  }
  return { localChecks, verificationChecks };
}

/**
 * The generic validation plan: the selected profiles' checks, the seed
 * areas' generators and own tests folded in, no remote runner required.
 * A change that selects a profile the catalog does not define under
 * `profiles:` (or selects none at all, in a catalog that defines none) is
 * refused with `ValidationPlanError` rather than planned with no checks: an
 * empty plan reads as "nothing to run".
 */
export function defaultValidation(ctx: ResolutionContext): ValidationPlan {
  const sourceAreas = [...ctx.seed].sort();
  const profiles = selectedProfiles(ctx);
  const undefinedProfiles = profiles.filter(
    (p) => !Object.hasOwn(ctx.catalog.profiles ?? {}, p),
  );
  if (undefinedProfiles.length > 0)
    throw new ValidationPlanError(
      `the change selects profile ${undefinedProfiles.map((p) => `\`${p}\``).join(", ")}, which the catalog's \`profiles:\` does not define; define its checks there, or supply the validation plan through a composer`,
    );
  if (profiles.length === 0 && ctx.changedFiles.length > 0)
    throw new ValidationPlanError(
      "the catalog defines no validation profiles, so the change has no checks to plan; declare them under `profiles:`, or supply the validation plan through a composer",
    );
  const definitions = profiles.flatMap((p) => ctx.catalog.profiles?.[p] ?? []);
  let lists: CheckLists = {
    localChecks: orderedUnion(definitions.map((d) => d.localChecks)),
    verificationChecks: orderedUnion(
      definitions.map((d) => d.verificationChecks),
    ),
  };
  lists = foldGenerated(lists, sourceAreas, ctx.catalog);
  lists = foldOwnTests(lists, sourceAreas, ctx.catalog);
  return {
    sourceAreas,
    profiles,
    ...lists,
    testbox: {
      required: false,
      command: null,
      warmupCommand: null,
      reason: null,
      requiredBy: [],
    },
    repositoryHooksRequired: true,
    githubCiRequired: true,
  };
}

// ── JSON ───────────────────────────────────────────────────────────────────

/** The tracker labels and flags of the seed areas, each sorted, each once. */
export function trackerProjection(
  seed: Set<string>,
  catalog: Catalog,
): ResolutionJson["linear"] {
  const labels = new Set<string>();
  const flags = new Set<string>();
  for (const key of seed) {
    const area = catalog.areas[key];
    const tracker = area && trackerOf(area);
    for (const label of tracker?.labels ?? []) labels.add(label);
    for (const flag of tracker?.flags ?? []) flags.add(flag);
  }
  return { labels: [...labels].sort(), flags: [...flags].sort() };
}

function generatedProjection(
  seed: Set<string>,
  catalog: Catalog,
): ResolutionJson["generated"] {
  const out: ResolutionJson["generated"] = [];
  for (const key of [...seed].sort())
    for (const gen of catalog.areas[key]?.generated ?? [])
      out.push({
        area: key,
        outputs: [...gen.outputs],
        source: [...gen.source],
        command: gen.command,
        check: gen.check,
      });
  return out;
}

/** The whole resolution as data; `validation` replaces the default plan. */
export function toResolution(
  ctx: ResolutionContext,
  validation:
    | ((ctx: ResolutionContext) => ValidationPlan)
    | null = defaultValidation,
): ResolutionJson {
  const { catalog, resolved, seed } = ctx;
  const postDeploy: ResolutionJson["postDeploy"] = [];
  const review: ResolutionJson["review"] = [];
  for (const key of areaKeys(catalog)) {
    if (!resolved.has(key)) continue;
    const skills = catalog.areas[key]?.review?.skills;
    if (skills?.length) review.push({ area: key, skills: [...skills] });
    for (const action of catalog.areas[key]?.postDeploy ?? [])
      postDeploy.push({ area: key, action });
  }
  return {
    changedFiles: [...ctx.changedFiles].sort(),
    seedAreas: [...seed].sort(),
    areas: [...resolved].sort(),
    flags: Object.fromEntries(
      areaKeys(catalog).map((key) => [key, resolved.has(key)]),
    ),
    postDeploy,
    review,
    reviewSkills: orderedUnion(review.map((r) => r.skills)),
    linear: trackerProjection(seed, catalog),
    validation: validation === null ? null : validation(ctx),
    generated: generatedProjection(seed, catalog),
  };
}

/** The resolution as indented JSON. */
export function toJson(
  ctx: ResolutionContext,
  validation?: ((ctx: ResolutionContext) => ValidationPlan) | null,
): string {
  return JSON.stringify(toResolution(ctx, validation), null, 2);
}

/**
 * Whether the skills a repository configures for an agent are skills it can
 * find: every skill of `do_item.guidance`, of the change-area catalog's
 * `implementation` blocks and `ci.repair_skill` must resolve to a skill
 * installed for the repository (its project skills, this plugin's) or on this
 * machine. A name that resolves to nothing is refused: do-item would tell the
 * implementing agent, and a drive its CI-repair pass, to use a skill it
 * cannot run.
 *
 * A malformed guidance list or `implementation` block is an error here, since
 * do-item refuses it at pickup; a catalog that cannot be read is the
 * change-areas check's to report, so it is not repeated.
 */
import { isMapping } from "../../../../shared/config-layers.ts";
import { swallow } from "../../../../shared/errors.ts";
import {
  missingSkills,
  skillSearch,
} from "../../../../shared/skill-resolve.ts";
import { catalogPathFromOverlay } from "../../../do-item/scripts/determine_agent.ts";
import {
  areaImplementation,
  parseGuidance,
} from "../../../do-item/scripts/lib/guidance.ts";
import { loadCatalogFile } from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import type { Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/** Each skill named, with the field that names it and the field its finding is keyed by. */
type Named = Array<[string, string, string]>;

const GUIDANCE = "do_item.guidance.skills";

/** An error for a malformed block, which do-item refuses at pickup. */
function invalid(id: string, e: unknown): Finding {
  return {
    id: `derivation:${id}:invalid`,
    severity: "error",
    message: `${e instanceof Error ? e.message : String(e)}: do-item refuses it`,
  };
}

/** The skills `do_item.guidance` names, or its refusal as an error. */
function entrySkills(config: Config, named: Named, problems: Finding[]): void {
  const section = config.do_item;
  if (!isMapping(section)) return;
  try {
    parseGuidance(section).forEach((entry, i) => {
      for (const s of entry.skills)
        named.push([s, `do_item.guidance[${i}].skills`, GUIDANCE]);
    });
  } catch (e) {
    problems.push(invalid("do_item.guidance", e));
  }
}

/** The change-area catalog, or `null` when it cannot be read (the change-areas check's to report). */
function readCatalog(config: Config, root: string) {
  try {
    const path = catalogPathFromOverlay(config, root);
    return path === null ? null : loadCatalogFile(path);
  } catch (e) {
    swallow(e, "the change-areas check reports a catalog it cannot read");
    return null;
  }
}

/** What the configuration names: each skill with its field, and each malformed block as an error. */
function namedSkills(
  config: Config,
  root: string,
): { named: Named; problems: Finding[] } {
  const named: Named = [];
  const problems: Finding[] = [];
  entrySkills(config, named, problems);
  for (const [key, area] of readCatalog(config, root) ?? []) {
    try {
      for (const s of areaImplementation(key, area.fields)?.skills ?? [])
        named.push([s, `area ${key} implementation.skills`, GUIDANCE]);
    } catch (e) {
      problems.push(invalid(`area.${key}.implementation`, e));
    }
  }
  const ci = config.ci;
  const repairSkill = isMapping(ci) ? ci.repair_skill : undefined;
  if (typeof repairSkill === "string")
    named.push([repairSkill, "ci.repair_skill", "ci.repair_skill"]);
  return { named, problems };
}

/** The guidance skills that resolve to nothing installed, each an error. */
export function guidanceFindings(
  config: Config,
  root: string,
  env: Record<string, string | undefined> = process.env,
): Finding[] {
  const { named, problems } = namedSkills(config, root);
  const missing = new Set(
    missingSkills(
      named.map(([s]) => s),
      skillSearch(root, env),
    ),
  );
  return [
    ...problems,
    ...named
      .filter(([s]) => missing.has(s))
      .map(
        ([skill, field, key]): Finding => ({
          id: `derivation:${key}:${skill}`,
          severity: "error",
          message: `${field} names ${skill}, which resolves to no skill installed for this repository or on this machine: install it, or name a skill that exists`,
        }),
      ),
  ];
}

/**
 * Whether the implementation guidance a repository configures names skills
 * an agent can find: every skill of `do_item.guidance` and of the change-area
 * catalog's `implementation` blocks must resolve to a skill installed for the
 * repository (its project skills, this plugin's) or on this machine. A name
 * that resolves to nothing is refused: do-item would tell the implementing
 * agent to use a skill it cannot run.
 *
 * A malformed guidance list is do-item's own refusal (`skillValidation`); a
 * catalog that cannot be read is the change-areas check's to report, so
 * neither is repeated here.
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

/** Each configured guidance skill with the field that names it, in order. */
function namedSkills(config: Config, root: string): Array<[string, string]> {
  const named: Array<[string, string]> = [];
  const section = config.do_item;
  if (isMapping(section)) {
    try {
      parseGuidance(section).forEach((entry, i) => {
        for (const s of entry.skills)
          named.push([s, `do_item.guidance[${i}].skills`]);
      });
    } catch (e) {
      swallow(e, "do-item's own validation reports a malformed guidance list");
    }
  }
  try {
    const path = catalogPathFromOverlay(config, root);
    if (path !== null)
      for (const [key, area] of loadCatalogFile(path))
        for (const s of areaImplementation(key, area.fields)?.skills ?? [])
          named.push([s, `area ${key} implementation.skills`]);
  } catch (e) {
    swallow(e, "the change-areas check reports a catalog it cannot read");
  }
  return named;
}

/** The guidance skills that resolve to nothing installed, each an error. */
export function guidanceFindings(
  config: Config,
  root: string,
  env: Record<string, string | undefined> = process.env,
): Finding[] {
  const named = namedSkills(config, root);
  const missing = new Set(
    missingSkills(
      named.map(([s]) => s),
      skillSearch(root, env),
    ),
  );
  return named
    .filter(([s]) => missing.has(s))
    .map(([skill, field]) => ({
      id: `derivation:do_item.guidance.skills:${skill}`,
      severity: "error",
      message: `${field} names ${skill}, which resolves to no skill installed for this repository or on this machine: install it, or name a skill that exists`,
    }));
}

/**
 * What a tick reads from a repository's configuration, checked in a
 * checkout with the tick's own readers: the `dispatch` section
 * (`readSection`), the tracker the configuration names with its issue
 * facets (`openTracker`, which resolves the facets against the label
 * taxonomy), and the change-area catalog `drive.change_areas_catalog`
 * names (the tick's path rule and `loadCatalogText`). A tick reads these
 * from the default branch; a repository's CI runs the check on the tree a
 * pull request would merge, so an error the tick would refuse every turn is
 * refused before the merge instead, with the tick's sentence
 * (`configuration-refusals.ts`).
 *
 * The check reads files only: it sends nothing to the tracker or the forge,
 * so what only those can say (a field the organization lacks, a facet's
 * detected store) is left to the tick.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { attempt, Defect } from "../../shared/outcome.ts";
import { loadCatalogText } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { facetsOf } from "../../skills/do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  CONFIGURATION_FILE,
  catalogMissing,
  catalogRefusal,
  sectionRefusal,
  trackerRefusal,
} from "./configuration-refusals.ts";
import { readSection, trackerConfigOf } from "./section.ts";
import { configuredCatalog, repositoryPath } from "./sources/contention.ts";
import { failureText } from "./text.ts";

/** One reading the tick would refuse: which part, and the tick's sentence. */
export interface ConfigFinding {
  part: "dispatch" | "tracker" | "catalog";
  message: string;
}

/**
 * The repository a GitHub tracker with no `issue_tracker.github.repository`
 * is bound to here. The tick binds it to the forge's own repository; the
 * check sends no request, so any well-formed name reads alike.
 */
const UNSENT_SLUG = "checkout/repository";

/** A file of the checkout as text; `null` when it is not there. */
function fileText(root: string, path: string) {
  const full = join(root, path);
  return attempt("unreadable", `${path} could not be read`, () =>
    existsSync(full) ? readFileSync(full, "utf8") : null,
  );
}

/**
 * A throw no configuration causes: a broken invariant or a programming
 * error in a reader. The check lets it travel, so a bug in the plugin is
 * reported as one and never as a fault of the repository's configuration.
 */
function isDefect(error: unknown): boolean {
  return (
    error instanceof Defect ||
    error instanceof TypeError ||
    error instanceof ReferenceError
  );
}

/** The tracker and its facets, as the tick opens them. */
function trackerFindings(
  values: Record<string, unknown>,
  root: string,
): ConfigFinding[] {
  let problem: string | null;
  try {
    const config = trackerConfigOf(values, UNSENT_SLUG);
    openTracker(config, root);
    problem = facetsOf(config, root).taxonomy.problem;
  } catch (error) {
    if (isDefect(error)) throw error;
    return [{ part: "tracker", message: trackerRefusal(failureText(error)) }];
  }
  // A taxonomy that fails its lint leaves type and size unreadable: the tick's facet record names this problem.
  return problem === null ? [] : [{ part: "tracker", message: problem }];
}

/** The change-area catalog, as the tick reads it for serialized areas. */
function catalogFindings(
  values: Record<string, unknown>,
  root: string,
): ConfigFinding[] {
  const configured = configuredCatalog(values);
  if (configured === null) return [];
  const refused = (why: string): ConfigFinding[] => [
    { part: "catalog", message: catalogRefusal(why) },
  ];
  const path = repositoryPath(configured);
  if (!path.ok) return refused(path.failure.reason);
  const text = fileText(root, path.value);
  if (!text.ok) return refused(text.failure.reason);
  if (text.value === null) return refused(catalogMissing(configured));
  const body = text.value;
  const parsed = attempt("invalid", "the change-area catalog", () =>
    loadCatalogText(body, path.value),
  );
  return parsed.ok ? [] : refused(failureText(parsed.failure.cause));
}

/**
 * Every reading of the configuration at `root` the tick would refuse, in
 * the order the tick reads them; none when the tick reads it whole. A
 * section that does not read ends the check, as it ends the tick's turn.
 */
export function checkConfiguration(root: string): ConfigFinding[] {
  const file = fileText(root, CONFIGURATION_FILE);
  if (!file.ok)
    return [{ part: "dispatch", message: sectionRefusal(file.failure.reason) }];
  const read = readSection(file.value, CONFIGURATION_FILE);
  if (!read.ok)
    return [
      {
        part: "dispatch",
        message: sectionRefusal(failureText(read.failure.reason)),
      },
    ];
  const { values } = read.value;
  return [...trackerFindings(values, root), ...catalogFindings(values, root)];
}

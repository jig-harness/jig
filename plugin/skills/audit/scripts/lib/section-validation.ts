import { parseDeclaration } from "../../../../gc/config.ts";
import { ExitError } from "../../../../shared/cli.ts";
import { isMapping as isRecord } from "../../../../shared/config-layers.ts";
import { parseReviewConfig } from "../../../../shared/consumer.ts";
import { swallow } from "../../../../shared/errors.ts";
import { parseTrackerLabels } from "../../../../shared/tracker-labels.ts";
import { adrConfig } from "../../../adr/scripts/locate.ts";
import {
  parseChangelogSection,
  resolve as resolveChangelog,
} from "../../../changelog/scripts/config.ts";
import { workingTree } from "../../../changelog/scripts/notes-dir.ts";
import { releasableVersion } from "../../../changelog/scripts/versions.ts";
import { parseCodeStatsConfig } from "../../../code-stats/scripts/lib/config.ts";
import { sheetRepositories } from "../../../decide/scripts/lib/overlay.ts";
import {
  settingsRequirement,
  validSettings,
} from "../../../design-brief-builder/scripts/contracts.ts";
import { parseRouting } from "../../../do-item/scripts/lib/routing.ts";
import { parseTrackerConfig } from "../../../do-item/scripts/lib/tracker/config.ts";
import { parseWorkTypes } from "../../../do-item/scripts/lib/work-types.ts";
import { parsePrPolicy } from "../../../drive-pr/scripts/lib/pr-policy.ts";
import { parseSeverityFormats } from "../../../drive-pr/scripts/lib/severity-formats.ts";
import { journalPath } from "../../../reflect/scripts/lib/context.ts";
import { parseReflection } from "../../../reflect/scripts/lib/settings.ts";
import { parseObligations } from "../../../resolve-conflicts/scripts/lib/obligations.ts";
import {
  parseWorkBatchSection,
  sizePointsMismatch,
} from "../../../work-batch/scripts/lib/policy.ts";
import { at, type Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/**
 * The changelog section resolved against the audited repository as the
 * skill's commands resolve it: the changelog and its format, the version
 * source set or derived from the manifests, and, from version files, the one
 * version they all hold, checked as one the release can move in every file.
 */
export function changelogValidation(config: Config, root: string): void {
  const section = parseChangelogSection(config.changelog);
  if (section === null) return;
  const read = workingTree(root);
  const resolved = resolveChangelog(root, section, read);
  if (resolved.version.kind === "files")
    releasableVersion(resolved.version, {
      read,
      format: resolved.format,
      tagPrefix: resolved.tagPrefix,
      changelog: read(resolved.changelog) ?? "",
      tags: () => [],
    });
}

/** The batchable sizes the file sets or defaults to; `null` when the labels do not parse. */
function batchSizesOf(config: Config): string[] | null {
  try {
    return parseTrackerLabels(config).batchSizes;
  } catch (e) {
    // The tracker validation below reports the labels themselves.
    swallow(e, "the issue-tracker labels are reported by the tracker check");
    return null;
  }
}

/**
 * `work_batch.size_points` must price exactly the batchable sizes. An error
 * when the repository configures `work_batch`; a warning when it only
 * changed the batchable sizes, since work-batch then refuses to run until the
 * points are set.
 */
export function sizePointsFindings(config: Config): Finding[] {
  // The size points are the cross-field rule's to report.
  const batchSizes = batchSizesOf(config);
  if (batchSizes === null) return [];
  const points = at(config, "work_batch.size_points");
  const keys = isRecord(points) ? Object.keys(points) : null;
  const mismatch = sizePointsMismatch(keys, batchSizes);
  if (mismatch === null) return [];
  return [
    {
      id: "rule:work_batch.size_points",
      severity: at(config, "work_batch") === undefined ? "warning" : "error",
      message: mismatch,
    },
  ];
}

/**
 * Run each skill's own validation of the file, so the audit refuses what they
 * refuse. Each validator gets the repository's file alone: the user layer and
 * the environment belong to whoever runs the audit, not to the repository.
 */
export function skillValidation(
  config: Config,
  path: string,
  root: string,
): Finding[] {
  const findings: Finding[] = [];
  const attempt = (skill: string, check: () => unknown) => {
    try {
      check();
    } catch (e) {
      findings.push({
        id: `rejected:${skill}`,
        severity: "error",
        message: `${skill} refuses the file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };
  attempt("do-item (pull-request policy)", () => parsePrPolicy(config));
  attempt("do-item (tracker)", () => {
    parseWorkTypes(config); // refuses a do_issue section before anything else
    parseTrackerConfig(config);
  });
  attempt("do-item (routing)", () =>
    parseRouting(config, parseWorkTypes(config)),
  );
  attempt("resolve-review-comments", () => parseReviewConfig(config.review));
  attempt("drive-pr (severity formats)", () => {
    const review = config.review;
    if (typeof review === "object" && review !== null && !Array.isArray(review))
      parseSeverityFormats((review as Config).severity_formats);
  });
  attempt("adr", () => adrConfig(path));
  attempt("decide, explain (sheets)", () => sheetRepositories(config, root));
  attempt("changelog", () => changelogValidation(config, root));
  attempt("resolve-conflicts", () =>
    parseObligations(config.resolve_conflicts),
  );
  attempt("code-stats", () => parseCodeStatsConfig(config.code_stats));
  attempt("gc", () => parseDeclaration(config.gc, root));
  attempt("design-brief-builder (handback)", () => {
    const handback = at(config, "design_brief.handback");
    if (handback !== undefined && !validSettings(handback))
      throw new ExitError(2, settingsRequirement);
  });
  const batchSizes = batchSizesOf(config);
  if (batchSizes !== null && sizePointsFindings(config).length === 0)
    attempt("work-batch", () => parseWorkBatchSection(config, batchSizes));
  attempt("reflect", () => {
    const reflection = parseReflection(config.reflection, root);
    const journal = reflection.journal ?? null;
    if (journal !== null) journalPath(journal, root);
  });
  return findings;
}

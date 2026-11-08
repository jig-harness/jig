/**
 * Whether a repository that keeps its issues' type, priority and size on a
 * tracker runs the weekly sweep that catches an issue filed without them
 * (design/tracker-facets.md, "The weekly sweep"): the tracker refuses such a
 * filing through its own scripts, but an issue form or a filing by hand goes
 * around them, and only the sweep finds what no pool reads.
 *
 * A repository keeps facets when its configuration has an `issue_tracker`
 * section. It runs the sweep when a tracked CI workflow, a systemd unit or a
 * crontab runs `file-issue`'s `check-fields.ts` other than for a move. A
 * host's own scheduler outside the repository cannot be seen, so the finding
 * is a suggestion the repository can decline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { swallow } from "../../../../shared/errors.ts";
import { probedFiles } from "./criteria.ts";
import type { Finding } from "./schema.ts";
import { taxonomyFindings } from "./taxonomy-fit.ts";

/** The tracked files that schedule work: CI pipelines and host schedulers. */
const SCHEDULERS = [
  /^\.github\/workflows\/[^/]+\.ya?ml$/,
  /^\.(?:forgejo|gitea)\/workflows\/[^/]+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
  /(?:^|\/)[^/]+\.(?:service|timer)$/,
  /(?:^|\/)(?:crontab|[^/]+\.cron)$/,
];

/** A line that runs the sweep: `check-fields.ts`, other than its move. */
const RUNS_SWEEP = /check-fields\.ts["']?(?![^\n]*\bmove\b)/;

/** The scheduler files among `tracked` whose text runs the sweep. */
export function sweepRunners(
  root: string,
  tracked: readonly string[],
): string[] {
  return probedFiles(tracked)
    .filter((f) => SCHEDULERS.some((p) => p.test(f)))
    .filter((f) => {
      try {
        return RUNS_SWEEP.test(readFileSync(join(root, f), "utf8"));
      } catch (err) {
        swallow(
          err,
          "a tracked scheduler file that cannot be read runs nothing the audit can see",
        );
        return false;
      }
    });
}

/**
 * Every finding config-fit reads from the repository's files about its
 * tracker: the configuration against its label taxonomy, and the sweep.
 */
export function trackerFileFindings(
  config: Record<string, unknown>,
  root: string,
  tracked: readonly string[],
): Finding[] {
  return [
    ...taxonomyFindings(config, root, tracked),
    ...sweepFindings(config, root, tracked),
  ];
}

/** A suggestion when the repository keeps facets and nothing here runs the sweep. */
export function sweepFindings(
  config: Record<string, unknown>,
  root: string,
  tracked: readonly string[],
): Finding[] {
  if (!isMapping(config.issue_tracker)) return [];
  if (sweepRunners(root, tracked).length > 0) return [];
  return [
    {
      id: "suggestion:issue_tracker.sweep",
      severity: "suggestion",
      message:
        "this repository keeps each issue's type, priority and size on its tracker, and no workflow, systemd unit or crontab here runs the weekly sweep for issues filed without them: schedule `file-issue`'s `check-fields.ts check --yes` weekly with a credential that may comment on issues and move them to triage (file-issue's README, The weekly sweep), or decline this where a host's own scheduler runs it",
    },
  ];
}

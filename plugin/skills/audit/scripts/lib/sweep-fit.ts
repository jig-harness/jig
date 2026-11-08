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
import { load } from "../../../../shared/yaml.ts";
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

/** A direct applying sweep command, excluding comments, report mode and migrations. */
function applying(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length !== 1) return false;
  return lines.some((line) => {
    const code = line.trim();
    return (
      /^(?:exec\s+)?bun\s+/.test(code) &&
      /(?:^|[/\s])check-fields\.ts["']?(?:\s+check)?\s+--yes(?:\s|$)/.test(
        code,
      ) &&
      !/\bmove\b/.test(code)
    );
  });
}

/** A workflow counts only when its parsed schedule runs an unconditional applying job. */
function scheduledWorkflow(text: string): boolean {
  const doc = load(text);
  if (
    !isMapping(doc) ||
    !isMapping(doc.on) ||
    !Array.isArray(doc.on.schedule) ||
    doc.on.schedule.length === 0 ||
    !isMapping(doc.jobs)
  )
    return false;
  if (
    !doc.on.schedule.every(
      (s) =>
        isMapping(s) &&
        typeof s.cron === "string" &&
        /^\d+ \d+ \* \* [0-7]$/.test(s.cron.trim()),
    )
  )
    return false;
  return Object.values(doc.jobs).some(
    (job) =>
      isMapping(job) &&
      job.if === undefined &&
      Array.isArray(job.steps) &&
      job.steps.some(
        (step) =>
          isMapping(step) &&
          step.if === undefined &&
          step["continue-on-error"] !== true &&
          applying(step.run),
      ),
  );
}

/** Confirm visible executable schedule evidence; uncertain host schedulers remain advisory. */
export function sweepRunners(
  root: string,
  tracked: readonly string[],
): string[] {
  return probedFiles(tracked)
    .filter((f) => SCHEDULERS.some((p) => p.test(f)))
    .filter((f) => {
      try {
        const text = readFileSync(join(root, f), "utf8");
        if (/\.ya?ml$/.test(f)) return scheduledWorkflow(text);
        if (/(?:crontab|\.cron)$/.test(f))
          return text.split("\n").some((line) => {
            const match = /^(?:\S+\s+){5}(.+)$/.exec(line.trim());
            return !line.trim().startsWith("#") && applying(match?.[1]);
          });
        // A service alone has no activation evidence; a tracked enabled timer must name it.
        if (!f.endsWith(".service")) return false;
        const timer = f.replace(/\.service$/, ".timer");
        if (!tracked.includes(timer)) return false;
        const timing = readFileSync(join(root, timer), "utf8");
        return (
          /^OnCalendar=weekly\s*$/m.test(timing) &&
          /^WantedBy=timers.target\s*$/m.test(timing) &&
          text
            .split("\n")
            .some(
              (line) =>
                line.startsWith("ExecStart=") && applying(line.slice(10)),
            )
        );
      } catch (err) {
        swallow(
          err,
          "unreadable or uncertain scheduler evidence does not certify an operating sweep",
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
        "this repository keeps each issue's type, priority and size on its tracker, and a scheduled applying sweep for issues filed without them could not be confirmed from the tracked scheduler commands: schedule `file-issue`'s `check-fields.ts check --yes` weekly with a credential that may comment on issues and move them to triage (file-issue's README, The weekly sweep), or decline this where a host's own scheduler runs it",
    },
  ];
}

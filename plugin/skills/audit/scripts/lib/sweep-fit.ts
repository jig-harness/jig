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

import { spawnSync } from "node:child_process";
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

/** Read only direct Bun invocations and the known status/summary wrapper. */
function applying(command: unknown, requirePosition: boolean): boolean {
  if (typeof command !== "string") return false;
  const lines = command
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 1) return sweepCommand(lines[0] ?? "", requirePosition);
  return statusWrapper(lines, requirePosition);
}

/** The supported shell wrapper preserves the sweep's exit status. */
function statusWrapper(lines: string[], requirePosition: boolean): boolean {
  // A wrapper is evidence only in this order: capture the command's status,
  // print its output, publish that output, then return the captured status.
  // Arbitrary shell control flow needs a person's inspection.
  const suffix = ' > "$RUNNER_TEMP/sweep.txt" || status=$?';
  const command = lines[1] ?? "";
  return (
    lines.length === 5 &&
    lines[0] === "status=0" &&
    command.endsWith(suffix) &&
    sweepCommand(command.slice(0, -suffix.length), requirePosition) &&
    lines[2] === 'cat "$RUNNER_TEMP/sweep.txt"' &&
    /^\{ echo '[^']+'; cat "\$RUNNER_TEMP\/sweep.txt"; echo '[^']+'; \} >> "\$GITHUB_STEP_SUMMARY"$/u.test(
      lines[3] ?? "",
    ) &&
    lines[4] === 'exit "$status"'
  );
}

/** Certify only literal script paths (or quoted paths) and the supported arguments. */
function sweepCommand(line: string, requirePosition: boolean): boolean {
  // Read the executable's script argument, never a comment or later argument.
  const m = /^(?:exec\s+)?bun\s+("[^"`]+"|'[^']+'|[^\s'"`]+)\s+(.*)$/u.exec(
    line,
  );
  if (m === null) return false;
  const token = m[1] ?? "";
  if (
    !token.startsWith('"') &&
    !token.startsWith("'") &&
    !/^[a-zA-Z0-9_./:-]+$/u.test(token)
  )
    return false;
  const script =
    token.startsWith('"') || token.startsWith("'") ? token.slice(1, -1) : token;
  if (script.includes("$(") || script.split("/").at(-1) !== "check-fields.ts")
    return false;
  const args = m[2] ?? "";
  return (
    /^(?:check\s+)?--yes(?: --retired-from [a-zA-Z0-9_./][a-zA-Z0-9_./-]*)?(?: --position [a-zA-Z0-9_./][a-zA-Z0-9_./-]*)?$/u.test(
      args,
    ) &&
    (!requirePosition || args.includes(" --position "))
  );
}

/** Only guards known to permit a scheduled default-branch run count. */
function scheduleSafe(value: unknown, branch: string | null): boolean {
  if (value === undefined || value === true) return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const condition =
    trimmed.startsWith("${{") && trimmed.endsWith("}}")
      ? trimmed.slice(3, -2).trim()
      : trimmed;
  return (
    condition === "github.event_name == 'schedule'" ||
    (branch !== null && condition === `github.ref == 'refs/heads/${branch}'`)
  );
}

/** Certify only a simple daily or weekly schedule; other cron dialects remain advisory. */
function weeklyCron(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  const bounded = (s: string | undefined, max: number) =>
    s !== undefined && /^\d{1,2}$/u.test(s) && Number(s) <= max;
  return (
    bounded(minute, 59) &&
    bounded(hour, 23) &&
    day === "*" &&
    month === "*" &&
    (weekday === "*" || bounded(weekday, 7))
  );
}

/** A workflow counts only with an independent job and no uncertain preceding steps. */
function scheduledWorkflow(
  text: string,
  branch: string | null,
  requirePosition: boolean,
): boolean {
  const doc = load(text);
  if (
    !isMapping(doc) ||
    !isMapping(doc.on) ||
    !Array.isArray(doc.on.schedule) ||
    doc.on.schedule.length === 0 ||
    !isMapping(doc.jobs)
  )
    return false;
  if (!doc.on.schedule.every((s) => isMapping(s) && weeklyCron(s.cron)))
    return false;
  return Object.values(doc.jobs).some((job) => {
    if (
      !isMapping(job) ||
      !scheduleSafe(job.if, branch) ||
      job.needs !== undefined ||
      !Array.isArray(job.steps)
    )
      return false;
    // Persistence cannot be proven from the file, so a positioned sweep
    // counts only in the one shape known to keep it: a plain cache step, then
    // the sweep as the job's last step, all in the workspace root.
    const cacheLead =
      isMapping(job.steps[0]) &&
      typeof job.steps[0].uses === "string" &&
      job.steps[0].uses.startsWith("actions/cache@");
    const step = job.steps[cacheLead ? 1 : 0];
    if (
      requirePosition &&
      (!cacheLead || job.steps.length !== 2 || !inRoot(doc, job, step))
    )
      return false;
    const position = requirePosition
      ? positionPath(isMapping(step) ? step.run : undefined)
      : null;
    return (
      (!requirePosition ||
        (position !== null && cachesPath(job.steps[0], position))) &&
      isMapping(step) &&
      scheduleSafe(step.if, branch) &&
      step["continue-on-error"] !== true &&
      applying(step.run, requirePosition)
    );
  });
}

/** No workflow, job or step moves the commands out of the workspace root. */
function inRoot(doc: Record<string, unknown>, job: unknown, step: unknown) {
  const runDefaults = (o: unknown): unknown =>
    isMapping(o) && isMapping(o.defaults) ? o.defaults.run : undefined;
  return (
    [runDefaults(doc), runDefaults(job)].every(
      (d) =>
        d === undefined ||
        (isMapping(d) && d["working-directory"] === undefined),
    ) &&
    isMapping(step) &&
    step["working-directory"] === undefined
  );
}

/** The file the validated sweep invocation saves its read position to. */
function positionPath(run: unknown): string | null {
  if (typeof run !== "string") return null;
  const line = run
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && l.includes("check-fields.ts"));
  const m = /--position ([a-zA-Z0-9_./][a-zA-Z0-9_./-]*)/u.exec(line ?? "");
  return m?.[1] ?? null;
}

/**
 * A plain cache step that restores the last position and saves the next: a
 * key unique to the run (an exact hit is never saved over) with a restore
 * prefix, and no condition, lookup-only or other input that could skip it.
 */
function cachesPath(step: unknown, path: string): boolean {
  if (
    !isMapping(step) ||
    typeof step.uses !== "string" ||
    !/^actions\/cache@/u.test(step.uses) ||
    !isMapping(step.with) ||
    !Object.keys(step).every((k) =>
      ["uses", "with", "name", "id"].includes(k),
    ) ||
    !Object.keys(step.with).every((k) =>
      ["path", "key", "restore-keys"].includes(k),
    )
  )
    return false;
  const { key } = step.with;
  const restore = step.with["restore-keys"];
  return (
    step.with.path === path &&
    typeof key === "string" &&
    /\$\{\{\s*github\.run_(?:id|number)\s*\}\}/u.test(key) &&
    typeof restore === "string" &&
    restore.trim() !== ""
  );
}

/** Confirm visible executable schedule evidence; uncertain host schedulers remain advisory. */
export function sweepRunners(
  root: string,
  tracked: readonly string[],
  requirePosition = false,
): string[] {
  const defaultRef = spawnSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: root, encoding: "utf8", timeout: 5000 },
  );
  const branch =
    defaultRef.status === 0
      ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
      : null;
  return probedFiles(tracked)
    .filter((f) => SCHEDULERS.some((p) => p.test(f)))
    .filter((f) => {
      try {
        const text = readFileSync(join(root, f), "utf8");
        if (/\.ya?ml$/.test(f))
          return scheduledWorkflow(text, branch, requirePosition);
        if (/(?:crontab|\.cron)$/.test(f))
          return text.split("\n").some((line) => {
            const words = line.trim().split(/\s+/);
            const command =
              words.length > 5 ? words.slice(5).join(" ") : undefined;
            return (
              weeklyCron(words.slice(0, 5).join(" ")) &&
              applying(command, requirePosition)
            );
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
                line.startsWith("ExecStart=") &&
                applying(line.slice(10), requirePosition),
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
  if (sweepRunners(root, tracked).length > 0) {
    const fileIssue = config.file_issue;
    const commentOnly =
      isMapping(fileIssue) &&
      isMapping(fileIssue.sweep) &&
      fileIssue.sweep.move === false;
    if (!commentOnly || sweepRunners(root, tracked, true).length > 0) return [];
    return [
      {
        id: "suggestion:issue_tracker.sweep.position",
        severity: "suggestion",
        message:
          "this repository sets `file_issue.sweep.move: false`, but no scheduled sweep passes `--position` with the file kept between runs (a workflow caches it with a run-keyed actions/cache step ahead of the sweep, which is the job's last step): without a saved read position each run starts at the oldest issue, so issues past the read cap are never reached; pass `--position <file>` and keep that file between runs (file-issue's README, The weekly sweep)",
      },
    ];
  }
  return [
    {
      id: "suggestion:issue_tracker.sweep",
      severity: "suggestion",
      message:
        "this repository keeps each issue's type, priority and size on its tracker, and a scheduled applying sweep for issues filed without them could not be confirmed from the tracked scheduler commands: schedule `file-issue`'s `check-fields.ts check --yes` weekly with a credential that may comment on issues and move them to triage (file-issue's README, The weekly sweep), or decline this where a host's own scheduler runs it",
    },
  ];
}

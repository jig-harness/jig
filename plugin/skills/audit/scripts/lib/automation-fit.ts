/**
 * Whether the workflows that open pull requests label them as automation:
 * a regeneration, a sync or a schema update a workflow opens should carry a
 * label of the `automation:` family (`automation:docs-sync`), which says
 * which job opened it. Without one, a person reading the pull request list
 * cannot tell it from a person's, and Jig's dispatcher, which drives an
 * automation pull request only while it needs work, falls back to its
 * author: a pull request a workflow opens with a person's token reads as
 * that person's.
 *
 * A workflow opens a pull request in a step that uses
 * `peter-evans/create-pull-request` (labelled through its `labels` input) or
 * runs `gh pr create` (labelled through `--label` or `-l`). Other ways of
 * opening one (an API call from a script) are not read, so the finding is a
 * suggestion the repository can decline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMapping } from "../../../../shared/config-layers.ts";
import { swallow } from "../../../../shared/errors.ts";
import { load } from "../../../../shared/yaml.ts";
import { probedFiles } from "./criteria.ts";
import type { Finding } from "./schema.ts";
import { trackerFileFindings } from "./sweep-fit.ts";

const WORKFLOW = /^\.(?:github|forgejo|gitea)\/workflows\/[^/]+\.ya?ml$/;
const CREATE_ACTION = /^peter-evans\/create-pull-request@/;
const GH_CREATE = /\bgh\s+pr\s+create\b/;
/** One `--label`/`-l` flag of `gh pr create` and its value, quoted or not; the flag may repeat and a value may list labels with commas. */
const GH_LABEL = /(?:--label|-l)(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g;

/** Whether a list of label names, comma or newline separated, holds one of the `automation:` family. */
const listsAutomation = (labels: string): boolean =>
  labels.split(/[,\n]/).some((l) => l.trim().startsWith("automation:"));

/** Whether a `gh pr create` command line applies an `automation:` label through any of its label flags. */
function ghLabels(run: string): boolean {
  return [...run.matchAll(GH_LABEL)].some((m) =>
    listsAutomation(m[1] ?? m[2] ?? m[3] ?? ""),
  );
}

/** Whether one step opens a pull request, and whether it labels it as automation; `null` when it opens none. */
function stepLabels(step: unknown): boolean | null {
  if (!isMapping(step)) return null;
  if (typeof step.uses === "string" && CREATE_ACTION.test(step.uses)) {
    const labels = isMapping(step.with) ? step.with.labels : undefined;
    return typeof labels === "string" && listsAutomation(labels);
  }
  if (typeof step.run === "string" && GH_CREATE.test(step.run))
    return ghLabels(step.run);
  return null;
}

/** The steps of one parsed workflow that open a pull request with no automation label, by job and step name. */
export function unlabelledSteps(doc: unknown): string[] {
  if (!isMapping(doc) || !isMapping(doc.jobs)) return [];
  const found: string[] = [];
  for (const [job, spec] of Object.entries(doc.jobs)) {
    if (!isMapping(spec) || !Array.isArray(spec.steps)) continue;
    spec.steps.forEach((step, i) => {
      if (stepLabels(step) !== false) return;
      const name = isMapping(step) && typeof step.name === "string";
      found.push(
        `${job} › ${name ? (step as { name: string }).name : `step ${i + 1}`}`,
      );
    });
  }
  return found;
}

/** One tracked workflow file, parsed; `null` when it does not read or parse. */
function workflowDoc(root: string, file: string): unknown {
  try {
    return load(readFileSync(join(root, file), "utf8"));
  } catch (err) {
    swallow(
      err,
      "a workflow that does not read opens no pull request we can see",
    );
    return null;
  }
}

/** A suggestion naming each workflow step that opens a pull request with no `automation:` label. */
export function automationLabelFindings(
  root: string,
  tracked: readonly string[],
): Finding[] {
  const unlabelled: string[] = [];
  for (const file of probedFiles(tracked).filter((f) => WORKFLOW.test(f))) {
    const steps = unlabelledSteps(workflowDoc(root, file));
    unlabelled.push(...steps.map((s) => `${file} (${s})`));
  }
  if (unlabelled.length === 0) return [];
  return [
    {
      id: "suggestion:automation-labels",
      severity: "suggestion",
      message: `these workflow steps open pull requests without an \`automation:\` label: ${unlabelled.join("; ")}. Label each with \`automation:<job>\` (the \`labels\` input of create-pull-request, \`--label\` of \`gh pr create\`) so people and the dispatcher tell them from a person's; the dispatcher then drives one only while it needs work (plugin README, Dispatch labels)`,
    },
  ];
}

/**
 * Every finding config-fit reads from the repository's tracked files: its
 * tracker's (`sweep-fit.ts`), where it has a configuration, and its
 * workflows' automation labels.
 */
export function fileFindings(
  config: Record<string, unknown>,
  tracked: readonly string[],
  opts: { root: string },
  report: { configured: boolean },
): Finding[] {
  return [
    ...(report.configured
      ? trackerFileFindings(config, opts.root, tracked)
      : []),
    ...automationLabelFindings(opts.root, tracked),
  ];
}

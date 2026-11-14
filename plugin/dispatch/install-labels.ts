/**
 * The one-time setup of the pull request state labels: `jig dispatch labels
 * [--repo <path>]... [--yes]`, which installs no job, and the labels part of
 * `jig install dispatch --repo <path> [--yes]`. Drives, follow-ups and the
 * dispatcher write the labels and never create them. For each repository
 * whose `dispatch` section (read from its default branch, as the tick reads
 * it) turns the labels on, the labels of the set it does not have yet are
 * listed, with the marker labels the tick keeps beside them (the
 * repository's manual-operations label and `automation`, `pr-markers.ts`),
 * and so are the labels of the set it has whose description is not the
 * one this release gives them (a release that changes what a label means
 * changes its description). With `--yes` each one created or updated is
 * named, and those the signed-in account may not create or edit are listed
 * for a person, each with the command that does it. An update sets the
 * description alone: a color a person chose stays, and so does a marker
 * label's description, which is the repository's own. A repository with
 * the labels off needs none.
 */
import {
  createLabel,
  defaultBranchConfig,
  describeLabel,
  repoTarget,
  repositoryLabels,
} from "./lib/forge.ts";
import { labelSet, type LabelSpec } from "./lib/labels.ts";
import { manualOpsLabel } from "./lib/owed-steps.ts";
import { markerSet } from "./lib/pr-markers.ts";
import { readSection } from "./lib/section.ts";
import { failureText } from "./lib/text.ts";

/** One shell word, in single quotes. */
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** How a person creates one label by hand. */
function createCommand(slug: string, label: LabelSpec): string {
  return `gh label create ${quote(label.name)} --repo ${slug} --color ${label.color} --description ${quote(label.description)}`;
}

/** How a person gives one label this release's description by hand. */
function describeCommand(slug: string, label: LabelSpec): string {
  return `gh label edit ${quote(label.name)} --repo ${slug} --description ${quote(label.description)}`;
}

/** Say why one repository's labels cannot be checked; it still misses what it needs. */
function unchecked(path: string, reason: string): true {
  console.error(`${path}: the dispatch labels cannot be checked: ${reason}`);
  return true;
}

type Refused = Array<{ label: LabelSpec; why: string }>;

/** Writes each label in turn, naming each one written; the labels the signed-in account could not write, each with why. */
async function writeEach(
  slug: string,
  labels: LabelSpec[],
  write: typeof createLabel,
  done: string,
): Promise<Refused> {
  const refused: Refused = [];
  for (const label of labels) {
    let written: Awaited<ReturnType<typeof createLabel>>;
    try {
      written = await write(slug, label);
    } catch (error) {
      refused.push({ label, why: failureText(error) });
      continue;
    }
    if (written.ok) console.log(`${slug}: ${done} ${label.name}`);
    else refused.push({ label, why: written.failure.reason });
  }
  return refused;
}

/** The labels a person must write, each with its command; whether there was any. */
function forPerson(
  slug: string,
  refused: Refused,
  what: string,
  command: (slug: string, label: LabelSpec) => string,
): boolean {
  if (refused.length === 0) return false;
  console.log(
    `${slug}: these labels could not be ${what} with the signed-in account; a person who may ${what === "created" ? "create" : "edit"} labels runs:`,
  );
  for (const r of refused)
    console.log(`  ${command(slug, r.label)}   # ${r.why}`);
  return true;
}

/** One repository's labels; whether any it needs is still missing or outdated. */
async function repoLabels(path: string, confirm: boolean): Promise<boolean> {
  const target = await repoTarget(path);
  if (!target.ok) return unchecked(path, target.failure.reason);
  const repo = target.value;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  const file = await defaultBranchConfig(repo);
  if (!file.ok) return unchecked(path, file.failure.reason);
  const read = readSection(file.value, where);
  if (!read.ok) return unchecked(path, failureText(read.failure.reason));
  const config = read.value.section.labels;
  if (!config.enabled) {
    console.log(
      `${repo.slug}: dispatch.labels is off on ${repo.defaultBranch}, so it needs no label`,
    );
    return false;
  }
  const manualOps = manualOpsLabel(read.value.values, config.prefix);
  if (!manualOps.ok) return unchecked(path, manualOps.failure.reason);
  const labels = await repositoryLabels(repo.slug);
  if (!labels.ok) return unchecked(path, labels.failure.reason);
  const have = new Map(labels.value.map((l) => [l.name, l.description]));
  const missing = [...labelSet(config), ...markerSet(manualOps.value)].filter(
    (l) => !have.has(l.name),
  );
  const outdated = labelSet(config).filter(
    (l) => have.has(l.name) && have.get(l.name) !== l.description,
  );
  if (missing.length === 0 && outdated.length === 0) {
    console.log(
      `${repo.slug}: every dispatch label under '${config.prefix}' exists and says what this release means by it, with ${manualOps.value} and automation`,
    );
    return false;
  }
  if (!confirm) {
    const list = (heading: string, specs: LabelSpec[]) => {
      if (specs.length === 0) return;
      console.log(`${repo.slug}: ${heading}`);
      for (const l of specs) console.log(`  ${l.name}: ${l.description}`);
    };
    list(
      "these dispatch labels do not exist yet; repeat with --yes to create them:",
      missing,
    );
    list(
      "these dispatch labels say what an earlier release meant by them; repeat with --yes to update them:",
      outdated,
    );
    return false;
  }
  const notCreated = await writeEach(
    repo.slug,
    missing,
    createLabel,
    "created",
  );
  const notUpdated = await writeEach(
    repo.slug,
    outdated,
    describeLabel,
    "updated",
  );
  const created = forPerson(repo.slug, notCreated, "created", createCommand);
  const updated = forPerson(repo.slug, notUpdated, "edited", describeCommand);
  return created || updated;
}

/** Exit `1` when a repository still misses a label or its description after `--yes`, or cannot be read; `0` otherwise. */
export async function installLabels(
  paths: readonly string[],
  confirm: boolean,
): Promise<number> {
  let failed = false;
  for (const path of paths) {
    try {
      if (await repoLabels(path, confirm)) failed = true;
    } catch (error) {
      unchecked(path, failureText(error));
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

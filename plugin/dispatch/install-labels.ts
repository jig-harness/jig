/**
 * The one-time setup of the pull request state labels: `jig dispatch labels
 * [--repo <path>]... [--yes]`, which installs no job, and the labels part of
 * `jig install dispatch --repo <path> [--yes]`. Drives and follow-ups write the
 * labels and never create them; the dispatcher's tick creates one a write
 * misses (`lib/actions/label-create.ts`). For each repository
 * whose `dispatch` section (read from its default branch, as the tick reads
 * it) turns the labels on, the labels of the set it does not have yet are
 * listed, with the marker labels the tick keeps beside them (the
 * repository's manual-operations label and `automation`, `pr-markers.ts`),
 * and so are the labels of the set it has whose description or color is
 * not the one this release gives them (a release that changes what a label
 * means changes its description, and one that settles the colors changes
 * its color, so every repository that installed the labels earlier comes
 * to the same scheme). With `--yes` each one created or updated is named,
 * and those the signed-in account may not create or edit are listed for a
 * person, each with the command that does it. An update sets only what
 * differs. A marker label is created when it is missing and otherwise left
 * as it is: its description and color are the repository's own. A
 * repository with the labels off needs none.
 */
import {
  createLabel,
  defaultBranchConfig,
  editLabel,
  type RepositoryLabel,
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

/** What of one label of the set the repository has differs from this release's. */
interface Outdated extends LabelSpec {
  /** The description it has, when it is not this release's. */
  oldDescription?: string;
  /** The color it has, when it is not this release's. */
  oldColor?: string;
}

/** The flags that give one outdated label this release's description and color, and nothing else. */
function editOf(label: Outdated): {
  name: string;
  description?: string;
  color?: string;
} {
  return {
    name: label.name,
    ...(label.oldDescription === undefined
      ? {}
      : { description: label.description }),
    ...(label.oldColor === undefined ? {} : { color: label.color }),
  };
}

/** How a person gives one label this release's description and color by hand. */
function editCommand(slug: string, label: Outdated): string {
  const edit = editOf(label);
  return [
    `gh label edit ${quote(label.name)} --repo ${slug}`,
    ...(edit.description === undefined
      ? []
      : [`--description ${quote(edit.description)}`]),
    ...(edit.color === undefined ? [] : [`--color ${edit.color}`]),
  ].join(" ");
}

/** The labels of the set the repository has with another description or color than this release gives them. */
function outdatedOf(
  set: readonly LabelSpec[],
  have: ReadonlyMap<string, RepositoryLabel>,
): Outdated[] {
  const outdated: Outdated[] = [];
  for (const spec of set) {
    const now = have.get(spec.name);
    if (now === undefined) continue;
    const label: Outdated = { ...spec };
    if (now.description !== spec.description)
      label.oldDescription = now.description;
    if (now.color !== spec.color.toLowerCase()) label.oldColor = now.color;
    if (label.oldDescription !== undefined || label.oldColor !== undefined)
      outdated.push(label);
  }
  return outdated;
}

/** Say why one repository's labels cannot be checked; it still misses what it needs. */
function unchecked(path: string, reason: string): true {
  console.error(`${path}: the dispatch labels cannot be checked: ${reason}`);
  return true;
}

type Refused<L> = Array<{ label: L; why: string }>;

/** Writes each label in turn, naming each one written; the labels the signed-in account could not write, each with why. */
async function writeEach<L extends LabelSpec>(
  slug: string,
  labels: L[],
  write: (slug: string, label: L) => ReturnType<typeof createLabel>,
  done: string,
): Promise<Refused<L>> {
  const refused: Refused<L> = [];
  for (const label of labels) {
    let written: Awaited<ReturnType<typeof createLabel>>;
    try {
      written = await write(slug, label);
    } catch (error) {
      refused.push({ label, why: failureText(error) });
      continue;
    }
    if (written.ok || written.failure.code === "exists")
      console.log(`${slug}: ${done} ${label.name}`);
    else refused.push({ label, why: written.failure.reason });
  }
  return refused;
}

/** The labels a person must write, each with its command; whether there was any. */
function forPerson<L extends LabelSpec>(
  slug: string,
  refused: Refused<L>,
  what: string,
  command: (slug: string, label: L) => string,
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
  const have = new Map(labels.value.map((l) => [l.name, l]));
  const missing = [...labelSet(config), ...markerSet(manualOps.value)].filter(
    (l) => !have.has(l.name),
  );
  const outdated = outdatedOf(labelSet(config), have);
  if (missing.length === 0 && outdated.length === 0) {
    console.log(
      `${repo.slug}: every dispatch label under '${config.prefix}' exists, says what this release means by it and has its color, with ${manualOps.value} and automation`,
    );
    return false;
  }
  if (!confirm) {
    const list = (heading: string, lines: string[]) => {
      if (lines.length === 0) return;
      console.log(`${repo.slug}: ${heading}`);
      for (const line of lines) console.log(`  ${line}`);
    };
    list(
      "these dispatch labels do not exist yet; repeat with --yes to create them:",
      missing.map((l) => `${l.name}: ${l.description}`),
    );
    list(
      "these dispatch labels say what an earlier release meant by them; repeat with --yes to update them:",
      outdated
        .filter((l) => l.oldDescription !== undefined)
        .map((l) => `${l.name}: ${l.description}`),
    );
    list(
      "these dispatch labels have another color than this release gives them; repeat with --yes to update them:",
      outdated
        .filter((l) => l.oldColor !== undefined)
        .map((l) => `${l.name}: ${l.oldColor} -> ${l.color}`),
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
    (slug, label) => editLabel(slug, editOf(label)),
    "updated",
  );
  const created = forPerson(repo.slug, notCreated, "created", createCommand);
  const updated = forPerson(repo.slug, notUpdated, "edited", editCommand);
  return created || updated;
}

/** Exit `1` when a repository still misses a label, or its description or color, after `--yes`, or cannot be read; `0` otherwise. */
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

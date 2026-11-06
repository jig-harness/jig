/**
 * `jig install dispatch --repo <path> [--yes]`: the dispatch labels a
 * repository needs before the tick writes them. For each repository whose
 * `dispatch` section (read from its default branch, as the tick reads it)
 * turns the labels on, the labels of the set it does not have yet are
 * listed; with `--yes` they are created, and those the signed-in account
 * may not create are listed for a person, each with the command that
 * creates it. A repository with the labels off needs none.
 */
import {
  createLabel,
  defaultBranchConfig,
  repoTarget,
  repositoryLabels,
} from "./lib/forge.ts";
import { labelSet, type LabelSpec } from "./lib/labels.ts";
import { readSection } from "./lib/section.ts";
import { failureText } from "./lib/text.ts";

/** One shell word, in single quotes. */
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** How a person creates one label by hand. */
function createCommand(slug: string, label: LabelSpec): string {
  return `gh label create ${quote(label.name)} --repo ${slug} --color ${label.color} --description ${quote(label.description)}`;
}

/** One repository's labels; whether any it needs is still missing. */
async function repoLabels(path: string, confirm: boolean): Promise<boolean> {
  const repo = await repoTarget(path);
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  const { section } = readSection(await defaultBranchConfig(repo), where);
  const config = section.labels;
  if (!config.enabled) {
    console.log(
      `${repo.slug}: dispatch.labels is off on ${repo.defaultBranch}, so it needs no label`,
    );
    return false;
  }
  const have = new Set(await repositoryLabels(repo.slug));
  const missing = labelSet(config).filter((l) => !have.has(l.name));
  if (missing.length === 0) {
    console.log(
      `${repo.slug}: every dispatch label under '${config.prefix}' exists`,
    );
    return false;
  }
  if (!confirm) {
    console.log(
      `${repo.slug}: these dispatch labels do not exist yet; repeat with --yes to create them:`,
    );
    for (const l of missing) console.log(`  ${l.name}: ${l.description}`);
    return false;
  }
  const refused: Array<{ label: LabelSpec; why: string }> = [];
  for (const label of missing) {
    try {
      await createLabel(repo.slug, label);
      console.log(`${repo.slug}: created ${label.name}`);
    } catch (error) {
      refused.push({ label, why: failureText(error) });
    }
  }
  if (refused.length === 0) return false;
  console.log(
    `${repo.slug}: these labels could not be created with the signed-in account; a person who may create labels runs:`,
  );
  for (const r of refused)
    console.log(`  ${createCommand(repo.slug, r.label)}   # ${r.why}`);
  return true;
}

/** Exit `1` when a repository still misses a label after `--yes`, or cannot be read; `0` otherwise. */
export async function installLabels(
  paths: readonly string[],
  confirm: boolean,
): Promise<number> {
  let failed = false;
  for (const path of paths) {
    try {
      if (await repoLabels(path, confirm)) failed = true;
    } catch (error) {
      console.error(
        `${path}: the dispatch labels cannot be checked: ${failureText(error)}`,
      );
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

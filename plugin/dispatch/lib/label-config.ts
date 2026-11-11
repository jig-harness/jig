/**
 * `dispatch.labels` as every writer of the pull request state labels reads
 * it: from the repository's configuration file on its default branch, as the
 * tick and the label setup read it (`section.ts`), never from a checkout's
 * copy. A drive and a follow-up then write under the same prefix the tick
 * projects with and the setup created, whatever a pull request's own branch
 * says, so a pull request that changes the prefix never ends up with a state
 * label under each. Two forge calls, each under `ghCall`'s deadline.
 */
import type { Outcome } from "../../shared/outcome.ts";
import { failed, ok } from "../../shared/outcome.ts";
import type { LabelConfig } from "../../shared/pr-labels/projection.ts";
import { defaultBranchConfig, repoTarget } from "./forge.ts";
import { readSection } from "./section.ts";

/** The repository's `owner/name`, and its `dispatch.labels` from its default branch. */
export interface RepositoryLabels {
  slug: string;
  config: LabelConfig;
}

/**
 * The labels setting of the repository the checkout at `path` belongs to,
 * or of the one `slug` names; why it does not read otherwise.
 */
export async function defaultBranchLabels(
  path: string,
  slug?: string,
): Promise<Outcome<RepositoryLabels, "unreadable">> {
  const target = await repoTarget(path, slug);
  if (!target.ok) return target;
  const repo = target.value;
  const file = await defaultBranchConfig(repo);
  if (!file.ok) return file;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  const read = readSection(file.value, where);
  if (!read.ok)
    return failed(
      "unreadable",
      `${where}: ${read.failure.reason}`,
      read.failure.cause,
    );
  return ok({ slug: repo.slug, config: read.value.section.labels });
}

/** Read the original releasing commit of a single tag without planning any other release. */
import { integrationBranch, remoteRef } from "./branches.ts";
import { configAtBase, resolve } from "./config.ts";
import {
  configuredChecks,
  fileAt,
  refuseShallow,
  releasingCommits,
} from "./tag.ts";

export interface ReleasingCommit {
  sha: string;
  branch: string;
  checks: string[] | undefined;
}

export function releasingCommit(
  root: string,
  tag: string,
  knownBranch?: string,
): ReleasingCommit | null {
  const branch =
    knownBranch ??
    process.env.JIG_RELEASE_INSPECTION_BRANCH ??
    integrationBranch(root, process.env, null);
  if (branch === null) return null;
  const ref = remoteRef(root, branch);
  const config = configAtBase(root, ref);
  if (config === null || !tag.startsWith(config.tagPrefix)) return null;
  const version = tag.slice(config.tagPrefix.length);
  const resolved = resolve(root, config, (path) => fileAt(root, ref, path));
  refuseShallow(root);
  const found = releasingCommits(
    root,
    ref,
    resolved.changelog,
    resolved.format,
    [version],
  ).get(version);
  return found?.added === 1
    ? { sha: found.commit, branch, checks: configuredChecks(root, ref) }
    : null;
}

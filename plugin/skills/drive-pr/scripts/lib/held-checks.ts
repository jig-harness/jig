/** Read held-head sentinels without treating a held failure as passing CI. */
import { ExitError } from "./cli.ts";
import { consumerRoot } from "../../../../shared/consumer.ts";
import { readPolicySnapshot } from "../../../../shared/autonomy.ts";
import { load } from "../../../../shared/yaml.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { ghCall, git, gitCallTimeoutSeconds } from "./proc.ts";
import { holdLabelPolicy } from "./ci-policy.ts";
import {
  sentinelNames,
  reviewedSpecialCiSettings,
} from "./ci-special-checks.ts";

/** Names suppressed only while the forge confirms the PR still carries the hold. */
export async function liveHeldChecks(pr: string): Promise<string[]> {
  const label = holdLabelPolicy();
  if (label === null) return [];
  const live = await ghCall(["pr", "view", pr, "--json", "labels"], {
    stderr: "pipe",
  });
  if (live.code !== 0)
    throw new ExitError(
      1,
      `cannot read the live CI hold label: ${live.stderr}`,
    );
  const value: unknown = JSON.parse(live.stdout);
  if (!isRecord(value) || !Array.isArray(value.labels))
    throw new ExitError(1, "unreadable CI hold labels");
  if (!value.labels.some((l) => isRecord(l) && l.name === label)) return [];
  const names = reviewedSpecialCiSettings().holdSentinels;
  const policy = readPolicySnapshot();
  if (policy.from === "unreadable") {
    console.error(
      `Held-check policy unreadable: ${policy.reason}; no held checks are suppressed.`,
    );
    return [];
  }
  const ref = policy.from === "base" ? policy.commit : "HEAD";
  const root = consumerRoot();
  const listing = await git(
    ["ls-tree", "-r", "--name-only", ref, "--", ".github/workflows"],
    { cwd: root, stderr: "pipe", timeoutSec: gitCallTimeoutSeconds() },
  );
  if (listing.code !== 0)
    throw new ExitError(
      1,
      `cannot read workflows for held-head checks (exit ${listing.code}): ${listing.stderr}`,
    );
  for (const path of listing.stdout
    .trim()
    .split("\n")
    .filter((p) => /\.ya?ml$/.test(p))) {
    const source = await git(["show", `${ref}:${path}`], {
      cwd: root,
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
    });
    if (source.code !== 0)
      throw new ExitError(
        1,
        `cannot read held-head workflow ${path} (exit ${source.code}): ${source.stderr}`,
      );
    names.push(...sentinelNames(load(source.stdout), label));
  }
  return [...new Set(names)];
}

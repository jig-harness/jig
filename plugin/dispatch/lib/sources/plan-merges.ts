/** Conflict edges require current associations and directly verified immutable merge facts. */
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { swallow } from "../../../shared/errors.ts";
import { baseBranch } from "../../../skills/drive-pr/scripts/lib/overlay.ts";
import { ghCall } from "../../../skills/drive-pr/scripts/lib/proc.ts";
import { forgeReads } from "../../../skills/do-item/scripts/linked-pr.ts";
import {
  readLinkedPr,
  pullNumbersIn,
  type LinkedPrReads,
} from "../../../skills/do-item/scripts/lib/linked-pr.ts";
import {
  readExecutionPlan,
  type PlanEdge,
} from "../../../skills/do-item/scripts/lib/execution-plan.ts";
import { trackerConfigFrom } from "../../../skills/do-item/scripts/lib/tracker/config.ts";
import { issueKeysOf } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  remoteUrl,
  repoFromRemote,
  slug,
} from "../../../skills/do-item/scripts/lib/tracker/github/refs.ts";
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { pullRequestFiles } from "../forge.ts";
import {
  isMergeFact,
  readMergeFact,
  writeMergeFact,
  type MergeFact,
} from "../merge-facts.ts";

export interface PlanMerges {
  merged: string[];
  held: Record<string, string>;
}
export type PlanMergeReader = (
  description: string,
  block?: string,
) => Promise<PlanMerges>;
export interface MergeContext {
  root: string;
  repository: string;
  trunk: string;
  keySource: string;
  trackerRepository?: string | undefined;
  bodyLinkRequired: boolean;
}
export interface MergeReads {
  links: LinkedPrReads;
  fact(pr: number): Promise<MergeFact | null>;
}

/** One direct merge view, followed by the governed, bounded complete file listing. */
async function directFact(
  context: MergeContext,
  pr: number,
): Promise<MergeFact | null> {
  const kept = readMergeFact(context.repository, pr);
  if (kept !== null) return kept;
  const result = await ghCall(
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      context.repository,
      "--json",
      "mergedAt,baseRefName",
    ],
    { cwd: context.root },
  );
  if (result.code !== 0) {
    swallow(result, "a refused direct merge read keeps the conflict edge held");
    return null;
  }
  try {
    const value = JSON.parse(result.stdout);
    if (typeof value?.mergedAt !== "string") return null;
    const files = await pullRequestFiles(context.repository, pr);
    if (!files.ok) {
      swallow(
        files.failure,
        "an incomplete file listing keeps the conflict edge held",
      );
      return null;
    }
    const fact = {
      mergedAt: value.mergedAt,
      base: value.baseRefName,
      files: files.value,
    };
    if (!isMergeFact(fact)) return null;
    writeMergeFact(context.repository, pr, fact);
    return fact;
  } catch (error) {
    swallow(error, "unreadable merge facts leave a conflict edge held");
    return null;
  }
}

/** The lifetime is one tick or one fresh launch check; association answers never survive it. */
export function planMergeReader(
  tracker: Tracker,
  context: MergeContext,
  reads: MergeReads = {
    links: forgeReads(tracker, context.root, context.repository),
    fact: (pr) => directFact(context, pr),
  },
): PlanMergeReader {
  const states = new Map<number, string>();
  const note = <T extends { number: number; state: string }>(pulls: T[]) => {
    for (const pull of pulls) states.set(pull.number, pull.state.toUpperCase());
    return pulls;
  };
  const currentLinks: LinkedPrReads = {
    comments: (key) => reads.links.comments(key),
    search: async (term) => {
      const found = await reads.links.search(term);
      return found === null ? null : note(found);
    },
    view: async (pr) => {
      const found = await reads.links.view(pr);
      if (found !== null) note([found]);
      return found;
    },
  };
  const links = new Map<string, ReturnType<typeof readLinkedPr>>();
  const facts = new Map<number, Promise<MergeFact | null>>();
  const linked = (key: string) => {
    let value = links.get(key);
    if (value === undefined) {
      value = readLinkedPr(key, { ...context, reads: currentLinks });
      links.set(key, value);
    }
    return value;
  };
  const fact = (pr: number) => {
    let value = facts.get(pr);
    if (value === undefined) {
      value = reads.fact(pr);
      facts.set(pr, value);
    }
    return value;
  };
  return async (description, block) => {
    const evidence: PlanMerges = { merged: [], held: {} };
    const edges =
      readExecutionPlan(description, block)?.edges.filter(
        (edge) => edge.completion === "merged",
      ) ?? [];
    for (const edge of edges) {
      const key = `${edge.from}>${edge.to}`;
      const result = await linked(edge.from);
      let reason = result.reason;
      if (result.pullRequest === "merged") {
        const numbers = [
          ...new Set(
            result.pulls.flatMap((url) =>
              pullNumbersIn(url, context.repository),
            ),
          ),
        ];
        const merges = await Promise.all(
          numbers.filter((pr) => states.get(pr) === "MERGED").map(fact),
        );
        if (merges.some((merge) => merge === null))
          reason =
            "a linked pull request's merge facts could not be read completely";
        else if (merges.some((merge) => delivers(merge, edge, context.trunk))) {
          evidence.merged.push(key);
          continue;
        } else
          reason =
            "no linked merge into the integration branch changes the conflict files";
      }
      evidence.held[key] =
        `waits on conflict edge ${edge.from} → ${edge.to}: ${reason}`;
    }
    return evidence;
  };
}

function delivers(
  merge: MergeFact | null,
  edge: PlanEdge,
  trunk: string,
): boolean {
  return (
    merge !== null &&
    merge.base === trunk &&
    (edge.conflictFiles === undefined ||
      edge.conflictFiles.some((file) => merge.files.includes(file)))
  );
}

/** Interactive claims use the current consumer; ticks pass their default-branch context explicitly. */
async function consumerMergeReader(
  tracker: Tracker,
): Promise<PlanMergeReader | null> {
  const root = consumerRoot();
  const remote = remoteUrl(root);
  const repository = remote === null ? null : repoFromRemote(remote);
  const trunk = await baseBranch(root);
  if (repository === null || trunk === null) return null;
  const values = readConfig();
  const config = trackerConfigFrom(values);
  const policy = values.pull_requests as { issue_link?: unknown } | undefined;
  return planMergeReader(tracker, {
    root,
    repository: slug(repository),
    trunk,
    keySource: issueKeysOf(config)?.source ?? "(?!)",
    trackerRepository:
      config.adapter === "github"
        ? (config.github.repository ?? slug(repository))
        : undefined,
    bodyLinkRequired: policy?.issue_link !== "none",
  });
}

/** Ordinary plans do not depend on forge discovery. */
export async function planMergeEvidence(
  tracker: Tracker,
  description: string,
  block?: string,
  reader?: PlanMergeReader,
): Promise<PlanMerges | undefined> {
  const plan = readExecutionPlan(description, block);
  if (!plan?.edges.some((edge) => edge.completion === "merged"))
    return undefined;
  const resolved = reader ?? (await consumerMergeReader(tracker));
  if (resolved !== null) return resolved(description, block);
  return {
    merged: [],
    held: Object.fromEntries(
      plan.edges
        .filter((edge) => edge.completion === "merged")
        .map((edge) => [
          `${edge.from}>${edge.to}`,
          `waits on conflict edge ${edge.from} → ${edge.to}: the forge repository or integration branch cannot be read`,
        ]),
    ),
  };
}

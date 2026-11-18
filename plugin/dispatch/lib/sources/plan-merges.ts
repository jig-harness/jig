/** Conflict edges require current associations and directly verified immutable merge facts. */
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { swallow } from "../../../shared/errors.ts";
import { baseBranch } from "../../../skills/drive-pr/scripts/lib/overlay.ts";
import { ghCall } from "../../../skills/drive-pr/scripts/lib/proc.ts";
import { ghRunFailure } from "../../../shared/outbound/github.ts";
import { OutboundError, outboundOf } from "../../../shared/outbound/failure.ts";
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
import type { Pool } from "../pool.ts";
import { ended, passedBefore, secondsLeft, type TickBound } from "./bounded.ts";
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
  /** The observe tick's deadline, when this reader runs as part of a tick. */
  bound?: TickBound | undefined;
  /** A merge proof's transport failure, retained by a tick's tracker record. */
  onFailure?(error: OutboundError): void;
  /** The limit on merge proofs in flight, when they run in a tick. */
  pool?: Pool | undefined;
}
export interface MergeReads {
  links: LinkedPrReads;
  fact(pr: number): Promise<MergeFact | null>;
}

function defaultReads(tracker: Tracker, context: MergeContext): MergeReads {
  return {
    links: forgeReads(tracker, context.root, context.repository),
    fact: (pr) => directFact(context, pr),
  };
}

/** The bound has ended: the proof is unread, and the tick's record says so rather than reading complete. */
function passedBound(context: MergeContext, what: string): null {
  context.onFailure?.(new OutboundError("unreachable", passedBefore(what)));
  return null;
}

/** A proof that answered in a form that does not read is unread too, never an observed absence. */
function unreadProof(context: MergeContext, what: string): null {
  context.onFailure?.(
    new OutboundError(
      "invalid",
      `${what} answered in a form that does not read`,
    ),
  );
  return null;
}

/** The options of one read, and whether that read reported a cause of its own. */
function associationOptions(context: MergeContext) {
  const timeoutSec = secondsLeft(context.bound);
  const state = { reported: false };
  const options = {
    ...(context.bound === undefined ? {} : { signal: context.bound.signal }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    ...(context.onFailure === undefined
      ? {}
      : {
          onFailure: (err: OutboundError) => {
            state.reported = true;
            context.onFailure?.(err);
          },
        }),
  };
  return { options, state };
}

/** A null read that named its cause keeps it; one that named none is unreadable evidence. */
function nullRead(
  context: MergeContext,
  state: { reported: boolean },
  what: string,
): null {
  return state.reported ? null : unreadProof(context, what);
}

/** One direct merge view, followed by the governed, bounded complete file listing. */
async function directFact(
  context: MergeContext,
  pr: number,
): Promise<MergeFact | null> {
  const kept = readMergeFact(context.repository, pr);
  if (kept !== null) return kept;
  if (ended(context.bound)) return passedBound(context, "a merge proof");
  const timeoutSec = secondsLeft(context.bound);
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
    {
      cwd: context.root,
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    },
  );
  if (result.code !== 0) {
    const failure = ghRunFailure(result);
    if (failure !== null)
      context.onFailure?.(new OutboundError(failure.code, failure.reason));
    swallow(result, "a refused direct merge read keeps the conflict edge held");
    return null;
  }
  try {
    return await factFrom(context, pr, JSON.parse(result.stdout));
  } catch (error) {
    swallow(error, "unreadable merge facts leave a conflict edge held");
    return unreadProof(context, "a merge proof");
  }
}

/** The merge fact a direct merge view and its complete file listing prove, kept once read. */
async function factFrom(
  context: MergeContext,
  pr: number,
  value: { mergedAt?: unknown; baseRefName?: unknown } | null,
): Promise<MergeFact | null> {
  if (typeof value?.mergedAt !== "string")
    return unreadProof(context, "a merge proof");
  const files = await pullRequestFiles(context.repository, pr, context.bound);
  if (!files.ok) {
    const failure = outboundOf(files.failure);
    if (failure !== null)
      context.onFailure?.(new OutboundError(failure.code, failure.reason));
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
  if (!isMergeFact(fact)) return unreadProof(context, "a merge proof");
  writeMergeFact(context.repository, pr, fact);
  return fact;
}

/** The merge facts of the numbered pull requests that read as merged. */
async function mergedFacts(
  numbers: number[],
  states: Map<number, string>,
  fact: (pr: number) => Promise<MergeFact | null>,
): Promise<Array<MergeFact | null>> {
  const merges: Array<MergeFact | null> = [];
  for (const pr of numbers)
    if (states.get(pr) === "MERGED") merges.push(await fact(pr));
  return merges;
}

/** The lifetime is one tick or one fresh launch check; association answers never survive it. */
export function planMergeReader(
  tracker: Tracker,
  context: MergeContext,
  reads: MergeReads = defaultReads(tracker, context),
): PlanMergeReader {
  const facts = new Map<number, Promise<MergeFact | null>>();
  const fact = (pr: number) => {
    let value = facts.get(pr);
    if (value === undefined) {
      value = reads.fact(pr);
      facts.set(pr, value);
    }
    return value;
  };
  const read = async (description: string, block?: string) => {
    const states = new Map<number, string>();
    const note = <T extends { number: number; state: string }>(pulls: T[]) => {
      for (const pull of pulls)
        states.set(pull.number, pull.state.toUpperCase());
      return pulls;
    };
    const currentLinks: LinkedPrReads = {
      comments: (key) =>
        ended(context.bound)
          ? Promise.resolve(passedBound(context, "a linked-pull-request read"))
          : reads.links.comments(key, associationOptions(context).options),
      search: async (term) => {
        if (ended(context.bound))
          return passedBound(context, "a linked-pull-request search");
        const { options, state } = associationOptions(context);
        const found = await reads.links.search(term, options);
        return found === null
          ? nullRead(context, state, "a linked-pull-request search")
          : note(found);
      },
      view: async (pr) => {
        if (ended(context.bound))
          return passedBound(context, "a linked-pull-request view");
        const { options, state } = associationOptions(context);
        const found = await reads.links.view(pr, options);
        if (found === null)
          return nullRead(context, state, "a linked-pull-request view");
        note([found]);
        return found;
      },
    };
    const links = new Map<string, ReturnType<typeof readLinkedPr>>();
    const linked = (key: string) => {
      let value = links.get(key);
      if (value === undefined) {
        value = readLinkedPr(key, { ...context, reads: currentLinks });
        links.set(key, value);
      }
      return value;
    };
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
        const merges = await mergedFacts(numbers, states, fact);
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
  const { pool } = context;
  if (pool === undefined) return read;
  return (description, block) => pool.run(() => read(description, block));
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

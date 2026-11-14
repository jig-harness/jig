/** The steward sees facts per target, with unavailable reads and untrusted text explicit. */
import { failed, ok } from "../../shared/outcome.ts";
import { targetOf, type ReadRecord } from "./launches.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import type { RepoObservation } from "./tick-observe.ts";
import { lowBudget } from "./tick-reads.ts";
import {
  treeEvidence,
  type TreeEvidence,
  type EvidenceRead,
  type EvidenceRoom,
} from "./steward-evidence-git.ts";
import {
  linkedPullRequests,
  pullRequestChecks,
  type LinkedPullRequest,
  type PullRequestChecks,
} from "./steward-evidence-forge.ts";
import { DURABLE_OUTPUT_LIMIT, durableSummary } from "./pass-output.ts";

export interface StewardTargetEvidence {
  target: string;
  workspace: EvidenceRead<TreeEvidence>;
  lastPass: {
    record: string;
    output: {
      untrusted: true;
      tail: string;
      truncated: boolean | null;
      unavailable?: string;
    };
  } | null;
  lastPassUnavailable?: string;
  pullRequests: EvidenceRead<LinkedPullRequest[]>;
  checks: EvidenceRead<PullRequestChecks[]>;
}
export interface StewardEvidenceReaders {
  git(path: string, room: EvidenceRoom): Promise<EvidenceRead<TreeEvidence>>;
  prs(
    target: string,
    observation: RepoObservation,
    records: ReadRecord[],
    room: EvidenceRoom,
    takeForgeReads: (count: number) => boolean,
  ): Promise<EvidenceRead<LinkedPullRequest[]>>;
  checks(
    pr: number,
    observation: RepoObservation,
    room: EvidenceRoom,
  ): Promise<EvidenceRead<PullRequestChecks>>;
}
export const STEWARD_HISTORY_TARGET_LIMIT = 20;

const READERS: StewardEvidenceReaders = {
  git: treeEvidence,
  prs: (target, observation, records, room, takeForgeReads) =>
    linkedPullRequests(
      target,
      observation,
      records,
      room,
      undefined,
      takeForgeReads,
    ),
  checks: pullRequestChecks,
};

/** A launch's explicit workspace is preferred; ambiguous runtime joins stay unknown. */
function workspace(
  target: string,
  records: ReadRecord[],
  observation: RepoObservation,
): string | null {
  const explicit = records.find((r) => targetOf(r.record) === target)?.record
    .workspace;
  if (explicit) return explicit.path;
  if (!observation.sessions.ok) return null;
  const number = /^PR #([1-9]\d*)$/.exec(target)?.[1];
  const paths = new Set(
    observation.sessions.workspaces
      .filter((w) =>
        number === undefined
          ? w.items.includes(target)
          : w.prs.includes(Number(number)),
      )
      .map((w) => w.path),
  );
  return paths.size === 1 ? ([...paths][0] ?? null) : null;
}

interface EvidenceContext {
  records: ReadRecord[];
  observation: RepoObservation;
  room: EvidenceRoom;
  readers: StewardEvidenceReaders;
  checkCache: Map<number, EvidenceRead<PullRequestChecks>>;
  /** Optional evidence must not consume the forge's reserve for the tick. */
  forgeReadsLeft: number | null;
}

function targetNames(context: EvidenceContext, queue: PoolIssue[]): string[] {
  const { observation, records } = context;
  const current = new Set([
    ...observation.opened.report.actions
      .filter((a) => a.stage === "notify")
      .map((a) => a.target),
    ...observation.forge.drives.map((pr) => `PR #${pr.number}`),
    ...queue.map((issue) => issue.identifier),
  ]);
  const historical = records
    .filter(
      (r) => r.record.action === "pickup" || r.record.action === "followup",
    )
    .map((r) => targetOf(r.record))
    .filter((target) => !current.has(target));
  return [
    ...current,
    ...[...new Set(historical)].slice(0, STEWARD_HISTORY_TARGET_LIMIT),
  ];
}

function budgetAvailable(context: EvidenceContext): boolean {
  const left = context.room();
  return left === null || left >= 1000;
}

function takeForgeReads(context: EvidenceContext, count: number): boolean {
  if (context.forgeReadsLeft === null) return true;
  if (context.forgeReadsLeft < count) return false;
  context.forgeReadsLeft -= count;
  return true;
}

function noBudget(): EvidenceRead<never> {
  return failed(
    "unreadable",
    "the tick budget has no room for another steward evidence read",
  );
}

function lastPass(
  target: string,
  records: ReadRecord[],
): Pick<StewardTargetEvidence, "lastPass" | "lastPassUnavailable"> {
  const pass = records.find(
    (r) => targetOf(r.record) === target && r.state.kind === "ended",
  );
  if (pass === undefined)
    return {
      lastPass: null,
      lastPassUnavailable:
        "no ended local launch supplied this target's last output",
    };
  const rawOutput =
    pass.state.kind === "ended" ? pass.state.exit.context : undefined;
  const token = pass.record.token;
  const output = token
    ? rawOutput?.split(token).join("[launch token]")
    : rawOutput;
  return {
    lastPass: {
      record: pass.record.id,
      output: {
        untrusted: true,
        tail: durableSummary(output ?? ""),
        truncated: outputTruncation(output),
        ...(output === undefined
          ? { unavailable: "this pass did not retain an output tail" }
          : {}),
      },
    },
  };
}

/** The summary keeps only the last `DURABLE_OUTPUT_LIMIT` characters of what the pass retained. */
function outputTruncation(output: string | undefined): boolean | null {
  if (output === undefined) return null;
  return output.length > DURABLE_OUTPUT_LIMIT;
}

function forgeRefusal(context: EvidenceContext): EvidenceRead<never> | null {
  const budget = context.observation.forgeBudget;
  if (budget !== undefined && lowBudget(budget))
    return failed(
      "unreadable",
      "the forge budget is low; optional steward reads are skipped",
    );
  return null;
}

async function readTree(
  target: string,
  context: EvidenceContext,
): Promise<EvidenceRead<TreeEvidence>> {
  if (!budgetAvailable(context)) return noBudget();
  const path = workspace(target, context.records, context.observation);
  if (path === null)
    return failed(
      "unreadable",
      "no unambiguous workspace was found for this target",
    );
  return context.readers.git(path, context.room);
}

async function readPullRequests(
  target: string,
  context: EvidenceContext,
): Promise<EvidenceRead<LinkedPullRequest[]>> {
  const refusal = forgeRefusal(context);
  if (refusal !== null) return refusal;
  if (!budgetAvailable(context)) return noBudget();
  if (/^PR #[1-9]\d*$/.test(target)) return ok([]);
  return context.readers.prs(
    target,
    context.observation,
    context.records,
    context.room,
    (count) => takeForgeReads(context, count),
  );
}

async function readChecks(
  target: string,
  prs: EvidenceRead<LinkedPullRequest[]>,
  context: EvidenceContext,
): Promise<EvidenceRead<PullRequestChecks[]>> {
  const refusal = forgeRefusal(context);
  if (refusal !== null) return refusal;
  if (!budgetAvailable(context)) return noBudget();
  if (!prs.ok) return prs;
  const number = /^PR #([1-9]\d*)$/.exec(target)?.[1];
  const checkPrs =
    number === undefined ? prs.value.map((p) => p.number) : [Number(number)];
  const checks: PullRequestChecks[] = [];
  for (const pr of checkPrs) {
    let read = context.checkCache.get(pr);
    if (read === undefined) {
      // `pullRequestChecks` reads the PR plus head/base check runs and
      // statuses: five forge requests per uncached pull request.
      if (!takeForgeReads(context, 5)) return noBudget();
      read = await context.readers.checks(
        pr,
        context.observation,
        context.room,
      );
      context.checkCache.set(pr, read);
    }
    if (!read.ok) return read;
    checks.push(read.value);
  }
  return ok(checks);
}

async function targetEvidence(
  target: string,
  context: EvidenceContext,
): Promise<StewardTargetEvidence> {
  const tree = await readTree(target, context);
  const prs = await readPullRequests(target, context);
  const checks = await readChecks(target, prs, context);
  return {
    target,
    workspace: tree,
    ...lastPass(target, context.records),
    pullRequests: prs,
    checks,
  };
}

/** Read each target once; every subprocess consumes the remaining tick budget. */
export async function collectStewardEvidence(
  all: ReadRecord[],
  observation: RepoObservation,
  queue: PoolIssue[],
  room: EvidenceRoom,
  readers: StewardEvidenceReaders = READERS,
): Promise<StewardTargetEvidence[]> {
  const context: EvidenceContext = {
    records: all
      .filter((r) => r.record.repo === observation.opened.repo.slug)
      .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt)),
    observation,
    room,
    readers,
    checkCache: new Map(),
    forgeReadsLeft:
      observation.forgeBudget === undefined ||
      !("remaining" in observation.forgeBudget)
        ? null
        : Math.max(
            0,
            observation.forgeBudget.remaining -
              Math.ceil(observation.forgeBudget.limit * 0.1),
          ),
  };
  const results: StewardTargetEvidence[] = [];
  for (const target of targetNames(context, queue))
    results.push(await targetEvidence(target, context));
  return results;
}

#!/usr/bin/env bun
/**
 * The script half of `review-reflections`: load the findings in scope,
 * reconcile approved fixes with what merged, plan escalations, and record
 * decisions.
 *
 * Usage:
 *   bun review.ts load [--class <c>] [--target <t>] [--severity <s>] [--since <time>]
 *   bun review.ts reconcile [--dry-run]
 *   bun review.ts plan
 *   bun review.ts escalate <class> <issue> [--owner <owner>] [--session <json>]
 *   bun review.ts record [--session <json>]          # decisions, JSONL on stdin
 *
 * In scope are the findings this repository would fix: those about its own
 * scaffolding (`scope: repository`, this repository's `change.repository`),
 * and, in a repository that is a tool (it holds a plugin manifest), every
 * finding about that tool from every repository.
 *
 * load       groups the open findings by owner, class and target, newest
 *            first, with counts, and reports what `diagnose` found.
 * reconcile  records `implemented` for each approved finding whose commit,
 *            or its pull request's merge commit, is reachable from the
 *            integration branch. A check that cannot be completed leaves the
 *            finding approved and is reported; it is never read as "not
 *            merged".
 * plan       the classes in scope that recur enough to escalate, or have an
 *            open tracker issue to attach to.
 * escalate   records `escalated` to <issue> for every open or deferred
 *            finding of <class> the owner owns (default: this repository).
 * record     reads decisions ({"finding","decision","reason"} and optional
 *            commit, pull_request, issue), fills in id, time and session,
 *            and stores them; a decision about a finding the store does not
 *            hold is refused.
 *
 * Output: JSON on stdout. Exit codes: 0 done (or reflection off); 1 failed;
 * 2 usage; 3 the store, or the remote reconcile needs, is unavailable.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fail,
  readStdinAll,
  runMain,
} from "../../resolve-review-comments/scripts/lib/cli.ts";
import { isMapping } from "../../resolve-review-comments/scripts/lib/config-layers.ts";
import {
  consumerRoot,
  readConfig,
} from "../../resolve-review-comments/scripts/lib/consumer.ts";
import { ghCall, git } from "../../resolve-review-comments/scripts/lib/proc.ts";
import {
  chooseOperation,
  last,
  type OperationShape,
  type ParsedArgs,
} from "../../reflect/scripts/lib/args.ts";
import {
  repositoryId,
  sessionBlock,
} from "../../reflect/scripts/lib/context.ts";
import {
  configuredTracker,
  escalationDecisions,
  planOwnedClasses,
} from "../../reflect/scripts/lib/escalation.ts";
import {
  type ComputedState,
  type DecisionEvent,
  decisionStamp,
  eventProblems,
  type FindingState,
  highestSeverity,
  isClassName,
  jsonlLines,
  ownerOf,
  parseObject,
  type Session,
  SEVERITIES,
  targetLabel,
} from "../../reflect/scripts/lib/events.ts";
import {
  type ReflectionSettings,
  reflectionSettings,
} from "../../reflect/scripts/lib/settings.ts";
import {
  EXIT,
  failureOf,
  orExit,
  Store,
  storeState,
} from "../../reflect/scripts/lib/store-client.ts";

const USAGE = `usage:
  review.ts load [--class <c>] [--target <t>] [--severity <s>] [--since <time>]
  review.ts reconcile [--dry-run]
  review.ts plan
  review.ts escalate <class> <issue> [--owner <owner>] [--session <json>]
  review.ts record [--session <json>]   (decisions, JSONL on stdin)`;

const SKILL = "review-reflections";
const NETWORK_TIMEOUT_SEC = 60;
const DECISION_FIELDS = [
  "finding",
  "decision",
  "reason",
  "commit",
  "pull_request",
  "issue",
] as const;

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** The tools this repository is: the name in each plugin manifest it holds. */
export function toolsOf(root = consumerRoot()): string[] {
  const names = new Set<string>();
  for (const base of [root, join(root, "plugin")])
    for (const manifest of [".claude-plugin", ".codex-plugin"]) {
      const file = join(base, manifest, "plugin.json");
      if (!existsSync(file)) continue;
      const name = parseObject(readFileSync(file, "utf8"), file).name;
      if (typeof name === "string" && name !== "") names.add(name);
    }
  return [...names].sort();
}

/** The owners whose findings a review here acts on. */
export function ownersInScope(
  repository: string,
  tools: readonly string[],
): string[] {
  return [`repository:${repository}`, ...tools.map((tool) => `tool:${tool}`)];
}

function sessionFrom(raw: string | undefined): Session {
  const stated = raw === undefined ? {} : parseObject(raw, "--session");
  const session = sessionBlock(import.meta.dir, stated);
  if (!session.skills.includes(SKILL)) session.skills.push(SKILL);
  return session;
}

/** The store and every finding's state, or the store's exit. */
async function opened(
  settings: ReflectionSettings,
): Promise<{ store: Store; state: ComputedState }> {
  const store = Store.configured(settings);
  return { store, state: await orExit(() => storeState(store)) };
}

function view(held: FindingState): Record<string, unknown> {
  const f = held.finding;
  return {
    id: f.id,
    at: f.at,
    status: held.status,
    kind: f.kind,
    severity: f.severity,
    title: f.title,
    description: f.description,
    suggested_fix: f.suggested_fix,
    time_cost_minutes: f.time_cost_minutes ?? null,
    change: f.change,
    session: {
      jig_version: f.session.jig_version,
      harness: f.session.harness?.name ?? null,
      model: f.session.model,
      skills: f.session.skills,
    },
    latest_decision: held.latest,
  };
}

/** Whether a finding passes the review's filters. */
function matches(held: FindingState, args: ParsedArgs): boolean {
  const f = held.finding;
  const target = last(args, "target");
  const since = last(args, "since");
  return (
    [
      [last(args, "class"), f.class],
      [last(args, "severity"), f.severity],
    ].every(([wanted, actual]) => wanted === undefined || wanted === actual) &&
    (target === undefined ||
      targetLabel(f.target) === target ||
      f.target.name === target) &&
    (since === undefined || f.at >= since)
  );
}

/** Open findings by owner, class and target: the most recurrent first. */
function groupOpen(findings: readonly FindingState[]) {
  const groups = new Map<string, FindingState[]>();
  for (const held of findings.filter((held) => held.status === "open")) {
    const key = [
      held.owner,
      held.finding.class,
      targetLabel(held.finding.target),
    ].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), held]);
  }
  const newest = (members: FindingState[]): string =>
    members[0]?.finding.at ?? "";
  return [...groups.values()]
    .map((members) =>
      members.sort((a, b) => (a.finding.at < b.finding.at ? 1 : -1)),
    )
    .sort((a, b) => b.length - a.length || (newest(a) < newest(b) ? 1 : -1))
    .map((members) => {
      const first = members[0] as FindingState;
      return {
        owner: first.owner,
        class: first.finding.class,
        target: targetLabel(first.finding.target),
        count: members.length,
        severity: highestSeverity(members.map((held) => held.finding.severity)),
        findings: members.map(view),
      };
    });
}

async function load(
  settings: ReflectionSettings,
  args: ParsedArgs,
): Promise<number> {
  const severity = last(args, "severity");
  if (
    severity !== undefined &&
    !(SEVERITIES as readonly string[]).includes(severity)
  )
    fail(2, `--severity must be one of ${SEVERITIES.join(", ")}`);
  const { store, state } = await opened(settings);
  let notices: Array<Record<string, unknown>> = [];
  let diagnoseError: string | null = null;
  try {
    notices = await store.diagnose();
  } catch (error) {
    diagnoseError = failureOf(error).message;
  }
  const repository = repositoryId();
  const tools = toolsOf();
  const owners = ownersInScope(repository, tools);
  const inScope = [...state.findings.values()].filter(
    (held) => owners.includes(held.owner) && matches(held, args),
  );
  const byStatus = (status: string) =>
    inScope.filter((held) => held.status === status).map(view);
  print({
    repository,
    tools,
    owners,
    filters: Object.fromEntries(
      [...args.values].map(([name, values]) => [name, values.at(-1)]),
    ),
    groups: groupOpen(inScope),
    awaiting_merge: byStatus("approved"),
    deferred: byStatus("deferred"),
    notices,
    diagnose_error: diagnoseError,
    orphan_decisions: state.orphanDecisions.map((decision) => decision.id),
  });
  return 0;
}

/** The integration branch: `repository.base_branch`, else origin's default. */
async function integrationBranch(): Promise<string> {
  const section = readConfig().repository;
  if (isMapping(section) && typeof section.base_branch === "string")
    return section.base_branch;
  const r = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (r.code !== 0)
    fail(
      EXIT.unavailable,
      "the integration branch is unknown: set repository.base_branch, or run `git remote set-head origin --auto`",
    );
  return r.stdout.trim().replace(/^origin\//, "");
}

/** Whether `commit` is on `ref`; `err` when this clone cannot tell. */
async function reachable(
  commit: string,
  ref: string,
): Promise<"yes" | "no" | "err"> {
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  const present = await git(["cat-file", "-e", `${commit}^{commit}`], { env });
  if (present.code !== 0) return "err";
  const r = await git(["merge-base", "--is-ancestor", commit, ref], { env });
  return r.code === 0 ? "yes" : r.code === 1 ? "no" : "err";
}

/** The commit a pull request landed as, when it merged. */
async function mergeCommitOf(
  pr: number,
): Promise<{ commit: string | null; error?: string }> {
  const r = await ghCall(
    ["pr", "view", String(pr), "--json", "state,mergeCommit"],
    { timeoutSec: NETWORK_TIMEOUT_SEC },
  );
  if (r.code !== 0)
    return {
      commit: null,
      error: `pull request #${pr} cannot be read: ${r.stderr.trim()}`,
    };
  const data = parseObject(r.stdout, `pull request #${pr}`);
  if (data.state !== "MERGED") return { commit: null };
  const oid = isMapping(data.mergeCommit) ? data.mergeCommit.oid : null;
  return typeof oid === "string"
    ? { commit: oid }
    : {
        commit: null,
        error: `pull request #${pr} merged without a merge commit`,
      };
}

/**
 * Where an approved change landed: the first of its pull request's merge
 * commit and its recorded commit that is on `ref`, else what kept the check
 * from completing.
 */
async function landing(
  approval: DecisionEvent,
  ref: string,
): Promise<{ landed: string | null; problems: string[] }> {
  const candidates: string[] = [];
  const problems: string[] = [];
  if (approval.pull_request !== undefined) {
    const merged = await mergeCommitOf(approval.pull_request);
    if (merged.commit !== null) candidates.push(merged.commit);
    if (merged.error !== undefined) problems.push(merged.error);
  }
  if (approval.commit !== undefined) candidates.push(approval.commit);
  if (candidates.length === 0 && problems.length === 0)
    problems.push("the approval records no commit or pull request");
  for (const candidate of candidates) {
    const answer = await reachable(candidate, ref);
    if (answer === "yes") return { landed: candidate, problems: [] };
    if (answer === "err")
      problems.push(`commit ${candidate} is not in this clone`);
  }
  return { landed: null, problems };
}

function implemented(
  held: FindingState,
  approval: DecisionEvent,
  landed: string,
  base: string,
  session: Session,
): DecisionEvent {
  const decision: DecisionEvent = {
    v: 1,
    type: "decision",
    ...decisionStamp(approval),
    session,
    finding: held.finding.id,
    decision: "implemented",
    reason: `${landed.slice(0, 12)} is on ${base}`,
    commit: landed,
  };
  if (approval.pull_request !== undefined)
    decision.pull_request = approval.pull_request;
  return decision;
}

async function reconcile(
  settings: ReflectionSettings,
  args: ParsedArgs,
): Promise<number> {
  const dryRun = args.flags.has("dry-run");
  const { store, state } = await opened(settings);
  const owners = ownersInScope(repositoryId(), toolsOf());
  const approved = [...state.findings.values()].filter(
    (held) => held.status === "approved" && owners.includes(held.owner),
  );
  const decisions: DecisionEvent[] = [];
  const stillApproved: string[] = [];
  const unverifiable: Array<{ finding: string; reason: string }> = [];
  if (approved.length > 0) {
    const base = await integrationBranch();
    // One fetch for the whole review. A failed fetch is not "not merged": it
    // stops the reconcile, so a network error never leaves a merged fix
    // looking unmerged.
    const fetched = await git(["fetch", "--quiet", "origin", base], {
      timeoutSec: NETWORK_TIMEOUT_SEC,
    });
    if (fetched.code !== 0)
      fail(
        EXIT.unavailable,
        `cannot fetch origin/${base}: ${fetched.stderr.trim()}; nothing was reconciled`,
      );
    const session = sessionFrom(undefined);
    for (const held of approved) {
      const approval = held.latest as DecisionEvent;
      const { landed, problems } = await landing(
        approval,
        `refs/remotes/origin/${base}`,
      );
      if (landed !== null)
        decisions.push(implemented(held, approval, landed, base, session));
      else if (problems.length > 0)
        unverifiable.push({
          finding: held.finding.id,
          reason: problems.join("; "),
        });
      else stillApproved.push(held.finding.id);
    }
  }
  if (!dryRun && decisions.length > 0)
    await orExit(() => store.append(decisions));
  print({
    dry_run: dryRun,
    implemented: decisions.map((decision) => ({
      finding: decision.finding,
      commit: decision.commit,
    })),
    still_approved: stillApproved,
    unverifiable,
  });
  return 0;
}

async function plan(settings: ReflectionSettings): Promise<number> {
  const { state } = await opened(settings);
  const owners = ownersInScope(repositoryId(), toolsOf());
  const result = await planOwnedClasses(
    state,
    owners,
    settings.escalateAfter,
    configuredTracker(),
  );
  print({ escalate_after: settings.escalateAfter, owners, ...result });
  return 0;
}

async function escalate(
  settings: ReflectionSettings,
  args: ParsedArgs,
): Promise<number> {
  const [className, issue, extra] = args.positional;
  if (
    className === undefined ||
    issue === undefined ||
    extra !== undefined ||
    !isClassName(className)
  )
    fail(2, "escalate takes a class and an issue", USAGE);
  const owners = ownersInScope(repositoryId(), toolsOf());
  const owner = last(args, "owner") ?? `repository:${repositoryId()}`;
  if (!owners.includes(owner))
    fail(
      2,
      `${owner} is not an owner this review acts on (${owners.join(", ")})`,
    );
  const { store, state } = await opened(settings);
  const decisions = escalationDecisions(
    className,
    owner,
    issue,
    [],
    state,
    sessionFrom(last(args, "session")),
  );
  if (decisions.length > 0) await orExit(() => store.append(decisions));
  print({
    escalated: decisions.map((decision) => decision.finding),
    issue,
    ...(decisions.length === 0
      ? { note: `no open or deferred finding of ${className} for ${owner}` }
      : {}),
  });
  return 0;
}

/**
 * One decision from a line of input: the fields given, the time and an id
 * that orders it after the finding's latest decision.
 */
function decisionFrom(
  given: Record<string, unknown>,
  latest: Map<string, { at: string; id: string }>,
  session: Session,
): Record<string, unknown> {
  const about = typeof given.finding === "string" ? given.finding : "";
  const stamp = decisionStamp(latest.get(about) ?? null);
  latest.set(about, stamp);
  const decision: Record<string, unknown> = {
    v: 1,
    type: "decision",
    ...stamp,
    session,
  };
  for (const field of DECISION_FIELDS)
    if (given[field] !== undefined && given[field] !== null)
      decision[field] = given[field];
  return decision;
}

async function record(
  settings: ReflectionSettings,
  args: ParsedArgs,
): Promise<number> {
  const lines = jsonlLines(await readStdinAll());
  if (lines.length === 0)
    fail(2, "record reads one decision per line on stdin", USAGE);
  const { store, state } = await opened(settings);
  const owners = ownersInScope(repositoryId(), toolsOf());
  const session = sessionFrom(last(args, "session"));
  // The latest decision per finding, this batch's included, so each new
  // decision orders after the one before it.
  const latest = new Map<string, { at: string; id: string }>();
  for (const held of state.findings.values())
    if (held.latest !== null) latest.set(held.finding.id, held.latest);
  const decisions = lines.map((line, index) => {
    const decision = decisionFrom(
      parseObject(line, `decision ${index + 1}`),
      latest,
      session,
    );
    const problems = eventProblems(decision);
    const held =
      typeof decision.finding === "string"
        ? state.findings.get(decision.finding)
        : undefined;
    if (typeof decision.finding === "string" && held === undefined)
      problems.push(`the store holds no finding ${decision.finding}`);
    else if (held !== undefined && !owners.includes(ownerOf(held.finding)))
      problems.push(
        `finding ${decision.finding} belongs to ${ownerOf(held.finding)}, which this review does not act on`,
      );
    if (problems.length > 0)
      fail(2, `decision ${index + 1}: ${problems.join("; ")}`);
    return decision as unknown as DecisionEvent;
  });
  await orExit(() => store.append(decisions));
  print({
    recorded: decisions.map((decision) => ({
      finding: decision.finding,
      decision: decision.decision,
    })),
  });
  return 0;
}

type Run = (settings: ReflectionSettings, args: ParsedArgs) => Promise<number>;

const OPERATIONS: Record<string, OperationShape & { run: Run }> = {
  load: {
    options: ["class", "target", "severity", "since"],
    positional: 0,
    run: load,
  },
  reconcile: { options: [], flags: ["dry-run"], positional: 0, run: reconcile },
  plan: { options: [], positional: 0, run: plan },
  escalate: { options: ["owner", "session"], positional: 2, run: escalate },
  record: { options: ["session"], positional: 0, run: record },
};

export async function main(argv: string[]): Promise<number> {
  const { operation, args } = chooseOperation(argv, OPERATIONS, USAGE);
  const settings = reflectionSettings();
  if (!settings.on) {
    print({ on: false });
    return 0;
  }
  return operation.run(settings, args);
}

if (import.meta.main) runMain("review.ts", () => main(process.argv.slice(2)));

#!/usr/bin/env bun
/**
 * The script half of `reflect`: gather what the journal holds, plan the
 * escalations, and contribute the findings to the store.
 *
 * Usage:
 *   bun reflect.ts status
 *   bun reflect.ts gather [--mode quick|comprehensive]
 *   bun reflect.ts plan
 *   bun reflect.ts contribute [--issue <class>=<issue>]... [--session <json>]
 *   bun reflect.ts hotspots <report.json>
 *
 * status      whether reflection is on, the store, the journal and its
 *             unsent count; no store access.
 * gather      adopts findings a removed worktree of this repository left
 *             pending, then prints the unsent findings and the classes the
 *             store already uses. `--mode` overrides `reflection.mode` for
 *             this reflection.
 * plan        per class this repository owns among the unsent findings: its
 *             recurrence count, its open or closed tracker issue, and the
 *             action (attach to the open issue, file one, or store as it is).
 * contribute  appends the unsent findings to the store, escalates every open
 *             finding of each class given with --issue to that issue
 *             (commenting on it when the tracker can), and marks the
 *             findings contributed in the journal.
 * hotspots    reads the merge-conflict history report (`history.ts --json`
 *             of resolve-conflicts) and notes one finding per conflict
 *             hotspot in the journal, its cause as the class; a hotspot the
 *             journal already holds is revised to the new count, and one the
 *             store already records is left (`lib/hotspots.ts`). `plan` and
 *             `contribute` then escalate and store them like any finding.
 *
 * Output: JSON on stdout. Exit codes: 0 done (or reflection off); 1 failed;
 * 2 usage; 3 the store is unavailable, and the findings stay in the journal
 * until the next run.
 */
import { fail, runMain } from "../../../shared/cli.ts";
import {
  currentChange,
  journalPath,
  repositoryId,
  sessionBlock,
} from "./lib/context.ts";
import {
  configuredTracker,
  withinTrackerDeadline,
  escalationDecisions,
  planEscalation,
} from "./lib/escalation.ts";
import {
  classesInUse,
  computeState,
  type DecisionEvent,
  type FindingEvent,
  isClassName,
  ownerOf,
  parseObject,
} from "./lib/events.ts";
import {
  adoptPending,
  finishOwnAdoptions,
  markContributed,
  markSending,
  readJournal,
  unsent,
} from "./lib/journal.ts";
import {
  MODES,
  type ReflectionSettings,
  reflectionSettings,
} from "./lib/settings.ts";
import { failureOf, orExit, Store, storeState } from "./lib/store-client.ts";
import { readHotspotReport, recordHotspots } from "./lib/hotspots.ts";
import { chooseOperation, last, type ParsedArgs } from "./lib/args.ts";

const USAGE = `usage:
  reflect.ts status
  reflect.ts gather [--mode quick|comprehensive]
  reflect.ts plan
  reflect.ts contribute [--issue <class>=<issue>]... [--session <json>]
  reflect.ts hotspots <report.json>`;

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function gather(
  settings: ReflectionSettings,
  path: string,
  args: ParsedArgs,
): Promise<number> {
  const asked = last(args, "mode");
  if (asked !== undefined && !(MODES as readonly string[]).includes(asked))
    fail(2, `--mode takes ${MODES.join(" or ")} (got '${asked}')`, USAGE);
  const repository = repositoryId();
  const adopted = adoptPending(path, repository);
  const findings = unsent(readJournal(path));
  let classes: ReturnType<typeof classesInUse> | null = null;
  let storeError: string | null = null;
  try {
    classes = classesInUse(await storeState(Store.configured(settings)));
  } catch (error) {
    storeError = failureOf(error).message;
  }
  print({
    mode: asked ?? settings.mode,
    journal: path,
    repository,
    change: currentChange(),
    adopted_from_pending: adopted,
    unsent: findings,
    classes,
    store_error: storeError,
  });
  return 0;
}

async function plan(
  settings: ReflectionSettings,
  path: string,
): Promise<number> {
  const findings = unsent(readJournal(path));
  const state = await orExit(() => storeState(Store.configured(settings)));
  const result = await planEscalation(
    findings,
    state,
    repositoryId(),
    settings.escalateAfter,
    findings.length === 0 ? "nothing to plan" : configuredTracker(),
  );
  print({ escalate_after: settings.escalateAfter, ...result });
  return 0;
}

function parseIssues(values: readonly string[]): Map<string, string> {
  const issues = new Map<string, string>();
  for (const value of values) {
    const at = value.indexOf("=");
    const className = value.slice(0, at);
    const issue = value.slice(at + 1).trim();
    if (at < 1 || !isClassName(className) || issue === "")
      fail(2, `--issue takes <class>=<issue> (got '${value}')`, USAGE);
    issues.set(className, issue);
  }
  return issues;
}

function commentBody(
  className: string,
  findings: readonly FindingEvent[],
  refs: Map<string, string | null>,
): string {
  const lines = [
    `Another occurrence of the recurring class \`${className}\`, recorded by reflection:`,
    "",
  ];
  for (const finding of findings) {
    const ref = refs.get(finding.id);
    const where =
      finding.change.pull_request !== null
        ? ` (pull request #${finding.change.pull_request})`
        : finding.change.branch !== null
          ? ` (branch ${finding.change.branch})`
          : "";
    lines.push(
      `- ${finding.title}${where}: \`${finding.id}\`${ref ? ` at ${ref}` : ""}`,
    );
  }
  return lines.join("\n");
}

/** Every `--issue` class must be one an unsent finding of this repository has. */
function checkIssues(
  issues: Map<string, string>,
  findings: readonly FindingEvent[],
  owner: string,
): void {
  for (const className of issues.keys())
    if (
      !findings.some(
        (finding) => finding.class === className && ownerOf(finding) === owner,
      )
    )
      fail(
        2,
        `--issue names ${className}, but no unsent finding this repository owns has that class`,
      );
}

interface Comment {
  issue: string;
  posted: boolean;
  error?: string;
}

/** Comment on each escalation issue with its new findings, where the tracker can. */
async function commentOnIssues(
  issues: Map<string, string>,
  findings: readonly FindingEvent[],
  owner: string,
  refs: Map<string, string | null>,
): Promise<Comment[]> {
  if (issues.size === 0) return [];
  const tracker = configuredTracker();
  const comments: Comment[] = [];
  for (const [className, issue] of issues) {
    if (typeof tracker === "string") {
      comments.push({ issue, posted: false, error: tracker });
      continue;
    }
    const members = findings.filter(
      (finding) => finding.class === className && ownerOf(finding) === owner,
    );
    try {
      await withinTrackerDeadline(
        (signal) =>
          tracker.comment(issue, commentBody(className, members, refs), signal),
        `the comment on ${issue}`,
      );
      comments.push({ issue, posted: true });
    } catch (error) {
      comments.push({ issue, posted: false, error: failureOf(error).message });
    }
  }
  return comments;
}

/**
 * The findings still to send, and those an earlier, cut-off send already
 * stored. The stored ones are not sent again; they are marked contributed
 * only once this contribution's append has landed, so an escalation decided
 * for them is not lost to a second cut-off.
 */
async function splitStored(
  store: Store,
  path: string,
  findings: readonly FindingEvent[],
  hint: string,
): Promise<{ toSend: FindingEvent[]; already: FindingEvent[] }> {
  const sending = readJournal(path).sending;
  if (!findings.some((finding) => sending.has(finding.id)))
    return { toSend: [...findings], already: [] };
  const stored = new Set(
    (await orExit(() => store.list(), hint)).map((entry) => entry.event.id),
  );
  return {
    toSend: findings.filter((finding) => !stored.has(finding.id)),
    already: findings.filter((finding) => stored.has(finding.id)),
  };
}

async function contribute(
  settings: ReflectionSettings,
  path: string,
  args: ParsedArgs,
): Promise<number> {
  const issues = parseIssues(args.values.get("issue") ?? []);
  const rawSession = last(args, "session");
  const stated =
    rawSession === undefined ? {} : parseObject(rawSession, "--session");
  // A send mark waiting in one of this journal's own claims is checked like
  // any other, so the adoption it belongs to is finished first.
  finishOwnAdoptions(path, repositoryId());
  const findings = unsent(readJournal(path));
  if (findings.length === 0) {
    print({
      stored: [],
      escalated: [],
      note: "the journal holds nothing to contribute",
    });
    return 0;
  }
  const store = Store.configured(settings);
  const owner = `repository:${repositoryId()}`;
  checkIssues(issues, findings, owner);
  const hint = `the findings not yet marked contributed stay in the journal (${path}); run reflect again later`;
  const state =
    issues.size > 0
      ? await orExit(() => storeState(store), hint)
      : computeState([]);
  const session = sessionBlock(import.meta.dir, stated);
  if (!session.skills.includes("reflect")) session.skills.push("reflect");
  const { toSend, already } = await splitStored(store, path, findings, hint);
  const decisions: DecisionEvent[] = [...issues].flatMap(([className, issue]) =>
    escalationDecisions(className, owner, issue, toSend, state, session),
  );
  // One append, so the findings and their escalations are stored together
  // or not at all.
  const findingIds = new Set(toSend.map((finding) => finding.id));
  markSending(
    path,
    toSend.map((finding) => finding.id),
  );
  const stored = (
    await orExit(() => store.append([...toSend, ...decisions]), hint)
  ).filter((entry) => findingIds.has(entry.id));
  markContributed(path, [
    ...already.map((finding) => ({ id: finding.id, ref: null })),
    ...stored,
  ]);
  const refs = new Map(stored.map((entry) => [entry.id, entry.ref]));
  print({
    stored,
    escalated: decisions.map((decision) => ({
      finding: decision.finding,
      issue: decision.issue,
    })),
    comments: await commentOnIssues(issues, findings, owner, refs),
  });
  return 0;
}

async function hotspots(
  settings: ReflectionSettings,
  path: string,
  args: ParsedArgs,
): Promise<number> {
  let report: ReturnType<typeof readHotspotReport>;
  try {
    report = readHotspotReport(args.positional[0] as string);
  } catch (error) {
    fail(2, failureOf(error).message, USAGE);
  }
  // A pending finding a removed worktree left is part of what the journal
  // holds, so it is adopted before a hotspot is looked up in it.
  adoptPending(path, repositoryId());
  const state = await orExit(
    () => storeState(Store.configured(settings)),
    "nothing was noted: whether the store already records a hotspot decides whether it is new; run it again when the store is back",
  );
  const results = recordHotspots(path, report, state, import.meta.dir);
  print({
    range: report.range.label,
    journal: path,
    hotspots: results,
    note:
      results.length === 0
        ? "the report names no conflict hotspot"
        : "run reflect.ts plan, then contribute, to escalate and store what was noted",
  });
  return 0;
}

function status(settings: ReflectionSettings, path: string): number {
  print({
    on: true,
    store: settings.store,
    path: settings.store === "filesystem" ? settings.path : null,
    mode: settings.mode,
    escalate_after: settings.escalateAfter,
    journal: path,
    unsent: unsent(readJournal(path)).length,
  });
  return 0;
}

type Run = (
  settings: ReflectionSettings,
  path: string,
  args: ParsedArgs,
) => Promise<number> | number;

const OPERATIONS: Record<
  string,
  { options: string[]; positional?: number; run: Run }
> = {
  status: { options: [], run: status },
  gather: { options: ["mode"], run: gather },
  plan: { options: [], run: plan },
  hotspots: { options: [], positional: 1, run: hotspots },
  contribute: { options: ["issue", "session"], run: contribute },
};

export async function main(argv: string[]): Promise<number> {
  const { operation, args } = chooseOperation(argv, OPERATIONS, USAGE);
  const settings = reflectionSettings();
  if (!settings.on) {
    print({ on: false });
    return 0;
  }
  return operation.run(settings, journalPath(settings.journal), args);
}

if (import.meta.main) runMain("reflect.ts", () => main(process.argv.slice(2)));

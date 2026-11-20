/** Governed tracker reads and writes for the on-demand epic closure sweep. */
import {
  EPIC_WAIVER_MARKER,
  hasEpicWaiver,
  newestEpicVerdict,
} from "../../../../shared/epic-closure.ts";
import { parseMs } from "../../../../shared/time.ts";
import { sweepMarkerOnLastLine } from "./epic-sweep-plan.ts";
import { numberKeys, teamKeys } from "./tracker/keys.ts";
import {
  CLOSED_STATE_TYPES,
  type CommentFact,
  type Issue,
  type Tracker,
  TrackerRequestError,
} from "./tracker/port.ts";

function isClosed(state: Issue["state"]): boolean {
  return CLOSED_STATE_TYPES.some((kind) => kind === state.type);
}

export async function listSweepEpics(
  tracker: Pick<Tracker, "labelledIssues">,
  epicLabel: string,
): Promise<string[]> {
  // The tracker expands a read by the epic label to the configured native types.
  const issues = await tracker.labelledIssues(epicLabel);
  return issues
    .filter(
      ({ stateType }) => !CLOSED_STATE_TYPES.some((kind) => kind === stateType),
    )
    .map(({ identifier }) => identifier);
}

export async function readSweepEpic(
  tracker: Pick<Tracker, "getIssue">,
  key: string,
) {
  const epic = await tracker.getIssue(key);
  if (!epic?.isEpic)
    throw new TrackerRequestError(
      "invalid",
      `${key} is no longer a readable epic`,
    );
  return { epic, children: epic.children };
}

type CommentTracker = Pick<Tracker, "adapter" | "team" | "issueComments">;

function issueForReply(tracker: CommentTracker, url: URL): string | null {
  if (tracker.adapter === "github") {
    const parts = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(url.pathname);
    return parts?.[1]?.toLowerCase() === tracker.team.toLowerCase() &&
      /^#issuecomment-[1-9]\d*$/.test(url.hash)
      ? `#${parts[2]}`
      : null;
  }
  const key =
    tracker.adapter === "jira"
      ? /^\/browse\/([^/]+)$/.exec(url.pathname)?.[1]
      : /\/issue\/([^/]+)(?:\/|$)/.exec(url.pathname)?.[1];
  return key === undefined ? null : teamKeys(tracker.team).normalize(key);
}

function trustedReply(comment: CommentFact): boolean {
  return (
    comment.trusted &&
    comment.author != null &&
    !comment.author.name.toLowerCase().endsWith("[bot]")
  );
}

function invalid(message: string): TrackerRequestError {
  return new TrackerRequestError("invalid", message);
}

/** The moment a comment was posted and the moment its current text took effect. */
function commentTimes(comment: CommentFact): {
  created: number;
  effectiveAt: number;
} | null {
  const created = parseMs(comment.createdAt);
  const effectiveAt = parseMs(comment.editedAt ?? comment.createdAt);
  return Number.isFinite(created) &&
    Number.isFinite(effectiveAt) &&
    effectiveAt >= created
    ? { created, effectiveAt }
    : null;
}

type Proposal = { body: string; effectiveAt: number; marker: string };

/** The proposals visible before the acceptance, each in the form the person read. */
function precedingProposals(
  comments: CommentFact[],
  acceptedAt: number,
): Proposal[] {
  const preceding: Proposal[] = [];
  for (const comment of comments) {
    const marker = comment.trusted && sweepMarkerOnLastLine(comment.body);
    if (!marker) continue;
    const times = commentTimes(comment);
    if (times === null)
      throw invalid(
        `Cannot establish the proposal's time relative to the reply (${comment.url ?? comment.id})`,
      );
    const { created, effectiveAt } = times;
    // A proposal that was already visible when the person accepted cannot be
    // silently ignored when an edit changes it afterwards. A genuinely later
    // proposal, however, is outside that authorization.
    if (created < acceptedAt && effectiveAt >= acceptedAt)
      throw invalid(
        `Proposal changed after the reply (${comment.url ?? comment.id})`,
      );
    if (created < acceptedAt)
      preceding.push({ body: comment.body, effectiveAt, marker });
  }
  return preceding.sort((left, right) => left.effectiveAt - right.effectiveAt);
}

/** Resolve the actual tracker reply, never the caller's transcription of it. */
export async function readSweepReply(
  tracker: CommentTracker,
  replyUrl: string,
) {
  const url = URL.parse(replyUrl);
  const key =
    url?.protocol === "https:" && !url.username && !url.password
      ? issueForReply(tracker, url)
      : null;
  if (url === null || key === null)
    throw invalid(
      "supply a tracker comment URL on an issue in this repository",
    );
  const { comments } = await tracker.issueComments(key);
  const reply = comments.find((comment) => comment.url === url.href);
  if (reply === undefined || !trustedReply(reply))
    throw invalid("the comment URL must name a trusted person's tracker reply");
  // An edited answer is new authorization at its edit time. A proposal
  // edited after that authorization could now describe a different sweep.
  const acceptance = commentTimes(reply);
  if (acceptance === null)
    throw invalid("the tracker reply has no readable acceptance time");
  const preceding = precedingProposals(comments, acceptance.effectiveAt);
  const latest = preceding.at(-1);
  if (
    latest &&
    preceding.some(
      ({ effectiveAt, marker }) =>
        effectiveAt === latest.effectiveAt && marker !== latest.marker,
    )
  )
    throw invalid("Multiple latest proposals have the same tracker time");
  return {
    body: reply.body,
    precedingBodies: preceding.map(({ body }) => body),
  };
}

function localKey(tracker: Pick<Tracker, "adapter" | "team">, key: string) {
  return tracker.adapter === "github"
    ? numberKeys(tracker.team).normalize(key)
    : teamKeys(tracker.team).normalize(key);
}

const fold = (name: string) => name.trim().toLowerCase();

type RemainderTracker = Pick<
  Tracker,
  "adapter" | "team" | "getIssue" | "stateName" | "listRelations"
>;

/** The sweep checks work the coordinator already refiled. */
export async function validateSweepRemainder(
  tracker: RemainderTracker,
  epic: Issue,
  remainder: readonly { title: string; issue: string }[],
): Promise<void> {
  const seen = new Set<string>();
  for (const { title, issue: raw } of remainder) {
    const key = localKey(tracker, raw);
    if (key === null || key === epic.identifier || seen.has(key))
      throw new TrackerRequestError(
        "invalid",
        `${raw} must name a distinct backlog issue in this repository`,
      );
    seen.add(key);
    const issue = await tracker.getIssue(key);
    const backlog = tracker.stateName("backlog", issue?.nativeType ?? null);
    if (
      issue === null ||
      isClosed(issue.state) ||
      issue.isEpic ||
      issue.parent?.identifier === epic.identifier ||
      backlog === null ||
      fold(issue.state.name) !== fold(backlog)
    )
      throw new TrackerRequestError(
        "invalid",
        `${key} must be in backlog outside ${epic.identifier}`,
      );
    if (issue.title.trim() !== title.trim())
      throw new TrackerRequestError(
        "invalid",
        `${key} must match the approved remainder title "${title}"`,
      );
    if (!(await isRelated(tracker, key, epic.identifier)))
      throw new TrackerRequestError(
        "invalid",
        `${key} must be related to ${epic.identifier}`,
      );
  }
}

async function isRelated(
  tracker: Pick<Tracker, "listRelations">,
  key: string,
  other: string,
): Promise<boolean> {
  return (await tracker.listRelations(key)).some(
    (relation) => relation.type === "related" && relation.issue === other,
  );
}

interface SweepTrackerInput {
  epic: Issue;
  personChecks?: string;
  personTails: readonly string[];
  ordinaryTails: readonly string[];
  operatorSteps: readonly string[];
  replyUrl: string;
  classifyTail?: (child: Issue) => "person" | "ordinary" | null;
}

type SweepTracker = RemainderTracker &
  Pick<
    Tracker,
    "issueComments" | "postComment" | "relate" | "updateIssue" | "transition"
  >;

async function postOnce(tracker: SweepTracker, key: string, body: string) {
  const { comments } = await tracker.issueComments(key);
  if (
    !comments.some((comment) => comment.trusted && comment.body.trim() === body)
  )
    await tracker.postComment(key, body);
}

function epicRef(epic: Issue): string {
  return epic.url === null ? epic.identifier : `<${epic.url}>`;
}

async function assertAuthorized(tracker: SweepTracker, key: string) {
  const { comments } = await tracker.issueComments(key);
  if (newestEpicVerdict(comments) === "REJECT")
    throw new TrackerRequestError(
      "invalid",
      `${key} has a rejecting acceptance verdict`,
    );
  return comments;
}

function assertTailKind(
  input: SweepTrackerInput,
  issue: Issue,
  person: boolean,
) {
  if (
    input.classifyTail !== undefined &&
    input.classifyTail(issue) !== (person ? "person" : "ordinary")
  )
    throw new TrackerRequestError(
      "invalid",
      `approved tail ${issue.identifier} changed kind`,
    );
}

function isInBacklog(tracker: SweepTracker, issue: Issue): boolean {
  const backlog = tracker.stateName("backlog", issue.nativeType);
  return backlog !== null && fold(issue.state.name) === fold(backlog);
}

/** The scope and already settled children still match the preflight read. */
function sameEpicScope(before: Issue, current: Issue): boolean {
  if (
    !current.isEpic ||
    current.description !== before.description ||
    current.state.type !== before.state.type ||
    fold(current.state.name) !== fold(before.state.name)
  )
    return false;
  const labels = new Set(current.labels.map(fold));
  if (
    labels.size !== new Set(before.labels.map(fold)).size ||
    before.labels.some((label) => !labels.has(fold(label)))
  )
    return false;
  const states = new Map(
    current.children.map((child) => [child.identifier, child.state.type]),
  );
  return before.children.every(
    (child) =>
      !isClosed(child.state) ||
      states.get(child.identifier) === child.state.type,
  );
}

interface Move {
  child: string;
  parent: string | null;
}

interface SweepPlan {
  tracker: SweepTracker;
  input: SweepTrackerInput;
  key: string;
  tails: Map<string, boolean>;
  destination: Issue | null;
  moves: Move[];
}

function refuse(message: string): TrackerRequestError {
  return new TrackerRequestError("invalid", message);
}

/** The tails the person approved, each marked as a person check or not. */
function approvedTails(input: SweepTrackerInput): Map<string, boolean> {
  const tails = new Map([
    ...input.personTails.map((child) => [child, true] as const),
    ...input.ordinaryTails.map((child) => [child, false] as const),
  ]);
  if (tails.size !== input.personTails.length + input.ordinaryTails.length)
    throw refuse(`${input.epic.identifier} has duplicate approved tails`);
  return tails;
}

/** The standing person-checks issue, read when the sweep has something to hand it. */
async function readDestination(
  tracker: SweepTracker,
  input: SweepTrackerInput,
  tails: Map<string, boolean>,
): Promise<Issue | null> {
  if (input.personTails.length === 0 && input.operatorSteps.length === 0)
    return null;
  const key = input.epic.identifier;
  const destinationKey = localKey(tracker, input.personChecks ?? "");
  if (destinationKey === null)
    throw refuse(
      "set issue_tracker.person_checks to the standing open issue's key",
    );
  const destination = await tracker.getIssue(destinationKey);
  if (
    destination === null ||
    isClosed(destination.state) ||
    destination.identifier === key ||
    destination.parent?.identifier === key ||
    tails.has(destination.identifier)
  )
    throw refuse(
      "issue_tracker.person_checks must name an open issue outside the epic",
    );
  return destination;
}

/** Whether an approved tail still sits where the proposal found it. */
async function assertTailPlace(
  tracker: SweepTracker,
  issue: Issue,
  key: string,
  parent: string | null,
) {
  const current = issue.parent?.identifier ?? null;
  if (
    current !== key &&
    (current !== parent || !(await isRelated(tracker, issue.identifier, key)))
  )
    throw refuse(
      `approved tail ${issue.identifier} moved without the expected link or destination`,
    );
}

/** Check each approved tail and list the ones that still have to move. */
async function planMoves(
  tracker: SweepTracker,
  input: SweepTrackerInput,
  tails: Map<string, boolean>,
  destination: Issue | null,
): Promise<Move[]> {
  const key = input.epic.identifier;
  const moves: Move[] = [];
  for (const [child, person] of tails) {
    const issue = await tracker.getIssue(child);
    if (issue === null) throw refuse(`approved tail ${child} is unreadable`);
    const parent = person ? (destination?.identifier ?? null) : null;
    await assertTailPlace(tracker, issue, key, parent);
    if (isClosed(issue.state)) continue;
    assertTailKind(input, issue, person);
    if (
      issue.parent?.identifier === key ||
      (!person && !isInBacklog(tracker, issue))
    )
      moves.push({ child, parent });
  }
  return moves;
}

/** The epic is still the one proposed, and only approved tails remain open. */
async function assertEpicUnchanged(plan: SweepPlan): Promise<"done" | "open"> {
  const { tracker, input, key, tails } = plan;
  const before = await tracker.getIssue(key);
  if (before === null || !before.isEpic)
    throw refuse(`${key} is no longer a readable epic`);
  if (before.state.type === "completed") return "done";
  if (
    isClosed(before.state) ||
    !sameEpicScope(input.epic, before) ||
    before.children.some(
      (child) => !isClosed(child.state) && !tails.has(child.identifier),
    )
  )
    throw refuse(`${key} changed since its closure proposal`);
  return "open";
}

async function assertDestinationOpen(plan: SweepPlan) {
  const { tracker, key, destination } = plan;
  if (destination === null) return;
  const current = await tracker.getIssue(destination.identifier);
  if (
    current === null ||
    isClosed(current.state) ||
    current.parent?.identifier === key
  )
    throw refuse(
      "issue_tracker.person_checks must still name an open issue outside the epic",
    );
}

async function postOperatorSteps(plan: SweepPlan) {
  const { tracker, input, destination } = plan;
  if (destination === null || input.operatorSteps.length === 0) return;
  const steps = input.operatorSteps.map(
    (step) => `- [ ] ${step.replace(/\s+/g, " ")}`,
  );
  await postOnce(
    tracker,
    destination.identifier,
    [`Operator checks from epic ${epicRef(input.epic)}.`, "", ...steps].join(
      "\n",
    ),
  );
}

async function applyMove(plan: SweepPlan, { child, parent }: Move) {
  const { tracker, input, key, destination } = plan;
  const issue = await tracker.getIssue(child);
  if (issue === null)
    throw refuse(`approved tail ${child} changed parent during the sweep`);
  if (isClosed(issue.state)) return;
  assertTailKind(input, issue, parent !== null);
  const underEpic = issue.parent?.identifier === key;
  if (underEpic && !(await isRelated(tracker, child, key)))
    await tracker.relate(child, "related", key);
  if (underEpic) {
    const movedTo =
      destination !== null && parent === destination.identifier
        ? ` to the standing person-checks list ${epicRef(destination)}`
        : "";
    await postOnce(
      tracker,
      child,
      `Moved from epic ${epicRef(input.epic)}${movedTo} during its closure sweep.`,
    );
    await tracker.updateIssue(child, { parent });
  } else if ((issue.parent?.identifier ?? null) !== parent) {
    throw refuse(`approved tail ${child} changed parent during the sweep`);
  }
  if (parent === null && !isInBacklog(tracker, issue))
    await tracker.transition(child, "backlog");
}

async function closeEpic(plan: SweepPlan) {
  const { tracker, input, key } = plan;
  const after = await tracker.getIssue(key);
  if (
    after === null ||
    isClosed(after.state) ||
    !sameEpicScope(input.epic, after) ||
    after.children.some((child) => !isClosed(child.state))
  )
    throw refuse(`${key} has changed or still has open children`);
  const comments = await assertAuthorized(tracker, key);
  if (!hasEpicWaiver(comments, input.replyUrl)) {
    await tracker.postComment(
      key,
      `Epic closure accepted in <${input.replyUrl}>.\n\n${EPIC_WAIVER_MARKER}`,
    );
  }
  await tracker.transition(key, "done");
  if ((await tracker.getIssue(key))?.state.type !== "completed")
    throw new TrackerRequestError(
      "unresolved",
      `${key} did not reach its done state`,
    );
}

/** Verify all tracker-side prerequisites before returning the write phase. */
export async function prepareSweepTracker(
  tracker: SweepTracker,
  input: SweepTrackerInput,
): Promise<() => Promise<void>> {
  const key = input.epic.identifier;
  if (localKey(tracker, input.personChecks ?? "") === key)
    throw refuse(
      `${key} is the standing issue_tracker.person_checks destination`,
    );
  if (tracker.stateName("done", input.epic.nativeType) === null)
    throw refuse(`${key} has no configured done state`);
  await assertAuthorized(tracker, key);
  const tails = approvedTails(input);
  const destination = await readDestination(tracker, input, tails);
  const moves = await planMoves(tracker, input, tails, destination);
  const plan: SweepPlan = { tracker, input, key, tails, destination, moves };

  return async () => {
    if ((await assertEpicUnchanged(plan)) === "done") return;
    await assertAuthorized(tracker, key);
    await assertDestinationOpen(plan);
    await postOperatorSteps(plan);
    for (const move of moves) await applyMove(plan, move);
    await closeEpic(plan);
  };
}

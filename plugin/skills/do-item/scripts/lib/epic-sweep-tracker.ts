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
    throw new TrackerRequestError(
      "invalid",
      "supply a tracker comment URL on an issue in this repository",
    );
  const { comments } = await tracker.issueComments(key);
  const reply = comments.find((comment) => comment.url === url.href);
  if (reply === undefined || !trustedReply(reply))
    throw new TrackerRequestError(
      "invalid",
      "the comment URL must name a trusted person's tracker reply",
    );
  // An edited answer is new authorization at its edit time. A proposal
  // edited after that authorization could now describe a different sweep.
  const postedAt = parseMs(reply.createdAt);
  const acceptedAt = parseMs(reply.editedAt ?? reply.createdAt);
  if (
    !Number.isFinite(postedAt) ||
    !Number.isFinite(acceptedAt) ||
    acceptedAt < postedAt
  )
    throw new TrackerRequestError(
      "invalid",
      "the tracker reply has no readable acceptance time",
    );
  const preceding: { body: string; effectiveAt: number; marker: string }[] = [];
  for (const comment of comments) {
    if (!comment.trusted) continue;
    const marker = sweepMarkerOnLastLine(comment.body);
    if (!marker) continue;
    const created = parseMs(comment.createdAt);
    const effectiveAt = parseMs(comment.editedAt ?? comment.createdAt);
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(effectiveAt) ||
      effectiveAt < created
    )
      throw new TrackerRequestError(
        "invalid",
        `Cannot establish the proposal's time relative to the reply (${comment.url ?? comment.id})`,
      );
    // A proposal that was already visible when the person accepted cannot be
    // silently ignored when an edit changes it afterwards. A genuinely later
    // proposal, however, is outside that authorization.
    if (created < acceptedAt && effectiveAt >= acceptedAt)
      throw new TrackerRequestError(
        "invalid",
        `Proposal changed after the reply (${comment.url ?? comment.id})`,
      );
    if (created >= acceptedAt) continue;
    preceding.push({ body: comment.body, effectiveAt, marker });
  }
  preceding.sort((left, right) => left.effectiveAt - right.effectiveAt);
  const latest = preceding.at(-1);
  if (
    latest &&
    preceding.some(
      ({ effectiveAt, marker }) =>
        effectiveAt === latest.effectiveAt && marker !== latest.marker,
    )
  ) {
    throw new TrackerRequestError(
      "invalid",
      "Multiple latest proposals have the same tracker time",
    );
  }
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

/** Verify all tracker-side prerequisites before returning the write phase. */
export async function prepareSweepTracker(
  tracker: SweepTracker,
  input: SweepTrackerInput,
): Promise<() => Promise<void>> {
  const { epic, personTails, ordinaryTails, operatorSteps, replyUrl } = input;
  const key = epic.identifier;
  const destinationKey = localKey(tracker, input.personChecks ?? "");
  if (destinationKey === key)
    throw new TrackerRequestError(
      "invalid",
      `${key} is the standing issue_tracker.person_checks destination`,
    );
  if (tracker.stateName("done", epic.nativeType) === null)
    throw new TrackerRequestError(
      "invalid",
      `${key} has no configured done state`,
    );
  await assertAuthorized(tracker, key);
  const tails = new Map([
    ...personTails.map((child) => [child, true] as const),
    ...ordinaryTails.map((child) => [child, false] as const),
  ]);
  if (tails.size !== personTails.length + ordinaryTails.length)
    throw new TrackerRequestError(
      "invalid",
      `${key} has duplicate approved tails`,
    );

  let destination: Issue | null = null;
  if (personTails.length > 0 || operatorSteps.length > 0) {
    if (destinationKey === null)
      throw new TrackerRequestError(
        "invalid",
        "set issue_tracker.person_checks to the standing open issue's key",
      );
    destination = await tracker.getIssue(destinationKey);
    if (
      destination === null ||
      isClosed(destination.state) ||
      destination.identifier === key ||
      destination.parent?.identifier === key ||
      tails.has(destination.identifier)
    )
      throw new TrackerRequestError(
        "invalid",
        "issue_tracker.person_checks must name an open issue outside the epic",
      );
  }
  const moves: Array<{ child: string; parent: string | null }> = [];
  for (const [child, person] of tails) {
    const issue = await tracker.getIssue(child);
    if (issue === null)
      throw new TrackerRequestError(
        "invalid",
        `approved tail ${child} is unreadable`,
      );
    const parent = person ? (destination?.identifier ?? null) : null;
    if (
      issue.parent?.identifier !== key &&
      ((issue.parent?.identifier ?? null) !== parent ||
        !(await isRelated(tracker, child, key)))
    )
      throw new TrackerRequestError(
        "invalid",
        `approved tail ${child} moved without the expected link or destination`,
      );
    if (!isClosed(issue.state)) {
      assertTailKind(input, issue, person);
      if (
        issue.parent?.identifier === key ||
        (!person && !isInBacklog(tracker, issue))
      )
        moves.push({ child, parent });
    }
  }

  return async () => {
    const before = await tracker.getIssue(key);
    if (before === null || !before.isEpic)
      throw new TrackerRequestError(
        "invalid",
        `${key} is no longer a readable epic`,
      );
    if (before.state.type === "completed") return;
    if (
      isClosed(before.state) ||
      !sameEpicScope(epic, before) ||
      before.children.some(
        (child) => !isClosed(child.state) && !tails.has(child.identifier),
      )
    )
      throw new TrackerRequestError(
        "invalid",
        `${key} changed since its closure proposal`,
      );
    await assertAuthorized(tracker, key);
    if (destination !== null) {
      const current = await tracker.getIssue(destination.identifier);
      if (
        current === null ||
        isClosed(current.state) ||
        current.parent?.identifier === key
      )
        throw new TrackerRequestError(
          "invalid",
          "issue_tracker.person_checks must still name an open issue outside the epic",
        );
    }
    if (destination !== null && operatorSteps.length > 0) {
      const steps = operatorSteps.map(
        (step) => `- [ ] ${step.replace(/\s+/g, " ")}`,
      );
      await postOnce(
        tracker,
        destination.identifier,
        [`Operator checks from epic ${epicRef(epic)}.`, "", ...steps].join(
          "\n",
        ),
      );
    }
    for (const { child, parent } of moves) {
      const issue = await tracker.getIssue(child);
      if (issue === null)
        throw new TrackerRequestError(
          "invalid",
          `approved tail ${child} changed parent during the sweep`,
        );
      if (isClosed(issue.state)) continue;
      assertTailKind(input, issue, parent !== null);
      if (
        issue.parent?.identifier === key &&
        !(await isRelated(tracker, child, key))
      )
        await tracker.relate(child, "related", key);
      const movedTo =
        destination !== null && parent === destination.identifier
          ? ` to the standing person-checks list ${epicRef(destination)}`
          : "";
      if (issue.parent?.identifier === key) {
        await postOnce(
          tracker,
          child,
          `Moved from epic ${epicRef(epic)}${movedTo} during its closure sweep.`,
        );
        await tracker.updateIssue(child, { parent });
      } else if ((issue.parent?.identifier ?? null) !== parent) {
        throw new TrackerRequestError(
          "invalid",
          `approved tail ${child} changed parent during the sweep`,
        );
      }
      if (parent === null && !isInBacklog(tracker, issue))
        await tracker.transition(child, "backlog");
    }
    const after = await tracker.getIssue(key);
    if (
      after === null ||
      isClosed(after.state) ||
      !sameEpicScope(epic, after) ||
      after.children.some((child) => !isClosed(child.state))
    )
      throw new TrackerRequestError(
        "invalid",
        `${key} has changed or still has open children`,
      );
    const comments = await assertAuthorized(tracker, key);
    if (!hasEpicWaiver(comments, replyUrl)) {
      await tracker.postComment(
        key,
        `Epic closure accepted in <${replyUrl}>.\n\n${EPIC_WAIVER_MARKER}`,
      );
    }
    await tracker.transition(key, "done");
    if ((await tracker.getIssue(key))?.state.type !== "completed")
      throw new TrackerRequestError(
        "unresolved",
        `${key} did not reach its done state`,
      );
  };
}

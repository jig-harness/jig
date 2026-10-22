/**
 * What the stores that keep one page or issue per change (the Notion and
 * GitHub stores) share: which change an event belongs to, the events a
 * page holds as `list` returns them, the order an append plans its events
 * in, and the parts of a change's view computed alike in both.
 */
import {
  type DecisionEvent,
  distinctById,
  type FindingEvent,
  type ReflectionEvent,
} from "./events.ts";

/** Which change a finding belongs to: its issue key, else its branch. */
export function changeKey(finding: FindingEvent): string {
  const change = finding.change;
  const what =
    change.issue !== null
      ? `issue:${change.issue}`
      : `branch:${change.branch ?? "(no branch)"}`;
  return `${change.repository}#${what}`;
}

/** The change of the first finding among `copies`, else `unfiled`. */
export function changeKeyOf(
  copies: ReadonlyArray<{ event: ReflectionEvent }>,
  unfiled: string,
): string {
  const finding = copies.find((copy) => copy.event.type === "finding");
  return finding === undefined
    ? unfiled
    : changeKey(finding.event as FindingEvent);
}

/** Each id's event as `list` returns it: the copy whose text sorts first. */
export function winnersOf(
  copies: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
): Map<string, ReflectionEvent> {
  return new Map(
    distinctById(copies).map((stored) => [stored.event.id, stored.event]),
  );
}

/**
 * The events a page holds, each as `list` returns it: where a page holds
 * the losing copy of an id conflict, the winning copy speaks for it.
 */
export function eventsOn(
  ids: Iterable<string>,
  winners: ReadonlyMap<string, ReflectionEvent>,
): ReflectionEvent[] {
  return [...new Set(ids)].flatMap((id) => {
    const event = winners.get(id);
    return event === undefined ? [] : [event];
  });
}

/** Plan an append's events: findings first, so a decision finds a finding sent beside it. */
export function planFindingsFirst(
  lines: ReadonlyArray<{ event: ReflectionEvent; text: string }>,
  add: (event: ReflectionEvent, text: string) => void,
): void {
  for (const type of ["finding", "decision"])
    for (const { event, text } of lines)
      if (event.type === type) add(event, text);
}

export interface ChangeEvents {
  /** Oldest first. */
  findings: FindingEvent[];
  decisions: DecisionEvent[];
}

/** A change's findings, oldest first, and its decisions. */
export function changeEvents(events: readonly ReflectionEvent[]): ChangeEvents {
  return {
    findings: events
      .filter((event): event is FindingEvent => event.type === "finding")
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    decisions: events.filter(
      (event): event is DecisionEvent => event.type === "decision",
    ),
  };
}

/** A change's title: `[<repository>] <issue or branch>: <first finding's title>`. */
export function changeTitle(
  key: string,
  first: FindingEvent | undefined,
): string {
  if (first === undefined) return key;
  const change = first.change;
  return `[${change.repository}] ${change.issue ?? change.branch ?? "(no branch)"}: ${first.title}`;
}

/**
 * Where a decision's change is: its commit, pull request (its number after
 * `pullRequestMark`) and issue, those it names.
 */
export function decisionPlaces(
  decision: DecisionEvent,
  pullRequestMark: string,
): string[] {
  return [
    decision.commit === undefined ? null : `commit ${decision.commit}`,
    decision.pull_request === undefined
      ? null
      : `pull request ${pullRequestMark}${decision.pull_request}`,
    decision.issue === undefined ? null : `issue ${decision.issue}`,
  ].filter((part) => part !== null);
}

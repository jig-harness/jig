/**
 * Who made a GitHub issue ready, for a ready pool: the actor of the newest
 * timeline event that put the issue in the open state it is in now, and
 * whether that actor can write to the repository.
 *
 * In labels mode a state is its label, and the issue's state is the
 * furthest-along label it carries, so the timeline's label events are
 * replayed and the move into the state is the newest event after which it
 * reads as the current one, having read as another before (an edit of a
 * lower label while a higher one holds is no move), or a reopening after
 * it. The state that carries no label (`todo`, which every new issue reads
 * as) is entered the same way; with no such event in the whole timeline the
 * issue was opened there, by its author.
 * In project mode the move is the newest change of the board's status field
 * to the state's option, or a reopening after it; a change a project
 * workflow made is an untrusted one, and an issue with no option set is in
 * no recorded state. Every other gap (a timeline longer than one read, no
 * such event, a deleted account) throws rather than answer.
 */

import { type Assigner, type Tracker, TrackerRequestError } from "../port.ts";
import { canWrite, refuseForeign } from "./assigner.ts";
import type { Client } from "./client.ts";
import type { OPEN_STATES } from "./model.ts";
import { record, str, wholeLabels } from "./read.ts";
import { GitHubApiError } from "./transport.ts";

type OpenState = (typeof OPEN_STATES)[number];

const EVENTS = 100;

/**
 * The events that can move an issue into a state. A board's status changes
 * are asked for only in project mode: reading them needs the `read:project`
 * scope, which a tracker on labels does not hold.
 */
const MOVES = (onBoard: boolean) => `
query TrackerStateChanges($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      author { login }
      timelineItems(itemTypes: [${onBoard ? "PROJECT_V2_ITEM_STATUS_CHANGED_EVENT" : "LABELED_EVENT, UNLABELED_EVENT"}, REOPENED_EVENT], last: ${EVENTS}) {
        pageInfo { hasPreviousPage }
        nodes {
          __typename
          ... on ReopenedEvent { createdAt actor { login } }
          ${
            onBoard
              ? "... on ProjectV2ItemStatusChangedEvent { createdAt actor { login } status wasAutomated project { url } }"
              : `... on LabeledEvent { createdAt actor { login } label { name } }
          ... on UnlabeledEvent { createdAt actor { login } label { name } }`
          }
        }
      }
    }
  }
}`;

/** The status field GitHub's status-change events record. */
const STATUS_FIELD = "Status";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What puts a board issue in its state: the board's option set. */
type Target = { option: string; board: string };

interface Move {
  at: string;
  actor: string | null;
  automated: boolean;
}

/** Whether event `node` of kind `kind` put the issue in `target`. */
function movesInto(
  kind: unknown,
  node: Record<string, unknown>,
  target: Target,
): boolean {
  if (kind === "ReopenedEvent") return true;
  return (
    kind === "ProjectV2ItemStatusChangedEvent" &&
    typeof node.status === "string" &&
    same(node.status, target.option) &&
    same(str(record(node.project, "project").url, "project.url"), target.board)
  );
}

/** The events that put the issue in `target`, oldest first. */
function moves(nodes: unknown[], key: string, target: Target): Move[] {
  const out: Move[] = [];
  for (const [i, n] of nodes.entries()) {
    const node = record(n, `issue ${key} event ${i}`);
    if (!movesInto(node.__typename, node, target)) continue;
    out.push({
      at: str(node.createdAt, `issue ${key} event ${i}.createdAt`),
      actor:
        node.actor === null
          ? null
          : str(record(node.actor, "actor").login, "actor.login"),
      automated: node.wasAutomated === true,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The moves into the state `labels` read as now, in labels mode, by
 * replaying the timeline's state-label events: the state is the
 * furthest-along label, so only an event after which the state is the
 * current one, having been another before it, is a move into it (a lower
 * label's edit while a higher one holds changes nothing). The labels before
 * the first event are the current ones with every event undone, so a
 * timeline longer than one read still replays from a known start. `opened`
 * says the issue was in the state before any event.
 */
interface LabelEvent {
  at: string;
  actor: string | null;
  /** True for a label added, false for one removed, null for a reopening. */
  add: boolean | null;
  label: string;
}

/** The timeline's reopenings and its events of the `tracked` (lower-cased) state labels, oldest first. */
function labelEvents(
  nodes: unknown[],
  key: string,
  tracked: Set<string>,
): LabelEvent[] {
  const events: LabelEvent[] = [];
  for (const [i, n] of nodes.entries()) {
    const node = record(n, `issue ${key} event ${i}`);
    const at = str(node.createdAt, `issue ${key} event ${i}.createdAt`);
    const actor =
      node.actor === null
        ? null
        : str(record(node.actor, "actor").login, "actor.login");
    if (node.__typename === "ReopenedEvent") {
      events.push({ at, actor, add: null, label: "" });
      continue;
    }
    const label = str(
      record(node.label, "label").name,
      "label.name",
    ).toLowerCase();
    if (tracked.has(label))
      events.push({
        at,
        actor,
        add: node.__typename === "LabeledEvent",
        label,
      });
  }
  return events;
}

/** `held` with `event` applied (a reopening changes no label). */
function applied(held: Set<string>, event: LabelEvent): void {
  if (event.add === true) held.add(event.label);
  else if (event.add === false) held.delete(event.label);
}

/**
 * The moves into the state `labels` read as now, in labels mode, by
 * replaying the timeline's state-label events: the state is the
 * furthest-along label, so only an event after which the state is the
 * current one, having been another before it, is a move into it (a lower
 * label's edit while a higher one holds changes nothing). The labels before
 * the first event are the current ones with every event undone, so a
 * timeline longer than one read still replays from a known start. `opened`
 * says the issue was in the state before any event.
 */
function labelMoves(
  nodes: unknown[],
  key: string,
  labels: string[],
  stateLabels: string[],
  stateIn: (labels: string[]) => string,
): { moves: Move[]; opened: boolean } {
  const tracked = new Set(stateLabels.map((l) => l.toLowerCase()));
  const events = labelEvents(nodes, key, tracked);
  const held = new Set(
    labels.map((l) => l.toLowerCase()).filter((l) => tracked.has(l)),
  );
  for (const e of [...events].reverse())
    applied(held, { ...e, add: e.add === null ? null : !e.add });
  const now = stateIn(labels);
  let before = stateIn([...held]);
  const opened = before === now;
  const out: Move[] = [];
  for (const e of events) {
    applied(held, e);
    const after = stateIn([...held]);
    if (e.add === null || (after === now && before !== now))
      out.push({ at: e.at, actor: e.actor, automated: false });
    before = after;
  }
  return { moves: out, opened };
}

export function stateChangeOperations(
  client: Client,
): Pick<Tracker, "stateChangedBy"> {
  const { model, ctx } = client;

  /** What put the issue in its current state, or why that is not recorded. */
  function targetOf(
    board: NonNullable<Client["ctx"]["board"]>,
    key: string,
    status: string | null,
  ): Target {
    if (!same(board.statusField, STATUS_FIELD))
      throw new TrackerRequestError(
        "invalid",
        `the board's status field is ${board.statusField}: GitHub records who changed the ${STATUS_FIELD} field only, so who made ${key} ready is not recorded`,
      );
    if (status === null)
      throw new TrackerRequestError(
        "invalid",
        `issue ${key} has no ${STATUS_FIELD} option on the board: it is in no recorded state, so who made it ready is not recorded`,
      );
    return { option: status, board: board.url };
  }

  /** The newest move into the issue's state, and whether it was opened there. */
  function latestMove(
    nodes: unknown[],
    key: string,
    issue: Parameters<typeof wholeLabels>[0] & { status: string | null },
    state: OpenState,
  ): { latest: Move | undefined; opened: boolean } {
    if (ctx.board !== null)
      return {
        latest: moves(nodes, key, targetOf(ctx.board, key, issue.status)).at(
          -1,
        ),
        opened: false,
      };
    const replayed = labelMoves(
      nodes,
      key,
      wholeLabels(issue),
      model.stateLabels,
      (labels) => model.stateOf({ ...issue, labels }),
    );
    return {
      latest: replayed.moves.at(-1),
      opened: replayed.opened && model.stateLabel(state) === null,
    };
  }

  return {
    async stateChangedBy(key) {
      const ref = client.ref(key);
      refuseForeign(client, ref, key);
      const found = await client.issue(ref);
      if (found === null)
        throw new GitHubApiError(`issue ${key} does not exist`);
      const { issue } = found;
      if (!issue.open)
        throw new GitHubApiError(`issue ${key} is closed: it is in no pool`);
      // An open issue reads as an open state.
      const state = model.stateOf({
        ...issue,
        labels: wholeLabels(issue),
      }) as OpenState;
      const name = model.stateName(state) ?? state;
      const data = record(
        await client.transport(MOVES(ctx.board !== null), {
          owner: ref.owner,
          name: ref.name,
          number: ref.number,
        }),
        "data",
      );
      const read = record(
        record(data.repository, "repository").issue,
        `issue ${key}`,
      );
      const timeline = record(read.timelineItems, `issue ${key}.timelineItems`);
      if (!Array.isArray(timeline.nodes))
        throw new GitHubApiError(`issue ${key}.timelineItems: nodes missing`);
      const whole =
        record(timeline.pageInfo, "pageInfo").hasPreviousPage !== true;
      const found2 = latestMove(timeline.nodes, key, issue, state);
      let latest = found2.latest;
      const opened = found2.opened;
      // Never moved into the state: opened in it.
      if (latest === undefined && whole && opened)
        latest = {
          at: "",
          actor:
            read.author === null
              ? null
              : str(record(read.author, "author").login, "author.login"),
          automated: false,
        };
      if (latest === undefined)
        throw new GitHubApiError(
          whole
            ? `issue ${key}: no event moved it into ${name}`
            : `issue ${key}: its move into ${name} lies beyond the last ${EVENTS} events`,
        );
      if (latest.actor === null)
        throw new GitHubApiError(
          `issue ${key}: its move into ${name} names no actor (a deleted account)`,
        );
      if (latest.automated)
        return {
          id: latest.actor,
          name: `a project workflow (as ${latest.actor})`,
          trusted: false,
        } satisfies Assigner;
      return {
        id: latest.actor,
        name: latest.actor,
        trusted: await canWrite(client, latest.actor),
      } satisfies Assigner;
    },
  };
}

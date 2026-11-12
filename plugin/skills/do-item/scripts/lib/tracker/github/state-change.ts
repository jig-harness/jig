/**
 * Who made a GitHub issue ready, for a ready pool: the actor of the newest
 * timeline event that put the issue in the open state it is in now, and
 * whether that actor can write to the repository.
 *
 * In labels mode a state is its label, so the move into it is the newest
 * labelling with that label (GitHub records one for a label an issue is
 * opened with), or a reopening after it. The state that carries no label
 * (`todo`, which every new issue reads as) is entered by removing the last
 * state label, or by a reopening: the newest of those is the move, and with
 * neither in the whole timeline the issue was opened there, by its author.
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

/**
 * What puts an issue in its state: its label added or any state label
 * changed (the state is the furthest-along label, so removing a higher one
 * exposes this one), every state label gone, or the board's option set.
 */
type Target =
  | { label: string; stateLabels: string[] }
  | { unlabeled: string[] }
  | { option: string; board: string };

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
  const label = () => str(record(node.label, "label").name, "label.name");
  if (kind === "LabeledEvent" && "label" in target)
    return target.stateLabels.some((l) => same(l, label()));
  if (kind === "UnlabeledEvent" && "label" in target)
    return target.stateLabels.some((l) => same(l, label()));
  if (kind === "UnlabeledEvent" && "unlabeled" in target)
    return target.unlabeled.some((l) => same(l, label()));
  return (
    kind === "ProjectV2ItemStatusChangedEvent" &&
    "option" in target &&
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

export function stateChangeOperations(
  client: Client,
): Pick<Tracker, "stateChangedBy"> {
  const { model, ctx } = client;

  /** What put the issue in its current state, or why that is not recorded. */
  function targetOf(key: string, state: OpenState, status: string | null) {
    if (ctx.board === null) {
      const label = model.stateLabel(state);
      return label === null
        ? { unlabeled: model.stateLabels }
        : { label, stateLabels: model.stateLabels };
    }
    if (!same(ctx.board.statusField, STATUS_FIELD))
      throw new TrackerRequestError(
        "invalid",
        `the board's status field is ${ctx.board.statusField}: GitHub records who changed the ${STATUS_FIELD} field only, so who made ${key} ready is not recorded`,
      );
    if (status === null)
      throw new TrackerRequestError(
        "invalid",
        `issue ${key} has no ${STATUS_FIELD} option on the board: it is in no recorded state, so who made it ready is not recorded`,
      );
    return { option: status, board: ctx.board.url };
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
      const target: Target = targetOf(key, state, issue.status);
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
      let latest = moves(timeline.nodes, key, target).at(-1);
      // Never moved into the state that carries no label: opened in it.
      if (latest === undefined && whole && "unlabeled" in target)
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

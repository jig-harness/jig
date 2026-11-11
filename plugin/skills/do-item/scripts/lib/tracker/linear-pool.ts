/**
 * The Linear adapter's pool queries, filters and assignment reads: what a
 * pool reads of each issue, the filter a candidate pool reads with, every
 * open issue of the team, the issues
 * assigned to one user in the given states, and who made an issue's
 * current assignment, from the issue's
 * history, with the claim's reads and write (`linear-claim.ts`). `linear.ts`
 * hands in its pool query and parser, so the assignment reads return the
 * pool form the candidate pools do.
 *
 * A Linear user is named by email or display name, compared without regard
 * to case. An assigner is trusted when it is a non-guest member of the team.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import type { LinearTransport } from "./linear.ts";
import { claimOperations } from "./linear-claim.ts";
import {
  type Assigner,
  CLOSED_STATE_TYPES,
  type PoolQuery,
  type StateNames,
  TrackerRequestError,
} from "./port.ts";
import type { CorePoolIssue, CoreTracker } from "./facets/tracker.ts";
import { readEstimate, type WithEstimate } from "./linear-facets.ts";
import {
  labelPage,
  optStr,
  priorityOf,
  record,
  ShapeError,
  str,
  timestamp,
} from "./linear-shapes.ts";

/** An issue's assignment that cannot be traced to the user who made it. */
class AssignmentError extends Error {}

/**
 * What a pool reads of each issue: its open children read one deep, as a
 * flag, and `extra` (the estimate, where size is kept in it).
 */
const poolFields = (extra: string) => `
  identifier title url priority${extra} createdAt updatedAt
  state { id name type }
  assignee { id name }
  labels(first: 100) { pageInfo { hasNextPage } nodes { name } }
  children(first: 1, filter: { state: { type: { nin: ${JSON.stringify(CLOSED_STATE_TYPES)} } } }) {
    pageInfo { hasNextPage }
    nodes { id }
  }
`;

/** The pool reads: a filtered list, an issue's open children, and one issue. */
export function poolQueries(extra = "") {
  const fields = poolFields(extra);
  return {
    pool: `
query TrackerPool($filter: IssueFilter!, $after: String) {
  issues(first: 100, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${fields} }
  }
}`,
    openChildren: `
query TrackerOpenChildren($id: String!, $filter: IssueFilter!, $after: String) {
  issue(id: $id) {
    children(first: 100, after: $after, filter: $filter) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`,
    poolIssue: `
query TrackerPoolIssue($id: String!) { issue(id: $id) { ${fields} } }`,
  };
}

/** Parse one pool node; a truncated label page is recorded, not fatal. */
export function parsePoolIssue(raw: unknown): WithEstimate<CorePoolIssue> {
  const n = record(raw, "pool issue");
  const where = `pool issue ${typeof n.identifier === "string" ? n.identifier : "?"}`;
  const labels = labelPage(n.labels, where);
  const children = record(n.children, `${where}.children`);
  if (
    !Array.isArray(children.nodes) ||
    !isRecord(children.pageInfo) ||
    typeof children.pageInfo.hasNextPage !== "boolean"
  )
    throw new ShapeError(`${where}.children: unreadable`);
  const state = record(n.state, `${where}.state`);
  const assignee =
    n.assignee === null ? null : record(n.assignee, `${where}.assignee`);
  return {
    identifier: str(n.identifier, `${where}.identifier`),
    title: str(n.title, `${where}.title`),
    url: optStr(n.url, `${where}.url`),
    priority: priorityOf(n.priority, where),
    ...readEstimate(n, where),
    createdAt: timestamp(n.createdAt, `${where}.createdAt`),
    ...(typeof n.updatedAt === "string" ? { updatedAt: n.updatedAt } : {}),
    state: {
      id: str(state.id, `${where}.state.id`),
      name: str(state.name, `${where}.state.name`),
      type: str(state.type, `${where}.state.type`),
    },
    assignee:
      assignee === null
        ? null
        : {
            id: str(assignee.id, `${where}.assignee.id`),
            name: str(assignee.name, `${where}.assignee.name`),
          },
    labels: labels.names,
    hasOpenChildren: children.nodes.length > 0 || children.pageInfo.hasNextPage,
    truncated: labels.truncated ? ["labels"] : [],
  };
}

/** The filter of an issue that is not finished. */
export const OPEN = { state: { type: { nin: [...CLOSED_STATE_TYPES] } } };

/**
 * Linear's issue filter for a pool. Each label clause is its own `and` entry:
 * two `labels` keys in one object would leave only the last. "Carries none"
 * is `every` + `nin`; `some` + `nin` would match any issue with one label
 * outside the list, which is nearly all of them.
 */
export function poolFilter(
  team: string,
  query: PoolQuery,
): Record<string, unknown> {
  if (
    query.withSomeOf.length === 0 ||
    query.withSomeOf.some((l) => l.length === 0)
  )
    throw new TrackerRequestError(
      "invalid",
      "a pool query needs at least one non-empty label list; an empty one would read every open issue",
    );
  return {
    and: [
      { team: { key: { eq: team } } },
      OPEN,
      ...query.withSomeOf.map((l) => ({ labels: { name: { in: l } } })),
      ...(query.withNoneOf === undefined || query.withNoneOf.length === 0
        ? []
        : [{ labels: { every: { name: { nin: query.withNoneOf } } } }]),
    ],
  };
}

type Pager = (
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => unknown,
  where: string,
  signal?: AbortSignal,
) => Promise<unknown[]>;

export interface AssignedOptions {
  team: string;
  states: StateNames;
  transport: LinearTransport;
  pageAll: Pager;
  poolQuery: string;
  parsePool: (raw: unknown) => CorePoolIssue;
}

const USER = "id email displayName name";

const HISTORY_QUERY = `
query TrackerAssignmentHistory($id: String!, $team: String!, $after: String) {
  issue(id: $id) {
    assignee { ${USER} }
    history(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt
        toAssignee { ${USER} }
        actor { id name guest teams(filter: { key: { eq: $team } }) { nodes { key } } }
      }
    }
  }
}`;

function field(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new AssignmentError(`${where}: expected an object`);
  return v;
}

/** Whether `user` is the one `name` names: its id, email or display name. */
function names(user: unknown, name: string): boolean {
  if (!isRecord(user)) return false;
  const wanted = name.toLowerCase();
  return ["id", "email", "displayName", "name"].some(
    (k) => typeof user[k] === "string" && user[k].toLowerCase() === wanted,
  );
}

function assigner(actor: unknown, key: string, team: string): Assigner {
  if (!isRecord(actor) || typeof actor.id !== "string")
    throw new AssignmentError(
      `issue ${key}: its assignment was made by no user (an integration or an automation)`,
    );
  const teams = field(actor.teams, `issue ${key} assigner.teams`).nodes;
  return {
    id: actor.id,
    name: typeof actor.name === "string" ? actor.name : actor.id,
    trusted:
      actor.guest === false &&
      Array.isArray(teams) &&
      teams.some((t) => isRecord(t) && t.key === team),
  };
}

export function assignedOperations(
  opts: AssignedOptions,
): Pick<
  CoreTracker,
  | "assignedIssues"
  | "assignedBy"
  | "viewer"
  | "assignees"
  | "assign"
  | "assignUnassigned"
  | "user"
  | "openPopulation"
> {
  const { team, states, transport, pageAll } = opts;
  return {
    ...claimOperations(transport, pageAll),
    async openPopulation(signal) {
      const filter = { and: [{ team: { key: { eq: team } } }, OPEN] };
      const nodes = await pageAll(
        transport,
        opts.poolQuery,
        { filter },
        (d) => d.issues,
        `open issues of ${team}`,
        signal,
      );
      return nodes.map(opts.parsePool);
    },
    async assignedIssues(identity, wanted, signal) {
      if (wanted.length === 0)
        throw new TrackerRequestError(
          "invalid",
          "an assigned-issues query needs at least one state",
        );
      const filter = {
        and: [
          { team: { key: { eq: team } } },
          {
            assignee: {
              or: [
                { email: { eqIgnoreCase: identity } },
                { displayName: { eqIgnoreCase: identity } },
              ],
            },
          },
          {
            state: {
              name: {
                in: wanted
                  .map((s) => states[s])
                  .filter((n): n is string => n !== null),
              },
            },
          },
        ],
      };
      const nodes = await pageAll(
        transport,
        opts.poolQuery,
        { filter },
        (d) => d.issues,
        `issues assigned to ${identity}`,
        signal,
      );
      return nodes.map(opts.parsePool);
    },

    async assignedBy(key, assignee) {
      let current: unknown = null;
      const nodes = await pageAll(
        transport,
        HISTORY_QUERY,
        { id: key, team },
        (d) => {
          const issue = field(d.issue, `issue ${key}`);
          current = issue.assignee;
          return issue.history;
        },
        `history of ${key}`,
      );
      const who = assignee ?? (isRecord(current) ? current.id : undefined);
      if (typeof who !== "string")
        throw new AssignmentError(`issue ${key} is assigned to nobody`);
      if (!names(current, who))
        throw new AssignmentError(
          `issue ${key} is no longer assigned to ${who}`,
        );
      const latest = nodes
        .map((n, i) => field(n, `history of ${key}[${i}]`))
        .filter((n) => names(n.toAssignee, who))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .at(-1);
      if (latest === undefined)
        throw new AssignmentError(
          `issue ${key}: its history holds no assignment of ${who}`,
        );
      return assigner(latest.actor, key, team);
    },
  };
}

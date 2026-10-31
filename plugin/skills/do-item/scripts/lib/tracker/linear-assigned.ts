/**
 * The Linear adapter's assignment reads: the issues assigned to one user in
 * the given states, and who made an issue's current assignment, from the
 * issue's history. Kept beside `linear.ts`, which hands in its pool query and
 * parser, so the two reads share the pool form the candidate pools return.
 *
 * A Linear user is named by email or display name, compared without regard
 * to case. An assigner is trusted when it is a non-guest member of the team.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import type { LinearTransport } from "./linear.ts";
import type { Assigner, CanonicalState, PoolIssue, Tracker } from "./port.ts";

type Pager = (
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => unknown,
  where: string,
) => Promise<unknown[]>;

export interface AssignedOptions {
  team: string;
  states: Record<CanonicalState, string>;
  transport: LinearTransport;
  pageAll: Pager;
  poolQuery: string;
  parsePool: (raw: unknown) => PoolIssue;
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
  if (!isRecord(v)) throw new Error(`${where}: expected an object`);
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
    throw new Error(
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
): Pick<Tracker, "assignedIssues" | "assignedBy"> {
  const { team, states, transport, pageAll } = opts;
  return {
    async assignedIssues(identity, wanted) {
      if (wanted.length === 0)
        throw new Error("an assigned-issues query needs at least one state");
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
          { state: { name: { in: wanted.map((s) => states[s]) } } },
        ],
      };
      const nodes = await pageAll(
        transport,
        opts.poolQuery,
        { filter },
        (d) => d.issues,
        `issues assigned to ${identity}`,
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
        throw new Error(`issue ${key} is assigned to nobody`);
      const latest = nodes
        .map((n, i) => field(n, `history of ${key}[${i}]`))
        .filter((n) => names(n.toAssignee, who))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .at(-1);
      if (latest === undefined)
        throw new Error(
          `issue ${key}: its history holds no assignment of ${who}`,
        );
      return assigner(latest.actor, key, team);
    },
  };
}

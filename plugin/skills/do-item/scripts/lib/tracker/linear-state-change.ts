/**
 * Who made a Linear issue ready, for a ready pool: the actor of the newest
 * entry in the issue's history that moved it into the workflow state it is
 * in now, and whether that actor is a non-guest member of the team. An issue
 * whose history holds no such move was created in that state, so its
 * creator made it ready. A move an integration or an automation made (no
 * user as its actor) is an untrusted one; a history that cannot be read in
 * full throws, so an unknown mover is never read as a trusted one.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import type { LinearTransport } from "./linear.ts";
import type { AssignedOptions } from "./linear-pool.ts";
import type { Assigner } from "./port.ts";

/** An issue whose latest move into its state cannot be traced. */
class StateChangeError extends Error {}

/**
 * What a history read takes of the user who made a change. The team
 * connection is bounded because Linear prices an unbounded one at its
 * default page of 50 for every history node (6,013 points for a 57-node
 * history against 623 with the bound); the filter leaves at most one team.
 */
export const ACTOR =
  "id name guest teams(first: 1, filter: { key: { eq: $team } }) { nodes { key } }";

const STATE_HISTORY = `
query TrackerStateHistory($id: String!, $team: String!, $after: String) {
  issue(id: $id) {
    state { id name }
    creator { ${ACTOR} }
    history(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id createdAt
        toState { id }
        actor { ${ACTOR} }
      }
    }
  }
}`;

function field(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new StateChangeError(`${where}: expected an object`);
  return v;
}

/** A user of the tracker as an assigner or a mover: trusted when a non-guest member of `team`. */
export function teamMember(
  actor: Record<string, unknown> & { id: string },
  team: string,
): Assigner {
  const teams = isRecord(actor.teams) ? actor.teams.nodes : undefined;
  return {
    id: actor.id,
    name: typeof actor.name === "string" ? actor.name : actor.id,
    trusted:
      actor.guest === false &&
      Array.isArray(teams) &&
      teams.some((t) => isRecord(t) && t.key === team),
  };
}

/** The user who made the move; untrusted when no user made it. */
function mover(actor: unknown, team: string): Assigner {
  return isRecord(actor) && typeof actor.id === "string"
    ? teamMember(actor as Record<string, unknown> & { id: string }, team)
    : { id: "", name: "an integration or an automation", trusted: false };
}

export function stateChangeOperations(opts: {
  team: string;
  transport: LinearTransport;
  pageAll: AssignedOptions["pageAll"];
}): { stateChangedBy(key: string): Promise<Assigner> } {
  const { team, transport, pageAll } = opts;
  return {
    async stateChangedBy(key) {
      let issue: Record<string, unknown> | null = null;
      const nodes = await pageAll(
        transport,
        STATE_HISTORY,
        { id: key, team },
        (d) => {
          issue = field(d.issue, `issue ${key}`);
          return issue.history;
        },
        `history of ${key}`,
      );
      const read = field(issue, `issue ${key}`);
      const state = field(read.state, `issue ${key}.state`);
      if (typeof state.id !== "string")
        throw new StateChangeError(`issue ${key}.state: no id`);
      const latest = nodes
        .map((n, i) => field(n, `history of ${key}[${i}]`))
        .filter((n) => isRecord(n.toState) && n.toState.id === state.id)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .at(-1);
      return mover(latest === undefined ? read.creator : latest.actor, team);
    },
  };
}

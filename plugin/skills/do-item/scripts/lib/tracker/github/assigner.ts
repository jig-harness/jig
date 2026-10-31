/**
 * Who made an issue's current assignment, on GitHub: the newest assignment
 * event for the assignee on the issue's timeline, and whether its actor can
 * write to the repository. A dispatcher starts work on an assigned issue
 * only when a person with write access made the assignment, so every gap
 * (a timeline longer than one read, no such event, an actor whose
 * permission cannot be read) throws rather than answer.
 */

import type { Assigner, Tracker } from "../port.ts";
import type { Client } from "./client.ts";
import { record, str } from "./read.ts";
import { GitHubApiError } from "./transport.ts";

const EVENTS = 100;

const ASSIGNMENTS = `
query TrackerAssignedBy($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      assignees(first: 1) { nodes { login } }
      timelineItems(itemTypes: [ASSIGNED_EVENT], last: ${EVENTS}) {
        pageInfo { hasPreviousPage }
        nodes {
          ... on AssignedEvent {
            createdAt
            actor { login }
            assignee {
              ... on User { login }
              ... on Bot { login }
              ... on Mannequin { login }
            }
          }
        }
      }
    }
  }
}`;

const COLLABORATOR = `
query TrackerCollaborator($owner: String!, $name: String!, $login: String!) {
  repository(owner: $owner, name: $name) {
    collaborators(query: $login, first: 100) {
      edges { permission node { login } }
    }
  }
}`;

/** The permissions that can write to the repository. */
const WRITERS = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

interface Assignment {
  at: string;
  actor: string | null;
  assignee: string;
}

function assignments(nodes: unknown[], key: string): Assignment[] {
  return nodes.map((n, i) => {
    const node = record(n, `issue ${key} assignment ${i}`);
    const assignee = record(
      node.assignee,
      `issue ${key} assignment ${i}.assignee`,
    );
    return {
      at: str(node.createdAt, `issue ${key} assignment ${i}.createdAt`),
      actor:
        node.actor === null
          ? null
          : str(record(node.actor, "actor").login, "actor.login"),
      assignee: str(
        assignee.login,
        `issue ${key} assignment ${i}.assignee.login`,
      ),
    };
  });
}

export function assignerOperations(
  client: Client,
): Pick<Tracker, "assignedBy"> {
  async function writes(login: string): Promise<boolean> {
    const data = record(
      await client.transport(COLLABORATOR, {
        owner: client.home.owner,
        name: client.home.name,
        login,
      }),
      "data",
    );
    const collaborators = record(
      record(data.repository, "repository").collaborators,
      "repository.collaborators",
    );
    if (!Array.isArray(collaborators.edges))
      throw new GitHubApiError("repository.collaborators: edges missing");
    return collaborators.edges.some((e) => {
      const edge = record(e, "collaborator");
      return (
        same(
          str(record(edge.node, "collaborator.node").login, "login"),
          login,
        ) && WRITERS.has(String(edge.permission))
      );
    });
  }

  return {
    async assignedBy(key, assignee) {
      const ref = client.ref(key);
      const data = record(
        await client.transport(ASSIGNMENTS, {
          owner: ref.owner,
          name: ref.name,
          number: ref.number,
        }),
        "data",
      );
      const issue = record(
        record(data.repository, "repository").issue,
        `issue ${key}`,
      );
      const current = record(issue.assignees, `issue ${key}.assignees`).nodes;
      const who =
        assignee ??
        (Array.isArray(current) && current[0] !== undefined
          ? str(record(current[0], "assignee").login, "assignee.login")
          : undefined);
      if (who === undefined)
        throw new GitHubApiError(`issue ${key} is assigned to nobody`);
      const timeline = record(
        issue.timelineItems,
        `issue ${key}.timelineItems`,
      );
      if (!Array.isArray(timeline.nodes))
        throw new GitHubApiError(`issue ${key}.timelineItems: nodes missing`);
      const latest = assignments(timeline.nodes, key)
        .filter((a) => same(a.assignee, who))
        .at(-1);
      if (latest === undefined)
        throw new GitHubApiError(
          record(timeline.pageInfo, "pageInfo").hasPreviousPage === true
            ? `issue ${key}: the assignment of ${who} lies beyond the last ${EVENTS} assignment events`
            : `issue ${key}: no assignment event names ${who}`,
        );
      if (latest.actor === null)
        throw new GitHubApiError(
          `issue ${key}: the assignment of ${who} names no actor (a deleted account)`,
        );
      return {
        id: latest.actor,
        name: latest.actor,
        trusted: await writes(latest.actor),
      } satisfies Assigner;
    },
  };
}

/**
 * What claiming an issue reads and writes on GitHub: the login the token
 * acts as, every assignee of an issue, and an assignment that replaces them.
 * A user is named by its node id, compared exactly, and its login.
 */

import type { Tracker, TrackerUser } from "../port.ts";
import type { Client } from "./client.ts";
import { record, str } from "./read.ts";
import { GitHubApiError } from "./transport.ts";

/** The most assignees GitHub lets an issue have. */
const MAX_ASSIGNEES = 10;

const VIEWER = `query TrackerViewer { viewer { id login } }`;

const ASSIGNEES = `
query TrackerAssignees($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      assignees(first: ${MAX_ASSIGNEES}) { totalCount nodes { id login } }
    }
  }
}`;

const ASSIGN = `mutation TrackerAssign($input: UpdateIssueInput!) {
  updateIssue(input: $input) { issue { id } }
}`;

function userOf(value: unknown, where: string): TrackerUser {
  const node = record(value, where);
  return { id: str(node.id, `${where}.id`), name: str(node.login, where) };
}

export function claimOperations(
  client: Client,
): Pick<Tracker, "viewer" | "assignees" | "assign"> {
  /** The issue's node id and every assignee; throws when the issue is absent or the list is cut. */
  async function read(
    key: string,
  ): Promise<{ id: string; users: TrackerUser[] }> {
    const ref = client.ref(key);
    const data = record(
      await client.transport(ASSIGNEES, {
        owner: ref.owner,
        name: ref.name,
        number: ref.number,
      }),
      "data",
    );
    const issue = record(data.repository, "repository").issue;
    if (issue === null || issue === undefined)
      throw new GitHubApiError(`issue ${key} does not exist`);
    const found = record(issue, `issue ${key}`);
    const list = record(found.assignees, `issue ${key}.assignees`);
    if (!Array.isArray(list.nodes))
      throw new GitHubApiError(`issue ${key}.assignees: nodes missing`);
    const users = list.nodes.map((n, i) =>
      userOf(n, `issue ${key}.assignees[${i}]`),
    );
    if (typeof list.totalCount !== "number" || list.totalCount > users.length)
      throw new GitHubApiError(
        `issue ${key}: its assignees could not be read in full`,
      );
    return { id: str(found.id, `issue ${key}.id`), users };
  }

  return {
    async viewer() {
      const data = record(await client.transport(VIEWER, {}), "data");
      return userOf(data.viewer, "viewer");
    },
    async assignees(key) {
      return (await read(key)).users;
    },
    async assign(key, user) {
      const { id } = await read(key);
      await client.mutate(ASSIGN, { input: { id, assigneeIds: [user.id] } });
    },
  };
}

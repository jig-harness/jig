/**
 * What claiming an issue reads and writes on Linear: the user the API key
 * acts as (`viewer`), the issue's assignee (a Linear issue has at most one),
 * and an assignment by user id. A user is named by its id, compared
 * exactly, and its display name.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import type { LinearTransport } from "./linear.ts";
import type { Tracker, TrackerUser } from "./port.ts";

/** An answer the claim cannot use: not the shape its query asked for, or a write Linear did not confirm. */
class LinearClaimError extends Error {}

const VIEWER = `query TrackerViewer { viewer { id name } }`;

const ASSIGNEE = `
query TrackerAssignee($id: String!) { issue(id: $id) { id assignee { id name } } }`;

const ASSIGN = `
mutation TrackerAssign($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

function record(v: unknown, where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new LinearClaimError(`${where}: expected an object`);
  return v;
}

function userOf(v: unknown, where: string): TrackerUser {
  const u = record(v, where);
  if (typeof u.id !== "string" || u.id === "")
    throw new LinearClaimError(`${where}.id: expected a string`);
  return { id: u.id, name: typeof u.name === "string" ? u.name : u.id };
}

export function claimOperations(
  transport: LinearTransport,
): Pick<Tracker, "viewer" | "assignees" | "assign"> {
  async function read(
    key: string,
  ): Promise<{ id: string; assignee: TrackerUser | null }> {
    const data = record(await transport(ASSIGNEE, { id: key }), "data");
    const issue = record(data.issue, `issue ${key}`);
    if (typeof issue.id !== "string")
      throw new LinearClaimError(`issue ${key}.id: expected a string`);
    return {
      id: issue.id,
      assignee:
        issue.assignee === null || issue.assignee === undefined
          ? null
          : userOf(issue.assignee, `issue ${key}.assignee`),
    };
  }

  return {
    async viewer() {
      return userOf(
        record(await transport(VIEWER, {}), "data").viewer,
        "viewer",
      );
    },
    async assignees(key) {
      const { assignee } = await read(key);
      return assignee === null ? [] : [assignee];
    },
    async assign(key, user) {
      const { id } = await read(key);
      const data = record(
        await transport(ASSIGN, { id, input: { assigneeId: user.id } }),
        "data",
      );
      if (record(data.issueUpdate, "issueUpdate").success !== true)
        throw new LinearClaimError(
          `Linear did not assign ${key} to ${user.name}`,
        );
    },
  };
}

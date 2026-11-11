/**
 * What claiming an issue reads and writes on Linear: the user the API key
 * acts as (`viewer`), the issue's assignee (a Linear issue has at most one),
 * an assignment by user id, the assignment of an unassigned issue verified
 * against the issue's history (`assign-verified.ts`: Linear offers no
 * conditional write), the deletion of a comment (a claim withdrawing its
 * marker), and the one user an email or a display name names. A
 * user is named by its id, compared exactly, and its display name.
 */

import { isRecord } from "../../../../../shared/guards.ts";
import { type AssigneeChange, assignVerified } from "./assign-verified.ts";
import type { LinearTransport } from "./linear.ts";
import { type Tracker, TrackerRequestError, type TrackerUser } from "./port.ts";

/** An answer the claim cannot use: not the shape its query asked for, or a write Linear did not confirm. */
class LinearClaimError extends Error {}

const VIEWER = `query TrackerViewer { viewer { id name } }`;

const ASSIGNEE = `
query TrackerAssignee($id: String!) { issue(id: $id) { id assignee { id name } } }`;

const USERS = `
query TrackerUsers($who: String!) {
  users(filter: { or: [{ email: { eqIgnoreCase: $who } }, { displayName: { eqIgnoreCase: $who } }] }, first: 2) {
    nodes { id name }
  }
}`;

const ASSIGNEE_HISTORY = `
query TrackerAssigneeHistory($id: String!, $after: String) {
  issue(id: $id) {
    history(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id createdAt fromAssignee { id } toAssignee { id } }
    }
  }
}`;

/** Every page of one connection, as `linear.ts` reads them. */
export type HistoryPager = (
  transport: LinearTransport,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: Record<string, unknown>) => unknown,
  where: string,
) => Promise<unknown[]>;

const COMMENT_DELETE = `
mutation TrackerDeleteComment($id: String!) {
  commentDelete(id: $id) { success }
}`;

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

/** The id a history entry's assignee side names; `null` for nobody. */
function sideId(v: unknown, where: string): string | null {
  if (v === null || v === undefined) return null;
  return userOf(v, where).id;
}

export function claimOperations(
  transport: LinearTransport,
  pageAll: HistoryPager,
): Pick<
  Tracker,
  | "viewer"
  | "assignees"
  | "assign"
  | "user"
  | "assignUnassigned"
  | "deleteComment"
> {
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

  async function assignId(key: string, assigneeId: string, name: string) {
    const { id } = await read(key);
    const data = record(
      await transport(ASSIGN, { id, input: { assigneeId } }),
      "data",
    );
    if (record(data.issueUpdate, "issueUpdate").success !== true)
      throw new LinearClaimError(`Linear did not assign ${key} to ${name}`);
  }

  /** Every assignee change in the issue's history. */
  async function history(key: string): Promise<AssigneeChange[]> {
    const nodes = await pageAll(
      transport,
      ASSIGNEE_HISTORY,
      { id: key },
      (d) => record(d.issue, `issue ${key}`).history,
      `history of ${key}`,
    );
    return nodes.flatMap((n, i) => {
      const where = `history of ${key}[${i}]`;
      const node = record(n, where);
      if (typeof node.createdAt !== "string")
        throw new LinearClaimError(`${where}.createdAt: expected a string`);
      const from = sideId(node.fromAssignee, `${where}.fromAssignee`);
      const to = sideId(node.toAssignee, `${where}.toAssignee`);
      return from === null && to === null
        ? []
        : [{ from, to, at: node.createdAt }];
    });
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
      await assignId(key, user.id, user.name);
    },
    async assignUnassigned(key, user) {
      return assignVerified(
        {
          assignee: async () => (await read(key)).assignee?.id ?? null,
          assign: (id) => assignId(key, id, id),
          history: () => history(key),
        },
        user.id,
      );
    },
    async deleteComment(key, id) {
      const data = record(await transport(COMMENT_DELETE, { id }), "data");
      if (record(data.commentDelete, "commentDelete").success !== true)
        throw new LinearClaimError(`Linear did not delete a comment on ${key}`);
    },
    async user(identity) {
      const who = identity.trim();
      const data = record(await transport(USERS, { who }), "data");
      const nodes = record(data.users, "users").nodes;
      if (!Array.isArray(nodes))
        throw new LinearClaimError("users.nodes: expected a list");
      if (nodes.length !== 1)
        throw new TrackerRequestError(
          "unresolved",
          `${JSON.stringify(who)} names ${nodes.length === 0 ? "no" : "more than one"} Linear user by email or display name`,
        );
      return userOf(nodes[0], `user ${who}`);
    },
  };
}

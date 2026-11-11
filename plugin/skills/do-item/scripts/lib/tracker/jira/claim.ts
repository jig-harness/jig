/**
 * What claiming an issue reads and writes on Jira: the account the
 * credential acts as (`myself`), the issue's assignee (a Jira issue has at
 * most one), an assignment by account id, the assignment of an unassigned
 * issue verified against the issue's changelog (`assign-verified.ts`: Jira
 * offers no conditional write), and the account an identity names. A user
 * is named by its account id, compared exactly, and its display name.
 */

import { assignVerified } from "../assign-verified.ts";
import type { Tracker, TrackerUser } from "../port.ts";
import type { Client } from "./client.ts";
import { JiraApiError } from "./transport.ts";

export function claimOperations(
  client: Client,
): Pick<
  Tracker,
  "viewer" | "assignees" | "assign" | "user" | "assignUnassigned"
> {
  async function assignId(key: string, accountId: string): Promise<void> {
    const issue = await client.mustIssue(key);
    await client.transport({
      method: "PUT",
      path: `issue/${encodeURIComponent(issue.key)}/assignee`,
      body: { accountId },
    });
  }

  return {
    async viewer() {
      const me = await client.transport({ method: "GET", path: "myself" });
      const id =
        typeof me === "object" && me !== null
          ? (me as Record<string, unknown>).accountId
          : undefined;
      if (typeof id !== "string" || id === "")
        throw new JiraApiError("myself: the answer names no account id");
      const name = (me as Record<string, unknown>).displayName;
      return { id, name: typeof name === "string" && name !== "" ? name : id };
    },
    async assignees(key) {
      const issue = await client.mustIssue(key);
      return issue.assignee === null
        ? []
        : [
            {
              id: issue.assignee.accountId,
              name: issue.assignee.displayName || issue.assignee.accountId,
            } satisfies TrackerUser,
          ];
    },
    async assign(key, user) {
      await assignId(key, user.id);
    },
    async assignUnassigned(key, user) {
      return assignVerified(
        {
          assignee: async () =>
            (await client.mustIssue(key)).assignee?.accountId ?? null,
          assign: (id) => assignId(key, id),
          history: async () =>
            (await client.changelog(key)).flatMap((e) =>
              e.items
                .filter((i) => i.fieldId === "assignee")
                .map((i) => ({ from: i.from, to: i.to, at: e.createdAt })),
            ),
        },
        user.id,
      );
    },
    async user(identity) {
      // The account id resolves as the dispatcher's assigned-issues read resolves it.
      return { id: await client.accountId(identity), name: identity.trim() };
    },
  };
}

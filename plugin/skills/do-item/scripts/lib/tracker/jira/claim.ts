/**
 * What claiming an issue reads and writes on Jira: the account the
 * credential acts as (`myself`), the issue's assignee (a Jira issue has at
 * most one), and an assignment by account id. A user is named by its
 * account id, compared exactly, and its display name.
 */

import type { Tracker, TrackerUser } from "../port.ts";
import type { Client } from "./client.ts";
import { JiraApiError } from "./transport.ts";

export function claimOperations(
  client: Client,
): Pick<Tracker, "viewer" | "assignees" | "assign"> {
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
      const issue = await client.mustIssue(key);
      await client.transport({
        method: "PUT",
        path: `issue/${encodeURIComponent(issue.key)}/assignee`,
        body: { accountId: user.id },
      });
    },
  };
}

/**
 * Who made a Jira issue ready, for a ready pool: the author of the newest
 * changelog entry that moved the issue into the status it is in now, and
 * whether that author is trusted (a licensed, non-guest Atlassian account
 * that can be assigned issues in the project). An issue whose changelog
 * holds no move into its status was created there, so its creator made it
 * ready. A Jira Automation rule's moves are authored by its rule actor, so
 * the Automation app's own account (of type `app`) is never trusted; an
 * entry with no author (a deleted account) is an untrusted mover, and a
 * changelog that cannot be read in full throws.
 */

import { isRecord } from "../../../../../../shared/guards.ts";
import type { Tracker } from "../port.ts";
import { authorOf } from "./assigner.ts";
import type { Client } from "./client.ts";
import { JiraApiError } from "./transport.ts";

/** The issue's creator, as the issue reports it; `null` for a deleted account. */
async function creatorOf(
  client: Client,
  key: string,
): Promise<Record<string, unknown> | null> {
  const raw = await client.transport({
    method: "GET",
    path: `issue/${encodeURIComponent(key)}`,
    query: { fields: "creator" },
  });
  const fields = isRecord(raw) ? raw.fields : undefined;
  if (!isRecord(fields))
    throw new JiraApiError(`issue ${key}: its creator could not be read`);
  return isRecord(fields.creator) ? fields.creator : null;
}

export function stateChangeOperations(
  client: Client,
): Pick<Tracker, "stateChangedBy"> {
  return {
    async stateChangedBy(key) {
      const issue = await client.mustIssue(key);
      const status = issue.status.id;
      if (status === "")
        throw new JiraApiError(`issue ${issue.key}: its status has no id`);
      const latest = (await client.changelog(issue.key))
        .filter((e) =>
          e.items.some((i) => i.fieldId === "status" && i.to === status),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .at(-1);
      return authorOf(
        client,
        latest === undefined
          ? await creatorOf(client, issue.key)
          : latest.author,
      );
    },
  };
}

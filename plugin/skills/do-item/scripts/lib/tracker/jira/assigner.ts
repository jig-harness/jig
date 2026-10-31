/**
 * Who made an issue's current assignment, on Jira: the newest changelog
 * entry that set the issue's assignee to the account, and whether its author
 * is trusted (a licensed, non-guest Atlassian account that can be assigned
 * issues in the project). A Jira Automation rule's changes are authored by
 * its rule actor, so the Automation app's own account (of type `app`) is
 * never trusted, and a rule starts work only when a person is its actor.
 *
 * A dispatcher starts work on an assigned issue only when a trusted person
 * made the assignment, so every gap (an issue no longer assigned to the
 * account, a changelog holding no such change, a trust that cannot be read)
 * throws rather than answer. An entry with no author (a deleted account) is
 * an untrusted assigner.
 */

import type { Assigner, Tracker } from "../port.ts";
import type { Client } from "./client.ts";
import type { JiraIssue } from "./read.ts";
import { JiraApiError } from "./transport.ts";

/** The account the assignment is asked about: the given one, else the current assignee. */
async function wantedAccount(
  client: Client,
  issue: JiraIssue,
  assignee: string | undefined,
): Promise<string> {
  const current = issue.assignee;
  if (current === null)
    throw new JiraApiError(`issue ${issue.key} is assigned to nobody`);
  const who =
    assignee === undefined
      ? current.accountId
      : await client.accountId(assignee);
  if (current.accountId !== who)
    throw new JiraApiError(
      `issue ${issue.key} is no longer assigned to ${assignee ?? who}`,
    );
  return who;
}

/** The author of the newest change that assigned the issue to `who`. */
async function latestAssigner(
  client: Client,
  key: string,
  who: string,
): Promise<Record<string, unknown> | null> {
  const latest = (await client.changelog(key))
    .filter((e) =>
      e.items.some((i) => i.fieldId === "assignee" && i.to === who),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (latest === undefined)
    throw new JiraApiError(
      `issue ${key}: its changelog holds no assignment of ${who}`,
    );
  return latest.author;
}

export function assignerOperations(
  client: Client,
): Pick<Tracker, "assignedBy"> {
  return {
    async assignedBy(key, assignee) {
      const issue = await client.mustIssue(key);
      const who = await wantedAccount(client, issue, assignee);
      const author = await latestAssigner(client, issue.key, who);
      if (author === null || typeof author.accountId !== "string")
        return { id: "", name: "a deleted account", trusted: false };
      const name =
        typeof author.displayName === "string" ? author.displayName : "";
      return {
        id: author.accountId,
        name: name || author.accountId,
        trusted: await client.trusted(author),
      } satisfies Assigner;
    },
  };
}

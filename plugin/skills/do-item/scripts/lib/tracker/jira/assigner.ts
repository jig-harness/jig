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
import { AssignerUnknown } from "../assigner-unknown.ts";
import type { Client } from "./client.ts";
import type { JiraIssue } from "./read.ts";
import { JiraApiError } from "./transport.ts";

/** The account the assignment is asked about: the given one, else the current assignee. */
async function wantedAccount(
  client: Client,
  issue: JiraIssue,
  assignee: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const current = issue.assignee;
  if (current === null)
    throw new AssignerUnknown(`issue ${issue.key} is assigned to nobody`);
  const who =
    assignee === undefined
      ? current.accountId
      : await client.accountId(assignee, signal);
  if (current.accountId !== who)
    throw new AssignerUnknown(
      `issue ${issue.key} is no longer assigned to ${assignee ?? who}`,
    );
  return who;
}

/** The author of the newest change that assigned the issue to `who`. */
async function latestAssigner(
  client: Client,
  key: string,
  who: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const log = await client.changelog(key, signal);
  // An assignee change missing its `from` or `to` cannot be placed in the
  // history, so no answer drawn from the rest of it is complete.
  if (
    log.some((e) =>
      e.items.some((i) => i.fieldId === "assignee" && !i.explicit),
    )
  )
    throw new JiraApiError(
      `issue ${key}: its changelog holds an assignee change missing from or to`,
    );
  const latest = log
    .filter((e) =>
      e.items.some((i) => i.fieldId === "assignee" && i.to === who),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (latest === undefined)
    throw new AssignerUnknown(
      `issue ${key}: its changelog holds no assignment of ${who}. Jira omits assignments made at issue creation. To start a pickup, have a trusted person unassign the issue and assign it again.`,
    );
  return latest.author;
}

/** A changelog entry's author as an assigner or a mover, with its trust; a deleted account is untrusted. */
export async function authorOf(
  client: Client,
  author: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<Assigner> {
  if (author === null || typeof author.accountId !== "string")
    return { id: "", name: "a deleted account", trusted: false };
  const name = typeof author.displayName === "string" ? author.displayName : "";
  return {
    id: author.accountId,
    name: name || author.accountId,
    trusted: await client.trusted(author, signal),
  };
}

export function assignerOperations(
  client: Client,
): Pick<Tracker, "assignedBy"> {
  return {
    async assignedBy(key, assignee, signal) {
      const issue = await client.mustIssue(key, signal);
      const who = await wantedAccount(client, issue, assignee, signal);
      return authorOf(
        client,
        await latestAssigner(client, issue.key, who, signal),
        signal,
      );
    },
  };
}

/** Jira's native readings, before a checkout maps its statuses and facet fields. */
import { credentialKey } from "../../../../../../shared/tracker-budget.ts";
import type { CorePoolIssue, CoreTracker } from "../facets/tracker.ts";
import { readSignal, refuseStopped } from "../facets/bounds.ts";
import type { DispatchRawIssue } from "../port.ts";
import type { Client } from "./client.ts";
import { jiraAuthorization, resolveJiraCredential } from "./credential.ts";
import { inProject, keyList, quote, ORDER } from "./jql.ts";
import { parseIssue, record, str } from "./read.ts";
import { relationsOf } from "./relations.ts";
import { JiraApiError, searchPages } from "./transport.ts";

export function dispatchSource(
  client: Client,
  project: (
    raw: unknown,
    children: unknown[],
    signal?: AbortSignal,
  ) => Promise<CorePoolIssue>,
): NonNullable<CoreTracker["dispatchSource"]> {
  const requirements = (
    ["triage", "backlog", "todo", "blocked", "in_progress", "pr_open"] as const
  )
    .flatMap((state) => client.model.stateNames(state))
    .map((name) => `queue-state:${name}`);
  let demanded = new Set(requirements);
  async function search(
    jql: string,
    fields: readonly string[] = ["*all"],
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    refuseStopped(signal);
    await client.authenticate(signal);
    return searchPages(
      client.transport,
      jql,
      fields,
      "the native dispatch reading",
      signal,
    );
  }
  async function wrap(
    issues: unknown[],
    signal?: AbortSignal,
  ): Promise<DispatchRawIssue[]> {
    refuseStopped(signal);
    const children = new Map<string, unknown[]>();
    const keys = issues.map((raw) =>
      str(record(raw, "dispatch issue").key, "dispatch issue.key"),
    );
    for (let start = 0; start < keys.length; start += 50) {
      const batch = keys.slice(start, start + 50);
      for (const child of await search(
        `parent in ${keyList(batch)}${ORDER}`,
        ["parent", "status", "issuetype", "resolution"],
        signal,
      )) {
        const fields = record(
          record(child, "dispatch child").fields,
          "dispatch child.fields",
        );
        const key = str(
          record(fields.parent, "dispatch child.parent").key,
          "dispatch child.parent.key",
        );
        children.set(key, [...(children.get(key) ?? []), child]);
      }
    }
    return issues.map((raw, index) => ({
      identifier: keys[index] as string,
      value: {
        issue: raw,
        children: children.get(keys[index] as string) ?? [],
      },
    }));
  }
  return {
    requirements,
    configure(union) {
      demanded = new Set([...demanded, ...union]);
    },
    get shape() {
      return JSON.stringify([...demanded].sort());
    },
    shareReads: (reads) => client.shareReads(reads),
    async credential() {
      const selected = resolveJiraCredential();
      if (!selected.ok) return credentialKey("jira", "unavailable");
      const header = await jiraAuthorization(selected.value).header();
      if (!header.ok) throw new JiraApiError(header.failure.reason);
      return credentialKey("jira", header.value);
    },
    async queue(identity, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const account = await client.accountId(identity, signal);
      const names = [...demanded]
        .filter((name) => name.startsWith("queue-state:"))
        .map((name) => quote(name.slice(12)));
      if (names.length === 0) return [];
      return wrap(
        await search(
          inProject(
            client.project,
            `assignee = ${quote(account)}`,
            `status in (${names.join(", ")})`,
          ),
          undefined,
          signal,
        ),
        signal,
      );
    },
    async issue(key, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      await client.authenticate(signal);
      let raw: unknown;
      try {
        raw = await client.transport(
          {
            method: "GET",
            path: `issue/${encodeURIComponent(key)}`,
            query: { fields: "*all" },
          },
          signal,
        );
      } catch (error) {
        if (error instanceof JiraApiError && error.notFound) return null;
        throw error;
      }
      return (await wrap([raw], signal))[0] ?? null;
    },
    async children(key, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      return wrap(
        await search(`parent = ${quote(key)}${ORDER}`, undefined, signal),
        signal,
      );
    },
    async includes(raw, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      await client.poolScope(signal);
      if (client.settings.poolIssueTypes.length === 0) return true;
      const value = record(raw.value, "dispatch native issue");
      const fields = record(
        record(value.issue, "dispatch issue").fields,
        "dispatch issue.fields",
      );
      const name = str(
        record(fields.issuetype, "dispatch issue.issuetype").name,
        "dispatch issue.issuetype.name",
      );
      return client.settings.poolIssueTypes.some(
        (type) => type.toLowerCase() === name.toLowerCase(),
      );
    },
    async project(raw, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const value = record(raw.value, "dispatch native issue");
      if (!Array.isArray(value.children))
        throw new JiraApiError(
          "dispatch native issue.children: expected an array",
        );
      return project(value.issue, value.children, signal);
    },
    async projectRelations(raw, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const value = record(raw.value, "dispatch native issue");
      return relationsOf(
        parseIssue(value.issue, client.site),
        await client.linkTypes(signal),
      );
    },
  };
}

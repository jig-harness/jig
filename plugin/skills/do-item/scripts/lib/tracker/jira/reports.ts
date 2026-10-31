/**
 * The Jira adapter's reads for the fleet metrics and the candidate pools.
 *
 * Every population is one JQL query (`jql.ts`) read to its end. A window is
 * widened by a minute on each side, since JQL dates have minute precision in
 * the credential's profile time zone, and each issue is then kept or dropped
 * by its exact time. A comment search reads every comment of the labelled
 * issues updated in the window and matches the text here: JQL's `comment ~`
 * matches words, and a marker it missed would be a lost finding.
 */

import type {
  CanonicalState,
  FoundComment,
  IssueFact,
  LabelledIssueState,
  LedgerIssue,
  PoolIssue,
  StartedIssueActivity,
  Tracker,
} from "../port.ts";
import { TrackerRequestError } from "../port.ts";
import { checkPoolQuery, inWindow } from "../requests.ts";
import type { Client } from "./client.ts";
import { type JiraIssue, record } from "./read.ts";
import {
  inProject,
  KEY,
  keyList,
  noLabel,
  OPEN,
  ORDER,
  quote,
  since,
  someLabel,
  stringList,
  widened,
} from "./jql.ts";
import { JiraApiError, offsetPages, searchPages } from "./transport.ts";

type ReportOps = Pick<
  Tracker,
  | "issuesByKeys"
  | "issuesInWindow"
  | "startedIssueActivity"
  | "commentsContaining"
  | "issueComments"
  | "ledger"
  | "labelledIssues"
  | "openIssues"
  | "openChildren"
  | "poolIssue"
  | "assignedIssues"
>;

/** The ancestors the attribution walk reads; a further one fails the read. */
const PARENT_DEPTH = 5;
/** Keys per `key in (...)` query. */
const BATCH = 50;

/** The keys a JQL error says do not exist, among `asked`. */
function missingKeys(err: unknown, asked: ReadonlyArray<string>): string[] {
  if (!(err instanceof JiraApiError) || err.status !== 400) return [];
  const said = err.errorMessages.join(" ");
  return asked.filter((k) => new RegExp(`'${k}'`).test(said));
}

export function reportOperations(client: Client): ReportOps {
  const { model, project } = client;
  const ownKey = new RegExp(`^${project}-\\d+$`);

  function stateType(issue: JiraIssue): string {
    return model.read(issue).state.type;
  }

  /** When the issue was closed as `done`; `null` otherwise. */
  function completedAt(issue: JiraIssue): string | null {
    if (issue.status.category !== "done") return null;
    if (model.read(issue).canonical !== "done") return null;
    return issue.resolutionDate ?? issue.categoryChangedAt;
  }

  function canceledAt(issue: JiraIssue): string | null {
    if (issue.status.category !== "done") return null;
    const s = model.read(issue).canonical;
    if (s !== "canceled" && s !== "duplicate") return null;
    return issue.resolutionDate ?? issue.categoryChangedAt;
  }

  function requireOwnKey(key: string): void {
    if (!ownKey.test(key))
      throw new TrackerRequestError(
        "invalid",
        `not an issue key of Jira project ${project}: ${key}`,
      );
  }

  /**
   * The issues of `keys`, by key, through `key in (...)` in batches. A key
   * JQL refuses as unknown is dropped and the batch asked again.
   */
  async function byKeys(
    keys: ReadonlyArray<string>,
    bound: boolean,
  ): Promise<Map<string, JiraIssue>> {
    const out = new Map<string, JiraIssue>();
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += BATCH)
      for (const issue of await batchByKeys(unique.slice(i, i + BATCH), bound))
        out.set(issue.key, issue);
    return out;
  }

  /** One batch of keys; each key JQL calls unknown is dropped and the rest asked again. */
  async function batchByKeys(
    keys: string[],
    bound: boolean,
  ): Promise<JiraIssue[]> {
    let batch = keys;
    while (batch.length > 0) {
      const clause = `key in ${keyList(batch)}`;
      const jql = bound ? inProject(project, clause) : `${clause}${ORDER}`;
      const read = await client
        .search(jql, `issues ${batch.join(", ")}`)
        .catch((err: unknown) => err);
      if (Array.isArray(read)) return read;
      const missing = missingKeys(read, batch);
      if (missing.length === 0) throw read;
      batch = batch.filter((k) => !missing.includes(k));
    }
    return [];
  }

  /** Facts of `issues`, each with its parent chain read in full. */
  async function facts(issues: JiraIssue[]): Promise<IssueFact[]> {
    const known = new Map(issues.map((i) => [i.key, i]));
    let frontier = issues;
    for (let depth = 0; depth < PARENT_DEPTH; depth++) {
      const wanted = frontier
        .map((i) => i.parent?.key)
        .filter((k): k is string => k !== undefined && !known.has(k));
      if (wanted.length === 0) break;
      const found = await byKeys(wanted, false);
      for (const [k, v] of found) known.set(k, v);
      frontier = [...found.values()];
    }
    return issues.map((issue) => {
      const ancestors: Array<{ id: string; labels: string[] }> = [];
      let parent = issue.parent?.key;
      while (parent !== undefined) {
        if (ancestors.length === PARENT_DEPTH)
          throw new JiraApiError(
            `issue ${issue.key}: more than ${PARENT_DEPTH} ancestors, so its epic may lie beyond the read`,
          );
        const p = known.get(parent);
        if (p === undefined)
          throw new JiraApiError(
            `issue ${issue.key}: its ancestor ${parent} is not visible, so its chain would be partial`,
          );
        ancestors.push({ id: p.key, labels: p.labels });
        parent = p.parent?.key;
      }
      return {
        id: issue.key,
        title: issue.title,
        labels: issue.labels,
        createdAt: issue.createdAt,
        completedAt: completedAt(issue),
        stateType: stateType(issue),
        description: issue.description,
        ancestors,
      };
    });
  }

  /** The keys among `keys` with at least one open child. */
  async function withOpenChildren(keys: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      const found = await searchPages(
        client.transport,
        inProject(project, `parent in ${keyList(batch)}`, OPEN),
        ["parent"],
        `open children of ${batch.join(", ")}`,
      );
      for (const child of found) {
        const fields = record(
          child.fields,
          `issue ${String(child.key)}.fields`,
        );
        if (fields.parent !== null && typeof fields.parent === "object")
          out.add(String((fields.parent as Record<string, unknown>).key));
      }
    }
    return out;
  }

  async function pools(issues: JiraIssue[]): Promise<PoolIssue[]> {
    const parents = await withOpenChildren(issues.map((i) => i.key));
    return issues.map((issue) => {
      const { state } = model.read(issue);
      return {
        identifier: issue.key,
        title: issue.title,
        url: issue.url,
        priority: model.priorityOf(issue.priority),
        createdAt: issue.createdAt,
        state: { ...state, id: issue.status.id },
        assignee:
          issue.assignee === null
            ? null
            : {
                id: issue.assignee.accountId,
                name: issue.assignee.displayName,
              },
        labels: issue.labels,
        hasOpenChildren: parents.has(issue.key),
        truncated: [],
      };
    });
  }

  /** Refuse a label no issue of the site carries: it would read as an empty population. */
  async function requireLabel(label: string): Promise<void> {
    const values = await offsetPages(
      client.transport,
      { method: "GET", path: "label", query: { query: label } },
      {
        items: "values",
        idOf: () => undefined,
        where: `labels like '${label}'`,
        strings: true,
      },
    );
    if (!values.some((v) => v.name === label))
      throw new TrackerRequestError(
        "unresolved",
        `the configured label '${label}' is not a label of the Jira site; a name that resolves to nothing silently shrinks the population`,
      );
  }

  const label = (l: string) => `labels = ${quote(l)}`;

  return {
    async issuesByKeys(keys) {
      const own = keys.filter((k) => ownKey.test(k));
      const found = await byKeys(own, true);
      const out = new Map<string, IssueFact>();
      for (const f of await facts([...found.values()])) out.set(f.id, f);
      return out;
    },

    async issuesInWindow(query) {
      const zone =
        query.createdIn === undefined && query.completedIn === undefined
          ? null
          : await client.timeZone();
      const clauses: string[] = [];
      if (query.label !== undefined) clauses.push(label(query.label));
      if (query.createdIn !== undefined && zone !== null)
        clauses.push(widened("created", query.createdIn, zone));
      if (query.completedIn !== undefined && zone !== null)
        clauses.push(
          "statusCategory = Done",
          `(${widened("resolutiondate", query.completedIn, zone)} OR ${widened("statusCategoryChangedDate", query.completedIn, zone)})`,
        );
      const read = await client.search(
        inProject(project, ...clauses),
        `issues of ${project} in the window`,
      );
      return facts(
        read.filter(
          (i) =>
            inWindow(i.createdAt, query.createdIn) &&
            inWindow(completedAt(i), query.completedIn),
        ),
      );
    },

    async startedIssueActivity(l, signal) {
      const epics = await client.search(
        inProject(project, label(l), 'statusCategory = "In Progress"'),
        `started issues labelled '${l}'`,
        signal,
      );
      const out: StartedIssueActivity[] = [];
      for (const epic of epics) {
        if (signal?.aborted === true)
          throw new JiraApiError("the collector deadline passed");
        if (stateType(epic) !== "started") continue;
        const kids = await client.children(epic.key, false, signal);
        out.push({
          epic: epic.key,
          startedAt: epic.categoryChangedAt ?? epic.updatedAt,
          project: epic.fixVersions[0] ?? null,
          assignee: epic.assignee?.displayName ?? null,
          labels: epic.labels,
          children: kids.map((k) => ({
            issue: k.key,
            updatedAt: k.updatedAt,
            stateType: stateType(k),
          })),
        });
      }
      return out;
    },

    async commentsContaining(query) {
      const zone = await client.timeZone();
      const issues = await client.search(
        inProject(
          project,
          label(query.issueLabel),
          since("updated", query.createdIn.sinceMs, zone),
        ),
        `issues labelled '${query.issueLabel}' updated in the window`,
      );
      const out: FoundComment[] = [];
      for (const issue of issues)
        for (const c of await client.comments(issue.key))
          if (
            c.body.includes(query.text) &&
            inWindow(c.createdAt, query.createdIn)
          )
            out.push({
              issue: issue.key,
              body: c.body,
              createdAt: c.createdAt,
              trusted: await client.trusted(c.author),
            });
      return out;
    },

    async issueComments(key) {
      requireOwnKey(key);
      const issue = await client.mustIssue(key);
      const comments = [];
      for (const c of await client.comments(issue.key))
        comments.push({
          body: c.body,
          createdAt: c.createdAt,
          trusted: await client.trusted(c.author),
        });
      return { uuid: issue.id, comments };
    },

    async ledger(query, onPage) {
      await requireLabel(query.label);
      // The version must exist: a mistyped one would silently halve the union.
      if (query.project !== undefined) await client.version(query.project);
      const scope =
        query.project === undefined
          ? label(query.label)
          : `(${label(query.label)} OR fixVersion = ${quote(query.project)})`;
      const read = await client.search(
        inProject(project, scope),
        `the ledger of '${query.label}'`,
      );
      const out: LedgerIssue[] = [];
      for (const issue of read) {
        out.push({
          identifier: issue.key,
          createdAt: issue.createdAt,
          completedAt: completedAt(issue),
          canceledAt: canceledAt(issue),
          stateType: stateType(issue),
          priority: model.priorityOf(issue.priority),
          parent: issue.parent?.key ?? null,
          project: issue.fixVersions[0] ?? null,
          labels: issue.labels,
          truncated: [],
        });
        onPage?.(out.length);
      }
      return out;
    },

    async labelledIssues(l, signal, withDescription = false) {
      const read = await client.search(
        inProject(project, label(l)),
        `issues labelled '${l}'`,
        signal,
      );
      return read.map((issue): LabelledIssueState => {
        const base = {
          identifier: issue.key,
          stateType: stateType(issue),
          completedAt: completedAt(issue),
        };
        return withDescription
          ? { ...base, description: issue.description }
          : base;
      });
    },

    async openIssues(query) {
      checkPoolQuery(query);
      const none = query.withNoneOf ?? [];
      const read = await client.search(
        inProject(
          project,
          OPEN,
          ...query.withSomeOf.map(someLabel),
          ...(none.length === 0 ? [] : [noLabel(none)]),
        ),
        `the pool of ${query.withSomeOf.map((l) => stringList(l)).join(" and ")}`,
      );
      return pools(read);
    },

    async openChildren(key) {
      requireOwnKey(key);
      return pools(await client.children(key, true));
    },

    async poolIssue(key) {
      if (!KEY.test(key)) return null;
      const issue = await client.issue(key);
      return issue === null ? null : ((await pools([issue]))[0] ?? null);
    },

    async assignedIssues(identity, states) {
      if (states.length === 0)
        throw new TrackerRequestError(
          "invalid",
          "an assigned-issues query needs at least one state",
        );
      const accountId = await client.accountId(identity);
      const names = [...new Set(states.map((s) => model.stateName(s)))];
      const read = await client.search(
        inProject(
          project,
          `assignee = ${quote(accountId)}`,
          `status in ${stringList(names)}`,
        ),
        `issues assigned to ${identity}`,
      );
      const wanted = new Set<CanonicalState>(states);
      return pools(
        read.filter((i) => {
          const s = model.read(i).canonical;
          return s !== null && wanted.has(s);
        }),
      );
    },
  };
}

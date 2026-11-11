/**
 * The Jira adapter's reads for the fleet metrics and the candidate pools.
 *
 * Every population is one JQL query (`jql.ts`) read to its end. A window is
 * widened by a minute on each side, since JQL dates have minute precision in
 * the credential's profile time zone, and each issue is then kept or dropped
 * by its exact time. A comment search reads every comment of the labelled
 * issues updated in the window and matches the text here: JQL's `comment ~`
 * matches words, and a marker it missed would be a lost finding.
 *
 * The candidate pools and the populations (`openIssues`, `assignedIssues`,
 * `openPopulation`, which the facet census counts, and an `issuesInWindow`
 * that names no label) are limited to `issue_tracker.jira.pool_issue_types`
 * where it is set. Reads by key, an issue's children and the reads a label
 * defines are not: an epic's accounting needs every type its label carries.
 */

import type {
  CanonicalState,
  FoundComment,
  IssueFact,
  LabelledIssueState,
  LedgerIssue,
  StartedIssueActivity,
} from "../port.ts";
import type { CorePoolIssue, CoreTracker } from "../facets/tracker.ts";
import { TrackerRequestError } from "../port.ts";
import { checkPoolQuery, inWindow } from "../requests.ts";
import type { Client } from "./client.ts";
import type { JiraFacetStores } from "./facets.ts";
import { type JiraIssue, record } from "./read.ts";
import {
  fieldOfLabel,
  hasLabel,
  inProject,
  KEY,
  keyList,
  noLabel,
  openClause,
  ORDER,
  quote,
  since,
  someLabel,
  stringList,
  widened,
} from "./jql.ts";
import {
  abortedError,
  JiraApiError,
  offsetPages,
  searchPages,
} from "./transport.ts";

type ReportOps = Pick<
  CoreTracker,
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
  | "openPopulation"
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

export function reportOperations(
  client: Client,
  stores: Pick<JiraFacetStores, "read">,
): ReportOps {
  const { model, project } = client;
  const open = openClause(model.stateName("blocked"));
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
  async function withOpenChildren(
    keys: string[],
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      const found = await searchPages(
        client.transport,
        `parent in ${keyList(batch)} AND ${open}${ORDER}`,
        ["parent"],
        `open children of ${batch.join(", ")}`,
        signal,
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

  async function pools(
    issues: JiraIssue[],
    signal?: AbortSignal,
  ): Promise<CorePoolIssue[]> {
    const parents = await withOpenChildren(
      issues.map((i) => i.key),
      signal,
    );
    return issues.map((issue) => {
      const { state } = model.read(issue);
      return {
        identifier: issue.key,
        title: issue.title,
        url: issue.url,
        priority: model.priorityOf(issue.priority),
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
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
        ...stores.read(issue),
        truncated: [],
      };
    });
  }

  /**
   * Refuse a label no issue of the site carries: it would read as an empty
   * population. A field's value (`field_labels`) is not a Jira label, and
   * its field was resolved when the fields were read.
   */
  async function requireLabel(label: string): Promise<void> {
    if (fieldOfLabel(label, await client.fieldLabels()) !== null) return;
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

  const label = async (l: string, signal?: AbortSignal) =>
    hasLabel(l, await client.fieldLabels(signal));

  /** The pool's issue-type clause, as a list to spread; empty when unscoped. */
  const scope = async (signal?: AbortSignal) => {
    const clause = await client.poolScope(signal);
    return clause === null ? [] : [clause];
  };

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
      const clauses: string[] =
        query.label === undefined ? await scope() : [await label(query.label)];
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
        inProject(
          project,
          await label(l, signal),
          'statusCategory = "In Progress"',
        ),
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
          await label(query.issueLabel),
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
      const has = await label(query.label);
      const scope =
        query.project === undefined
          ? has
          : `(${has} OR fixVersion = ${quote(query.project)})`;
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
        inProject(project, await label(l, signal)),
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
      const fields = await client.fieldLabels();
      const read = await client.search(
        inProject(
          project,
          open,
          ...(await scope()),
          ...query.withSomeOf.map((l) => someLabel(l, fields)),
          ...(none.length === 0 ? [] : [noLabel(none, fields)]),
        ),
        `the pool of ${query.withSomeOf.map((l) => stringList(l)).join(" and ")}`,
      );
      return pools(read);
    },

    async openChildren(key) {
      requireOwnKey(key);
      return pools(await client.children(key, true));
    },

    async openPopulation(signal) {
      return pools(
        await client.search(
          inProject(project, open, ...(await scope(signal))),
          `open issues of ${project}`,
          signal,
        ),
        signal,
      );
    },

    async poolIssue(key, signal) {
      if (!KEY.test(key)) return null;
      const issue = await client.issue(key, signal);
      return issue === null
        ? null
        : ((await pools([issue], signal))[0] ?? null);
    },

    async assignedIssues(identity, states, signal) {
      if (states.length === 0)
        throw new TrackerRequestError(
          "invalid",
          "an assigned-issues query needs at least one state",
        );
      if (signal?.aborted === true) throw abortedError(signal);
      const names = [
        ...new Set(
          states
            .map((s) => model.stateName(s))
            .filter((n): n is string => n !== null),
        ),
      ];
      if (names.length === 0) return [];
      const accountId = await client.accountId(identity, signal);
      const read = await client.search(
        inProject(
          project,
          `assignee = ${quote(accountId)}`,
          `status in ${stringList(names)}`,
          ...(await scope(signal)),
        ),
        `issues assigned to ${identity}`,
        signal,
      );
      const wanted = new Set<CanonicalState>(states);
      return pools(
        read.filter((i) => {
          const s = model.read(i).canonical;
          return s !== null && wanted.has(s);
        }),
        signal,
      );
    },
  };
}

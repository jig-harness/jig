/**
 * The Jira Cloud adapter of the tracker port (`port.ts`).
 *
 * It works on the issues of one Jira project (`issue_tracker.team`, the
 * project key), whose keys are `<KEY>-<n>`, through Jira's REST API version
 * 3 (`transport.ts`). How the port's vocabulary maps onto Jira:
 *
 * - workflow states: `model.ts` (status names, categories and resolutions);
 *   a transition is one hop, the one transition out of the current status
 *   whose target status has the state's name: the full workflow is readable
 *   only with administration rights, so no path is searched for;
 * - priority: the priority's name (`issue_tracker.jira.priorities`), or
 *   labels where `issue_tracker.facets.priority` names that store; type: the
 *   issue type, a custom field or labels, and size a custom field or labels,
 *   as `issue_tracker.facets` names them (`facets.ts`, `../facets/`); a
 *   project: the first fix version; the native type: the issue type's name;
 * - parent and children: the `parent` field, for sub-tasks and an Epic's
 *   issues alike;
 * - relations: issue links of the configured types
 *   (`issue_tracker.jira.link_types`), several per relation where it lists
 *   them, an inverted type read the other way round; a new link takes the
 *   first; other link types are ignored;
 * - descriptions and comments: Markdown converted to and from ADF (`adf.ts`);
 * - labels: Jira labels, free text shared across the site, written as given
 *   when well-formed, and the values of the fields `field_labels` names,
 *   each behind its prefix, which are read and queried but written only as
 *   the facet such a field keeps;
 * - a trusted comment: one whose author is a licensed, non-guest Atlassian
 *   account that can be assigned issues in the project.
 *
 * The reports and candidate pools are in `reports.ts`, limited to
 * `issue_tracker.jira.pool_issue_types` where it is set; `assignedBy` in
 * `assigner.ts`.
 */

import type {
  CanonicalState,
  IssuePatch,
  IssueRelation,
  IssueSummary,
  RelationType,
  Tracker,
} from "../port.ts";
import { TrackerRequestError } from "../port.ts";
import { namedState, TrackerConfigError } from "../config-error.ts";
import { type CoreTracker, withFacets } from "../facets/tracker.ts";
import {
  checkPatch,
  checkPriority,
  checkRelation,
  checkSearchText,
  refuseSameIssue,
  requireTitle,
} from "../requests.ts";
import { markdownToAdf } from "./adf.ts";
import { assignerOperations } from "./assigner.ts";
import { claimOperations } from "./claim.ts";
import type { Client, IssueTypeMeta, RelationLink } from "./client.ts";
import { jiraFacetStores } from "./facets.ts";
import { type JiraIssue, record, str } from "./read.ts";
import { fieldOfLabel, inProject, OPEN, quote } from "./jql.ts";
import { isResolvedState } from "./model.ts";
import { reportOperations } from "./reports.ts";
import { LINKED_RELATIONS, type LinkedRelation } from "./settings.ts";
import { JiraApiError, offsetPages } from "./transport.ts";

/** A relation's two sides: as the issue reads it outward, and inward. */
const SIDES: Record<
  LinkedRelation,
  [IssueRelation["type"], IssueRelation["type"]]
> = {
  blocks: ["blocks", "blocked_by"],
  duplicate: ["duplicate", "duplicated_by"],
  related: ["related", "related"],
};

/** A label Jira accepts: no whitespace, at most 255 characters. */
const LABEL = /^\S{1,255}$/;

const same = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Refuse a label Jira would reject or split. */
export function checkLabels(labels: ReadonlyArray<string>): void {
  const bad = labels.filter((l) => !LABEL.test(l));
  if (bad.length > 0)
    throw new TrackerRequestError(
      "invalid",
      `Jira labels have no whitespace and at most 255 characters: ${bad.map((l) => JSON.stringify(l)).join(", ")}`,
    );
}

export function summaryOf(issue: JiraIssue, client: Client): IssueSummary {
  return {
    identifier: issue.key,
    title: issue.title,
    state: client.model.read(issue).state,
    labels: issue.labels,
  };
}

/** A parent's level in the project's hierarchy: -1 a sub-task, 0 standard, 1+ an Epic. */
function levelOf(parent: JiraIssue, types: IssueTypeMeta[]): number {
  const own = parent.issueType;
  if (own === null) return 0;
  const found = types.find((t) => same(t.name, own.name));
  const meta = found?.levelKnown === false ? own : (found ?? own);
  return meta.subtask ? -1 : meta.level;
}

/** The project's one sub-task type; none or several is a setting to make. */
function onlySubtaskType(types: IssueTypeMeta[], project: string): string {
  const subtasks = types.filter((t) => t.subtask).map((t) => t.name);
  if (subtasks.length !== 1)
    throw new TrackerConfigError(
      "issue_tracker.jira.subtask_type",
      `project ${project} has ${subtasks.length} sub-task issue types (${subtasks.join(", ") || "none"}); name the one to use in issue_tracker.jira.subtask_type`,
    );
  return subtasks[0] as string;
}

interface Transition {
  id: string;
  name: string;
  to: string;
  /** The transition's screen has a resolution field. */
  resolution: boolean;
}

function transitionOf(v: unknown, where: string): Transition {
  const r = record(v, where);
  const fields = r.fields;
  return {
    id: str(r.id, `${where}.id`),
    name: str(r.name, `${where}.name`),
    to: str(record(r.to, `${where}.to`).name, `${where}.to.name`),
    resolution:
      fields !== null && typeof fields === "object" && "resolution" in fields,
  };
}

/** The one transition to `target`, or a refusal naming those available. */
function onlyTransition(
  all: Transition[],
  issue: JiraIssue,
  target: string,
  state: CanonicalState,
): Transition {
  const matches = all.filter((t) => same(t.to, target));
  if (matches.length === 1) return matches[0] as Transition;
  const available = all.map((t) => `${t.name} → ${t.to}`).join(", ") || "none";
  throw new TrackerRequestError(
    "unresolved",
    `${issue.key} is in '${issue.status.name}', and ${matches.length} transitions from there lead to '${target}' (issue_tracker.states.${state}), expected exactly 1; available: ${available}`,
  );
}

export function jiraTracker(client: Client): Tracker {
  const { model, project, settings, transport } = client;
  const stores = jiraFacetStores(client);
  const path = (key: string) => `issue/${encodeURIComponent(key)}`;

  /** The issue type of a new issue under `parent` (or none). */
  async function issueTypeUnder(parent: JiraIssue | null): Promise<string> {
    if (parent === null) return settings.issueType;
    const types = await client.issueTypes();
    const level = levelOf(parent, types);
    if (level < 0)
      throw new TrackerRequestError(
        "invalid",
        `${parent.key} is a sub-task, and Jira gives a sub-task no children`,
      );
    if (level >= 1) return settings.issueType;
    return settings.subtaskType ?? onlySubtaskType(types, project);
  }

  async function priorityField(
    priority: number,
    signal?: AbortSignal,
  ): Promise<{ id: string } | null> {
    const name = model.priorityName(priority);
    return name === null ? null : { id: await client.priority(name, signal) };
  }

  async function relations(key: string): Promise<IssueRelation[]> {
    const issue = await client.mustIssue(key);
    const types = await client.linkTypes();
    const out: IssueRelation[] = [];
    for (const link of issue.links)
      for (const relation of LINKED_RELATIONS) {
        const entry = types[relation].find((t) => same(link.type, t.name));
        if (entry === undefined) continue;
        const forward = (link.direction === "outward") !== entry.inverted;
        out.push({ type: SIDES[relation][forward ? 0 : 1], issue: link.issue });
        break;
      }
    const ids = out.map((r) => `${r.type} ${r.issue}`);
    return out.filter((_, i) => ids.indexOf(ids[i] as string) === i);
  }

  /** The fields a patch sets, each name resolved first. */
  async function patchFields(
    patch: IssuePatch,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.description !== undefined)
      fields.description = markdownToAdf(patch.description);
    if (patch.priority !== undefined)
      fields.priority = await priorityField(patch.priority, signal);
    if (patch.project !== undefined)
      fields.fixVersions = [
        { id: await client.version(patch.project, signal) },
      ];
    if (patch.parent !== undefined)
      fields.parent =
        patch.parent === null
          ? null
          : { key: (await client.mustIssue(patch.parent, signal)).key };
    return fields;
  }

  async function transitionsOf(
    key: string,
    signal?: AbortSignal,
  ): Promise<Transition[]> {
    const raw = record(
      await transport(
        {
          method: "GET",
          path: `${path(key)}/transitions`,
          query: { expand: "transitions.fields" },
        },
        signal,
      ),
      `transitions of ${key}`,
    );
    if (!Array.isArray(raw.transitions))
      throw new JiraApiError(`transitions of ${key}: list missing`);
    return raw.transitions.map((t, i) =>
      transitionOf(t, `transitions of ${key}[${i}]`),
    );
  }

  /**
   * Refuse a label that is a field's value: the adapter writes such a field
   * only as the facet it keeps, and reads the others but never writes them.
   */
  async function refuseFieldLabels(
    labels: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) {
    const fields = await client.fieldLabels(signal);
    for (const l of labels) {
      const found = fieldOfLabel(l, fields);
      if (found === null) continue;
      const facet = (await client.facetFields(signal)).find(
        (f) => f.id === found.field.id,
      )?.facet;
      throw new TrackerRequestError(
        "invalid",
        facet === undefined
          ? `label '${l}' is the value of the Jira field '${found.field.name}' (issue_tracker.jira.field_labels.${found.field.configured}), which the adapter reads but does not write; set the field in Jira`
          : `label '${l}' is the value of the Jira field '${found.field.name}', which keeps the ${facet}; give it as the issue's ${facet}, not as a label`,
      );
    }
  }

  async function siteLabels(): Promise<string[]> {
    const values = await offsetPages(
      transport,
      { method: "GET", path: "label" },
      {
        items: "values",
        idOf: () => undefined,
        where: "labels",
        strings: true,
      },
    );
    return values.map((v) => String(v.name));
  }

  /** Link `key` to `target` as the outward side, unless the link exists. */
  async function link(key: string, type: RelationType, target: string) {
    checkRelation(key, type, target);
    const types = await client.linkTypes();
    const [from, to] = [
      await client.mustIssue(key),
      await client.mustIssue(target),
    ];
    refuseSameIssue([from.id, to.id], key, target, from.key);
    const existing = await relations(from.key);
    if (existing.some((r) => r.type === type && r.issue === to.key)) return;
    const first = types[type][0] as RelationLink;
    const [inward, outward] = first.inverted ? [to, from] : [from, to];
    await transport({
      method: "POST",
      path: "issueLink",
      body: {
        type: { name: first.name },
        inwardIssue: { key: inward.key },
        outwardIssue: { key: outward.key },
      },
    });
  }

  const tracker: CoreTracker = {
    adapter: "jira",
    team: project,
    stateName: (state) => model.stateName(state),

    async reach(signal) {
      try {
        await transport({ method: "GET", path: `project/${project}` }, signal);
      } catch (err) {
        if (err instanceof JiraApiError && err.notFound)
          throw new TrackerConfigError(
            "issue_tracker.team",
            `issue_tracker.team names ${project}, which is no Jira project at ${client.site} the credential can see`,
          );
        throw err;
      }
      await client.poolScope(signal);
      // Each `field_labels` entry resolved against the site: a field it does
      // not name once, or whose values do not read as labels, is refused here
      // rather than at the first issue read.
      await client.fieldLabels(signal);
    },

    async getIssue(key) {
      const issue = await client.issue(key);
      if (issue === null) return null;
      const kids = await client.children(issue.key);
      return {
        id: issue.id,
        identifier: issue.key,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        updatedAt: issue.updatedAt,
        state: model.read(issue).state,
        labels: issue.labels,
        priority: model.priorityOf(issue.priority),
        ...facetValuesOf(issue),
        nativeType: issue.issueType?.name ?? null,
        parent:
          issue.parent === null
            ? null
            : { identifier: issue.parent.key, title: issue.parent.title },
        children: kids.map((k) => summaryOf(k, client)),
        assignee:
          issue.assignee === null
            ? null
            : issue.assignee.displayName || issue.assignee.accountId,
        project: issue.fixVersions[0] ?? null,
      };
    },

    async listComments(key, signal) {
      return (await client.comments(key, signal)).map((c) => ({
        body: c.body,
        createdAt: c.createdAt,
      }));
    },

    async listChildren(key) {
      return (await client.children(key)).map((k) => summaryOf(k, client));
    },

    async transition(key, state, signal) {
      const target = namedState(model.stateName(state), state);
      const issue = await client.mustIssue(key, signal);
      const already =
        same(issue.status.name, target) &&
        (!isResolvedState(state) || model.read(issue).canonical === state);
      if (already) return;
      const all = await transitionsOf(issue.key, signal);
      const chosen = onlyTransition(all, issue, target, state);
      const resolution =
        isResolvedState(state) && chosen.resolution
          ? { fields: { resolution: { name: model.resolutionOf(state) } } }
          : {};
      await transport(
        {
          method: "POST",
          path: `${path(issue.key)}/transitions`,
          body: { transition: { id: chosen.id }, ...resolution },
        },
        signal,
      );
      if (isResolvedState(state) && !chosen.resolution) {
        const after = await client.mustIssue(issue.key, signal);
        if (model.read(after).canonical !== state)
          throw new JiraApiError(
            `${issue.key} entered ${after.status.name}, which its transition cannot record as ${state}: the transition has no resolution field`,
          );
      }
    },

    async postComment(issue, body, signal) {
      if (signal?.aborted === true)
        throw new JiraApiError("the comment was cancelled before it was sent");
      if (issue.trim() === "")
        throw new TrackerRequestError("invalid", "a comment needs an issue");
      // An answer lost after the request left is reported as the transport
      // says it (the comment may have landed), never settled by reading the
      // history back: a comment in the same words proves nothing about this
      // call. The caller decides whether to write again.
      await transport(
        {
          method: "POST",
          path: `${path(issue)}/comment`,
          body: { body: markdownToAdf(body) },
        },
        signal,
      );
    },

    ...reportOperations(client, stores),
    ...assignerOperations(client),
    ...claimOperations(client),

    async createIssue(issue) {
      requireTitle(issue.title);
      checkPriority(issue.priority);
      checkLabels(issue.labels);
      stores.refuseLabels(issue.labels, "to file");
      await refuseFieldLabels(issue.labels);
      // Every name resolves before the write, so a typo files nothing.
      const parent =
        issue.parent === undefined
          ? null
          : await client.mustIssue(issue.parent);
      const facet = await stores.create(issue, {
        issueType: await issueTypeUnder(parent),
        top: parent === null,
      });
      checkLabels(facet.add);
      const labels = [...new Set([...issue.labels, ...facet.add])];
      const priority = await priorityField(issue.priority ?? 0);
      const version =
        issue.project === undefined
          ? null
          : await client.version(issue.project);
      // A lost answer is reported, never reconciled against a search for a
      // matching issue: a match by title cannot prove this write filed it.
      const created = record(
        await transport({
          method: "POST",
          path: "issue",
          body: {
            fields: {
              project: { key: project },
              summary: issue.title,
              description: markdownToAdf(issue.description),
              issuetype: { name: facet.issueType },
              ...(labels.length === 0 ? {} : { labels }),
              ...(priority === null ? {} : { priority }),
              ...(parent === null ? {} : { parent: { key: parent.key } }),
              ...(version === null ? {} : { fixVersions: [{ id: version }] }),
              ...facet.fields,
            },
          },
        }),
        "created issue",
      );
      if (typeof created.key !== "string")
        throw new JiraApiError(
          "the created issue's key is missing; the issue may have been filed",
        );
      return {
        identifier: created.key,
        url: `${client.site}/browse/${created.key}`,
      };
    },

    async updateIssue(key, patch: IssuePatch, signal) {
      signal?.throwIfAborted();
      checkPatch(key, patch);
      const labels = [
        ...(patch.addLabels ?? []).map((l) => ({ add: l })),
        ...(patch.removeLabels ?? []).map((l) => ({ remove: l })),
      ];
      const named = labels.map((l) => ("add" in l ? l.add : l.remove));
      checkLabels(named);
      stores.refuseLabels(patch.addLabels ?? [], "to add");
      await refuseFieldLabels(named, signal);
      if (patch.priority === 0)
        throw new TrackerRequestError(
          "invalid",
          "a Jira issue always carries a priority, so priority 0 (none) cannot be set",
        );
      const issue = await client.mustIssue(key, signal);
      const fields = await patchFields(patch, signal);
      const facet = await stores.update(issue, patch, signal);
      Object.assign(fields, facet.fields);
      checkLabels(facet.add);
      labels.push(
        ...facet.add.map((l) => ({ add: l })),
        ...facet.remove
          .filter((l) => !(patch.removeLabels ?? []).includes(l))
          .map((l) => ({ remove: l })),
      );
      const body: Record<string, unknown> = {};
      if (Object.keys(fields).length > 0) body.fields = fields;
      if (labels.length > 0) body.update = { labels };
      // A facet already at its value is no change, and no request.
      if (Object.keys(body).length === 0) return;
      signal?.throwIfAborted();
      await transport({ method: "PUT", path: path(issue.key), body }, signal);
    },

    async listLabels() {
      const names = await siteLabels();
      names.sort((a, b) => a.localeCompare(b));
      return names.map((name) => ({ name, group: null }));
    },

    async searchIssues(text, opts = {}) {
      checkSearchText(text);
      const match = `(summary ~ ${quote(text)} OR description ~ ${quote(text)})`;
      const found = await client.search(
        inProject(
          project,
          match,
          ...(opts.includeClosed === true ? [] : [OPEN]),
        ),
        `issues containing '${text}'`,
      );
      return found.map((i) => summaryOf(i, client));
    },

    listRelations: relations,

    relate: link,
  };
  tracker.facetReport = (options) => stores.report(options);
  return withFacets(tracker, client.facets, stores.own);

  /** The type and size the adapter keeps itself, read off an issue. */
  function facetValuesOf(issue: JiraIssue) {
    const { unmappedFacets: _, ...values } = stores.read(issue);
    return values;
  }
}

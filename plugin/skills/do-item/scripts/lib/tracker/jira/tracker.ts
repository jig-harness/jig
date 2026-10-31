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
 * - priority: the priority's name (`issue_tracker.jira.priorities`); a
 *   project: the first fix version; the native type: the issue type's name;
 * - parent and children: the `parent` field, for sub-tasks and an Epic's
 *   issues alike;
 * - relations: issue links of the configured types
 *   (`issue_tracker.jira.link_types`); other link types are ignored;
 * - descriptions and comments: Markdown converted to and from ADF (`adf.ts`);
 * - labels: Jira labels, free text shared across the site, written as given
 *   when well-formed;
 * - a trusted comment: one whose author is a licensed, non-guest Atlassian
 *   account that can be assigned issues in the project.
 *
 * The reports and candidate pools are in `reports.ts`, `assignedBy` in
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
import { TrackerConfigError } from "../config-error.ts";
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
import type { Client, IssueTypeMeta } from "./client.ts";
import { type JiraIssue, record, str } from "./read.ts";
import { inProject, OPEN, quote } from "./jql.ts";
import { isResolvedState } from "./model.ts";
import { reportOperations } from "./reports.ts";
import { JiraApiError, offsetPages } from "./transport.ts";

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
  ): Promise<{ id: string } | null> {
    const name = model.priorityName(priority);
    return name === null ? null : { id: await client.priority(name) };
  }

  async function relations(key: string): Promise<IssueRelation[]> {
    const issue = await client.mustIssue(key);
    const types = await client.linkTypes();
    const out: IssueRelation[] = [];
    for (const link of issue.links) {
      const outward = link.direction === "outward";
      if (same(link.type, types.blocks.name))
        out.push({
          type: outward ? "blocks" : "blocked_by",
          issue: link.issue,
        });
      else if (same(link.type, types.duplicate.name))
        out.push({
          type: outward ? "duplicate" : "duplicated_by",
          issue: link.issue,
        });
      else if (same(link.type, types.related.name))
        out.push({ type: "related", issue: link.issue });
    }
    const ids = out.map((r) => `${r.type} ${r.issue}`);
    return out.filter((_, i) => ids.indexOf(ids[i] as string) === i);
  }

  /** The fields a patch sets, each name resolved first. */
  async function patchFields(
    patch: IssuePatch,
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {};
    if (patch.title !== undefined) fields.summary = patch.title;
    if (patch.description !== undefined)
      fields.description = markdownToAdf(patch.description);
    if (patch.priority !== undefined)
      fields.priority = await priorityField(patch.priority);
    if (patch.project !== undefined)
      fields.fixVersions = [{ id: await client.version(patch.project) }];
    if (patch.parent !== undefined)
      fields.parent =
        patch.parent === null
          ? null
          : { key: (await client.mustIssue(patch.parent)).key };
    return fields;
  }

  async function transitionsOf(key: string): Promise<Transition[]> {
    const raw = record(
      await transport({
        method: "GET",
        path: `${path(key)}/transitions`,
        query: { expand: "transitions.fields" },
      }),
      `transitions of ${key}`,
    );
    if (!Array.isArray(raw.transitions))
      throw new JiraApiError(`transitions of ${key}: list missing`);
    return raw.transitions.map((t, i) =>
      transitionOf(t, `transitions of ${key}[${i}]`),
    );
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
    await transport({
      method: "POST",
      path: "issueLink",
      body: {
        type: { name: types[type].name },
        inwardIssue: { key: from.key },
        outwardIssue: { key: to.key },
      },
    });
  }

  /** A write whose outcome is unknown: the request left but no answer came back. */
  function lostAnswer(err: unknown): boolean {
    return err instanceof JiraApiError && err.status === null && !err.notFound;
  }

  /** The created issue's record; after a lost answer, the issue found filed. */
  async function filed(
    write: () => Promise<unknown>,
    title: string,
    parent: string | null,
  ): Promise<Record<string, unknown>> {
    try {
      return record(await write(), "created issue");
    } catch (err) {
      if (!lostAnswer(err)) throw err;
      const found = await findFiled(title, parent);
      if (found === null)
        throw new JiraApiError(
          `the answer to filing '${title}' was lost and no such issue was found; it may have been filed`,
          { unavailable: true },
        );
      return { key: found.key };
    }
  }

  /** The issue a lost create answer may have left: same title, parent and reporter, filed lately. */
  async function findFiled(
    title: string,
    parent: string | null,
  ): Promise<JiraIssue | null> {
    const found = await client
      .search(
        inProject(
          project,
          "reporter = currentUser()",
          'created >= "-15m"',
          `summary ~ ${quote(title)}`,
        ),
        `issues just filed as '${title}'`,
      )
      .catch(() => []);
    return (
      found.find(
        (i) => i.title === title && (i.parent?.key ?? null) === parent,
      ) ?? null
    );
  }

  const tracker: Tracker = {
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

    async listComments(key) {
      return (await client.comments(key)).map((c) => ({
        body: c.body,
        createdAt: c.createdAt,
      }));
    },

    async listChildren(key) {
      return (await client.children(key)).map((k) => summaryOf(k, client));
    },

    async transition(key, state) {
      const issue = await client.mustIssue(key);
      const target = model.stateName(state);
      const already =
        same(issue.status.name, target) &&
        (!isResolvedState(state) || model.read(issue).canonical === state);
      if (already) return;
      const all = await transitionsOf(issue.key);
      const chosen = onlyTransition(all, issue, target, state);
      const resolution =
        isResolvedState(state) && chosen.resolution
          ? { fields: { resolution: { name: model.resolutionOf(state) } } }
          : {};
      await transport({
        method: "POST",
        path: `${path(issue.key)}/transitions`,
        body: { transition: { id: chosen.id }, ...resolution },
      });
      if (isResolvedState(state) && !chosen.resolution) {
        const after = await client.mustIssue(issue.key);
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
      try {
        await transport(
          {
            method: "POST",
            path: `${path(issue)}/comment`,
            body: { body: markdownToAdf(body) },
          },
          signal,
        );
      } catch (err) {
        if (!lostAnswer(err)) throw err;
        const sent = await client.comments(issue).catch(() => []);
        if (sent.some((c) => c.body.trim() === body.trim())) return;
        throw err;
      }
    },

    ...reportOperations(client),
    ...assignerOperations(client),

    async createIssue(issue) {
      requireTitle(issue.title);
      checkPriority(issue.priority);
      checkLabels(issue.labels);
      // Every name resolves before the write, so a typo files nothing.
      const parent =
        issue.parent === undefined
          ? null
          : await client.mustIssue(issue.parent);
      const issueType = await issueTypeUnder(parent);
      const priority = await priorityField(issue.priority ?? 0);
      const version =
        issue.project === undefined
          ? null
          : await client.version(issue.project);
      const write = () =>
        transport({
          method: "POST",
          path: "issue",
          body: {
            fields: {
              project: { key: project },
              summary: issue.title,
              description: markdownToAdf(issue.description),
              issuetype: { name: issueType },
              ...(issue.labels.length === 0
                ? {}
                : { labels: [...new Set(issue.labels)] }),
              ...(priority === null ? {} : { priority }),
              ...(parent === null ? {} : { parent: { key: parent.key } }),
              ...(version === null ? {} : { fixVersions: [{ id: version }] }),
            },
          },
        });
      const created = await filed(write, issue.title, parent?.key ?? null);
      if (typeof created.key !== "string")
        throw new JiraApiError(
          "the created issue's key is missing; the issue may have been filed",
        );
      return {
        identifier: created.key,
        url: `${client.site}/browse/${created.key}`,
      };
    },

    async updateIssue(key, patch: IssuePatch) {
      checkPatch(key, patch);
      const labels = [
        ...(patch.addLabels ?? []).map((l) => ({ add: l })),
        ...(patch.removeLabels ?? []).map((l) => ({ remove: l })),
      ];
      checkLabels(labels.map((l) => ("add" in l ? l.add : l.remove)));
      if (patch.priority === 0)
        throw new TrackerRequestError(
          "invalid",
          "a Jira issue always carries a priority, so priority 0 (none) cannot be set",
        );
      const issue = await client.mustIssue(key);
      const fields = await patchFields(patch);
      const body: Record<string, unknown> = {};
      if (Object.keys(fields).length > 0) body.fields = fields;
      if (labels.length > 0) body.update = { labels };
      await transport({ method: "PUT", path: path(issue.key), body });
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
  return tracker;
}

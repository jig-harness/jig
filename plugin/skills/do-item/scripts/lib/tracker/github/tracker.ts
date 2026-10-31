/**
 * The GitHub Issues adapter of the tracker port (`port.ts`).
 *
 * It works on the issues of one repository (`issue_tracker.github.repository`,
 * else the git remote's, `repository.remote` or `origin`), whose keys are `#<n>`. How the port's
 * vocabulary maps onto GitHub:
 *
 * - workflow states: `model.ts` (close reasons, and labels or a board's
 *   Status field for the open states);
 * - priority: a label per level; a project: a milestone;
 * - parent and children: sub-issues; `blocks`: GitHub's issue dependencies;
 *   `duplicate`: closing as a duplicate of the other issue, which GitHub
 *   records on both; `related`: GitHub has no such link, so each issue gets a
 *   comment naming the other, carrying a marker the adapter reads back from
 *   comments by people who can write to the repository;
 * - a trusted comment: one whose author owns the repository, belongs to its
 *   organization or is a collaborator.
 *
 * The reports and candidate pools are in `reports.ts`.
 */

import type { CanonicalState, IssuePatch, Tracker } from "../port.ts";
import type { IssueComment, IssueRelation, IssueSummary } from "../port.ts";
import { TrackerRequestError } from "../port.ts";
import {
  checkPatch,
  checkPriority,
  checkRelation,
  requireTitle,
} from "../requests.ts";
import type { Client } from "./client.ts";
import { CLOSE_REASONS, isClosedState } from "./model.ts";
import {
  type GhIssue,
  ISSUE_TYPE,
  issueFields,
  nativeTypeOf,
  onePage,
  PAGE,
  parseIssue,
  record,
  str,
  summaryOf,
  wholeLabels,
} from "./read.ts";
import { keyOf, repoOf, slug } from "./refs.ts";
import { assignerOperations } from "./assigner.ts";
import { reportOperations } from "./reports.ts";
import { GitHubApiError, pageAll } from "./transport.ts";

const SUB_ISSUES = (fields: string) => `
query TrackerChildren($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${fields} }
      }
    }
  }
}`;

const COMMENTS = `
query TrackerComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id
      comments(first: ${PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt authorAssociation viewerDidAuthor }
      }
    }
  }
}`;

const SEARCH = (fields: string) => `
query TrackerSearch($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: ${PAGE}, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${fields} } }
  }
}`;

const REF = "number repository { nameWithOwner }";

const RELATIONS = `
  blockedBy(first: ${PAGE}) { pageInfo { hasNextPage } nodes { ${REF} } }
  blocking(first: ${PAGE}) { pageInfo { hasNextPage } nodes { ${REF} } }
  duplicateOf { ${REF} }
  timelineItems(itemTypes: [MARKED_AS_DUPLICATE_EVENT], first: ${PAGE}) {
    pageInfo { hasNextPage }
    nodes {
      ... on MarkedAsDuplicateEvent {
        canonical { ... on Issue { ${REF} } }
        duplicate { ... on Issue { ${REF} duplicateOf { ${REF} } } }
      }
    }
  }`;

export const M = {
  comment: `mutation TrackerComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) { clientMutationId }
  }`,
  close: `mutation TrackerClose($issueId: ID!, $stateReason: IssueClosedStateReason, $duplicateIssueId: ID) {
    closeIssue(input: { issueId: $issueId, stateReason: $stateReason, duplicateIssueId: $duplicateIssueId }) { issue { id } }
  }`,
  reopen: `mutation TrackerReopen($issueId: ID!) {
    reopenIssue(input: { issueId: $issueId }) { issue { id } }
  }`,
  addLabels: `mutation TrackerAddLabels($id: ID!, $labelIds: [ID!]!) {
    addLabelsToLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId }
  }`,
  removeLabels: `mutation TrackerRemoveLabels($id: ID!, $labelIds: [ID!]!) {
    removeLabelsFromLabelable(input: { labelableId: $id, labelIds: $labelIds }) { clientMutationId }
  }`,
  create: `mutation TrackerCreate($input: CreateIssueInput!) {
    createIssue(input: $input) { issue { number url } }
  }`,
  update: `mutation TrackerUpdate($input: UpdateIssueInput!) {
    updateIssue(input: $input) { issue { id } }
  }`,
  addSubIssue: `mutation TrackerAddSubIssue($issueId: ID!, $subIssueId: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId, replaceParent: true }) { issue { id } }
  }`,
  removeSubIssue: `mutation TrackerRemoveSubIssue($issueId: ID!, $subIssueId: ID!) {
    removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) { issue { id } }
  }`,
  addBlockedBy: `mutation TrackerAddBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { id } }
  }`,
  addItem: `mutation TrackerAddItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }`,
  setStatus: `mutation TrackerSetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
      value: { singleSelectOptionId: $optionId }
    }) { projectV2Item { id } }
  }`,
};

/** Authors whose comments are trusted: they can write to the repository. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The marker of a `related` comment; the other issue is always qualified. */
const RELATED_MARKER =
  /<!-- jig:related ([A-Za-z0-9-]+\/[A-Za-z0-9._-]+#[1-9]\d*) -->/g;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A node id GitHub gives an issue. */
const NODE_ID = /^I_[A-Za-z0-9_-]+$/;

export interface CommentNode {
  body: string;
  createdAt: string;
  trusted: boolean;
}

export function gitHubTracker(client: Client): Tracker {
  const { home, model, ctx } = client;
  const fields = issueFields(ctx.board);

  async function comments(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; comments: CommentNode[] }> {
    const ref = client.ref(key);
    let id = "";
    const nodes = await pageAll(
      client.transport,
      COMMENTS,
      { owner: ref.owner, name: ref.name, number: ref.number },
      (d) => {
        const issue = record(
          record(d.repository, "repository").issue,
          `issue ${key}`,
        );
        id = str(issue.id, `issue ${key}.id`);
        return issue.comments;
      },
      `comments of ${key}`,
      signal,
    );
    return {
      id,
      comments: nodes.map((c, i) => {
        const n = record(c, `comments of ${key}[${i}]`);
        const createdAt = str(
          n.createdAt,
          `comments of ${key}[${i}].createdAt`,
        );
        if (!Number.isFinite(Date.parse(createdAt)))
          throw new GitHubApiError(`issue ${key}: an unreadable comment node`);
        return {
          body: str(n.body, `comments of ${key}[${i}].body`),
          createdAt,
          // The viewer's own comments too: a bot token's writes carry no
          // association, and the adapter must read back what it wrote.
          trusted:
            TRUSTED.has(String(n.authorAssociation)) ||
            n.viewerDidAuthor === true,
        };
      }),
    };
  }

  async function children(
    key: string,
    extra = "",
    signal?: AbortSignal,
  ): Promise<Array<{ issue: GhIssue; raw: Record<string, unknown> }>> {
    const ref = client.ref(key);
    const nodes = await pageAll(
      client.transport,
      SUB_ISSUES(`${fields} ${extra}`),
      { owner: ref.owner, name: ref.name, number: ref.number },
      (d) =>
        record(record(d.repository, "repository").issue, `issue ${key}`)
          .subIssues,
      `children of ${key}`,
      signal,
    );
    return nodes.map((n) => {
      const raw = record(n, `children of ${key}`);
      return { issue: parseIssue(raw, ctx), raw };
    });
  }

  /** Close, reopen or leave an issue so it is in `state`'s open or closed half. */
  async function setOpenness(
    issue: GhIssue,
    state: CanonicalState,
  ): Promise<void> {
    if (isClosedState(state)) {
      const reason = CLOSE_REASONS[state];
      if (!issue.open && (issue.stateReason ?? "COMPLETED") === reason) return;
      await client.mutate(M.close, {
        issueId: issue.id,
        stateReason: reason,
        duplicateIssueId: null,
      });
    } else if (!issue.open) {
      await client.mutate(M.reopen, { issueId: issue.id });
    }
  }

  async function transitionByLabels(
    issue: GhIssue,
    state: CanonicalState,
  ): Promise<void> {
    const carried = wholeLabels(issue).filter((l) =>
      model.stateLabels.some((s) => same(s, l)),
    );
    const target = isClosedState(state) ? null : model.stateLabel(state);
    const add =
      target !== null && !carried.some((l) => same(l, target)) ? [target] : [];
    const remove = carried.filter((l) => target === null || !same(l, target));
    const ids = await client.labelIds(
      [...add, ...remove],
      (name) =>
        `issue_tracker.states.${state} names '${name}', which is not a label of ${slug(home)}; create it (gh label create "${name}" --repo ${slug(home)}) or name another`,
    );
    await setOpenness(issue, state);
    if (add.length > 0)
      await client.mutate(M.addLabels, {
        id: issue.id,
        labelIds: add.map((l) => ids.get(l)),
      });
    if (remove.length > 0)
      await client.mutate(M.removeLabels, {
        id: issue.id,
        labelIds: remove.map((l) => ids.get(l)),
      });
  }

  async function transitionOnBoard(
    issue: GhIssue,
    state: CanonicalState,
  ): Promise<void> {
    const board = await client.board();
    const name = model.stateName(state);
    const options = board.options.filter((o) => same(o.name, name));
    // A closed state needs no option: closing the issue is the state, and
    // many boards have no option for a canceled or duplicate issue.
    if (options.length > 1 || (options.length === 0 && !isClosedState(state)))
      throw new TrackerRequestError(
        "unresolved",
        `issue_tracker.states.${state} names '${name}', which matches ${options.length} options of the board's ${JSON.stringify(ctx.board?.statusField)} field (expected 1)`,
      );
    const option = options[0];
    if (option !== undefined) {
      let itemId = issue.boardItem?.id;
      if (itemId === undefined) {
        const added = await client.mutate(M.addItem, {
          projectId: board.projectId,
          contentId: issue.id,
        });
        itemId = str(
          record(
            record(added.addProjectV2ItemById, "addProjectV2ItemById").item,
            "item",
          ).id,
          "item.id",
        );
      }
      await client.mutate(M.setStatus, {
        projectId: board.projectId,
        itemId,
        fieldId: board.fieldId,
        optionId: option.id,
      });
    }
    await setOpenness(issue, state);
  }

  /**
   * Refuse a change that resolves labels or milestones, on an issue of
   * another repository: they are read from the home repository, whose ids
   * would not apply there.
   */
  function refuseForeign(key: string, what: string): void {
    const ref = client.ref(key);
    if (keyOf(ref, home) !== `#${ref.number}`)
      throw new TrackerRequestError(
        "invalid",
        `${key} is an issue of ${slug(ref)}; its ${what} can be changed only on issues of ${slug(home)}`,
      );
  }

  /** Refuse a label the caller may not set directly: a state or a priority. */
  function refuseReserved(labels: string[]): void {
    const reserved = labels.filter((l) => model.isReserved(l));
    if (reserved.length > 0)
      throw new TrackerRequestError(
        "invalid",
        `${reserved.map((l) => `'${l}'`).join(", ")} stand for a workflow state or a priority; use transition or priority instead`,
      );
  }

  /** The key of a node read with `REF`, seen from the home repository. */
  function refKey(v: unknown, where: string): string {
    const n = record(v, where);
    const repo = record(n.repository, `${where}.repository`).nameWithOwner;
    return keyOf(
      { ...repoOf(str(repo, where)), number: Number(n.number) },
      home,
    );
  }

  /** `blocked_by` and `blocks`, from GitHub's issue dependencies. */
  function dependencies(
    raw: Record<string, unknown>,
    key: string,
  ): IssueRelation[] {
    return [
      ...onePage(raw.blockedBy, `${key}.blockedBy`).map(
        (n): IssueRelation => ({
          type: "blocked_by",
          issue: refKey(n, `${key}.blockedBy`),
        }),
      ),
      ...onePage(raw.blocking, `${key}.blocking`).map(
        (n): IssueRelation => ({
          type: "blocks",
          issue: refKey(n, `${key}.blocking`),
        }),
      ),
    ];
  }

  /**
   * `duplicate` from the issue's own link, `duplicated_by` from the
   * duplicate events on its timeline. An event is current only while the
   * duplicate still points here: unmarking a duplicate leaves the event.
   */
  function duplicates(
    raw: Record<string, unknown>,
    issue: GhIssue,
  ): IssueRelation[] {
    const out: IssueRelation[] =
      raw.duplicateOf === null || raw.duplicateOf === undefined
        ? []
        : [
            {
              type: "duplicate",
              issue: refKey(raw.duplicateOf, `${issue.key}.duplicateOf`),
            },
          ];
    const where = `${issue.key} duplicate event`;
    for (const e of onePage(raw.timelineItems, `${issue.key}.timelineItems`)) {
      const dup = record(record(e, where).duplicate, `${where}.duplicate`);
      const points = dup.duplicateOf;
      if (points === null || points === undefined) continue;
      if (refKey(points, where) === issue.key)
        out.push({ type: "duplicated_by", issue: refKey(dup, where) });
    }
    return out;
  }

  /** `related`, from the markers in trusted comments. */
  function related(comments: CommentNode[]): IssueRelation[] {
    return comments
      .filter((c) => c.trusted)
      .flatMap((c) => [...c.body.matchAll(RELATED_MARKER)])
      .map((m) => ({
        type: "related" as const,
        issue: keyOf(client.ref(m[1] as string), home),
      }));
  }

  async function relations(key: string): Promise<IssueRelation[]> {
    const found = await client.issue(client.ref(key), RELATIONS);
    if (found === null)
      throw new TrackerRequestError(
        "unresolved",
        `issue ${key} does not exist`,
      );
    const all = [
      ...dependencies(found.raw, key),
      ...duplicates(found.raw, found.issue),
      ...related((await comments(key)).comments),
    ];
    const ids = all.map((r) => `${r.type} ${r.issue}`);
    return all.filter((_, i) => ids.indexOf(ids[i] as string) === i);
  }

  /** Whether a patch names labels or a milestone, which resolve per repository. */
  function touchesRepositoryNames(patch: IssuePatch): boolean {
    return (
      (patch.addLabels ?? []).length > 0 ||
      (patch.removeLabels ?? []).length > 0 ||
      patch.priority !== undefined ||
      patch.project !== undefined
    );
  }

  /** The priority labels to add and remove for a new priority. */
  function priorityChange(
    carried: string[],
    priority: number | undefined,
  ): { add: string[]; remove: string[] } {
    if (priority === undefined) return { add: [], remove: [] };
    const target = model.priorityLabel(priority);
    const isTarget = (l: string) => target !== null && same(l, target);
    return {
      add: target !== null && !carried.some(isTarget) ? [target] : [],
      remove: carried.filter(
        (l) => model.priorityLabels.some((p) => same(p, l)) && !isTarget(l),
      ),
    };
  }

  /** The `updateIssue` input for the plain fields, or `null` for none. */
  async function fieldsInput(
    issue: GhIssue,
    patch: IssuePatch,
  ): Promise<Record<string, unknown> | null> {
    const input: Record<string, unknown> = { id: issue.id };
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.body = patch.description;
    if (patch.project !== undefined)
      input.milestoneId = (await client.milestone(patch.project)).id;
    return Object.keys(input).length > 1 ? input : null;
  }

  /** The parent to add the issue under, and the one to take it from. */
  async function parentChange(
    issue: GhIssue,
    parent: string | null | undefined,
  ): Promise<{ to: GhIssue | null; from: GhIssue | null }> {
    if (parent === undefined) return { to: null, from: null };
    if (parent !== null)
      return { to: await client.mustIssue(parent), from: null };
    return {
      to: null,
      from:
        issue.parent === null ? null : await client.mustIssue(issue.parent.key),
    };
  }

  async function relabel(
    issue: GhIssue,
    labels: { add: string[]; remove: string[] },
    ids: Map<string, string>,
  ): Promise<void> {
    const idsOf = (names: string[]) => [
      ...new Set(names.map((l) => ids.get(l))),
    ];
    if (labels.add.length > 0)
      await client.mutate(M.addLabels, {
        id: issue.id,
        labelIds: idsOf(labels.add),
      });
    if (labels.remove.length > 0)
      await client.mutate(M.removeLabels, {
        id: issue.id,
        labelIds: idsOf(labels.remove),
      });
  }

  async function reparent(
    issue: GhIssue,
    parents: { to: GhIssue | null; from: GhIssue | null },
  ): Promise<void> {
    if (parents.to !== null)
      await client.mutate(M.addSubIssue, {
        issueId: parents.to.id,
        subIssueId: issue.id,
      });
    if (parents.from !== null)
      await client.mutate(M.removeSubIssue, {
        issueId: parents.from.id,
        subIssueId: issue.id,
      });
  }

  const tracker: Tracker = {
    adapter: "github",
    team: slug(home),
    stateName: (state) => model.stateName(state),

    async reach(signal) {
      await client.repositoryId(signal);
    },

    async getIssue(key) {
      const found = await client.issue(
        client.ref(key),
        `${ISSUE_TYPE} subIssues(first: ${PAGE}) { pageInfo { hasNextPage } nodes { ${fields} } }`,
      );
      if (found === null) return null;
      const { issue, raw } = found;
      const kids = onePage(raw.subIssues, `issue ${key}.subIssues`).map((n) =>
        summaryOf(parseIssue(n, ctx), model),
      );
      return {
        id: issue.id,
        identifier: issue.key,
        title: issue.title,
        description: issue.body,
        url: issue.url,
        updatedAt: issue.updatedAt,
        state: model.issueState({ ...issue, labels: wholeLabels(issue) }),
        labels: model.visibleLabels(issue.labels),
        nativeType: nativeTypeOf(raw.issueType, `issue ${key}`),
        parent:
          issue.parent === null
            ? null
            : { identifier: issue.parent.key, title: issue.parent.title },
        children: kids,
        assignee: issue.assignee?.login ?? null,
        project: issue.milestone,
      };
    },

    async listComments(key) {
      const out: IssueComment[] = (await comments(key)).comments.map((c) => ({
        body: c.body,
        createdAt: c.createdAt,
      }));
      return out.sort((a, b) =>
        (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
      );
    },

    async listChildren(key): Promise<IssueSummary[]> {
      return (await children(key)).map(({ issue }) => summaryOf(issue, model));
    },

    async transition(key, state) {
      // On a board the state is the board's, whatever the repository; a
      // state label belongs to the home repository's labels.
      if (ctx.board === null) refuseForeign(key, "workflow state");
      const issue = await client.mustIssue(key);
      if (ctx.board === null) await transitionByLabels(issue, state);
      else await transitionOnBoard(issue, state);
    },

    async postComment(issue, body, signal) {
      const subjectId = NODE_ID.test(issue)
        ? issue
        : (await client.mustIssue(issue, signal)).id;
      if (signal?.aborted === true)
        throw new GitHubApiError(
          "the comment was cancelled before it was sent",
        );
      await client.transport(M.comment, { subjectId, body }, signal);
    },

    ...reportOperations(client, { comments, children }),
    ...assignerOperations(client),

    async createIssue(issue) {
      requireTitle(issue.title);
      checkPriority(issue.priority);
      refuseReserved(issue.labels);
      const priority = model.priorityLabel(issue.priority ?? 0);
      const names = [...issue.labels, ...(priority === null ? [] : [priority])];
      const ids = await client.labelIds(names, (name) =>
        name === priority
          ? `the priority label '${name}' (issue_tracker.github.priority_labels) is not a label of ${slug(home)}; create it (gh label create "${name}" --repo ${slug(home)})`
          : `'${name}' matches no label`,
      );
      const input: Record<string, unknown> = {
        repositoryId: await client.repositoryId(),
        title: issue.title,
        body: issue.description,
      };
      if (ids.size > 0) input.labelIds = [...new Set(ids.values())];
      if (issue.parent !== undefined)
        input.parentIssueId = (await client.mustIssue(issue.parent)).id;
      if (issue.project !== undefined)
        input.milestoneId = (await client.milestone(issue.project)).id;
      const data = await client.mutate(M.create, { input });
      const created = record(
        record(data.createIssue, "createIssue").issue,
        "createIssue.issue",
      );
      const number = created.number;
      if (typeof number !== "number")
        throw new GitHubApiError(
          "createIssue.issue.number: expected a number; the issue may have been filed",
        );
      return {
        identifier: `#${number}`,
        url: typeof created.url === "string" ? created.url : null,
      };
    },

    async updateIssue(key, patch) {
      checkPatch(key, patch);
      const add = patch.addLabels ?? [];
      const remove = patch.removeLabels ?? [];
      refuseReserved([...add, ...remove]);
      if (touchesRepositoryNames(patch))
        refuseForeign(key, "labels, priority or project");
      const issue = await client.mustIssue(key);
      const priority = priorityChange(wholeLabels(issue), patch.priority);
      const labels = {
        add: [...add, ...priority.add],
        remove: [...remove, ...priority.remove],
      };
      // Every name resolves before the first write, so a typo changes nothing.
      const ids = await client.labelIds([...labels.add, ...labels.remove]);
      // Label names resolve case-insensitively, so 'Bug' and 'bug' are one
      // label; adding and removing it would leave it removed.
      const removed = new Set(labels.remove.map((l) => ids.get(l)));
      const both = labels.add.filter((l) => removed.has(ids.get(l)));
      if (both.length > 0)
        throw new TrackerRequestError(
          "invalid",
          `the patch for ${key} both adds and removes ${both.map((l) => `'${l}'`).join(", ")}`,
        );
      const fields = await fieldsInput(issue, patch);
      const parents = await parentChange(issue, patch.parent);
      if (fields !== null) await client.mutate(M.update, { input: fields });
      await relabel(issue, labels, ids);
      await reparent(issue, parents);
    },

    async listLabels() {
      return (await client.repoLabels())
        .filter((l) => !model.isReserved(l.name))
        .map((l) => ({ name: l.name, group: null }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async searchIssues(text, opts = {}) {
      if (text.trim() === "")
        throw new TrackerRequestError(
          "invalid",
          "a search needs non-empty text; empty text would read every issue",
        );
      // GitHub's search matches words, not substrings; a phrase keeps the
      // words together. Quotes inside the text would end the phrase.
      const phrase = `"${text.replace(/"/g, " ").trim()}"`;
      const q = `repo:${slug(home)} is:issue ${opts.includeClosed === true ? "" : "is:open "}in:title,body ${phrase}`;
      let count = 0;
      const nodes = await pageAll(
        client.transport,
        SEARCH(fields),
        { q },
        (d) => {
          const conn = record(d.search, "search");
          count = Number(conn.issueCount);
          return conn;
        },
        `issues containing '${text}'`,
      );
      // GitHub returns at most the first 1,000 matches of a search.
      if (count > 1000)
        throw new TrackerRequestError(
          "invalid",
          `${count} issues match '${text}', more than a search can return in full; search for more specific text`,
        );
      return nodes.map((n) => summaryOf(parseIssue(n, ctx), model));
    },

    listRelations: relations,

    async relate(key, type, target) {
      checkRelation(key, type, target);
      const a = await client.mustIssue(key);
      const b = await client.mustIssue(target);
      // `#1`, `1`, the qualified key and the address all name one issue.
      if (a.id === b.id)
        throw new TrackerRequestError(
          "invalid",
          `an issue cannot be related to itself: ${key} and ${target} are ${a.key}`,
        );
      if (type === "blocks") {
        await client.mutate(M.addBlockedBy, {
          issueId: b.id,
          blockingIssueId: a.id,
        });
        return;
      }
      if (type === "duplicate") {
        await client.mutate(M.close, {
          issueId: a.id,
          stateReason: "DUPLICATE",
          duplicateIssueId: b.id,
        });
        return;
      }
      // Each side's note is its own write, so each is checked on its own: a
      // retry after one side failed writes only the missing note.
      const note = (other: GhIssue) =>
        `<!-- jig:related ${slug(other.ref)}#${other.ref.number} -->\nRelated to ${slug(other.ref)}#${other.ref.number}.`;
      for (const [on, other] of [
        [a, b],
        [b, a],
      ] as const)
        if (
          !(await relations(on.key)).some(
            (r) => r.type === "related" && r.issue === other.key,
          )
        )
          await client.mutate(M.comment, {
            subjectId: on.id,
            body: note(other),
          });
    },
  };
  return tracker;
}

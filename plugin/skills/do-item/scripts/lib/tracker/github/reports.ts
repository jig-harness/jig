/**
 * The GitHub adapter's reads for the fleet metrics and the candidate pools.
 *
 * Every population is read from the repository's issue list, page by page,
 * and narrowed here: GitHub's issue search returns at most 1,000 matches and
 * lags behind writes, so a report built on it could be short without saying
 * so. A window narrows the read by last update, which any creation, close or
 * comment in the window moves past the window's start.
 *
 * When an epic started is not recorded on GitHub. The census reads it as the
 * time the issue's current started-state label was added (labels mode), or
 * the time its board item last changed (project mode), falling back to the
 * issue's last update: never earlier than the real start, so a stuck epic is
 * reported late rather than early.
 */

import type {
  CommentFact,
  FoundComment,
  IssueFact,
  LabelledIssueState,
  LedgerIssue,
  PoolIssue,
  StartedIssueActivity,
  Tracker,
  WindowSpec,
} from "../port.ts";
import { TrackerRequestError } from "../port.ts";
import type { Client } from "./client.ts";
import { STATE_TYPES } from "./model.ts";
import {
  ancestorFields,
  completedAt,
  type GhIssue,
  onePage,
  PAGE,
  parseAncestors,
  parseIssue,
  record,
  str,
  wholeLabels,
} from "./read.ts";
import { GitHubApiError } from "./transport.ts";
import type { CommentNode } from "./tracker.ts";

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

/** What the reports borrow from the pickup operations. */
export interface Readers {
  comments(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; comments: CommentNode[] }>;
  children(
    key: string,
    extra?: string,
    signal?: AbortSignal,
  ): Promise<Array<{ issue: GhIssue; raw: Record<string, unknown> }>>;
}

/** Ancestors read past the attribution walk's depth, to detect a longer chain. */
const PARENT_DEPTH = 5;
const ANCESTORS = ancestorFields(PARENT_DEPTH + 1);

/** Whether each sub-issue is open, for `hasOpenChildren`. */
const OPEN_CHILDREN = `subIssues(first: ${PAGE}) { pageInfo { hasNextPage } nodes { state } }`;

/** The canonical states that only a closed issue is in. */
const CLOSED_STATES: ReadonlySet<string> = new Set([
  "done",
  "canceled",
  "duplicate",
]);

const LABELED_EVENTS = `timelineItems(itemTypes: [LABELED_EVENT], last: ${PAGE}) {
  nodes { ... on LabeledEvent { createdAt label { name } } }
}`;

const inWindow = (at: string | null, w: WindowSpec | undefined) =>
  w === undefined ||
  (at !== null && Date.parse(at) >= w.sinceMs && Date.parse(at) < w.untilMs);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function reportOperations(client: Client, readers: Readers): ReportOps {
  const { model, ctx, home } = client;

  function fact(issue: GhIssue, raw: Record<string, unknown>): IssueFact {
    const ancestors = parseAncestors(raw, ctx, model, `issue ${issue.key}`);
    if (ancestors.length > PARENT_DEPTH)
      throw new GitHubApiError(
        `issue ${issue.key}: more than ${PARENT_DEPTH} ancestors, so its epic may lie beyond the read`,
      );
    const labels = wholeLabels(issue);
    return {
      id: issue.key,
      title: issue.title,
      labels: model.visibleLabels(labels),
      createdAt: issue.createdAt,
      completedAt: completedAt(issue, model),
      stateType: STATE_TYPES[model.stateOf({ ...issue, labels })],
      description: issue.body,
      ancestors,
    };
  }

  function pool(issue: GhIssue, raw: Record<string, unknown>): PoolIssue {
    const labels = wholeLabels(issue);
    const state = model.stateOf({ ...issue, labels });
    const kids = onePage(raw.subIssues, `issue ${issue.key}.subIssues`);
    return {
      identifier: issue.key,
      title: issue.title,
      url: issue.url,
      priority: model.priorityOf(labels),
      createdAt: issue.createdAt,
      // The state's id is its canonical key: GitHub has no state objects,
      // and a claim re-check compares ids.
      state: {
        id: state,
        name: model.stateName(state),
        type: STATE_TYPES[state],
      },
      assignee:
        issue.assignee === null
          ? null
          : { id: issue.assignee.id, name: issue.assignee.login },
      labels: model.visibleLabels(labels),
      hasOpenChildren: kids.some(
        (k) => record(k, "sub-issue").state === "OPEN",
      ),
      truncated: [],
    };
  }

  /** The labelled issues of the home repository, every state; refuses an unknown label. */
  async function requireLabel(label: string): Promise<void> {
    const labels = await client.repoLabels();
    if (!labels.some((l) => same(l.name, label)))
      throw new TrackerRequestError(
        "unresolved",
        `the configured label '${label}' is not a label of ${home.owner}/${home.name}; a name that resolves to nothing silently shrinks the population`,
      );
  }

  /** When an open started issue started, by the rule in this file's header. */
  function startedAt(issue: GhIssue, raw: Record<string, unknown>): string {
    if (ctx.board !== null)
      return issue.boardItem?.updatedAt ?? issue.updatedAt;
    const label = model.stateLabel(
      model.stateOf(issue) as "in_progress" | "in_review" | "ops_pending",
    );
    return (
      (label === null ? null : labelledAt(raw, issue.key, label)) ??
      issue.updatedAt
    );
  }

  /** When `label` was last added, among the issue's latest label events. */
  function labelledAt(
    raw: Record<string, unknown>,
    key: string,
    label: string,
  ): string | null {
    const where = `issue ${key} label event`;
    const events = record(raw.timelineItems, `issue ${key}.timelineItems`);
    const nodes = Array.isArray(events.nodes) ? events.nodes : [];
    const added = nodes
      .map((e) => record(e, where))
      .filter((ev) => {
        const name = record(ev.label, `${where}.label`).name;
        return typeof name === "string" && same(name, label);
      });
    const last = added.at(-1);
    return last === undefined
      ? null
      : str(last.createdAt, `${where}.createdAt`);
  }

  function ledgerEntry(issue: GhIssue): LedgerIssue {
    const state = model.stateOf(issue);
    const abandoned = state === "canceled" || state === "duplicate";
    return {
      identifier: issue.key,
      createdAt: issue.createdAt,
      completedAt: completedAt(issue, model),
      canceledAt: abandoned ? issue.closedAt : null,
      stateType: STATE_TYPES[state],
      priority: model.priorityOf(issue.labels),
      parent: issue.parent?.key ?? null,
      project: issue.milestone,
      labels: model.visibleLabels(issue.labels),
      truncated: issue.labelsTruncated ? ["labels"] : [],
    };
  }

  return {
    async issuesByKeys(keys) {
      const out = new Map<string, IssueFact>();
      const numbers = [
        ...new Set(
          keys.flatMap((k) => {
            const m = /^#([1-9]\d*)$/.exec(k);
            return m === null ? [] : [Number(m[1])];
          }),
        ),
      ];
      for (let i = 0; i < numbers.length; i += 50) {
        const batch = numbers.slice(i, i + 50);
        const query = `query TrackerIssuesByNumber($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            ${batch.map((n) => `i${n}: issue(number: ${n}) { ${client.fields} ${ANCESTORS} }`).join("\n")}
          }
        }`;
        let data: unknown;
        try {
          data = await client.transport(query, {
            owner: home.owner,
            name: home.name,
          });
        } catch (err) {
          // A number that is no issue (absent, or a pull request) is absent
          // from the answer; GitHub reports it beside the issues it found.
          if (
            !(
              err instanceof GitHubApiError &&
              err.notFound &&
              err.data !== null
            )
          )
            throw err;
          data = err.data;
        }
        const repo = record(record(data, "data").repository, "repository");
        for (const n of batch) {
          const raw = repo[`i${n}`];
          if (raw === null || raw === undefined) continue;
          const node = record(raw, `issue #${n}`);
          const f = fact(parseIssue(node, ctx), node);
          out.set(f.id, f);
        }
      }
      return out;
    },

    async issuesInWindow(query) {
      const starts = [query.createdIn, query.completedIn]
        .filter((w): w is WindowSpec => w !== undefined)
        .map((w) => w.sinceMs);
      const read = await client.list(
        {
          ...(query.label === undefined ? {} : { labels: [query.label] }),
          ...(starts.length === 0
            ? {}
            : { since: new Date(Math.min(...starts)).toISOString() }),
          ...(query.completedIn === undefined
            ? {}
            : { states: ["CLOSED" as const] }),
        },
        ANCESTORS,
      );
      return read
        .filter(
          ({ issue }) =>
            inWindow(issue.createdAt, query.createdIn) &&
            inWindow(completedAt(issue, model), query.completedIn),
        )
        .map(({ issue, raw }) => fact(issue, raw));
    },

    async startedIssueActivity(label, signal) {
      const epics = await client.list(
        { labels: [label], states: ["OPEN"] },
        ctx.board === null ? LABELED_EVENTS : "",
        signal,
      );
      const out: StartedIssueActivity[] = [];
      for (const { issue, raw } of epics) {
        if (signal?.aborted === true)
          throw new GitHubApiError("the collector deadline passed");
        const labels = wholeLabels(issue);
        if (STATE_TYPES[model.stateOf({ ...issue, labels })] !== "started")
          continue;
        const kids = await readers.children(issue.key, "", signal);
        out.push({
          epic: issue.key,
          startedAt: startedAt(issue, raw),
          project: issue.milestone,
          assignee: issue.assignee?.login ?? null,
          labels: model.visibleLabels(labels),
          children: kids.map(({ issue: k }) => ({
            issue: k.key,
            updatedAt: k.updatedAt,
            stateType:
              STATE_TYPES[model.stateOf({ ...k, labels: wholeLabels(k) })],
          })),
        });
      }
      return out;
    },

    async commentsContaining(query) {
      const issues = await client.list({
        labels: [query.issueLabel],
        since: new Date(query.createdIn.sinceMs).toISOString(),
      });
      const out: FoundComment[] = [];
      for (const { issue } of issues)
        for (const c of (await readers.comments(issue.key)).comments)
          if (
            c.body.includes(query.text) &&
            inWindow(c.createdAt, query.createdIn)
          )
            out.push({ issue: issue.key, ...c });
      return out;
    },

    async issueComments(key) {
      if (!/^#[1-9]\d*$/.test(key))
        throw new TrackerRequestError(
          "invalid",
          `not an issue key of ${home.owner}/${home.name}: ${key}`,
        );
      const { id, comments } = await readers.comments(key);
      return {
        uuid: id,
        comments: comments.map((c): CommentFact => ({ ...c })),
      };
    },

    async ledger(query, onPage) {
      await requireLabel(query.label);
      const milestone =
        query.project === undefined
          ? null
          : await client.milestone(query.project);
      const read = [
        ...(await client.list({ labels: [query.label] })),
        ...(milestone === null
          ? []
          : await client.list({ milestoneNumber: String(milestone.number) })),
      ];
      const byKey = new Map<string, LedgerIssue>();
      for (const { issue } of read) {
        if (byKey.has(issue.key)) continue;
        byKey.set(issue.key, ledgerEntry(issue));
        onPage?.(byKey.size);
      }
      return [...byKey.values()];
    },

    async labelledIssues(label, signal, withDescription = false) {
      const read = await client.list({ labels: [label] }, "", signal);
      return read.map(({ issue }): LabelledIssueState => {
        const base = {
          identifier: issue.key,
          stateType:
            STATE_TYPES[
              model.stateOf({ ...issue, labels: wholeLabels(issue) })
            ],
          completedAt: completedAt(issue, model),
        };
        return withDescription ? { ...base, description: issue.body } : base;
      });
    },

    async openIssues(query) {
      if (
        query.withSomeOf.length === 0 ||
        query.withSomeOf.some((l) => l.length === 0)
      )
        throw new TrackerRequestError(
          "invalid",
          "a pool query needs at least one non-empty label list; an empty one would read every open issue",
        );
      // GitHub's label filter requires every listed label, so each
      // alternative of the first group is read on its own and the union is
      // deduplicated; every group is then applied locally.
      const byKey = new Map<
        string,
        Awaited<ReturnType<typeof client.list>>[number]
      >();
      for (const label of query.withSomeOf[0] as string[])
        for (const found of await client.list(
          { states: ["OPEN"], labels: [label] },
          OPEN_CHILDREN,
        ))
          if (!byKey.has(found.issue.key)) byKey.set(found.issue.key, found);
      return [...byKey.values()]
        .filter(({ issue }) => {
          const labels = wholeLabels(issue);
          const has = (l: string) => labels.some((x) => same(x, l));
          return (
            query.withSomeOf.every((list) => list.some(has)) &&
            !(query.withNoneOf ?? []).some(has)
          );
        })
        .map(({ issue, raw }) => pool(issue, raw));
    },

    async openChildren(key) {
      if (!/^#[1-9]\d*$/.test(key))
        throw new TrackerRequestError(
          "invalid",
          `not an issue key of ${home.owner}/${home.name}: ${key}`,
        );
      return (await readers.children(key, OPEN_CHILDREN))
        .filter(
          ({ issue }) =>
            issue.open &&
            same(issue.ref.owner, home.owner) &&
            same(issue.ref.name, home.name),
        )
        .map(({ issue, raw }) => pool(issue, raw));
    },

    async poolIssue(key) {
      const found = await client.issue(client.ref(key), OPEN_CHILDREN);
      return found === null ? null : pool(found.issue, found.raw);
    },

    async assignedIssues(identity, states) {
      if (states.length === 0)
        throw new TrackerRequestError(
          "invalid",
          "an assigned-issues query needs at least one state",
        );
      // The state is a label or a board column, so it is applied locally;
      // the listing is open-only unless a closed state is asked for.
      const closed = states.some((s) => CLOSED_STATES.has(s));
      const open = states.some((s) => !CLOSED_STATES.has(s));
      return (
        await client.list(
          {
            states: [
              ...(open ? ["OPEN" as const] : []),
              ...(closed ? ["CLOSED" as const] : []),
            ],
            assignee: identity,
          },
          OPEN_CHILDREN,
        )
      )
        .filter(({ issue }) =>
          states.includes(
            model.stateOf({ ...issue, labels: wholeLabels(issue) }),
          ),
        )
        .map(({ issue, raw }) => pool(issue, raw));
    },
  };
}

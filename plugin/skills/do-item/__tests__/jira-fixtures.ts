/**
 * Builders for the Jira adapter's tests: issues shaped as Jira Cloud's REST
 * API answers them, and a fake transport that answers each request from a
 * table keyed by method and path (`GET issue/ENG-1`), or from the test's own
 * function.
 */

import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { markdownToAdf } from "../scripts/lib/tracker/jira/adf.ts";
import { type Client, jiraClient } from "../scripts/lib/tracker/jira/client.ts";
import { jiraModel } from "../scripts/lib/tracker/jira/model.ts";
import { jiraTracker } from "../scripts/lib/tracker/jira/tracker.ts";
import type {
  JiraRequest,
  JiraTransport,
} from "../scripts/lib/tracker/jira/transport.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";

export const SITE = "https://example.atlassian.net";

export interface Call {
  /** `GET issue/ENG-1` */
  route: string;
  method: JiraRequest["method"];
  path: string;
  query: Record<string, string | number | boolean>;
  body: Record<string, unknown>;
}

export type Answer = (call: Call, n: number) => unknown;

/** The JQL a search call carries. */
export const jqlOf = (c: Call) => String(c.body.jql ?? "");

/**
 * An answer from a table of routes; a value that is a function is called
 * with the request. A route the table lacks fails the test's read.
 */
export function routes(table: Record<string, unknown>): Answer {
  return (call, n) => {
    if (!Object.hasOwn(table, call.route))
      return new Error(`unexpected request ${call.route}`);
    const v = table[call.route];
    return typeof v === "function" ? (v as Answer)(call, n) : v;
  };
}

function fakeTransport(answer: Answer): {
  transport: JiraTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (request) => {
      const call: Call = {
        route: `${request.method} ${request.path}`,
        method: request.method,
        path: request.path,
        query: request.query ?? {},
        body: (request.body ?? {}) as Record<string, unknown>,
      };
      calls.push(call);
      const out = answer(call, calls.length - 1);
      if (out instanceof Error) throw out;
      return out ?? null;
    },
  };
}

export interface IssueOptions {
  key: string;
  id?: string;
  title?: string;
  /** Markdown, sent as ADF. */
  description?: string;
  status?: string;
  statusId?: string;
  category?: "new" | "indeterminate" | "done";
  resolution?: string | null;
  resolutiondate?: string | null;
  statuscategorychangedate?: string | null;
  priority?: string | null;
  labels?: string[];
  type?: string;
  typeLevel?: number;
  subtask?: boolean;
  parent?: string | null;
  assignee?: { accountId: string; displayName: string } | null;
  fixVersions?: string[];
  links?: Array<{ type: string; outward?: string; inward?: string }>;
  created?: string;
  updated?: string;
}

/** The status categories, as Jira names them. */
const CATEGORY_NAMES = {
  new: "To Do",
  indeterminate: "In Progress",
  done: "Done",
};

const DEFAULTS = {
  status: "To Do",
  category: "new" as const,
  priority: "Medium",
  labels: [] as string[],
  type: "Task",
  subtask: false,
  fixVersions: [] as string[],
  links: [] as NonNullable<IssueOptions["links"]>,
  created: "2026-01-01T09:00:00.000+0000",
  updated: "2026-01-02T09:00:00.000+0000",
};

const linkOf = (
  l: { type: string; outward?: string; inward?: string },
  i: number,
) => ({
  id: `l${i}`,
  type: { name: l.type },
  ...(l.outward === undefined ? {} : { outwardIssue: { key: l.outward } }),
  ...(l.inward === undefined ? {} : { inwardIssue: { key: l.inward } }),
});

const parentOf = (key: string | null | undefined) =>
  key == null ? undefined : { key, fields: { summary: `Issue ${key}` } };

/** An issue as `GET issue/{key}` and `search/jql` return it. */
export function issue(given: IssueOptions): Record<string, unknown> {
  const o = { ...DEFAULTS, ...given };
  const n = o.key.split("-")[1] ?? "0";
  return {
    id: o.id ?? `100${n}`,
    key: o.key,
    self: `${SITE}/rest/api/3/issue/100${n}`,
    fields: {
      summary: o.title ?? `Issue ${o.key}`,
      description:
        o.description === undefined ? null : markdownToAdf(o.description),
      status: {
        id: o.statusId ?? `s-${o.status.replace(/\s/g, "")}`,
        name: o.status,
        statusCategory: { key: o.category, name: CATEGORY_NAMES[o.category] },
      },
      resolution: o.resolution == null ? null : { name: o.resolution },
      resolutiondate: o.resolutiondate ?? null,
      statuscategorychangedate: o.statuscategorychangedate ?? null,
      priority: o.priority === null ? null : { name: o.priority },
      labels: o.labels,
      issuetype: {
        name: o.type,
        subtask: o.subtask,
        hierarchyLevel: o.typeLevel ?? (o.subtask ? -1 : 0),
      },
      parent: parentOf(o.parent),
      subtasks: [],
      assignee: o.assignee ?? null,
      fixVersions: o.fixVersions.map((name, i) => ({ id: `v${i}`, name })),
      issuelinks: o.links.map(linkOf),
      created: o.created,
      updated: o.updated,
    },
  };
}

/** One search page holding every issue given. */
export const page = (...issues: Record<string, unknown>[]) => ({
  issues,
  isLast: true,
});

/** A comment as `GET issue/{key}/comment` returns it. */
export function comment(
  id: string,
  body: string,
  author: Record<string, unknown> | null,
  created = "2026-01-03T09:00:00.000+0000",
): Record<string, unknown> {
  return {
    id,
    ...(author === null ? {} : { author }),
    body: markdownToAdf(body),
    created,
  };
}

/** One offset page holding every comment given. */
export const comments = (...items: Record<string, unknown>[]) => ({
  comments: items,
  startAt: 0,
  maxResults: 100,
  total: items.length,
});

/** A licensed project member. */
export const MEMBER = {
  accountId: "5b10ac8d82e05b22cc7d4ef5",
  displayName: "Dana Lee",
  accountType: "atlassian",
};
/** The factory's own account. */
export const FACTORY = {
  accountId: "5b10ac8d82e05b22cc7d4ef6",
  displayName: "Jig Factory",
  accountType: "atlassian",
};
/** An app account, as Jira Automation's actor. */
export const APP = {
  accountId: "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077",
  displayName: "Automation for Jira",
  accountType: "app",
};

/** `user/assignable/search` answering for the accounts given. */
export const assignable =
  (...ids: string[]) =>
  (c: Call) =>
    ids.includes(String(c.query.accountId))
      ? [{ accountId: c.query.accountId }]
      : [];

export interface Overlay {
  issue_tracker?: Record<string, unknown>;
}

/** A Jira tracker over the fake transport, configured like an overlay. */
export function jira(
  answer: Answer,
  overlay: Overlay = {},
): { t: Tracker; calls: Call[]; client: Client } {
  const config = parseTrackerConfig({
    issue_tracker: {
      adapter: "jira",
      team: "ENG",
      ...overlay.issue_tracker,
      jira: {
        site: SITE,
        ...((overlay.issue_tracker?.jira as Record<string, unknown>) ?? {}),
      },
    },
  });
  const f = fakeTransport(answer);
  const client = jiraClient({
    project: "ENG",
    site: SITE,
    model: jiraModel(config.states, config.jira),
    settings: config.jira,
    transport: f.transport,
  });
  return { t: jiraTracker(client), calls: f.calls, client };
}

/** The requests that write, as routes. */
export const writes = (calls: Call[]) =>
  calls
    .filter((c) => c.method !== "GET" && c.path !== "search/jql")
    .map((c) => c.route);

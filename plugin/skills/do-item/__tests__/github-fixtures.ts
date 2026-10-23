/**
 * Builders for the GitHub adapter's tests: issue nodes shaped as GitHub's
 * GraphQL answers them, and a fake transport that answers each request from
 * the test's own function, keyed by the operation's name.
 */

import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { gitHubClient } from "../scripts/lib/tracker/github/client.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { gitHubTracker } from "../scripts/lib/tracker/github/tracker.ts";
import type { GitHubTransport } from "../scripts/lib/tracker/github/transport.ts";
import type { Tracker } from "../scripts/lib/tracker/port.ts";

const HOME = { owner: "acme", name: "app" };
const BOARD_URL = "https://github.com/orgs/acme/projects/7";

export interface Call {
  /** The operation's name: `TrackerIssue`, `TrackerClose`, … */
  op: string;
  query: string;
  variables: Record<string, unknown>;
}

function fakeTransport(answer: (call: Call, n: number) => unknown): {
  transport: GitHubTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    transport: async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      const call = { op, query, variables };
      calls.push(call);
      const out = answer(call, calls.length - 1);
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

export const conn = (nodes: unknown[], next: string | null = null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes,
});

const labelConn = (...names: string[]) => conn(names.map((name) => ({ name })));

export interface NodeOptions {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  repo?: string;
  assignee?: string | null;
  milestone?: string | null;
  parent?: number | null;
  /** Project mode: the issue's option on the board; `undefined` = not on it. */
  status?: string | null | undefined;
  extra?: Record<string, unknown>;
}

const orNull = <T, U>(v: T | null | undefined, f: (v: T) => U): U | null =>
  v === undefined || v === null ? null : f(v);

/** The board items of an issue: one on the board, or none. */
function boardItems(o: NodeOptions) {
  if (o.status === undefined) return conn([]);
  return conn([
    {
      id: `PVTI_${o.number}`,
      updatedAt: "2026-01-03T00:00:00Z",
      project: { url: BOARD_URL },
      fieldValueByName: o.status === null ? {} : { name: o.status },
    },
  ]);
}

/** An issue node as `issueFields` reads it. */
export function issueNode(o: NodeOptions): Record<string, unknown> {
  const repo = o.repo ?? `${HOME.owner}/${HOME.name}`;
  return {
    id: `I_${o.number}`,
    number: o.number,
    title: o.title ?? `Issue ${o.number}`,
    body: o.body ?? "",
    url: `https://github.com/${repo}/issues/${o.number}`,
    createdAt: o.createdAt ?? "2026-01-01T00:00:00Z",
    updatedAt: o.updatedAt ?? "2026-01-02T00:00:00Z",
    closedAt: o.closedAt ?? null,
    state: o.state ?? "OPEN",
    stateReason: o.stateReason ?? null,
    repository: { nameWithOwner: repo },
    labels: labelConn(...(o.labels ?? [])),
    assignees: {
      nodes: orNull(o.assignee, (login) => [{ id: `U_${login}`, login }]) ?? [],
    },
    milestone: orNull(o.milestone, (title) => ({ title })),
    parent: orNull(o.parent, (number) => ({
      number,
      title: `Issue ${number}`,
      repository: { nameWithOwner: repo },
    })),
    projectItems: boardItems(o),
    ...o.extra,
  };
}

/** An answer to `TrackerIssue` holding one issue, or none. */
export const oneIssue = (node: Record<string, unknown> | null) => ({
  repository: { issue: node },
});

/** An answer to `TrackerLabels` with the repository's labels. */
export const repoLabels = (...names: string[]) => ({
  repository: {
    labels: conn(names.map((name, i) => ({ id: `LA_${i}_${name}`, name }))),
  },
});

export interface TrackerOptions {
  issue_tracker?: Record<string, unknown>;
}

/** A GitHub tracker over the fake transport, configured like an overlay. */
export function gitHub(
  answer: (call: Call, n: number) => unknown,
  overlay: TrackerOptions = {},
): { t: Tracker; calls: Call[] } {
  const config = parseTrackerConfig({
    issue_tracker: {
      adapter: "github",
      ...overlay.issue_tracker,
      github: {
        repository: `${HOME.owner}/${HOME.name}`,
        ...((overlay.issue_tracker?.github as Record<string, unknown>) ?? {}),
      },
    },
  });
  const f = fakeTransport(answer);
  return {
    t: gitHubTracker(
      gitHubClient({
        home: HOME,
        model: gitHubModel(config.states, config.github),
        settings: config.github,
        transport: f.transport,
      }),
    ),
    calls: f.calls,
  };
}

/** The overlay of a tracker that keeps its open states on a board. */
export const ON_BOARD: TrackerOptions = {
  issue_tracker: { github: { states_from: "project", project: BOARD_URL } },
};

/** An answer to `TrackerBoard` with the status field's options. */
export const boardAnswer = (...options: string[]) => ({
  organization: {
    projectV2: {
      id: "PVT_7",
      field: {
        id: "PVTSSF_status",
        options: options.map((name, i) => ({ id: `opt_${i}`, name })),
      },
    },
  },
});

/** The mutations a fake run received, by operation name. */
export const writes = (calls: Call[]) =>
  calls
    .filter((c) => c.query.trimStart().startsWith("mutation"))
    .map((c) => c.op);

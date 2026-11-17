/** Bounded native reads; queue snapshots and coalescing belong to the shared reader. */
import { batch } from "../../../../../../shared/outbound/batch.ts";
import { createHash } from "node:crypto";
import { parseMs } from "../../../../../../shared/time.ts";
import type { Client } from "./client.ts";
import { keyOf, repoOf, slug, type Repo } from "./refs.ts";
import { record, str } from "./read.ts";
import { GitHubApiError } from "./transport.ts";
import { readSignal, refuseStopped } from "../facets/bounds.ts";
import type {
  ChangeAnswer,
  DispatchRawIssue,
  DispatchSource,
  Tracker,
} from "../port.ts";

/** At most 20 issues and 10,000 objects, including the scope's selected board fields. */
const ISSUE_BATCH = 20;
const OBJECT_CEILING = 10_000;
/** One repository per probe: at most 100 issues, one assignee and 20 labels each, under 4,000 objects. */
const PROBE_PAGE = 100;

export function issueBatch(
  client: Client,
  fields: () => string,
  wrap: (value: unknown, signal?: AbortSignal) => Promise<DispatchRawIssue>,
): NonNullable<DispatchSource["issues"]> {
  return async (keys, options) => {
    const signal = readSignal(options);
    refuseStopped(signal);
    const selection = fields();
    // 450 covers the issue, labels, assignee, children, dependency links, native values
    // and project items; each selected board value adds at most one object per
    // project item (first: 20).
    const objects =
      450 + 20 * (selection.match(/\bdispatchStatus[0-9a-f]+:/g)?.length ?? 0);
    if (objects > OBJECT_CEILING)
      throw new GitHubApiError(
        "dispatch batch selectors exceed the object ceiling",
        { code: "too-costly" },
      );
    const cap = Math.min(ISSUE_BATCH, Math.floor(OBJECT_CEILING / objects));
    const canonical = new Map(
      keys.map((key) => [
        key,
        keyOf(client.ref(key), client.home).toLowerCase(),
      ]),
    );
    const rows = await batch([...canonical.values()], cap, async (chunk) => {
      refuseStopped(signal);
      const variables: Record<string, unknown> = {};
      const declarations: string[] = [];
      const selections = chunk.map((key, i) => {
        const ref = client.ref(key);
        declarations.push(
          `$owner${i}: String!, $name${i}: String!, $number${i}: Int!`,
        );
        Object.assign(variables, {
          [`owner${i}`]: ref.owner,
          [`name${i}`]: ref.name,
          [`number${i}`]: ref.number,
        });
        return `i${i}: repository(owner: $owner${i}, name: $name${i}) { issue(number: $number${i}) { ${selection} } }`;
      });
      const data = record(
        await client.transport(
          `query TrackerDispatchIssues(${declarations.join(", ")}) { rateLimit { cost remaining resetAt limit } ${selections.join("\n")} }`,
          variables,
          signal,
          true,
        ),
        "dispatch batch response",
      );
      return Promise.all(
        chunk.map(async (key, i) => {
          const raw = record(data[`i${i}`], "dispatch batch repository").issue;
          if (raw === null)
            throw new GitHubApiError(
              `dispatch batch issue ${key} is inaccessible`,
              { code: "not-found" },
            );
          const row = await wrap(raw, signal);
          if (row.identifier.toLowerCase() !== key)
            throw new GitHubApiError(
              `dispatch batch issue ${key}: response identity differs`,
            );
          return [key, row] as const;
        }),
      );
    });
    const found = new Map(rows);
    return new Map(
      [...canonical].map(([key, id]) => {
        const row = found.get(id);
        if (row === undefined)
          throw new GitHubApiError(
            `dispatch batch issue ${id}: missing answer`,
          );
        return [key, row];
      }),
    );
  };
}

interface ProbePage {
  nodes: unknown[];
  complete: boolean;
}

function probePage(value: unknown, where: string): ProbePage {
  const connection = record(value, where);
  if (!Array.isArray(connection.nodes))
    throw new GitHubApiError(`${where}: nodes missing`);
  return {
    nodes: connection.nodes,
    complete:
      record(connection.pageInfo, `${where}.pageInfo`).hasNextPage === false,
  };
}

async function readChanges(
  client: Client,
  repo: Repo,
  since: string,
  signal?: AbortSignal,
): Promise<ProbePage> {
  refuseStopped(signal);
  const data = record(
    await client.transport(
      `query TrackerDispatchChanges($owner: String!, $name: String!, $since: DateTime!) {
      rateLimit { cost remaining resetAt limit }
      repository(owner: $owner, name: $name) {
        issues(first: ${PROBE_PAGE}, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage } nodes {
            number updatedAt state stateReason
            labels(first: 20) { pageInfo { hasNextPage } nodes { name } }
            assignees(first: 1) { pageInfo { hasNextPage } nodes { login } }
            parent { number repository { nameWithOwner } }
          }
        }
      }
    }`,
      { ...repo, since },
      signal,
      true,
    ),
    "dispatch change response",
  );
  return probePage(
    record(data.repository, "dispatch change repository").issues,
    "dispatch changes",
  );
}

function issueNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new GitHubApiError("dispatch change: invalid issue number");
  return value;
}

function parentKey(value: unknown, home: Repo): string | null {
  if (value === null) return null;
  const raw = record(value, "dispatch change.parent");
  const repository = str(
    record(raw.repository, "dispatch change.parent.repository").nameWithOwner,
    "dispatch change.parent.repository.nameWithOwner",
  );
  return keyOf(
    { ...repoOf(repository), number: issueNumber(raw.number) },
    home,
  );
}

interface Change {
  key: string;
  time: string;
  assignees: string[];
  parent: string | null;
  complete: boolean;
  boundaryToken: string;
}

function changeRow(value: unknown, repo: Repo, home: Repo): Change {
  const row = record(value, "dispatch change");
  const time = str(row.updatedAt, "dispatch change.updatedAt");
  if (!Number.isFinite(parseMs(time)))
    throw new GitHubApiError("dispatch change: invalid update time");
  const assignees = probePage(row.assignees, "dispatch change.assignees");
  const labels = probePage(row.labels, "dispatch change.labels");
  const names = assignees.nodes
    .map((node) =>
      str(
        record(node, "dispatch assignee").login,
        "dispatch assignee.login",
      ).toLowerCase(),
    )
    .sort((a, b) => a.localeCompare(b));
  const parent = parentKey(row.parent, home);
  const key = keyOf({ ...repo, number: issueNumber(row.number) }, home);
  const values = [
    names,
    parent,
    str(row.state, "dispatch change.state"),
    row.stateReason === null
      ? null
      : str(row.stateReason, "dispatch change.stateReason"),
    labels.nodes
      .map((node) =>
        str(record(node, "dispatch label").name, "dispatch label.name"),
      )
      .sort((a, b) => a.localeCompare(b)),
  ];
  return {
    key,
    time,
    assignees: names,
    parent,
    complete: assignees.complete && labels.complete,
    boundaryToken: `${key}:${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`,
  };
}

function affectedKeys(
  row: Change,
  watched: ReadonlyMap<string, string[]>,
  people: ReadonlySet<string>,
): string[] {
  const own = watched.get(row.key.toLowerCase());
  const parent =
    row.parent === null ? undefined : watched.get(row.parent.toLowerCase());
  if (
    own === undefined &&
    parent === undefined &&
    !row.assignees.some((name) => people.has(name))
  )
    return [];
  return [...(own ?? [row.key]), ...(parent ?? [])];
}

interface ProbeContext {
  home: Repo;
  sinceMs: number;
  includeBoundary: boolean;
  boundaryRows: ReadonlySet<string>;
  watched: ReadonlyMap<string, string[]>;
  people: ReadonlySet<string>;
}

interface PageChanges {
  keys: string[];
  complete: boolean;
  latest: string | null;
  boundaryRowKeys: string[];
}

function unseenAtBoundary(row: Change, context: ProbeContext): boolean {
  const time = parseMs(row.time);
  return (
    time >= context.sinceMs &&
    (time !== context.sinceMs ||
      (context.includeBoundary && !context.boundaryRows.has(row.boundaryToken)))
  );
}

function pageChanges(
  page: ProbePage,
  repo: Repo,
  context: ProbeContext,
): PageChanges {
  const incomplete = {
    keys: [],
    complete: false,
    latest: null,
    boundaryRowKeys: [],
  };
  if (!page.complete) return incomplete;
  const changed = new Set<string>();
  const boundaryRows = new Set<string>();
  let latest: string | null = null;
  for (const value of page.nodes) {
    const row = changeRow(value, repo, context.home);
    if (!row.complete) return incomplete;
    // IssueFilters.since includes its boundary. Retain the rows seen there so
    // a later row sharing its timestamp is not silently skipped.
    if (parseMs(row.time) < context.sinceMs) continue;
    if (latest === null || parseMs(row.time) > parseMs(latest)) {
      latest = row.time;
      boundaryRows.clear();
    }
    if (parseMs(row.time) === parseMs(latest))
      boundaryRows.add(row.boundaryToken);
    if (!unseenAtBoundary(row, context)) continue;
    const keys = affectedKeys(row, context.watched, context.people);
    if (keys.length === 0) continue;
    keys.forEach((key) => {
      changed.add(key);
    });
  }
  return {
    keys: [...changed],
    complete: true,
    latest,
    boundaryRowKeys: [...boundaryRows],
  };
}

/** Repository updates avoid search-index lag. Untimestamped link/board edits require the scheduled full refresh. */
export function changeProbe(
  client: Client,
): NonNullable<Tracker["changedSince"]> {
  return async (query, signal) => {
    refuseStopped(signal);
    // Sequential repository reads have independent source-clock boundaries.
    // Advancing one repository must never hide another repository's update.
    const watermarks: Record<string, string> = {};
    const boundaryRows: Record<string, string[]> = {};
    const watched = new Map<string, string[]>();
    for (const key of query.keys) {
      const id = keyOf(client.ref(key), client.home).toLowerCase();
      watched.set(id, [...(watched.get(id) ?? []), key]);
    }
    const people = new Set(
      [query.identity, ...(query.identities ?? [])].map((name) =>
        name.toLowerCase(),
      ),
    );
    const repositories = new Set([
      slug(client.home).toLowerCase(),
      ...query.keys.map((key) => slug(client.ref(key)).toLowerCase()),
    ]);
    const changed = new Set<string>();
    for (const name of repositories) {
      const repo = repoOf(name);
      const since = query.watermarks?.[name] ?? query.since;
      const page = await readChanges(client, repo, since, signal);
      const answer = pageChanges(page, repo, {
        home: client.home,
        sinceMs: parseMs(since),
        includeBoundary: query.boundaryRows !== undefined,
        boundaryRows: new Set(query.boundaryRows?.[name] ?? []),
        watched,
        people,
      });
      if (!answer.complete) return answer;
      answer.keys.forEach((key) => {
        changed.add(key);
      });
      watermarks[name] =
        answer.latest !== null && parseMs(answer.latest) > parseMs(since)
          ? answer.latest
          : since;
      // A complete inclusive page carries the current facts at its boundary.
      // Keeping superseded facts would hide a mutation back to an earlier value.
      boundaryRows[name] = answer.boundaryRowKeys;
    }
    return {
      keys: [...changed],
      complete: true,
      latest:
        Object.values(watermarks).sort((a, b) => parseMs(a) - parseMs(b))[0] ??
        null,
      watermarks,
      boundaryRows,
    } satisfies ChangeAnswer;
  };
}

/** Native issue readings shared by every checkout that files into this repository. */
import { createHash } from "node:crypto";
import { isRecord } from "../../../../../../shared/guards.ts";
import { credentialKey } from "../../../../../../shared/outbound/budget.ts";
import type { CorePoolIssue, CoreTracker } from "../facets/tracker.ts";
import { readSignal, refuseStopped } from "../facets/bounds.ts";
import type {
  FacetReadOptions,
  DispatchRawIssue,
  IssueRelation,
} from "../port.ts";
import { demandOf } from "../dispatch-source.ts";
import type { Client } from "./client.ts";
import { issueFields, onePage, record, str } from "./read.ts";
import { credentialToken, GitHubApiError, pageAll } from "./transport.ts";
import { issueBatch } from "./dispatch-reads.ts";
import { assignmentActor, canWrite } from "./assigner.ts";
import { keyOf, repoOf, type Repo } from "./refs.ts";

const FIELD_NODES = `nodes {
  __typename
  ... on IssueFieldSingleSelectValue { id name field { ... on IssueFieldSingleSelect { name } } }
  ... on IssueFieldNumberValue { id value field { ... on IssueFieldNumber { name } } }
  ... on IssueFieldTextValue { id value field { ... on IssueFieldText { name } } }
  ... on IssueFieldDateValue { id }
  ... on IssueFieldMultiSelectValue { id }
}`;

/** An alias depends only on the field name, so another checkout can interpret it. */
const statusAlias = (name: string) =>
  `dispatchStatus${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

/** The union of stores the scope's checkouts actually need. */
function fieldsOf(requirements: ReadonlySet<string>): string {
  const statuses = [...requirements]
    .filter((name) => name.startsWith("board:"))
    .map((name) => name.slice(6));
  const board =
    statuses.length === 0
      ? ""
      : `projectItems(first: 20) { pageInfo { hasNextPage } nodes {
    id updatedAt project { url }
    ${statuses.map((name) => `${statusAlias(name)}: fieldValueByName(name: ${JSON.stringify(name)}) { ... on ProjectV2ItemFieldSingleSelectValue { name } }`).join("\n")}
  } }`;
  return `${issueFields(null)}
    ${requirements.has("issue-type") ? "issueType { name }" : ""}
    ${requirements.has("issue-fields") ? `issueFieldValues(first: 25) { pageInfo { hasNextPage } ${FIELD_NODES} }` : ""}
    ${board}
    subIssues(first: 100) { pageInfo { hasNextPage } nodes { state } }
    ${DEPENDENCIES}`;
}

/** The dependency links dispatch acts on, carried with each row; a longer list is read on its own. */
const LINKS = 25;
const DEPENDENCIES = ["blockedBy", "blocking"]
  .map(
    (field) =>
      `${field}(first: ${LINKS}) { pageInfo { hasNextPage } nodes { number repository { nameWithOwner } } }`,
  )
  .join("\n    ");

/** One dependency list of a row as relations; `null` when the row does not carry it whole. */
function links(
  value: Record<string, unknown>,
  field: "blockedBy" | "blocking",
  home: Repo,
): IssueRelation[] | null {
  const list = value[field];
  if (!isRecord(list) || !Array.isArray(list.nodes)) return null;
  if (!isRecord(list.pageInfo) || list.pageInfo.hasNextPage !== false)
    return null;
  return list.nodes.map((node) => {
    const link = record(node, `dispatch issue.${field}`);
    const repository = record(
      link.repository,
      `dispatch issue.${field}.repository`,
    );
    return {
      type: field === "blockedBy" ? "blocked_by" : "blocks",
      issue: keyOf(
        {
          ...repoOf(
            str(
              repository.nameWithOwner,
              `dispatch issue.${field}.repository.nameWithOwner`,
            ),
          ),
          number: Number(link.number),
        },
        home,
      ),
    };
  });
}

/**
 * The dependency links a row carries (`blocked_by`, `blocks`), the only
 * relations dispatch acts on; `null` for a row read without them, or with
 * more than one page of either.
 */
export function rowDependencies(
  value: Record<string, unknown>,
  home: Repo,
): IssueRelation[] | null {
  const blockedBy = links(value, "blockedBy", home);
  const blocking = links(value, "blocking", home);
  return blockedBy === null || blocking === null
    ? null
    : [...blockedBy, ...blocking];
}

/** A row's description and its parent's key, from the fields every row carries. */
function rowDescription(
  value: Record<string, unknown>,
  home: Repo,
): { description: string; parent: string | null } | null {
  if (typeof value.body !== "string" || !("parent" in value)) return null;
  if (value.parent === null) return { description: value.body, parent: null };
  if (!isRecord(value.parent)) return null;
  const repository = record(
    value.parent.repository,
    "dispatch issue.parent.repository",
  );
  return {
    description: value.body,
    parent: keyOf(
      {
        ...repoOf(
          str(
            repository.nameWithOwner,
            "dispatch issue.parent.repository.nameWithOwner",
          ),
        ),
        number: Number(value.parent.number),
      },
      home,
    ),
  };
}

/** Adapt the native project fields to the ordinary issue parser's selected field. */
export function projectStatus(
  raw: Record<string, unknown>,
  client: Client,
): Record<string, unknown> {
  const board = client.ctx.board;
  if (board === null) return raw;
  const items = record(raw.projectItems, "dispatch issue.projectItems");
  return {
    ...raw,
    projectItems: {
      ...items,
      nodes: onePage(items, "dispatch issue.projectItems").map((value) => {
        const item = record(value, "dispatch project item");
        const selected = item[statusAlias(board.statusField)];
        return { ...item, fieldValueByName: selected ?? null };
      }),
    },
  };
}

export function dispatchSource(
  client: Client,
  project: (
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<CorePoolIssue>,
): NonNullable<CoreTracker["dispatchSource"]> {
  const variables = { owner: client.home.owner, name: client.home.name };
  const requirements = [
    ...(client.facets.fields.includes("issueType") ? ["issue-type"] : []),
    ...(client.facets.fields.includes("issueFieldValues")
      ? ["issue-fields"]
      : []),
    ...(client.ctx.board === null
      ? []
      : [`board:${client.ctx.board.statusField}`]),
  ];
  const demand = demandOf(requirements);
  const fields = () => fieldsOf(demand.selectors);
  const wrap = async (
    value: unknown,
    signal?: AbortSignal,
  ): Promise<DispatchRawIssue> => {
    refuseStopped(signal);
    const raw = record(value, "dispatch issue");
    const repository = record(raw.repository, "dispatch issue.repository");
    const home = `${client.home.owner}/${client.home.name}`;
    const repositoryName = str(
      repository.nameWithOwner,
      "dispatch issue.repository.nameWithOwner",
    );
    if (
      typeof raw.number !== "number" ||
      !Number.isInteger(raw.number) ||
      raw.number <= 0
    )
      throw new GitHubApiError(
        "dispatch issue.number: expected a positive integer",
      );
    const prefix =
      repositoryName.toLowerCase() === home.toLowerCase() ? "" : repositoryName;
    const identifier = `${prefix}#${Number(raw.number)}`;
    const values = raw.issueFieldValues;
    if (values !== null && values !== undefined) {
      const connection = record(values, "dispatch issue.issueFieldValues");
      const info = record(
        connection.pageInfo,
        "dispatch issue.issueFieldValues.pageInfo",
      );
      if (info.hasNextPage === true) {
        const ref = client.ref(identifier);
        const nodes = await pageAll(
          client.transport,
          `query TrackerDispatchFieldValues($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) { issue(number: $number) {
            issueFieldValues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } ${FIELD_NODES} }
          } }
        }`,
          { owner: ref.owner, name: ref.name, number: ref.number },
          (data) =>
            record(
              record(data.repository, "dispatch field repository").issue,
              "dispatch field issue",
            ).issueFieldValues,
          "the native issue field values",
          signal,
        );
        return {
          identifier,
          value: {
            ...raw,
            issueFieldValues: { pageInfo: { hasNextPage: false }, nodes },
          },
        };
      }
    }
    return { identifier, value: raw };
  };
  async function issue(
    key: string,
    options?: FacetReadOptions,
  ): Promise<DispatchRawIssue | null> {
    const signal = readSignal(options);
    refuseStopped(signal);
    const ref = client.ref(key);
    let answer: unknown;
    try {
      answer = await client.transport(
        `query TrackerDispatchIssue($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { ${fields()} } }
    }`,
        { owner: ref.owner, name: ref.name, number: ref.number },
        signal,
        true,
      );
    } catch (error) {
      if (
        error instanceof GitHubApiError &&
        error.notFound &&
        isRecord(error.data) &&
        isRecord(error.data.repository)
      )
        return null;
      throw error;
    }
    const data = record(answer, "dispatch issue response");
    const raw = record(data.repository, "dispatch issue repository").issue;
    return raw === null ? null : wrap(raw, signal);
  }
  return {
    requirements,
    shareReads: (reads) => client.shareReads(reads),
    configure: (union) => demand.configure(union),
    get shape() {
      return demand.shape;
    },
    async credential(options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const token = await credentialToken()();
      refuseStopped(signal);
      return credentialKey("github", token ?? "unavailable");
    },
    async queue(identity, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const nodes = await pageAll(
        client.transport,
        `query TrackerDispatchQueue($owner: String!, $name: String!, $identity: String!, $after: String) {
        repository(owner: $owner, name: $name) { issues(first: 100, after: $after, states: [OPEN${demand.selectors.has("queue-closed") ? ", CLOSED" : ""}], filterBy: {assignee: $identity}) {
          pageInfo { hasNextPage endCursor } nodes { ${fields()} }
        } }
      }`,
        { ...variables, identity },
        (data) => record(data.repository, "dispatch queue repository").issues,
        "the native assigned queue",
        signal,
      );
      return Promise.all(nodes.map((value) => wrap(value, signal)));
    },
    issue,
    issues: issueBatch(client, fields, wrap),
    async projectRelations(raw, options) {
      refuseStopped(readSignal(options));
      return rowDependencies(
        record(raw.value, "dispatch native issue"),
        client.home,
      );
    },
    describe: (raw) =>
      rowDescription(record(raw.value, "dispatch native issue"), client.home),
    assignmentActor: (key, assignee, options) =>
      assignmentActor(client, key, assignee, readSignal(options)),
    writeAccess: (person, options) =>
      canWrite(client, person, readSignal(options)),
    async children(key, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const ref = client.ref(key);
      const nodes = await pageAll(
        client.transport,
        `query TrackerDispatchChildren($owner: String!, $name: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor } nodes { ${fields()} }
        } } }
      }`,
        { owner: ref.owner, name: ref.name, number: ref.number },
        (data) =>
          record(
            record(data.repository, "dispatch children repository").issue,
            "dispatch children issue",
          ).subIssues,
        "the native children",
        signal,
      );
      return Promise.all(
        nodes
          .filter((value) => record(value, "dispatch child").state === "OPEN")
          .map((value) => wrap(value, signal)),
      );
    },
    project(raw, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      return project(
        projectStatus(record(raw.value, "dispatch native issue"), client),
        signal,
      );
    },
  };
}

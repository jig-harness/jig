/** Native issue readings shared by every checkout that files into this repository. */
import { createHash } from "node:crypto";
import { isRecord } from "../../../../../../shared/guards.ts";
import { credentialKey } from "../../../../../../shared/tracker-budget.ts";
import type { CorePoolIssue, CoreTracker } from "../facets/tracker.ts";
import { readSignal, refuseStopped } from "../facets/bounds.ts";
import type { FacetReadOptions, DispatchRawIssue } from "../port.ts";
import type { Client } from "./client.ts";
import { issueFields, onePage, record, str } from "./read.ts";
import { credentialToken, GitHubApiError, pageAll } from "./transport.ts";

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
    subIssues(first: 100) { pageInfo { hasNextPage } nodes { state } }`;
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
  let demanded = new Set(requirements);
  const fields = () => fieldsOf(demanded);
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
    configure(union) {
      demanded = new Set([...demanded, ...union]);
    },
    get shape() {
      return JSON.stringify([...demanded].sort());
    },
    async credential() {
      const token = await credentialToken()();
      return credentialKey("github", token ?? "unavailable");
    },
    async queue(identity, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const nodes = await pageAll(
        client.transport,
        `query TrackerDispatchQueue($owner: String!, $name: String!, $identity: String!, $after: String) {
        repository(owner: $owner, name: $name) { issues(first: 100, after: $after, states: [OPEN${demanded.has("queue-closed") ? ", CLOSED" : ""}], filterBy: {assignee: $identity}) {
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

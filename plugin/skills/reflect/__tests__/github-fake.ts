/**
 * A local fake of the GitHub GraphQL operations the GitHub store sends, for
 * its tests. It keeps one repository's labels, issues and comments in
 * memory and answers each request by its operation name, as GitHub does
 * where the store depends on it: bearer tokens, `first` between 1 and 100,
 * cursor paging, issues filtered by label and ordered by creation, the
 * author association of every issue and comment, and GitHub's limit on the
 * length of a body.
 */
import { randomUUID } from "node:crypto";

type Json = Record<string, unknown>;

export interface FakeComment {
  id: string;
  url: string;
  body: string;
  login: string;
  association: string;
}

export interface FakeIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  createdAt: string;
  association: string;
  labels: Set<string>;
  comments: FakeComment[];
}

interface Failure {
  operation: string;
  status: number;
  message: string;
  retryAfter?: number;
}

interface Partial {
  operation: string;
  /** GraphQL errors beside the data, as GitHub sends for a part it could not read. */
  errors?: Json[];
  /** Report more comments with no cursor to them. */
  noCursor?: boolean;
}

const MAX_BODY = 65_536;

/** The operation name a GraphQL document opens with. */
function operationOf(query: string | undefined): string {
  return /^\s*(?:query|mutation)\s+(\w+)/.exec(query ?? "")?.[1] ?? "";
}

/** Take the first queued entry for `operation` off the queue. */
function takeFor<T extends { operation: string }>(
  queue: T[],
  operation: string,
): T | undefined {
  const index = queue.findIndex((entry) => entry.operation === operation);
  return index < 0 ? undefined : queue.splice(index, 1)[0];
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class GraphQLError extends Error {
  readonly type: string;
  constructor(type: string, message: string) {
    super(message);
    this.type = type;
  }
}

export class FakeGitHub {
  readonly token = "ghp_fake_token";
  readonly owner = "example";
  readonly name = "reflections";
  readonly server: ReturnType<typeof Bun.serve>;
  readonly labels = new Map<string, string>([["bug", "LA_bug"]]);
  readonly issues: FakeIssue[] = [];
  /** Operation names, in the order they came. */
  readonly requests: string[] = [];
  hasIssuesEnabled = true;
  isArchived = false;
  viewerPermission = "ADMIN";
  viewerCanCreateIssues = true;
  /** The viewer's login, and how GitHub associates it with the repository. */
  viewer = { login: "store-writer", association: "OWNER" };
  /** The largest page a connection returns, to exercise cursors. */
  pageSize = 100;
  private nextNumber = 1;
  private nextComment = 1000;
  private clock = Date.parse("2026-10-20T09:00:00Z");
  private failures: Failure[] = [];
  private partials: Partial[] = [];

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}/graphql`;
  }

  get repository(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The environment a store command talks to this fake in. */
  env(base: Record<string, string>): Record<string, string> {
    return {
      ...base,
      GH_TOKEN: this.token,
      JIG_GITHUB_GRAPHQL_URL: this.url,
      JIG_GITHUB_INTERVAL_MS: "0",
    };
  }

  stop(): void {
    this.server.stop(true);
  }

  /** Create the store's label, as `gh label create` would. */
  addStoreLabel(name = "jig-reflection"): void {
    this.labels.set(name, `LA_${randomUUID()}`);
  }

  /** Answer the next request of `operation` with an HTTP error. */
  failNext(
    operation: string,
    status: number,
    message = "Server Error",
    retryAfter?: number,
  ): void {
    this.failures.push({
      operation,
      status,
      message,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }

  /** Answer the next request of `operation` with only part of what it asked. */
  partialNext(partial: Partial): void {
    this.partials.push(partial);
  }

  countRequests(operation: string): number {
    return this.requests.filter((name) => name === operation).length;
  }

  /** An issue carrying `label`, created by someone with `association`. */
  addIssue(
    title: string,
    body: string,
    association = "OWNER",
    labels = ["jig-reflection"],
  ): FakeIssue {
    const number = this.nextNumber++;
    const issue: FakeIssue = {
      id: `I_${randomUUID()}`,
      number,
      url: `https://github.com/${this.repository}/issues/${number}`,
      title,
      body,
      createdAt: this.tick(),
      association,
      labels: new Set(labels),
      comments: [],
    };
    this.issues.push(issue);
    return issue;
  }

  /** A comment on `issue` by `login`, associated with the repository as `association`. */
  addComment(
    issue: FakeIssue,
    body: string,
    login: string,
    association: string,
  ): FakeComment {
    const id = `IC_${randomUUID()}`;
    const comment: FakeComment = {
      id,
      url: `${issue.url}#issuecomment-${this.nextComment++}`,
      body,
      login,
      association,
    };
    issue.comments.push(comment);
    return comment;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private async handle(request: Request): Promise<Response> {
    if (request.headers.get("authorization") !== `bearer ${this.token}`)
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    const body = (await request.json()) as {
      query?: string;
      variables?: Json;
    };
    const operation = operationOf(body.query);
    this.requests.push(operation);
    return (
      this.failure(operation) ?? this.respond(operation, body.variables ?? {})
    );
  }

  /** The HTTP error queued for `operation`, if one is. */
  private failure(operation: string): Response | null {
    const f = takeFor(this.failures, operation);
    if (f === undefined) return null;
    const headers: Record<string, string> =
      f.retryAfter === undefined ? {} : { "Retry-After": String(f.retryAfter) };
    return Response.json({ message: f.message }, { status: f.status, headers });
  }

  private respond(operation: string, variables: Json): Response {
    try {
      return this.answered(operation, this.answer(operation, variables));
    } catch (error) {
      if (!(error instanceof GraphQLError)) throw error;
      return Response.json({
        data: null,
        errors: [{ type: error.type, message: error.message }],
      });
    }
  }

  /** The data, cut as a queued partial answer for `operation` says. */
  private answered(operation: string, data: Json): Response {
    const p = takeFor(this.partials, operation);
    if (p?.noCursor) this.dropCursors(data);
    return Response.json(p?.errors ? { data, errors: p.errors } : { data });
  }

  /** Say there is more of every connection, without a cursor to it. */
  private dropCursors(value: unknown): void {
    if (Array.isArray(value)) for (const item of value) this.dropCursors(item);
    else if (isObject(value))
      for (const [key, item] of Object.entries(value))
        if (key === "pageInfo" && isObject(item)) {
          item.hasNextPage = true;
          item.endCursor = null;
        } else this.dropCursors(item);
  }

  private answer(operation: string, v: Json): Json {
    switch (operation) {
      case "JigReflectionRepository":
        return { repository: this.repositoryObject(v) };
      case "JigReflectionIssues":
        return { repository: this.issuesPage(v) };
      case "JigReflectionComments": {
        const issue = this.issues.find((i) => i.id === v.id);
        return {
          node:
            issue === undefined
              ? null
              : { comments: this.commentsPage(issue, v.first, v.after) },
        };
      }
      case "JigReflectionCreateIssue":
        return { createIssue: { issue: this.createIssue(v.input) } };
      case "JigReflectionAddComment":
        return { addComment: { commentEdge: { node: this.comment(v.input) } } };
      case "JigReflectionUpdateIssue":
        return { updateIssue: { issue: this.updateIssue(v.input) } };
      default:
        throw new GraphQLError("UNKNOWN", `unknown operation ${operation}`);
    }
  }

  private checkRepository(v: Json): void {
    if (v.owner !== this.owner || v.name !== this.name)
      throw new GraphQLError(
        "NOT_FOUND",
        `Could not resolve to a Repository with the name '${String(v.owner)}/${String(v.name)}'.`,
      );
  }

  private repositoryObject(v: Json): Json {
    this.checkRepository(v);
    const label = this.labels.get(String(v.label));
    return {
      id: "R_fake",
      nameWithOwner: this.repository,
      url: `https://github.com/${this.repository}`,
      hasIssuesEnabled: this.hasIssuesEnabled,
      isArchived: this.isArchived,
      viewerPermission: this.viewerPermission,
      viewerCanCreateIssues: this.viewerCanCreateIssues,
      label: label === undefined ? null : { id: label },
    };
  }

  private page<T>(
    items: T[],
    first: unknown,
    after: unknown,
  ): { items: T[]; pageInfo: Json } {
    if (typeof first !== "number" || first < 1 || first > 100)
      throw new GraphQLError("ARGUMENT", "`first` must be between 1 and 100");
    const take = Math.min(first, this.pageSize);
    const start = typeof after === "string" ? Number(after.slice(7)) : 0;
    const end = start + take;
    return {
      items: items.slice(start, end),
      pageInfo: {
        hasNextPage: end < items.length,
        endCursor: end < items.length ? `cursor:${end}` : null,
      },
    };
  }

  private commentsPage(issue: FakeIssue, first: unknown, after: unknown): Json {
    const { items, pageInfo } = this.page(issue.comments, first, after);
    return {
      nodes: items.map((c) => ({
        id: c.id,
        url: c.url,
        body: c.body,
        authorAssociation: c.association,
        author: { login: c.login },
      })),
      pageInfo,
    };
  }

  private issuesPage(v: Json): Json {
    this.checkRepository(v);
    const labels = Array.isArray(v.labels) ? v.labels.map(String) : [];
    const matching = this.issues.filter((issue) =>
      labels.every((label) => issue.labels.has(label)),
    );
    const { items, pageInfo } = this.page(matching, v.first, v.after);
    return {
      issues: {
        nodes: items.map((issue) => ({
          id: issue.id,
          number: issue.number,
          url: issue.url,
          title: issue.title,
          body: issue.body,
          createdAt: issue.createdAt,
          authorAssociation: issue.association,
          comments: this.commentsPage(issue, v.comments, null),
        })),
        pageInfo,
      },
    };
  }

  private checkBody(body: unknown): string {
    if (typeof body !== "string")
      throw new GraphQLError("ARGUMENT", "body must be a string");
    if ([...body].length > MAX_BODY)
      throw new GraphQLError(
        "UNPROCESSABLE",
        "Body is too long (maximum is 65536 characters)",
      );
    return body;
  }

  private createIssue(input: unknown): Json {
    if (!isObject(input) || input.repositoryId !== "R_fake")
      throw new GraphQLError("NOT_FOUND", "no such repository");
    if (typeof input.title !== "string" || input.title.length > 256)
      throw new GraphQLError("UNPROCESSABLE", "title is missing or too long");
    const labels = (Array.isArray(input.labelIds) ? input.labelIds : []).map(
      (id) => {
        const name = [...this.labels].find(([, held]) => held === id)?.[0];
        if (name === undefined)
          throw new GraphQLError("NOT_FOUND", `no label ${String(id)}`);
        return name;
      },
    );
    const issue = this.addIssue(
      input.title,
      this.checkBody(input.body ?? ""),
      this.viewer.association,
      labels,
    );
    return { id: issue.id, url: issue.url };
  }

  private comment(input: unknown): Json {
    const issue = this.issues.find(
      (i) => isObject(input) && i.id === input.subjectId,
    );
    if (issue === undefined || !isObject(input))
      throw new GraphQLError("NOT_FOUND", "no such issue");
    const comment = this.addComment(
      issue,
      this.checkBody(input.body),
      this.viewer.login,
      this.viewer.association,
    );
    return { id: comment.id, url: comment.url };
  }

  private updateIssue(input: unknown): Json {
    const issue = this.issues.find((i) => isObject(input) && i.id === input.id);
    if (issue === undefined || !isObject(input))
      throw new GraphQLError("NOT_FOUND", "no such issue");
    if (typeof input.title === "string") issue.title = input.title;
    if (input.body !== undefined) issue.body = this.checkBody(input.body);
    return { id: issue.id };
  }
}

/**
 * The GitHub adapter's requests: reading one issue or a filtered list of a
 * repository's issues, resolving labels, milestones and the board to their
 * ids, and the writes the port's operations are made of. `tracker.ts` and
 * `reports.ts` build the port on these.
 *
 * A name that resolves to no resource, or (for a board option) to several,
 * is refused before anything is written.
 */

import { TrackerConfigError } from "../config-error.ts";
import type { GitHubSettings } from "./settings.ts";
import { TrackerRequestError } from "../port.ts";
import type { GitHubModel } from "./model.ts";
import {
  type Board,
  type GhIssue,
  issueFields,
  onePage,
  PAGE,
  parseIssue,
  type ReadContext,
  record,
  str,
} from "./read.ts";
import { type IssueRef, type Repo, requireRef, slug } from "./refs.ts";
import { isRecord } from "../../../../../../shared/guards.ts";
import { GitHubApiError, type GitHubTransport, pageAll } from "./transport.ts";

/** Which of a repository's issues a listing reads; every field narrows it. */
export interface IssueListing {
  states?: Array<"OPEN" | "CLOSED">;
  /** The issue carries at least one of these. */
  labels?: string[];
  /** Updated at or after this time (ISO 8601). */
  since?: string;
  /** The milestone's number, as GitHub's filter takes it. */
  milestoneNumber?: string;
  /** Assigned to this login. */
  assignee?: string;
}

export interface Client {
  readonly home: Repo;
  readonly model: GitHubModel;
  readonly ctx: ReadContext;
  readonly transport: GitHubTransport;
  /** The fields `parseIssue` reads, for a query of the caller's own. */
  readonly fields: string;
  ref(key: string): IssueRef;
  /** One issue, with `extra` fields read beside the usual ones; `null` when it does not exist. */
  issue(
    ref: IssueRef,
    extra?: string,
    signal?: AbortSignal,
  ): Promise<{ issue: GhIssue; raw: Record<string, unknown> } | null>;
  /** One issue that must exist. */
  mustIssue(key: string, signal?: AbortSignal): Promise<GhIssue>;
  /** Every issue of the home repository the listing selects, raw and parsed. */
  list(
    listing: IssueListing,
    extra?: string,
    signal?: AbortSignal,
  ): Promise<Array<{ issue: GhIssue; raw: Record<string, unknown> }>>;
  /**
   * The home repository's node id. A call with a `signal` asks afresh and
   * leaves the remembered answer alone, so an abort never poisons it.
   */
  repositoryId(signal?: AbortSignal): Promise<string>;
  /** Every label of the home repository, with its id. */
  repoLabels(): Promise<Array<{ id: string; name: string }>>;
  /** Label names to ids; each must name a label of the home repository. */
  labelIds(
    names: string[],
    why?: (name: string) => string,
  ): Promise<Map<string, string>>;
  /** A milestone of the home repository by its title. */
  milestone(title: string): Promise<{ id: string; number: number }>;
  /** Run a mutation and return its data. */
  mutate(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** The board, its status field and that field's options (project mode). */
  board(): Promise<BoardIds>;
}

export interface BoardIds {
  projectId: string;
  fieldId: string;
  options: Array<{ id: string; name: string }>;
}

const ISSUE_QUERY = (fields: string) => `
query TrackerIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${fields} } }
}`;

const LIST_QUERY = (fields: string) => `
query TrackerIssues($owner: String!, $name: String!, $after: String,
                    $states: [IssueState!], $filterBy: IssueFilters) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE}, after: $after, states: $states, filterBy: $filterBy,
           orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${fields} }
    }
  }
}`;

const REPO_ID_QUERY = `
query TrackerRepository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id }
}`;

const LABELS_QUERY = `
query TrackerLabels($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: ${PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id name }
    }
  }
}`;

const MILESTONES_QUERY = `
query TrackerMilestones($owner: String!, $name: String!, $query: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    milestones(first: ${PAGE}, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id number title }
    }
  }
}`;

const BOARD_QUERY = (ownerType: "organization" | "user") => `
query TrackerBoard($owner: String!, $number: Int!, $field: String!) {
  ${ownerType}(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: $field) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
    }
  }
}`;

export interface ClientOptions {
  home: Repo;
  model: GitHubModel;
  settings: GitHubSettings;
  transport: GitHubTransport;
}

export function gitHubClient(opts: ClientOptions): Client {
  const { home, model, settings, transport } = opts;
  const board: Board | null =
    settings.statesFrom === "project" && settings.project !== null
      ? { url: settings.project.url, statusField: settings.statusField }
      : null;
  const ctx: ReadContext = { home, board };
  const fields = issueFields(board);
  const repoVars = { owner: home.owner, name: home.name };

  let repoId: Promise<string> | undefined;
  let labels: Promise<Array<{ id: string; name: string }>> | undefined;
  let boardIds: Promise<BoardIds> | undefined;

  const client: Client = {
    home,
    model,
    ctx,
    transport,
    fields,
    ref: (key) => requireRef(key, home),

    async issue(ref, extra = "", signal) {
      let data: unknown;
      try {
        data = await transport(
          ISSUE_QUERY(`${fields} ${extra}`),
          { owner: ref.owner, name: ref.name, number: ref.number },
          signal,
        );
      } catch (err) {
        // The issue is absent only when its repository answered: a
        // repository the token cannot see is a setting or access problem.
        if (
          err instanceof GitHubApiError &&
          err.notFound &&
          isRecord(err.data) &&
          isRecord(err.data.repository)
        )
          return null;
        throw err;
      }
      const repo = record(record(data, "data").repository, "repository");
      if (repo.issue === null || repo.issue === undefined) return null;
      const raw = record(repo.issue, "repository.issue");
      return { issue: parseIssue(raw, ctx), raw };
    },

    async mustIssue(key, signal) {
      const found = await client.issue(client.ref(key), "", signal);
      if (found === null)
        throw new TrackerRequestError(
          "unresolved",
          `issue ${key} does not exist in ${slug(client.ref(key))}, or is not visible`,
        );
      return found.issue;
    },

    async list(listing, extra = "", signal) {
      const filterBy: Record<string, unknown> = {};
      if (listing.labels !== undefined) filterBy.labels = listing.labels;
      if (listing.since !== undefined) filterBy.since = listing.since;
      if (listing.assignee !== undefined) filterBy.assignee = listing.assignee;
      if (listing.milestoneNumber !== undefined)
        filterBy.milestoneNumber = listing.milestoneNumber;
      const nodes = await pageAll(
        transport,
        LIST_QUERY(`${fields} ${extra}`),
        { ...repoVars, states: listing.states ?? null, filterBy },
        (d) => record(d.repository, "repository").issues,
        `issues of ${slug(home)}`,
        signal,
      );
      return nodes.map((n) => {
        const raw = record(n, "issue");
        return { issue: parseIssue(raw, ctx), raw };
      });
    },

    repositoryId(signal) {
      const ask = async () => {
        const data = record(
          await transport(REPO_ID_QUERY, repoVars, signal),
          "data",
        );
        return str(record(data.repository, "repository").id, "repository.id");
      };
      if (signal !== undefined) return ask();
      repoId ??= ask();
      return repoId;
    },

    repoLabels() {
      labels ??= (async () => {
        const nodes = await pageAll(
          transport,
          LABELS_QUERY,
          repoVars,
          (d) => record(d.repository, "repository").labels,
          `labels of ${slug(home)}`,
        );
        return nodes.map((n, i) => {
          const l = record(n, `labels[${i}]`);
          return {
            id: str(l.id, `labels[${i}].id`),
            name: str(l.name, `labels[${i}].name`),
          };
        });
      })();
      return labels;
    },

    async labelIds(names, why) {
      const ids = new Map<string, string>();
      if (names.length === 0) return ids;
      const all = await client.repoLabels();
      const problems: string[] = [];
      for (const name of new Set(names)) {
        // GitHub label names are unique regardless of case.
        const match = all.find(
          (l) => l.name.toLowerCase() === name.toLowerCase(),
        );
        if (match === undefined)
          problems.push(why?.(name) ?? `'${name}' matches no label`);
        else ids.set(name, match.id);
      }
      if (problems.length > 0)
        throw new TrackerRequestError(
          "unresolved",
          `labels do not resolve to a label of ${slug(home)}: ${problems.join("; ")}`,
        );
      return ids;
    },

    async milestone(title) {
      const nodes = await pageAll(
        transport,
        MILESTONES_QUERY,
        { ...repoVars, query: title },
        (d) => record(d.repository, "repository").milestones,
        `milestones of ${slug(home)}`,
      );
      const matches = nodes.filter(
        (n) => record(n, "milestone").title === title,
      );
      if (matches.length !== 1)
        throw new TrackerRequestError(
          "unresolved",
          `project '${title}' matched ${matches.length} milestones of ${slug(home)}, expected exactly 1`,
        );
      const m = record(matches[0], "milestone");
      const number = m.number;
      if (typeof number !== "number")
        throw new GitHubApiError("milestone.number: expected a number");
      return { id: str(m.id, "milestone.id"), number };
    },

    async mutate(query, variables) {
      return record(await transport(query, variables), "data");
    },

    board() {
      boardIds ??= (async () => {
        const project = settings.project;
        if (project === null)
          throw new TrackerConfigError(
            "issue_tracker.github.project",
            "issue_tracker.github.project is not set",
          );
        let answer: unknown;
        try {
          answer = await transport(BOARD_QUERY(project.ownerType), {
            owner: project.owner,
            number: project.number,
            field: settings.statusField,
          });
        } catch (err) {
          if (!(err instanceof GitHubApiError && err.notFound)) throw err;
          answer = { [project.ownerType]: { projectV2: null } };
        }
        const data = record(answer, "data");
        const owner = record(data[project.ownerType], project.ownerType);
        if (owner.projectV2 === null)
          throw new TrackerConfigError(
            "issue_tracker.github.project",
            `issue_tracker.github.project names ${project.url}, which does not exist or is not visible; a token needs the project scope (gh auth refresh -s project)`,
          );
        const p = record(owner.projectV2, "projectV2");
        const field = p.field;
        if (
          !(field !== null && typeof field === "object" && "options" in field)
        )
          throw new TrackerConfigError(
            "issue_tracker.github.status_field",
            `issue_tracker.github.status_field names '${settings.statusField}', which is not a single-select field of ${project.url}`,
          );
        const f = record(field, "field");
        const options = (f.options as unknown[]).map((o, i) => {
          const r = record(o, `options[${i}]`);
          return {
            id: str(r.id, `options[${i}].id`),
            name: str(r.name, `options[${i}].name`),
          };
        });
        return {
          projectId: str(p.id, "projectV2.id"),
          fieldId: str(f.id, "field.id"),
          options,
        };
      })();
      return boardIds;
    },
  };
  return client;
}

/** Label nodes of a one-page connection, as names. */
export function labelNamesOf(v: unknown, where: string): string[] {
  return onePage(v, where).map((l, i) =>
    str(record(l, `${where}[${i}]`).name, `${where}[${i}].name`),
  );
}

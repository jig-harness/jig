/**
 * The repository the GitHub store keeps its issues in: what the signed-in
 * account sees of it, and what keeps the store from reading or writing
 * there, each with its fix.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { type GitHubClient, GitHubApiError } from "./api.ts";
import { LABEL_COLOR, LABEL_DESCRIPTION, STORE_LABEL } from "./model.ts";

/** Permissions that may create issues, label them, and be trusted. */
const WRITERS = new Set([
  "ADMIN",
  "MAINTAIN",
  "WRITE",
  "TRIAGE_PLUS",
  "TRIAGE",
]);

export interface Repository {
  id: string;
  owner: string;
  name: string;
  nameWithOwner: string;
  url: string;
  hasIssuesEnabled: boolean;
  isArchived: boolean;
  viewerPermission: string | null;
  viewerCanCreateIssues: boolean;
  labelId: string | null;
}

/** Why a repository cannot be used as a store, and how to fix that. */
export interface Unusable {
  reason: string;
  fix: string;
}

const REPOSITORY_QUERY = `query JigReflectionRepository($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) {
    id nameWithOwner url hasIssuesEnabled isArchived viewerPermission viewerCanCreateIssues
    label(name: $label) { id }
  }
}`;

/** A string field, or `fallback`. */
export function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** The `id` of an object GitHub returned, or null. */
function idOf(value: unknown): string | null {
  return isRecord(value) && typeof value.id === "string" ? value.id : null;
}

/** The query's answer, or null when GitHub says the repository is not there. */
async function queryRepository(
  client: GitHubClient,
  owner: string,
  name: string,
): Promise<unknown> {
  try {
    return await client.read(REPOSITORY_QUERY, {
      owner,
      name,
      label: STORE_LABEL,
    });
  } catch (error) {
    if (error instanceof GitHubApiError && error.notFound) return null;
    throw error;
  }
}

function repositoryOf(
  repo: Record<string, unknown>,
  nameWithOwner: string,
): Repository {
  const id = idOf(repo);
  if (id === null)
    throw new GitHubApiError(`GitHub returned ${nameWithOwner} without an id`);
  const [owner, name] = nameWithOwner.split("/");
  return {
    id,
    owner: String(owner),
    name: String(name),
    nameWithOwner: stringOr(repo.nameWithOwner, nameWithOwner),
    url: stringOr(repo.url, `https://github.com/${nameWithOwner}`),
    hasIssuesEnabled: repo.hasIssuesEnabled === true,
    isArchived: repo.isArchived === true,
    viewerPermission:
      typeof repo.viewerPermission === "string" ? repo.viewerPermission : null,
    viewerCanCreateIssues: repo.viewerCanCreateIssues === true,
    labelId: idOf(repo.label),
  };
}

/** The repository as the signed-in account sees it, or null when it cannot. */
export async function openRepository(
  client: GitHubClient,
  nameWithOwner: string,
): Promise<Repository | null> {
  const [owner, name] = nameWithOwner.split("/");
  const data = await queryRepository(client, String(owner), String(name));
  const repo = isRecord(data) ? data.repository : null;
  return isRecord(repo) ? repositoryOf(repo, nameWithOwner) : null;
}

export function notVisible(nameWithOwner: string): Unusable {
  return {
    reason: `the signed-in GitHub account cannot see the repository ${nameWithOwner}`,
    fix: "check reflection.github.repository, and that the account (gh auth status, or the token in GH_TOKEN) has access to it, with the repo scope for a private repository",
  };
}

type Rule = (repo: Repository) => Unusable | null;

function issuesOff(repo: Repository): Unusable | null {
  return repo.hasIssuesEnabled
    ? null
    : {
        reason: `${repo.nameWithOwner} has Issues turned off`,
        fix: `turn on Issues in the repository's settings (${repo.url}/settings)`,
      };
}

function labelMissing(repo: Repository): Unusable | null {
  return repo.labelId !== null
    ? null
    : {
        reason: `${repo.nameWithOwner} has no ${STORE_LABEL} label, which marks the store's issues`,
        fix: `gh label create ${STORE_LABEL} --repo ${repo.nameWithOwner} --description "${LABEL_DESCRIPTION}" --color ${LABEL_COLOR}`,
      };
}

function archived(repo: Repository): Unusable | null {
  return repo.isArchived
    ? {
        reason: `${repo.nameWithOwner} is archived, so nothing can be added to it`,
        fix: "unarchive it, or point reflection.github.repository at another repository",
      }
    : null;
}

function cannotWrite(repo: Repository): Unusable | null {
  const permission = repo.viewerPermission ?? "unknown";
  return repo.viewerCanCreateIssues && WRITERS.has(permission)
    ? null
    : {
        reason: `the signed-in GitHub account cannot write to ${repo.nameWithOwner} (its permission is ${permission}); the store reads only comments by people who can`,
        fix: "give the account write access to the repository, or sign in as one that has it",
      };
}

/** What keeps `list` from reading the store: Issues off, or no label. */
const READ_RULES: Rule[] = [issuesOff, labelMissing];

/** What keeps `append` from writing, beyond what keeps `list` from reading. */
const WRITE_RULES: Rule[] = [...READ_RULES, archived, cannotWrite];

function firstProblem(
  repo: Repository,
  rules: readonly Rule[],
): Unusable | null {
  for (const rule of rules) {
    const problem = rule(repo);
    if (problem !== null) return problem;
  }
  return null;
}

export function unreadable(repo: Repository): Unusable | null {
  return firstProblem(repo, READ_RULES);
}

export function unwritable(repo: Repository): Unusable | null {
  return firstProblem(repo, WRITE_RULES);
}

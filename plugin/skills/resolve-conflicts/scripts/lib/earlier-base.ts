/**
 * The earlier base of a stacked pull request that landed on the new base as
 * other commits: squash-merged (one new commit) or rebase-merged (copies).
 *
 * A pull request built on another pull request's branch holds that branch's
 * commits. Once the branch below lands by squash or rebase, the forge
 * retargets the pull request onto the base the branch landed on, which holds
 * the same changes under different commits. Git's own merge base is then the
 * point both branches forked from, so a merge of the new base sees the
 * earlier base's changes on both sides and reports conflicts that are only
 * their echoes. Merging with the point where this branch left the earlier
 * base as the merge base compares only this branch's own changes with the
 * new base's, and only those can conflict.
 *
 * The forge says which branch the pull request was retargeted from, and which
 * merged pull request landed that branch on the new base; git confirms the
 * rest locally: the landed commit is on the new base, the earlier base's tip
 * is not, and the chosen base lies above git's own.
 */
import { isRecord, isString, valueAt } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { graphqlAnswer } from "../../../../shared/outbound/github.ts";
import { ghCall, ghRepoEnv } from "../../../drive-pr/scripts/lib/proc.ts";
import { gitRaw, resolveCommit } from "./git.ts";

/** The query reading the pull request's base changes, as the cost ledger names it. */
export const RETARGET_QUERY_NAME = "EarlierBaseRetarget";

/** The query reading the merged pull request that landed the earlier base, as the cost ledger names it. */
export const LANDING_QUERY_NAME = "EarlierBaseLanding";

/** Base changes read: a pull request is retargeted a few times at most. */
const RETARGETS = 10;

/** Merged pull requests read for the earlier base's branch name. */
const LANDINGS = 5;

const RETARGET_QUERY = `query ${RETARGET_QUERY_NAME}($owner: String!, $name: String!, $number: Int!) {
  rateLimit { cost remaining resetAt limit }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      baseRefName
      timelineItems(last: ${RETARGETS}, itemTypes: [BASE_REF_CHANGED_EVENT]) {
        nodes { ... on BaseRefChangedEvent { previousRefName currentRefName createdAt } }
      }
    }
  }
}`;

const LANDING_QUERY = `query ${LANDING_QUERY_NAME}($owner: String!, $name: String!, $head: String!, $base: String!) {
  rateLimit { cost remaining resetAt limit }
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, headRefName: $head, baseRefName: $base, first: ${LANDINGS}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number headRefOid mergedAt mergeCommit { oid } }
    }
  }
}`;

/** The earlier base as the forge records it. */
export interface Landing {
  /** The branch the pull request was based on before it was retargeted. */
  ref: string;
  /** The merged pull request that landed that branch on the new base. */
  pr: number;
  /** That branch's last commit when it merged. */
  tip: string;
  /** The commit it landed as on the new base. */
  landed: string;
}

/** The forge's answer to one query, or why there is none. */
export type AskForge = (
  query: "retarget" | "landing",
  fields: Record<string, string | number>,
) => Promise<Outcome<unknown, "unreadable" | "too-costly">>;

/** The forge through its governed transport, in the checkout at `cwd`. */
export function askForge(cwd: string): AskForge {
  return (query, fields) =>
    graphqlAnswer(() =>
      ghCall(
        [
          "api",
          "graphql",
          "-f",
          `query=${query === "retarget" ? RETARGET_QUERY : LANDING_QUERY}`,
          "-F",
          "owner={owner}",
          "-F",
          "name={repo}",
          ...Object.entries(fields).flatMap(([key, value]) => [
            typeof value === "number" ? "-F" : "-f",
            `${key}=${value}`,
          ]),
        ],
        { stderr: "pipe", env: ghRepoEnv(), cwd },
      ),
    );
}

/**
 * The branch the pull request was based on just before it was based on
 * `base`: the latest recorded base change onto `base`. Null when it never
 * was retargeted onto `base`.
 */
export function earlierRef(answer: unknown, base: string): string | null {
  const nodes = valueAt(
    answer,
    "data",
    "repository",
    "pullRequest",
    "timelineItems",
    "nodes",
  );
  if (!Array.isArray(nodes)) return null;
  for (const node of [...nodes].reverse()) {
    if (!isRecord(node)) continue;
    const previous = node.previousRefName;
    if (
      node.currentRefName === base &&
      isString(previous) &&
      previous !== "" &&
      previous !== base
    )
      return previous;
  }
  return null;
}

/** The most recently merged of the listed pull requests that carries both commits. */
export function landingOf(answer: unknown): Omit<Landing, "ref"> | null {
  const nodes = valueAt(answer, "data", "repository", "pullRequests", "nodes");
  if (!Array.isArray(nodes)) return null;
  const landings = nodes.flatMap((node) => {
    const tip = valueAt(node, "headRefOid");
    const landed = valueAt(node, "mergeCommit", "oid");
    const pr = valueAt(node, "number");
    const mergedAt = valueAt(node, "mergedAt");
    if (!isString(tip) || !isString(landed) || typeof pr !== "number")
      return [];
    return [{ pr, tip, landed, mergedAt: isString(mergedAt) ? mergedAt : "" }];
  });
  landings.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const first = landings[0];
  return first === undefined
    ? null
    : { pr: first.pr, tip: first.tip, landed: first.landed };
}

/** Read from the forge which branch the pull request was stacked on, and how it landed on `base`. */
export async function readLanding(
  ask: AskForge,
  pr: number,
  base: string,
): Promise<Outcome<Landing | null, "unreadable" | "too-costly">> {
  const retarget = await ask("retarget", { number: pr });
  if (!retarget.ok) return retarget;
  const ref = earlierRef(retarget.value, base);
  if (ref === null) return ok(null);
  const answer = await ask("landing", { head: ref, base });
  if (!answer.ok) return answer;
  const landing = landingOf(answer.value);
  return ok(landing === null ? null : { ref, ...landing });
}

/** Why the earlier base does not set the merge base, in words for the record. */
export type NotApplicable =
  | "tip-missing"
  | "not-landed"
  | "merged-whole"
  | "unrelated"
  | "no-gain";

/** Whether `ancestor` is an ancestor of `of` (or the same commit). */
function isAncestor(root: string, ancestor: string, of: string): boolean {
  return gitRaw(root, ["merge-base", "--is-ancestor", ancestor, of]).code === 0;
}

/** Fetch the earlier base's tip when the clone does not hold it. */
function ensureTip(
  root: string,
  remote: string,
  landing: Landing,
): string | null {
  const held = resolveCommit(root, landing.tip);
  if (held !== null) return held;
  gitRaw(root, [
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    `refs/pull/${landing.pr}/head`,
  ]);
  return resolveCommit(root, landing.tip);
}

/**
 * The merge base to merge `theirs` into `head` with: where `head` left the
 * earlier base. Refused, naming why, when the clone does not hold the
 * earlier base's tip, its landed commit is not on `theirs`, the tip itself is
 * on `theirs` (an ordinary merge, which git's own base already handles), the
 * histories are unrelated, or the chosen base would be git's own.
 */
export function mergeBaseAfter(
  root: string,
  remote: string,
  head: string,
  theirs: string,
  landing: Landing,
): Outcome<string, NotApplicable> {
  const tip = ensureTip(root, remote, landing);
  if (tip === null)
    return failed(
      "tip-missing",
      `the earlier base's last commit ${landing.tip} could not be fetched`,
    );
  const landed = resolveCommit(root, landing.landed);
  if (landed === null || !isAncestor(root, landed, theirs))
    return failed(
      "not-landed",
      `the commit #${landing.pr} landed as (${landing.landed}) is not on the branch being merged`,
    );
  if (isAncestor(root, tip, theirs))
    return failed(
      "merged-whole",
      `the earlier base's commits are on the branch being merged, so git's own merge base already excludes them`,
    );
  const own = gitRaw(root, ["merge-base", head, theirs]);
  const after = gitRaw(root, ["merge-base", head, tip]);
  if (own.code !== 0 || after.code !== 0)
    return failed(
      "unrelated",
      "this branch shares no history with the earlier base",
    );
  const ownBase = own.stdout.trim();
  const base = after.stdout.trim();
  if (base === ownBase || !isAncestor(root, ownBase, base))
    return failed(
      "no-gain",
      "this branch left the earlier base no later than git's own merge base",
    );
  return ok(base);
}

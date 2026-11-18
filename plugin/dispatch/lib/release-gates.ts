/** The release station observes tags and, on counted authorization, retries failed jobs on the releasing commit. */
import {
  ghCall,
  ghRepoEnv,
  run,
  type RunHandle,
} from "../../skills/drive-pr/scripts/lib/proc.ts";
import { isRecord, isString, isStringArray } from "../../shared/guards.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { ghRunFailure } from "../../shared/outbound/github.ts";
import { failedBy } from "../../shared/outbound/failure.ts";
import { failedGateRuns } from "./release-gate-reads.ts";
import {
  claimReleaseRerun,
  dueReleaseTags,
  recordTagged,
} from "./release-needs.ts";
import {
  boundAt,
  ended,
  secondsLeft,
  type TickBound,
} from "./sources/bounded.ts";
import { currentMs } from "../../shared/time.ts";
import type { RepoTarget } from "./types.ts";
import { resolve } from "node:path";

const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");
const BRANCHES = resolve(
  import.meta.dir,
  "../../skills/changelog/scripts/branches.ts",
);
const INTEGRATION_BRANCH_INSPECTION = `import { integrationBranch } from ${JSON.stringify(BRANCHES)};
const root = process.env.JIG_RELEASE_INSPECTION_ROOT;
process.stdout.write(JSON.stringify(root === undefined ? null : integrationBranch(root)) + "\\n");`;
const RELEASING_COMMIT_INSPECTION = `import { releasingCommit } from ${JSON.stringify(resolve(import.meta.dir, "../../skills/changelog/scripts/releasing-commit.ts"))};
const root = process.env.JIG_RELEASE_INSPECTION_ROOT;
const tag = process.env.JIG_RELEASE_INSPECTION_TAG;
process.stdout.write(JSON.stringify(root === undefined || tag === undefined ? null : releasingCommit(root, tag)) + "\\n");`;

const refused = (why: string) => failed("refused", why);

async function forge(repo: RepoTarget, args: string[], bound?: TickBound) {
  const reply = await bounded(
    (onSpawn) =>
      ghCall(args, {
        cwd: repo.path,
        env: ghRepoEnv(),
        stderr: "pipe",
        timeoutSec: Math.min(secondsLeft(bound) ?? 20, 20),
        onSpawn,
      }),
    bound,
  );
  const failure = ghRunFailure(reply);
  return failure === null ? ok(reply.stdout) : failedBy("refused", failure);
}

/** Run one subprocess under the tick's cancellation signal as well as its deadline. */
async function bounded<T>(
  start: (onSpawn: (handle: RunHandle) => void) => Promise<T>,
  bound: TickBound | undefined,
): Promise<T> {
  let stop: (() => void) | undefined;
  const onSpawn = (handle: RunHandle) => {
    if (bound === undefined) return;
    stop = () => void handle.stop();
    bound.signal.addEventListener("abort", stop, { once: true });
    if (bound.signal.aborted) stop();
  };
  try {
    return await start(onSpawn);
  } finally {
    if (stop !== undefined) bound?.signal.removeEventListener("abort", stop);
  }
}

async function refreshIntegration(
  repo: RepoTarget,
  branch: string,
  bound: TickBound | undefined,
): Promise<Outcome<null, "refused">> {
  const reply = await bounded(
    (onSpawn) =>
      run(["git", "fetch", "origin", branch], {
        cwd: repo.path,
        stderr: "pipe",
        timeoutSec: Math.min(secondsLeft(bound) ?? 20, 20),
        onSpawn,
      }),
    bound,
  );
  const failure = ghRunFailure(reply);
  return failure === null
    ? ok(null)
    : failedBy(
        "refused",
        failure,
        "the integration branch could not be refreshed",
      );
}

type ReleasingCommit = {
  sha: string;
  branch: string;
  checks: string[] | undefined;
};

function isReleasingCommit(value: unknown): value is ReleasingCommit {
  return (
    isRecord(value) &&
    isString(value.sha) &&
    isString(value.branch) &&
    (value.checks === undefined || isStringArray(value.checks))
  );
}

/**
 * releasingCommit reads changelog history with synchronous Git calls. Keep that
 * implementation isolated in a child so a station tick can cancel the scan.
 */
async function inspectReleasingCommit(
  repo: RepoTarget,
  tag: string,
  branch: string,
  bound: TickBound | undefined,
): Promise<Outcome<ReleasingCommit | null, "refused">> {
  const reply = await bounded(
    (onSpawn) =>
      run(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          "-e",
          RELEASING_COMMIT_INSPECTION,
        ],
        {
          cwd: repo.path,
          env: {
            ...process.env,
            JIG_RELEASE_INSPECTION_BRANCH: branch,
            JIG_RELEASE_INSPECTION_ROOT: repo.path,
            JIG_RELEASE_INSPECTION_TAG: tag,
          },
          stderr: "pipe",
          timeoutSec: Math.min(secondsLeft(bound) ?? 20, 20),
          onSpawn,
        },
      ),
    bound,
  );
  const failure = ghRunFailure(reply);
  if (failure !== null)
    return failedBy(
      "refused",
      failure,
      "the releasing commit could not be read",
    );
  const parsed = attempt(
    "refused",
    "the releasing commit response is unreadable",
    (): unknown => JSON.parse(reply.stdout),
  );
  if (!parsed.ok) return parsed;
  return parsed.value === null || isReleasingCommit(parsed.value)
    ? ok(parsed.value)
    : refused("the release inspection returned an invalid commit");
}

/** Read the integration branch in the bounded child: its fallback may use synchronous Git or forge reads. */
async function inspectIntegrationBranch(
  repo: RepoTarget,
  bound: TickBound | undefined,
): Promise<Outcome<string | null, "refused">> {
  const reply = await bounded(
    (onSpawn) =>
      run(
        [
          process.execPath,
          "--no-env-file",
          `--config=${BUNFIG}`,
          "-e",
          INTEGRATION_BRANCH_INSPECTION,
        ],
        {
          cwd: repo.path,
          env: { ...process.env, JIG_RELEASE_INSPECTION_ROOT: repo.path },
          stderr: "pipe",
          timeoutSec: Math.min(secondsLeft(bound) ?? 20, 20),
          onSpawn,
        },
      ),
    bound,
  );
  const failure = ghRunFailure(reply);
  if (failure !== null)
    return failedBy(
      "refused",
      failure,
      "the integration branch could not be identified",
    );
  const parsed = attempt(
    "refused",
    "the integration branch response is unreadable",
    (): unknown => JSON.parse(reply.stdout),
  );
  if (!parsed.ok) return parsed;
  return parsed.value === null || isString(parsed.value)
    ? ok(parsed.value)
    : refused("the release inspection returned an invalid integration branch");
}

export async function taggedReleases(
  repo: RepoTarget,
  tags: readonly string[],
  bound?: TickBound,
): Promise<Outcome<Set<string>, "refused">> {
  const [owner, name] = repo.slug.split("/");
  const fields = tags.map(
    (tag, i) =>
      `tag${i}: ref(qualifiedName: ${JSON.stringify(`refs/tags/${tag}`)}) { name }`,
  );
  const query = `query DispatchReleaseTags($owner:String!,$name:String!){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){${fields.join(" ")}}}`;
  const reply = await forge(
    repo,
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ],
    bound,
  );
  if (!reply.ok) return reply;
  const parsed = attempt(
    "refused",
    "the release tag response is unreadable",
    (): unknown => JSON.parse(reply.value),
  );
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  const data =
    isRecord(body) && isRecord(body.data) ? body.data.repository : null;
  if (!isRecord(data)) return refused("the forge did not return release tags");
  const found = new Set<string>();
  for (const [i, tag] of tags.entries()) {
    const ref = data[`tag${i}`];
    if (ref === null) continue;
    if (!isRecord(ref) || ref.name !== tag)
      return refused(`the forge did not return a valid reference for ${tag}`);
    found.add(tag);
  }
  return ok(found);
}

export async function observeReleaseTags(
  repo: RepoTarget,
  now: number,
  bound?: TickBound,
): Promise<Outcome<null, "refused">> {
  if (ended(bound)) return ok(null);
  const tags = dueReleaseTags(repo.slug, now);
  if (tags.length === 0) return ok(null);
  const read = await taggedReleases(repo, tags, bound);
  if (!read.ok) return read;
  if (read.value.size > 0) recordTagged(repo.slug, [...read.value]);
  return ok(null);
}

export async function rerunReleaseGates(
  repo: RepoTarget,
  tag: string,
  root?: string,
  bound = boundAt(currentMs() + 120_000),
): Promise<Outcome<string, "refused">> {
  if (ended(bound))
    return refused("the tick ran out of time before reading the release");
  const tags = await taggedReleases(repo, [tag], bound);
  if (!tags.ok) return tags;
  if (tags.value.has(tag)) {
    recordTagged(repo.slug, [tag], root);
    return refused(`release ${tag} already has its tag`);
  }
  const branchRead = await inspectIntegrationBranch(repo, bound);
  if (!branchRead.ok) return branchRead;
  const branch = branchRead.value;
  if (branch === null)
    return refused(`the integration branch for ${tag} could not be identified`);
  const refreshed = await refreshIntegration(repo, branch, bound);
  if (!refreshed.ok) return refreshed;
  const current = await inspectReleasingCommit(repo, tag, branch, bound);
  if (!current.ok) return current;
  if (current.value === null)
    return refused(`the releasing commit for ${tag} could not be identified`);
  const runs = await failedGateRuns(async (endpoint) => {
    if (ended(bound))
      return refused("the tick ran out of time reading the failed gates");
    const reply = await forge(
      repo,
      ["api", `repos/${repo.slug}/${endpoint}`],
      bound,
    );
    return reply.ok
      ? attempt(
          "refused",
          "the failed gate response is unreadable",
          (): unknown => JSON.parse(reply.value),
        )
      : reply;
  }, current.value);
  if (!runs.ok) return runs;
  if (runs.value.length === 0)
    return refused(
      `no failed workflow runs on the releasing commit for ${tag}`,
    );
  if (ended(bound))
    return refused("the tick ran out of time before requesting reruns");
  if (!claimReleaseRerun(repo.slug, tag, root))
    return refused(
      `a rerun for ${tag} was already claimed or the tag was observed`,
    );
  return requestReruns(repo, runs.value, bound);
}

async function requestReruns(
  repo: RepoTarget,
  runs: readonly number[],
  bound: TickBound | undefined,
): Promise<Outcome<string, "refused">> {
  const accepted: number[] = [];
  const failures: string[] = [];
  for (const run of runs) {
    if (ended(bound)) {
      failures.push(`${run}: the tick ran out of time`);
      continue;
    }
    const reply = await forge(
      repo,
      [
        "api",
        "--method",
        "POST",
        `repos/${repo.slug}/actions/runs/${run}/rerun-failed-jobs`,
      ],
      bound,
    );
    if (reply.ok) accepted.push(run);
    else failures.push(`${run}: ${reply.failure.reason}`);
  }
  const requested =
    accepted.length === 0
      ? "No reruns requested"
      : `Requested failed jobs again in workflow runs ${accepted.join(", ")}`;
  return failures.length === 0
    ? ok(requested)
    : refused(`${requested}. Refused: ${failures.join("; ")}`);
}

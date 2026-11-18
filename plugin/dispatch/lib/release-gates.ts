/** The release station observes tags and, on counted authorization, retries failed jobs on the releasing commit. */
import { releasingCommit } from "../../skills/changelog/scripts/releasing-commit.ts";
import {
  ghCall,
  ghRepoEnv,
  run,
  type RunHandle,
} from "../../skills/drive-pr/scripts/lib/proc.ts";
import { isRecord } from "../../shared/guards.ts";
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
  const commit = attempt(
    "refused",
    "the releasing commit could not be read",
    () => releasingCommit(repo.path, tag),
  );
  if (!commit.ok) return commit;
  if (commit.value === null)
    return refused(`the releasing commit for ${tag} could not be identified`);
  const refreshed = await refreshIntegration(repo, commit.value.branch, bound);
  if (!refreshed.ok) return refreshed;
  const current = attempt(
    "refused",
    "the releasing commit could not be read",
    () => releasingCommit(repo.path, tag),
  );
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

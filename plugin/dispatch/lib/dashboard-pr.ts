/** Current forge state, separate from the immutable outcome log and tick snapshot. */
import { Defect } from "../../shared/outcome.ts";
import { readLine } from "./line-store.ts";

export interface DashboardPr {
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
  isDraft: boolean;
  url: string;
  checkedAt: string;
}

/** Per-server bounded cache; concurrent readers of a PR share one deadline-bound call. */
export function prReader(root: string) {
  const cache = new Map<
    string,
    { until: number; value: Promise<DashboardPr | null> }
  >();
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (active < 4) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (repo: string, pr: string): Promise<DashboardPr | null> => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[1-9]\d{0,9}$/.test(pr))
      return null;
    const line = readLine(root);
    if (!line.ok || !line.value?.repos.some((r) => r.slug === repo))
      return null;
    const key = `${repo}#${pr}`;
    const previous = cache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    if (waiting.length >= 64) return null;
    trimCache(cache);
    const value = (async (): Promise<DashboardPr | null> => {
      await acquire();
      try {
        return await readForgePr(repo, pr);
      } finally {
        const entry = cache.get(key);
        if (entry) entry.until = Date.now() + 60_000;
        release();
      }
    })();
    cache.set(key, { until: Number.POSITIVE_INFINITY, value });
    return value;
  };
}

async function readForgePr(
  repo: string,
  pr: string,
): Promise<DashboardPr | null> {
  const { ghCall, ghRepoEnv } = await import(
    "../../skills/drive-pr/scripts/lib/proc.ts"
  );
  const result = await ghCall(["api", `repos/${repo}/pulls/${pr}`], {
    env: ghRepoEnv(),
    stderr: "pipe",
    timeoutSec: 15,
  });
  if (result.code !== 0) {
    console.error(
      `jig dispatch dashboard: ${repo} PR #${pr} read failed (exit ${result.code}, timedOut=${result.timedOut})`,
      result.stderr,
    );
    return null;
  }
  const data = JSON.parse(result.stdout);
  if (
    !["open", "closed"].includes(data.state) ||
    typeof data.title !== "string" ||
    typeof data.draft !== "boolean" ||
    typeof data.merged !== "boolean" ||
    typeof data.html_url !== "string" ||
    !/^https:\/\//.test(data.html_url)
  )
    // As a response that is not JSON, it reaches the dashboard's defect boundary: the page shows the defect answer.
    throw new Defect(`${repo} PR #${pr}: forge response has invalid PR fields`);
  return {
    state: data.merged ? "MERGED" : data.state === "open" ? "OPEN" : "CLOSED",
    title: data.title,
    isDraft: data.draft,
    url: data.html_url,
    checkedAt: new Date().toISOString(),
  };
}

function trimCache(cache: Map<string, { until: number }>) {
  if (cache.size < 500) return;
  for (const [id, entry] of cache)
    if (entry.until <= Date.now()) cache.delete(id);
  const oldest = cache.keys().next().value;
  if (cache.size >= 500 && oldest !== undefined) cache.delete(oldest);
}

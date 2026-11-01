/**
 * The model and effort a pickup's session starts on: the item's route, as
 * `do-item`'s own `determine_route.ts` derives it, run in the item's new
 * workspace (a branch from the repository's base, so it reads the default
 * branch's settings) for Claude Code. Only a repository that declares
 * `routing` gets a route applied; without one, or when the route cannot be
 * derived, the session starts on Claude Code's own defaults and the launch
 * says why.
 */
import { resolve } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { run } from "../../shared/proc.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";

const DETERMINE_ROUTE = resolve(
  import.meta.dir,
  "../../skills/do-item/scripts/determine_route.ts",
);
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

export interface PickupRoute {
  model: string | null;
  effort: string | null;
  /** How the route was found, for the launch's report. */
  detail: string;
}

/** The route for `issue`, derived in `workspace`. */
export async function pickupRoute(
  issue: Pick<PoolIssue, "title" | "labels">,
  workspace: string,
  timeoutSec: number,
): Promise<PickupRoute> {
  // The workspace's own bunfig and env files are not this process's to load.
  const argv = [
    process.execPath,
    "--no-env-file",
    `--config=${BUNFIG}`,
    DETERMINE_ROUTE,
    "-",
  ];
  const done = await run(argv, {
    cwd: workspace,
    stdin: JSON.stringify({
      title: issue.title,
      labels: issue.labels,
      nativeType: null,
    }),
    // The route is the one for the runtime the session runs in.
    env: { ...process.env, CLAUDECODE: "1" },
    timeoutSec,
    stderr: "pipe",
  });
  const none = (why: string): PickupRoute => ({
    model: null,
    effort: null,
    detail: why,
  });
  if (done.code !== 0)
    return none(
      `no route (determine_route.ts exit ${done.code}: ${done.stderr.trim().slice(0, 200)}); the session derives its own`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(done.stdout);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed))
    return none("no route (determine_route.ts printed no route)");
  const route = parsed;
  if (route.declared !== true)
    return none("the repository declares no routing: Claude Code's defaults");
  const model = typeof route.model === "string" ? route.model : null;
  const effort =
    typeof route.runtime_effort === "string" ? route.runtime_effort : null;
  return {
    model,
    effort,
    detail: `route ${String(route.tier)}, ${effort ?? "default effort"}, ${model ?? "default model"}`,
  };
}

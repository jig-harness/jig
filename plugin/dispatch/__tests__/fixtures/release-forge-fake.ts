/** The dispatch test world's forge answers specific to releases. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function releaseForgeAnswer(dir: string, args: string[]): unknown {
  if (args[0] !== "api") return undefined;
  const query = args.find((arg) => arg.includes("query DispatchReleaseTags"));
  if (args[1] === "graphql" && query !== undefined) {
    // The tags `release-tags.json` lists exist; every other one does not.
    const listed = join(dir, "release-tags.json");
    const tags: string[] = existsSync(listed)
      ? JSON.parse(readFileSync(listed, "utf8"))
      : [];
    const refs = [
      ...query.matchAll(/(tag\d+): ref\(qualifiedName: "refs\/tags\/([^"]+)"\)/g),
    ];
    const repository = Object.fromEntries(
      refs.map(([, key, tag]) => [
        key,
        tag !== undefined && tags.includes(tag) ? { name: tag } : null,
      ]),
    );
    return {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-12T00:00:00Z" },
        repository,
      },
    };
  }
  // A workflow run's status, as `run-status.json` maps `<owner>/<repo>/<id>` to it.
  const statuses = join(dir, "run-status.json");
  const run = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(args[1] ?? "");
  if (run !== null && args.includes(".status") && existsSync(statuses)) {
    const status = JSON.parse(readFileSync(statuses, "utf8"))[`${run[1]}/${run[2]}`];
    return typeof status === "string" ? `${status}\n` : undefined;
  }
  const checks = join(dir, "release-checks.json");
  if (args.some((arg) => arg.includes("/check-runs?filter=latest")) && existsSync(checks))
    return readFileSync(checks, "utf8");
  const runs = join(dir, "release-runs.json");
  if (!existsSync(runs)) return undefined;
  if (args.some((arg) => arg.includes("/actions/runs?head_sha=")))
    return readFileSync(runs, "utf8");
  if (args.includes("POST") && args.some((arg) => arg.endsWith("/rerun-failed-jobs")))
    return "";
  return undefined;
}

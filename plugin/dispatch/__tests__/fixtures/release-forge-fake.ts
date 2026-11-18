/** The dispatch test world's forge answers specific to releases. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function releaseForgeAnswer(dir: string, args: string[]): unknown {
  if (args[0] !== "api") return undefined;
  const query = args.find((arg) => arg.includes("query DispatchReleaseTags"));
  if (args[1] === "graphql" && query !== undefined) {
    const refs = query.match(/tag\d+(?=: ref)/g) ?? [];
    const repository = Object.fromEntries(refs.map((key) => [key, null]));
    return {
      data: {
        rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-11-12T00:00:00Z" },
        repository,
      },
    };
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

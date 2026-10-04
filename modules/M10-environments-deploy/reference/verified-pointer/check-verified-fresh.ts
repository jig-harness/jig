#!/usr/bin/env bun
// Verified-pointer freshness watchdog — the self-healing check made mechanical.
//
// The problem it catches. Post-merge verification advances an explicit
// `verified` pointer (a branch or tag) to the newest commit that passed the
// full verification suite; deploys only ever ship what `verified` points at.
// That is only trustworthy if verification KEEPS UP: if the verifier wedges
// (a flaky suite, a broken runner, a stuck queue), `verified` silently freezes
// while the default branch races ahead, and "we deploy verified artifacts" now
// means "we deploy last week's code" — with nobody paged. This watchdog turns
// "is verification keeping up?" into a check that fails loudly, so an operator
// (or an automated heal run) is triggered instead of the freeze going unnoticed.
//
// What it measures. Two independent freshness signals for the pointer:
//   * BEHIND        — how many commits the verified pointer trails the
//                     default-branch tip (its commit distance).
//   * AGE_SECONDS   — how long since the verified pointer last advanced.
// You may supply either or both. The pointer is STALLED (fail) if EITHER signal
// exceeds its threshold; it is FRESH (pass) only if every supplied signal is at
// or under its threshold. At-threshold is fresh; only strictly-greater stalls.
//
// Thresholds (env, with defaults; validated up front like check-parity.ts does
// for MIN_PRECISION, because a bad threshold silently corrupts every verdict):
//   MAX_BEHIND        default 20     (commits)
//   MAX_AGE_SECONDS   default 86400  (24h)
//
// Input. Observations arrive via env (BEHIND=, AGE_SECONDS=) or via an input
// file passed as $1 whose lines are `<KEY> <value>` pairs (BEHIND / AGE_SECONDS,
// each at most once; blank lines and `# comments` ignored). Compute them from
// git, e.g.
//   BEHIND=$(git rev-list --count verified..origin/main)
//   AGE_SECONDS=$(( $(date +%s) - $(git log -1 --format=%ct verified) ))
// (recipes per forge in ../../mappings.md).
//
// Native Bun/TypeScript. Conventions: exit 0 fresh, 1 stalled (page/heal),
// 2 on a usage / non-numeric / bad-threshold error.
//
// Usage:
//   BEHIND=3 AGE_SECONDS=3600 check-verified-fresh.ts
//   check-verified-fresh.ts observation.txt
//   MAX_BEHIND=10 MAX_AGE_SECONDS=43200 check-verified-fresh.ts obs.txt
import { readFileSync } from "node:fs";
export function main(args = process.argv.slice(2), env = process.env): number {
  const observations: Record<string, string> = {
    BEHIND: env.BEHIND || "",
    AGE_SECONDS: env.AGE_SECONDS || "",
  };
  const thresholds = {
    BEHIND: env.MAX_BEHIND || "20",
    AGE_SECONDS: env.MAX_AGE_SECONDS || "86400",
  };
  const input = args[0];
  if (input) {
    const seen = new Set<string>();
    for (const raw of readFileSync(input, "utf8").split(/\r?\n/)) {
      const tokens = (raw.split("#")[0] ?? "").trim().split(/\s+/);
      if (!tokens[0]) continue;
      const [key, value] = tokens;
      if (tokens.length !== 2)
        throw new Error(`bad line in ${input} (want '<KEY> <value>'): ${raw}`);
      if (!key || !(key in observations))
        throw new Error(
          `unknown key in ${input} (allowed: BEHIND, AGE_SECONDS): ${key}`,
        );
      if (seen.has(key))
        throw new Error(`duplicate ${key} observation in ${input}`);
      seen.add(key);
      observations[key] = value ?? "";
    }
  }
  const uint = (s: string) => /^[0-9]{1,18}$/.test(s);
  for (const [key, val] of Object.entries(thresholds))
    if (!uint(val))
      throw new Error(`MAX_${key} must be a non-negative integer: ${val}`);
  if (!observations.BEHIND && !observations.AGE_SECONDS)
    throw new Error(
      "no observation given — set BEHIND and/or AGE_SECONDS (env), or pass an input file",
    );
  for (const [key, val] of Object.entries(observations))
    if (val && !uint(val))
      throw new Error(`${key} must be a non-negative integer: ${val}`);
  const reasons: string[] = [];
  if (
    observations.BEHIND &&
    BigInt(observations.BEHIND) > BigInt(thresholds.BEHIND)
  )
    reasons.push(
      `verified pointer is ${observations.BEHIND} commits behind the default-branch tip (max ${thresholds.BEHIND})`,
    );
  if (
    observations.AGE_SECONDS &&
    BigInt(observations.AGE_SECONDS) > BigInt(thresholds.AGE_SECONDS)
  )
    reasons.push(
      `verified pointer last advanced ${observations.AGE_SECONDS}s ago (max ${thresholds.AGE_SECONDS}s)`,
    );
  if (reasons.length) {
    console.log(
      "STALLED — verification has fallen behind; page on-call / trigger a heal run.",
    );
    for (const r of reasons) console.log(`  - ${r}`);
    return 1;
  }
  console.log(
    `OK — verified pointer is fresh (behind=${observations.BEHIND || "n/a"}/${thresholds.BEHIND}, age=${observations.AGE_SECONDS || "n/a"}/${thresholds.AGE_SECONDS}s)`,
  );
  return 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}

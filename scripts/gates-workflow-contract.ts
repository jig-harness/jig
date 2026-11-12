// What gates.yml and nightly.yml must hold for the separate suites to run, which
// gates.test.ts compares them with.
export type SuiteContract = { if?: string; needs?: string; stepIf?: string };

// On pull requests the drive-pr suite runs when its area is affected, the CI
// hold is off and the event is not another label's, after the job that
// resolves the areas; every night it runs unconditionally. The website's suite
// runs in the gate-set job, which runs whenever the hold is off and the event
// is not another label's, as a step selected by the website area and run in
// the one matrix leg that takes the checks part, so no other leg repeats it.
export const DRIVE_PR_AREA = `contains(needs.areas.outputs.areas, '"drive-pr"')`;
const NOT_HELD = `!contains(github.event.pull_request.labels.*.name, 'ci:hold')`;
const NOT_A_MIRROR = `!(github.event.label.name && github.event.label.name != 'ci:hold')`;
export const PR_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${DRIVE_PR_AREA} && ${NOT_HELD} && ${NOT_A_MIRROR} }}`,
};
export const WEBSITE_STEP = `\${{ !cancelled() && contains(needs.areas.outputs.areas, '"website"') && matrix.part == 'checks' }}`;
export const PR_WEBSITE_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${NOT_HELD} && ${NOT_A_MIRROR} }}`,
  stepIf: WEBSITE_STEP,
};
// Pull requests list the hold label's events beside the default types.
export const PR_TRIGGERS = {
  pull_request: {
    types: ["opened", "synchronize", "reopened", "labeled", "unlabeled"],
  },
  push: { branches: ["main"] },
};
export const NIGHTLY_TRIGGERS = {
  schedule: [{ cron: "17 3 * * *" }],
  workflow_dispatch: null,
};

// The nightly's known-failure baseline (scripts/nightly/invocation.ts) is the
// one environment a suite's job and step may set, since it decides which
// failures fail the suite: the job names itself, and the step names the
// baseline `bun run gates` checks (scripts/check-nightly-baseline.ts) and a
// folder for its results. Any other variable, or another baseline file, does
// not count.
const NIGHTLY_ENV: Record<"job" | "step", Record<string, RegExp>> = {
  job: { JIG_NIGHTLY_JOB: /^[^\n]+$/ },
  step: {
    JIG_NIGHTLY_BASELINE: /^\.config\/nightly-baseline\.yaml$/,
    JIG_NIGHTLY_RESULTS: /^\$\{\{ runner\.temp \}\}\/nightly-results$/,
  },
};
export function nightlyEnvAllowed(
  env: unknown,
  scope: "job" | "step",
): boolean {
  if (env === undefined) return true;
  if (typeof env !== "object" || env === null || Array.isArray(env))
    return false;
  const allowed = NIGHTLY_ENV[scope];
  return Object.entries(env).every(([name, value]) => {
    const shape = allowed[name];
    return (
      shape !== undefined && typeof value === "string" && shape.test(value)
    );
  });
}

/**
 * Whether `run` takes every shard of the suite in `dir` from the job's
 * matrix, and the matrix lists every shard from 1 to the command's total.
 */
export function runsEveryShard(
  run: string,
  dir: string,
  shards: unknown,
): boolean {
  const sharded = run.match(
    new RegExp(
      `^bun run test --shard=\\$\\{\\{ matrix\\.shard \\}\\}/([1-9][0-9]*) \\./${dir.replace(/[.]/g, "\\.")}$`,
    ),
  );
  if (!sharded) return false;
  const total = Number(sharded[1]);
  return (
    Array.isArray(shards) &&
    shards.length === total &&
    shards.every((shard, i) => shard === i + 1)
  );
}

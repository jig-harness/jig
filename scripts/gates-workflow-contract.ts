// What gates.yml and nightly.yml must hold for the separate suites to run, which
// gates.test.ts compares them with.
export type SuiteContract = { if?: string; needs?: string; stepIf?: string };

// On pull requests the drive-pr suite runs when its area is affected and the
// CI hold is off, after the job that resolves the areas; every night it runs
// unconditionally. The website's suite runs in the gate-set job, which runs
// whenever the hold is off, as a step selected by the website area.
export const DRIVE_PR_AREA = `contains(needs.areas.outputs.areas, '"drive-pr"')`;
const NOT_HELD = `!contains(github.event.pull_request.labels.*.name, 'ci:hold') && !inputs.held`;
export const PR_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${DRIVE_PR_AREA} && ${NOT_HELD} }}`,
};
export const WEBSITE_STEP = `\${{ !cancelled() && contains(needs.areas.outputs.areas, '"website"') }}`;
export const PR_WEBSITE_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${NOT_HELD} }}`,
  stepIf: WEBSITE_STEP,
};
// Pull requests run on the default types alone; ci-hold.yml starts a run by
// dispatch when the hold label changes.
export const PR_TRIGGERS = {
  pull_request: { types: ["opened", "synchronize", "reopened"] },
  push: { branches: ["main"] },
  workflow_dispatch: {
    inputs: {
      pr: {
        description: "The pull request to test; dispatch from its head branch",
        type: "number",
        required: true,
      },
      held: {
        description:
          "The pull request carries the hold label, so the heavy jobs skip and `gates` cancels this run",
        type: "boolean",
        required: true,
      },
    },
  },
};
export const NIGHTLY_TRIGGERS = {
  schedule: [{ cron: "17 3 * * *" }],
  workflow_dispatch: null,
};

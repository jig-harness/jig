// What gates.yml and nightly.yml must hold for the separate suites to run, which
// gates.test.ts compares them with.
export type SuiteContract = { if?: string; needs?: string; stepIf?: string };

// On pull requests the drive-pr suite runs when its area is affected, the CI
// hold is off and the event is not another label's, after the job that
// resolves the areas; every night it runs unconditionally. The website's suite
// runs in the gate-set job, which runs whenever the hold is off and the event
// is not another label's, as a step selected by the website area.
export const DRIVE_PR_AREA = `contains(needs.areas.outputs.areas, '"drive-pr"')`;
const NOT_HELD = `!contains(github.event.pull_request.labels.*.name, 'ci:hold')`;
const NOT_A_MIRROR = `!(github.event.label.name && github.event.label.name != 'ci:hold')`;
export const PR_SUITE: SuiteContract = {
  needs: "areas",
  if: `\${{ ${DRIVE_PR_AREA} && ${NOT_HELD} && ${NOT_A_MIRROR} }}`,
};
export const WEBSITE_STEP = `\${{ !cancelled() && contains(needs.areas.outputs.areas, '"website"') }}`;
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

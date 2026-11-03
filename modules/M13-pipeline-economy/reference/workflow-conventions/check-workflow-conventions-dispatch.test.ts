// The CI hold's second form: a sibling workflow dispatches the pipeline when the
// hold label changes.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONC,
  cleanRoots,
  exits,
  holdRepo,
  holdTrigger,
  job,
  LABELS,
  PR_HOLD,
  repo,
  rulesOf,
  run,
} from "./test-support.ts";

afterEach(cleanRoots);

const HELD_INPUTS =
  "  workflow_dispatch:\n    inputs:\n      pr:\n        type: number\n      held:\n        type: boolean\n";
const REACTION_TYPES =
  "on:\n  pull_request:\n    types: [labeled, unlabeled]\n";
const REACTION_CALL = `gh workflow run ci.yml --ref "$HEAD" -f pr="$PR" -f held="$HELD"`;
const reactionJob = (jobIf: string, step: string) =>
  `jobs:\n  dispatch:\n    if: \${{ ${jobIf} }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${step}`;
const REACTION_IF = "github.event.label.name == 'hold'";
const REACTION_STEP = `      - run: ${REACTION_CALL}\n`;
const REACTION = `${REACTION_TYPES}${CONC}${reactionJob(REACTION_IF, REACTION_STEP)}`;
const GUARD = `!contains(${LABELS}, 'hold') && !inputs.held`;
const SENTINEL = `contains(${LABELS}, 'hold') || inputs.held`;

/** A workflow in the dispatched form: `ci.yml` runs on no label event and
 * `ci-hold.yml` starts it when the hold label changes. Each part can be
 * replaced, to show what the form needs. */
function dispatchedHold({
  on = `on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n${HELD_INPUTS}`,
  e2eIf = GUARD,
  stepIf = SENTINEL,
  reaction = REACTION as string | null,
} = {}) {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - ci.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for it.\nheavy-per-change .github/workflows/ci.yml e2e\n",
    ".github/workflows/ci.yml": `${on}${CONC}jobs:\n  e2e:\n    if: \${{ ${e2eIf} }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n  verdict:\n    needs: [e2e]\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - if: \${{ ${stepIf} }}\n        run: exit 1\n      - run: make verdict\n`,
    ...(reaction === null ? {} : { ".github/workflows/ci-hold.yml": reaction }),
  });
}

test("a workflow a sibling dispatches on the hold label needs no label events", () => {
  exits(run(["--root", dispatchedHold()]), 0, "the dispatched form");
  exits(
    run([
      "--root",
      dispatchedHold({
        on: `on:\n  pull_request:\n${HELD_INPUTS}`,
      }),
    ]),
    0,
    "no types: runs on the three defaults",
  );
  exits(
    run([
      "--root",
      dispatchedHold({
        reaction: `${REACTION_TYPES}${CONC}${reactionJob(
          `${REACTION_IF} && github.event.pull_request.state == 'open'`,
          `      - run: curl -fsS -X POST "$API/repos/$REPO/actions/workflows/ci.yml/dispatches" -d "{\\"ref\\":\\"$HEAD\\",\\"inputs\\":{\\"pr\\":\\"$PR\\",\\"held\\":\\"$HELD\\"}}"\n`,
        )}`,
      }),
    ]),
    0,
    "dispatching through the API, with another condition beside the label's",
  );
});

test("the dispatched form needs a reaction that tests the exact label and dispatches this workflow", () => {
  for (const [what, reaction] of [
    ["no reaction workflow", null],
    [
      "only one transition",
      `on:\n  pull_request:\n    types: [labeled]\n${CONC}${reactionJob(REACTION_IF, REACTION_STEP)}`,
    ],
    [
      "another label",
      `${REACTION_TYPES}${CONC}${reactionJob("github.event.label.name == 'on-hold'", REACTION_STEP)}`,
    ],
    [
      "a test of the label set, which any label event passes while held",
      `${REACTION_TYPES}${CONC}${reactionJob(`contains(${LABELS}, 'hold')`, REACTION_STEP)}`,
    ],
    [
      "an || beside the label's test",
      `${REACTION_TYPES}${CONC}${reactionJob(`${REACTION_IF} || github.run_attempt > 1`, REACTION_STEP)}`,
    ],
    [
      "dispatching another workflow",
      `${REACTION_TYPES}${CONC}${reactionJob(REACTION_IF, `      - run: gh workflow run other-ci.yml -f held="$HELD"\n`)}`,
    ],
    [
      "not saying whether it is held",
      `${REACTION_TYPES}${CONC}${reactionJob(REACTION_IF, `      - run: gh workflow run ci.yml --ref "$HEAD"\n`)}`,
    ],
    [
      "a step that may not run",
      `${REACTION_TYPES}${CONC}${reactionJob(REACTION_IF, `      - if: github.run_attempt > 1\n        run: ${REACTION_CALL}\n`)}`,
    ],
    [
      "a step whose failure is tolerated",
      `${REACTION_TYPES}${CONC}${reactionJob(REACTION_IF, `      - run: ${REACTION_CALL}\n        continue-on-error: true\n`)}`,
    ],
  ] as const) {
    const result = run(["--root", dispatchedHold({ reaction })]);
    exits(result, 1, what);
    expect({ what, rules: rulesOf(result.err) }).toEqual({
      what,
      rules: ["ci-hold-events"],
    });
    expect(result.err).toContain("no workflow reacts to the label");
  }
});

test("the dispatched form carries the hold in a boolean input the run honours", () => {
  for (const [what, on] of [
    ["no input", "on:\n  pull_request:\n  workflow_dispatch:\n"],
    [
      "a string input, whose 'false' is true",
      "on:\n  pull_request:\n  workflow_dispatch:\n    inputs:\n      held:\n        type: string\n",
    ],
  ] as const) {
    const result = run(["--root", dispatchedHold({ on })]);
    exits(result, 1, what);
    expect({ what, rules: rulesOf(result.err) }).toEqual({
      what,
      rules: ["ci-hold-events"],
    });
  }

  const unskipped = run([
    "--root",
    dispatchedHold({ e2eIf: `!contains(${LABELS}, 'hold')` }),
  ]);
  exits(unskipped, 1, "a heavy job that runs in full on a held dispatch");
  expect(rulesOf(unskipped.err)).toEqual(["ci-hold-guard"]);
  expect(unskipped.err).toContain("!inputs.held");

  const unfailed = run([
    "--root",
    dispatchedHold({ stepIf: `contains(${LABELS}, 'hold')` }),
  ]);
  exits(unfailed, 1, "a sentinel a held dispatch does not reach");
  expect(rulesOf(unfailed.err)).toEqual(["ci-hold-sentinel"]);
  expect(unfailed.err).toContain("|| inputs.held");
});

test("a sentinel may fire on the held input as well, and on nothing else", () => {
  const guard = `!contains(${LABELS}, 'hold')`;
  exits(
    run(["--root", holdRepo("hold", guard, SENTINEL)]),
    0,
    "listing the label events itself, with the input beside the label's test",
  );
  for (const spelling of [
    `contains(${LABELS}, 'hold') || inputs.other`,
    `contains(${LABELS}, 'hold') && inputs.held`,
    "inputs.held",
  ]) {
    const result = run(["--root", holdRepo("hold", guard, spelling)]);
    exits(result, 1, spelling);
    expect({ spelling, rules: rulesOf(result.err) }).toEqual({
      spelling,
      rules: ["ci-hold-sentinel"],
    });
  }
});

test("a cheap workflow leaves a dispatched hold with no label events, no guard and no exception", () => {
  const root = dispatchedHold();
  writeFileSync(
    join(root, ".github/workflows/docs.yml"),
    `on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n${CONC}jobs:\n${job("docs")}`,
  );
  const result = run(["--root", root]);
  exits(result, 0, "outside the hold, and the reaction does not name it");
  expect(result.out).toContain("1 exception(s)");

  writeFileSync(
    join(root, ".config/workflow-conventions.yaml"),
    "heavy:\n  - ci.yml#e2e\n  - docs.yml#docs\n",
  );
  const declared = run(["--root", root]);
  exits(declared, 1, "still declared heavy, it is still in the hold");
  expect(rulesOf(declared.err)).toEqual([
    "ci-hold-events",
    "ci-hold-guard",
    "heavy-per-change",
  ]);
});

/** A required workflow and a heavy one, both dispatched on the hold label; the
 * heavy one's pull-request trigger carries `filter`. */
function filteredHeavy(filter: string, exceptions = "") {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml": "heavy:\n  - e2e.yml#e2e\n",
    ".config/workflow-conventions-exceptions.txt": `# The merge waits for it.\nheavy-per-change .github/workflows/e2e.yml e2e\n${exceptions}`,
    ".github/workflows/ci.yml": `on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n${HELD_INPUTS}${CONC}jobs:\n  verdict:\n    if: \${{ !cancelled() }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - if: \${{ ${SENTINEL} }}\n        run: exit 1\n`,
    ".github/workflows/e2e.yml": `on:\n  pull_request:\n    types: [opened, synchronize, reopened]\n    ${filter}\n${HELD_INPUTS}${CONC}jobs:\n  e2e:\n    if: \${{ ${GUARD} }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n`,
    ".github/workflows/ci-hold.yml": `${REACTION_TYPES}${CONC}${reactionJob(
      REACTION_IF,
      `      - run: |\n          ${REACTION_CALL}\n          gh workflow run e2e.yml --ref "$HEAD" -f pr="$PR" -f held="$HELD"\n`,
    )}`,
  });
}

test("a path filter on a dispatched workflow is reported, since the dispatched run ignores it", () => {
  for (const filter of ['paths: ["src/**"]', 'paths-ignore: ["docs/**"]']) {
    const result = run(["--root", filteredHeavy(filter)]);
    exits(result, 1, filter);
    expect({ filter, rules: rulesOf(result.err) }).toEqual({
      filter,
      rules: ["ci-hold-paths"],
    });
    expect(result.err).toContain(
      ".github/workflows/e2e.yml:2: [ci-hold-paths]",
    );
    expect(result.err).toContain("whatever the pull request changed");
  }
  exits(
    run([
      "--root",
      filteredHeavy(
        'paths: ["src/**"]',
        "\n# The release may run it on any change: it costs little.\nci-hold-paths .github/workflows/e2e.yml\n",
      ),
    ]),
    0,
    "a repository accepts the cost with a reason",
  );
});

test("a path filter is no finding where label events start the workflow", () => {
  const root = holdTrigger(PR_HOLD);
  writeFileSync(
    join(root, ".config/workflow-conventions.yaml"),
    "heavy:\n  - ci.yml#e2e\n  - e2e.yml#e2e\n",
  );
  writeFileSync(
    join(root, ".config/workflow-conventions-exceptions.txt"),
    "# The merge waits for them.\nheavy-per-change .github/workflows/ci.yml e2e\nheavy-per-change .github/workflows/e2e.yml e2e\n",
  );
  writeFileSync(
    join(root, ".github/workflows/e2e.yml"),
    `on:\n  pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled]\n    paths: ["src/**"]\n${CONC}jobs:\n  e2e:\n    if: \${{ !contains(${LABELS}, 'hold') }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n`,
  );
  exits(run(["--root", root]), 0, "label events respect the filter");
});

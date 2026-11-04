// The CI hold's mirror form: on an event for a label other than the hold's,
// the heavy jobs skip, the run cancels nothing, and the required job repeats the
// newest real run's result.
import { afterEach, expect, test } from "bun:test";
import {
  CONC,
  cleanRoots,
  exits,
  holdTrigger,
  LABELS,
  PR_HOLD,
  repo,
  rulesOf,
  run,
  SENTINEL_STEP,
} from "./test-support.ts";

afterEach(cleanRoots);

const OTHER = "github.event.label.name && github.event.label.name != 'hold'";
const RUN_NAME = `run-name: \${{ ${OTHER} && format('ci mirror ({0} label)', github.event.label.name) || github.event_name == 'pull_request' && format('ci - {0}', github.event.pull_request.title) || '' }}\n`;
const GROUP = `concurrency:\n  group: ci-\${{ ${OTHER} && format('mirror-{0}', github.run_id) || github.ref }}\n  cancel-in-progress: true\n`;
const SKIP = `!(${OTHER})`;
const HEAVY_IF = `!contains(${LABELS}, 'hold') && ${SKIP}`;
const MIRROR_STEP = `      - if: \${{ ${OTHER} }}\n        run: ./repeat-newest-real-run\n`;
const JUDGE_STEP = `      - if: \${{ ${SKIP} }}\n        run: make verdict\n`;

/** A workflow in the mirror form; each part can be replaced to show what the
 * form needs. */
function mirrored({
  runName = RUN_NAME,
  group = GROUP,
  e2eIf = HEAVY_IF,
  lintIf = HEAVY_IF,
  verdictIf = "!cancelled()",
  verdictSteps = `${SENTINEL_STEP}${MIRROR_STEP}${JUDGE_STEP}`,
} = {}) {
  return repo({
    ".config/jig.yaml": `ci:\n  required_checks: [verdict]\n  hold_label: "hold"\n`,
    ".config/workflow-conventions.yaml":
      "heavy:\n  - ci.yml#e2e\n  - ci.yml#lint\n",
    ".config/workflow-conventions-exceptions.txt":
      "# The merge waits for them.\nheavy-per-change .github/workflows/ci.yml\n",
    ".github/workflows/ci.yml": `${runName}${PR_HOLD}${group}jobs:\n  e2e:\n    if: \${{ ${e2eIf} }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make e2e\n  lint:\n    if: \${{ ${lintIf} }}\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: make lint\n  verdict:\n    needs: [e2e, lint]\n    if: \${{ ${verdictIf} }}\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n${verdictSteps}`,
  });
}

/** Runs the lint and expects exactly the `ci-hold-mirror` finding(s), with
 * `reported` among the messages. */
function failsMirror(
  root: string,
  what: string,
  reported: string,
  rules = ["ci-hold-mirror"],
) {
  const result = run(["--root", root]);
  exits(result, 1, what);
  expect({ what, rules: rulesOf(result.err) }).toEqual({ what, rules });
  expect(result.err).toContain(reported);
}

test("a workflow in the mirror form passes, beside one in the existing form", () => {
  exits(run(["--root", mirrored()]), 0, "the mirror form");
  exits(run(["--root", holdTrigger(PR_HOLD)]), 0, "the existing form");
});

test("a workflow that skips on other labels' events needs a step that repeats the real result", () => {
  failsMirror(
    mirrored({ verdictSteps: `${SENTINEL_STEP}      - run: make verdict\n` }),
    "no mirror step",
    "required job 'verdict' has no step that runs only on another label's event",
  );
  for (const [what, step] of [
    [
      "a step whose failure is tolerated",
      `      - if: \${{ ${OTHER} }}\n        run: ./repeat\n        continue-on-error: true\n`,
    ],
    [
      "a step with another condition beside the label test",
      `      - if: \${{ ${OTHER} && github.run_attempt == 1 }}\n        run: ./repeat\n`,
    ],
    [
      "a step for another label",
      `      - if: \${{ github.event.label.name && github.event.label.name != 'on-hold' }}\n        run: ./repeat\n`,
    ],
  ] as const)
    failsMirror(
      mirrored({ verdictSteps: `${SENTINEL_STEP}${step}${JUDGE_STEP}` }),
      what,
      "has no step that runs only on another label's event",
    );
});

test("a mirror run takes a concurrency group of its own", () => {
  failsMirror(
    mirrored({ group: CONC }),
    "the pull request's group",
    "its concurrency group",
  );
  failsMirror(
    mirrored({
      group: `concurrency:\n  group: ci-\${{ ${OTHER} && github.ref || github.sha }}\n  cancel-in-progress: true\n`,
    }),
    "a group keyed by the ref, not the run",
    "its concurrency group",
  );
  failsMirror(
    mirrored({
      group: `concurrency:\n  group: ci-\${{ ${OTHER} && format('mirror-{0}', 'github.run_id') || github.ref }}\n  cancel-in-progress: true\n`,
    }),
    "the run id only as quoted text, one key for every mirror",
    "its concurrency group",
  );
  failsMirror(
    mirrored({
      group: `concurrency:\n  group: ci-\${{ ${OTHER} && github.run_id && 'mirror' || github.ref }}\n  cancel-in-progress: true\n`,
    }),
    "a key that reads the run id and drops it",
    "its concurrency group",
  );
  exits(
    run([
      "--root",
      mirrored({
        group: `concurrency:\n  group: ci-\${{ ${OTHER} && github.run_id || github.ref }}\n  cancel-in-progress: true\n`,
      }),
    ]),
    0,
    "the run id alone as the key",
  );
});

test("a mirror run is marked by run-name", () => {
  failsMirror(mirrored({ runName: "" }), "no run-name", "no run-name");
  failsMirror(
    mirrored({ runName: "run-name: ci\n" }),
    "a run-name that marks nothing",
    "no run-name",
  );
  for (const [what, name] of [
    ["the same name for mirror and real runs", `'ci' || 'ci'`],
    [
      "a real run left to its default name",
      `format('ci mirror ({0} label)', github.event.label.name) || ''`,
    ],
    [
      "a distinct name only where no pull-request run reaches it",
      `'ci mirror' || github.event_name == 'pull_request' && 'ci mirror' || 'ci real'`,
    ],
    [
      "a real run's name that starts like the mirror's",
      `'ci mirror' || format('ci mirror - {0}', github.event.pull_request.title)`,
    ],
  ] as const)
    failsMirror(
      mirrored({ runName: `run-name: \${{ ${OTHER} && ${name} }}\n` }),
      what,
      "no run-name",
    );
});

test("a job that decides on the label event in another form is a finding, never a pass", () => {
  for (const [what, cond] of [
    [
      "a skip on any label event",
      `!contains(${LABELS}, 'hold') && github.event.label.name == ''`,
    ],
    [
      "a skip on one action",
      `!contains(${LABELS}, 'hold') && github.event.action != 'labeled'`,
    ],
    [
      "the other-label test spelled another way",
      `!contains(${LABELS}, 'hold') && github.event.label.name == 'hold'`,
    ],
    [
      "an index into the event",
      `!contains(${LABELS}, 'hold') && github.event['label'].name == ''`,
    ],
    [
      "an action compared in capitals",
      `!contains(${LABELS}, 'hold') && github.event.action != 'LABELED'`,
    ],
    [
      "an action that names no label",
      `!contains(${LABELS}, 'hold') && github.event.action == 'synchronize'`,
    ],
  ] as const) {
    const result = run([
      "--root",
      mirrored({
        e2eIf: cond,
        lintIf: `!contains(${LABELS}, 'hold')`,
        runName: "",
        group: CONC,
        verdictSteps: `${SENTINEL_STEP}      - run: make verdict\n`,
      }),
    ]);
    exits(result, 1, what);
    expect({ what, rules: rulesOf(result.err) }).toEqual({
      what,
      rules: ["ci-hold-guard"],
    });
    expect(result.err).toContain(
      "job 'e2e' decides on the event's action or label in a form the lint cannot prove safe",
    );
  }
});

test("the required job runs on other labels' events, and every heavy job skips", () => {
  failsMirror(
    mirrored({ verdictIf: `!cancelled() && ${SKIP}` }),
    "a required job that skips",
    "required job 'verdict' skips on another label's event",
    ["aggregator-unless-cancelled", "ci-hold-mirror", "ci-hold-sentinel"],
  );
  failsMirror(
    mirrored({ lintIf: `!contains(${LABELS}, 'hold')` }),
    "a heavy job that runs in full",
    "heavy job 'lint' runs in full on another label's event",
  );
});

test("the mirror step alone puts a workflow in the mirror form", () =>
  failsMirror(
    mirrored({
      e2eIf: `!contains(${LABELS}, 'hold')`,
      lintIf: `!contains(${LABELS}, 'hold')`,
      runName: "",
      group: CONC,
    }),
    "a mirror step with nothing else of the form",
    "heavy job 'e2e' runs in full on another label's event",
  ));

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sweepFindings } from "../scripts/lib/sweep-fit.ts";

const scratch = mkdtempSync(join(tmpdir(), "sweep-fit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A repository holding `files`, and the paths it tracks. */
function repo(files: Record<string, string>): {
  root: string;
  tracked: string[];
} {
  const root = join(scratch, `repo-${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, tracked: Object.keys(files) };
}

const tracker = { issue_tracker: { adapter: "github" } };

describe("the audit's sweep finding", () => {
  it("names a repository that keeps facets and runs no sweep", () => {
    const { root, tracked } = repo({
      ".github/workflows/ci.yml": "jobs: {}\n",
      // A document naming the command runs nothing.
      "docs/issues.md": "Run check-fields.ts check --yes weekly.\n",
      ".github/workflows/move.yml":
        "steps:\n  - run: bun check-fields.ts move --record r.json\n",
    });
    expect(sweepFindings(tracker, root, tracked).map((f) => f.id)).toEqual([
      "suggestion:issue_tracker.sweep",
    ]);
  });

  it("says nothing of a repository whose workflow or timer runs the sweep", () => {
    const workflow = repo({
      ".github/workflows/issue-fields.yml":
        "on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  sweep:\n    steps:\n      - run: bun plugin/skills/file-issue/scripts/check-fields.ts check --yes\n",
    });
    expect(sweepFindings(tracker, workflow.root, workflow.tracked)).toEqual([]);
    const timer = repo({
      "systemd/issue-fields.timer":
        "[Timer]\nOnCalendar=weekly\n[Install]\nWantedBy=timers.target\n",
      "systemd/issue-fields.service":
        'ExecStart=bun "$PLUGIN/skills/file-issue/scripts/check-fields.ts" --yes\n',
    });
    expect(sweepFindings(tracker, timer.root, timer.tracked)).toEqual([]);
    const positioned = repo({
      "systemd/issue-fields.timer":
        "[Timer]\nOnCalendar=weekly\n[Install]\nWantedBy=timers.target\n",
      "systemd/issue-fields.service":
        'ExecStart=bun "$PLUGIN/skills/file-issue/scripts/check-fields.ts" check --yes --position state/issue-fields-position.json\n',
    });
    expect(sweepFindings(tracker, positioned.root, positioned.tracked)).toEqual(
      [],
    );
  });

  it("says nothing of a repository that keeps no tracker", () => {
    const { root, tracked } = repo({ "README.md": "hello\n" });
    expect(sweepFindings({ drive: {} }, root, tracked)).toEqual([]);
  });
});

it("does not count comments, report mode, disabled jobs or unscheduled workflows", () => {
  for (const body of [
    "on: push\njobs:\n  s:\n    steps:\n      - run: bun check-fields.ts check --yes\n",
    "on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: '# TODO: bun check-fields.ts check --yes'\n",
    "on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: bun check-fields.ts check\n",
    "on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    if: false\n    steps:\n      - run: bun check-fields.ts check --yes\n",
  ]) {
    const { root, tracked } = repo({ ".github/workflows/sweep.yml": body });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

it("keeps the shipped sweep advisory because preceding actions may fail", () => {
  const root = process.cwd();
  expect(
    sweepFindings(tracker, root, [".github/workflows/issue-fields.yml"]),
  ).toHaveLength(1);
});

it("does not mistake a comment or quoted argument for a sweep", () => {
  for (const run of [
    "bun unrelated.ts # check-fields.ts check --yes",
    "bun unrelated.ts;#/check-fields.ts check --yes",
    "bun unrelated.ts&&#/check-fields.ts check --yes",
    "bun */check-fields.ts check --yes",
    "bun foo/$(echo check-fields.ts) check --yes",
    "bun unrelated.ts 'check-fields.ts check --yes'",
  ]) {
    const { root, tracked } = repo({
      ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
    });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

it("keeps workflows with uncertain dependency reachability advisory", () => {
  for (const needs of ["prerequisite", "[prerequisite]", "[missing]"]) {
    const { root, tracked } = repo({
      ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  prerequisite:\n    if: false\n    steps: []\n  sweep:\n    needs: ${needs}\n    steps:\n      - run: bun check-fields.ts check --yes\n`,
    });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

it("requires a validated weekly cron cadence in workflows and crontabs", () => {
  for (const cron of ["0 0 1 1 *", "99 99 * * 1", "x y * * 1", "0 0 * 1 1"]) {
    for (const files of [
      { "jobs.cron": `${cron} bun check-fields.ts check --yes\n` },
      {
        ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '${cron}'\njobs:\n  s:\n    steps:\n      - run: bun check-fields.ts check --yes\n`,
      },
    ]) {
      const { root, tracked } = repo(files);
      expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
    }
  }
  const { root, tracked } = repo({
    "jobs.cron": "37 5 * * 1 bun check-fields.ts check --yes\n",
  });
  expect(sweepFindings(tracker, root, tracked)).toEqual([]);
});

it("keeps uncertain preceding steps advisory", () => {
  for (const prior of [
    "run: exit 1",
    "run: echo ready",
    "uses: actions/checkout@v4",
  ]) {
    const { root, tracked } = repo({
      ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - ${prior}\n      - run: bun check-fields.ts check --yes\n`,
    });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

it("recognizes the supported status wrapper without preceding steps", () => {
  const run = `status=0
bun check-fields.ts check --yes > "$RUNNER_TEMP/sweep.txt" || status=$?
cat "$RUNNER_TEMP/sweep.txt"
{ echo 'text'; cat "$RUNNER_TEMP/sweep.txt"; echo 'end'; } >> "$GITHUB_STEP_SUMMARY"
exit "$status"`;
  const { root, tracked } = repo({
    ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
  });
  expect(sweepFindings(tracker, root, tracked)).toEqual([]);
});

it("keeps redirections and shell expansions outside the validated wrapper advisory", () => {
  const wrapper = `status=0
bun check-fields.ts check --yes > "$RUNNER_TEMP/sweep.txt" || status=$?
cat "$RUNNER_TEMP/sweep.txt"
{ echo 'text'; cat "$RUNNER_TEMP/sweep.txt"; echo 'end'; } >> "$GITHUB_STEP_SUMMARY"
exit "$status"`;
  for (const run of [
    'bun check-fields.ts check --yes > "$(exit 1)" || status=$?',
    'bun check-fields.ts check --yes > "$RUNNER_TEMP/sweep.txt" || status=$?',
    wrapper.replace("$RUNNER_TEMP/sweep.txt", "$(exit 1)"),
    wrapper.replace('cat "$RUNNER_TEMP/sweep.txt"', 'cat "$(exit 1)"'),
    wrapper.replace("$GITHUB_STEP_SUMMARY", "$(exit 1)"),
  ]) {
    const { root, tracked } = repo({
      ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
    });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

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

it("recognizes the shipped guarded sweep with its status wrapper", () => {
  const root = process.cwd();
  expect(
    sweepFindings(tracker, root, [".github/workflows/issue-fields.yml"]),
  ).toEqual([]);
});

it("does not mistake a comment or quoted argument for a sweep", () => {
  for (const run of [
    "bun unrelated.ts # check-fields.ts check --yes",
    "bun unrelated.ts 'check-fields.ts check --yes'",
  ]) {
    const { root, tracked } = repo({
      ".github/workflows/sweep.yml": `on:\n  schedule:\n    - cron: '37 5 * * 1'\njobs:\n  s:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
    });
    expect(sweepFindings(tracker, root, tracked)).toHaveLength(1);
  }
});

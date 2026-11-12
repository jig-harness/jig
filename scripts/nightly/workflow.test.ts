// The nightly workflow's wiring of the baseline and the report: what the
// report job reads only arrives when every job holds up its end.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../lib/record.ts";
import { load } from "../../lib/vendor/js-yaml.mjs";
import { BASELINE_ENV, JOB_ENV, RESULTS_ENV } from "./invocation.ts";

const workflow = load(
  readFileSync(
    join(import.meta.dir, "../../.github/workflows/nightly.yml"),
    "utf8",
  ),
) as { jobs: Record<string, Record<string, unknown>> };
const steps = (job: Record<string, unknown>) =>
  (job.steps as unknown[]).filter(isRecord);
const testJobs = Object.entries(workflow.jobs).filter(
  ([id]) => id !== "report",
);

test("each job names itself to its results as GitHub names it", () => {
  for (const [, job] of testJobs)
    expect((job.env as Record<string, string>)[JOB_ENV]).toBe(
      job.name as string,
    );
});

test("each job's gate or suite step names the baseline and a results folder, other test steps are named, and every job keeps its results", () => {
  for (const [id, job] of testJobs) {
    const runsTests = steps(job).filter(
      (step) =>
        typeof step.run === "string" &&
        /^bun run (test|gates)\b/.test(step.run),
    );
    const classified = runsTests.filter(
      (step) => isRecord(step.env) && step.env[BASELINE_ENV],
    );
    expect({ id, classified: classified.length }).toEqual({
      id,
      classified: 1,
    });
    // Any other test step is a smoke check that reports through the job's own
    // outcome, not through named failures: it is the one step the workflow
    // names here, so an added test step that reports nothing fails this test.
    const unclassified = runsTests
      .filter((step) => !classified.includes(step))
      .map((step) => step.run);
    expect({ id, unclassified }).toEqual({
      id,
      unclassified:
        id === "platform-gates"
          ? [
              "bun run test --timeout 60000 tools/plugin/powershell-smoke.test.ts --test-name-pattern PowerShell",
            ]
          : [],
    });
    expect(classified[0]?.env).toMatchObject({
      [BASELINE_ENV]: ".config/nightly-baseline.yaml",
      [RESULTS_ENV]: `\${{ runner.temp }}/nightly-results`,
    });
    const upload = steps(job).find((step) =>
      String(step.uses).startsWith("actions/upload-artifact@"),
    );
    expect(upload).toMatchObject({
      if: "always()",
      with: { path: `\${{ runner.temp }}/nightly-results` },
    });
  }
});

test("the report waits for every other job, and reports only main's runs", () => {
  const report = workflow.jobs.report ?? {};
  expect([...(report.needs as string[])].sort()).toEqual(
    testJobs.map(([id]) => id).sort(),
  );
  expect(report.if).toBe(
    `\${{ !cancelled() && github.ref == 'refs/heads/main' }}`,
  );
  expect(report.permissions).toEqual({
    contents: "read",
    actions: "read",
    issues: "write",
  });
});

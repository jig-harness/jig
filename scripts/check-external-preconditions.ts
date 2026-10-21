// Jig's live registry and its one GitHub issue. Never used as a per-PR host gate.
import { readFileSync } from "node:fs";
import { cli, strictOptions } from "../lib/cli.ts";
import { isRecord } from "../plugin/shared/guards.ts";
import { branchProtection } from "../modules/M10-environments-deploy/reference/external-preconditions/branch-protection.ts";
import { githubIssues } from "../modules/M10-environments-deploy/reference/external-preconditions/github-issues.ts";
import { ghProcess } from "../modules/M10-environments-deploy/reference/external-preconditions/deadline.ts";
import {
  reconcilePreconditions,
  type TrackerPort,
} from "../modules/M10-environments-deploy/reference/external-preconditions/reconcile.ts";
import {
  PreconditionError,
  parseRegistry,
  runRegistry,
  type Check,
  type Report,
} from "../modules/M10-environments-deploy/reference/external-preconditions/registry.ts";

export async function verifyPreconditions(
  raw: string,
  tracker: TrackerPort,
  checks: Record<string, Check>,
  observed?: Record<string, unknown>,
): Promise<Report> {
  let report: Report;
  try {
    report = await runRegistry(parseRegistry(raw), {
      checks,
      ...(observed ? { input: observed } : {}),
    });
  } catch (error) {
    // A broken declaration is red operational state too, never permission to close.
    report = {
      status: "fail",
      entries: [
        {
          id: "registry",
          kind: "registry",
          owner: "maintainers",
          status: "unknown",
          outcome: "unknown",
          reasons: [String(error)],
          remediation:
            "Repair .config/external-preconditions.yaml and rerun the check.",
        },
      ],
    };
  }
  const body = report.entries
    .map((entry) =>
      [
        `### ${entry.id}: ${entry.outcome}`,
        `Owner: ${entry.owner}`,
        ...entry.reasons.map((reason) => `- ${reason}`),
        `Recovery: ${entry.remediation}`,
        ...(entry.waiver
          ? [
              `Waiver: ${entry.waiver.reason}; approver: ${entry.waiver.approved_by}; expires: ${entry.waiver.expires}`,
            ]
          : []),
      ].join("\n\n"),
    )
    .join("\n\n");
  await reconcilePreconditions(tracker, {
    key: "jig-delivery",
    title: "External preconditions require attention",
    body,
    healthy: report.status === "pass",
  });
  return report;
}
/**
 * The scheduled workflow's reading job, which holds the App key and runs
 * nothing from the repository, hands its observations over as data. An
 * unavailable file leaves every entry without observation, so it stays red.
 */
function observedInput(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed)) return parsed;
    console.error(`${path} does not map precondition ids to observations`);
  } catch (error) {
    console.error(`observations unavailable: ${String(error)}`);
  }
  return {};
}
async function main(): Promise<number> {
  const { values } = strictOptions(
    {
      args: process.argv.slice(2),
      options: { observed: { type: "string" } },
    },
    "usage: bun scripts/check-external-preconditions.ts [--observed FILE]",
  );
  const observed =
    values.observed === undefined ? undefined : observedInput(values.observed);
  // Capture the reader before switching the tracker adapter to its own identity.
  const readApi = ghProcess();
  const check: Check =
    observed || process.env.GH_TOKEN
      ? branchProtection(readApi)
      : () => {
          throw new PreconditionError(
            "Consuming App token unavailable; live access denied",
          );
        };
  const issueToken = process.env.PRECONDITIONS_ISSUE_TOKEN;
  if (!issueToken)
    throw new PreconditionError(
      "PRECONDITIONS_ISSUE_TOKEN is required for issue reconciliation",
    );
  // Issue writes carry their own token so the App never needs issue-write
  // permission.
  const issueApi = ghProcess({ GH_TOKEN: issueToken });
  let raw: string;
  try {
    raw = readFileSync(".config/external-preconditions.yaml", "utf8");
  } catch (error) {
    raw = String(error);
  }
  const report = await verifyPreconditions(
    raw,
    githubIssues("jig-harness/jig", "github-actions[bot]", issueApi),
    { "branch-protection": check },
    observed,
  );
  console.log(JSON.stringify(report, null, 2));
  return report.status === "pass" ? 0 : 1;
}
if (import.meta.main) cli(main);

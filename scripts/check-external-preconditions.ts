// Jig's live registry and its one GitHub issue. Never used as a per-PR host gate.
import { readFileSync } from "node:fs";
import { cli } from "../lib/cli.ts";
import { branchProtection } from "../modules/M10-environments-deploy/reference/external-preconditions/branch-protection.ts";
import { githubIssues } from "../modules/M10-environments-deploy/reference/external-preconditions/github-issues.ts";
import { spawnSync } from "../plugin/shared/guarded-git-spawn.ts";
import { gitEnv } from "../plugin/skills/changelog/scripts/notes-dir.ts";
import { ghApi } from "../plugin/skills/changelog/scripts/github-rules.ts";
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
): Promise<Report> {
  let report: Report;
  try {
    report = await runRegistry(parseRegistry(raw), { checks });
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
async function main(): Promise<number> {
  if (process.argv.length > 2)
    throw new PreconditionError(
      "usage: bun scripts/check-external-preconditions.ts",
    );
  // Capture the reader before switching the tracker adapter to its own identity.
  const readApi = ghApi();
  const check: Check = process.env.GH_TOKEN
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
  // ghApi reads its environment on each call; use an explicit child environment
  // for issue writes so the App never needs issue-write permission.
  const issueApi: ReturnType<typeof ghApi> = (args) => {
    const result = spawnSync("gh", ["api", ...args], {
      env: { ...gitEnv(), GH_TOKEN: issueToken },
      timeout: 30_000,
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr || result.error?.message || "",
    };
  };
  let raw: string;
  try {
    raw = readFileSync(".config/external-preconditions.yaml", "utf8");
  } catch (error) {
    raw = String(error);
  }
  const report = await verifyPreconditions(
    raw,
    githubIssues("jig-harness/jig", issueApi),
    { "branch-protection": check },
  );
  console.log(JSON.stringify(report, null, 2));
  return report.status === "pass" ? 0 : 1;
}
if (import.meta.main) cli(main);

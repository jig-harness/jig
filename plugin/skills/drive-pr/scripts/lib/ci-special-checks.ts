/** Named CI exceptions, read from reviewed policy, and their conservative classification. */
import { readPolicySnapshot } from "../../../../shared/autonomy.ts";
import { readConfig } from "../../../../shared/consumer.ts";
import {
  DecodeError,
  isRecord,
  isDistinctNameList,
} from "../../../../shared/guards.ts";
import type { ParkedDecision } from "../../../../shared/decisions/park.ts";

export interface SpecialCiSettings {
  holdSentinels: string[];
  advisoryChecks: string[];
}

/** Lists match whole check names, preserving punctuation and case. */
export function specialCiSettings(
  config: Record<string, unknown>,
): SpecialCiSettings {
  const ci = config.ci;
  // Repository configuration treats null as an explicit unset value unless a
  // schema field opts out. `ci` and these optional lists do not opt out.
  if (ci !== undefined && ci !== null && !isRecord(ci))
    throw new DecodeError("CI policy", "$.ci", "ci must be a mapping");
  const list = (key: string): string[] => {
    const value = isRecord(ci) ? ci[key] : undefined;
    if (value === undefined || value === null) return [];
    if (!isDistinctNameList(value))
      throw new DecodeError(
        "CI policy",
        `$.ci.${key}`,
        `ci.${key} must be a list of distinct nonempty check names`,
      );
    return value;
  };
  return {
    holdSentinels: list("hold_sentinels"),
    advisoryChecks: list("advisory_checks"),
  };
}

/** A running drive trusts its base branch, never a PR's edited configuration. */
export function reviewedSpecialCiSettings(): SpecialCiSettings {
  const policy = readPolicySnapshot();
  if (policy.from === "unreadable") {
    console.error(
      `CI exception policy unreadable: ${policy.reason}; no held-sentinel or advisory exceptions apply.`,
    );
    return { holdSentinels: [], advisoryChecks: [] };
  }
  const settings = specialCiSettings(
    policy.from === "base" ? policy.values : readConfig(),
  );
  if (policy.from === "base" && policy.bound !== undefined) {
    const bound = specialCiSettings(policy.bound.values);
    settings.advisoryChecks = settings.advisoryChecks.filter((n) =>
      bound.advisoryChecks.includes(n),
    );
    settings.holdSentinels = settings.holdSentinels.filter((n) =>
      bound.holdSentinels.includes(n),
    );
  }
  return settings;
}

/** Held failures are not green; advisory failures remain failures until a person decides. */
export function classifyFailures(
  names: readonly string[],
  sentinels: readonly string[],
  advisory: readonly string[],
  held: boolean,
) {
  const holding = names.filter((n) => held && sentinels.includes(n));
  const remaining = names.filter((n) => !holding.includes(n));
  return {
    held: holding,
    advisory: remaining.filter((n) => advisory.includes(n)),
    repair: remaining.filter((n) => !advisory.includes(n)),
  };
}

/** M13's exact hold-label test, optionally wrapped in an expression. */
function holds(value: unknown, label: string): boolean {
  if (typeof value !== "string") return false;
  const bare = value
    .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
    .replace(/\s/g, "");
  return (
    bare === `contains(github.event.pull_request.labels.*.name,'${label}')` ||
    bare === `contains(github.event.pull_request.labels.*.name,"${label}")`
  );
}

/** Canonical shell sentinel: a terminal, unconditional exit, with no earlier exit path. */
function terminalFailure(run: string): boolean {
  const lines = run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return (
    lines.at(-1) === "exit 1" &&
    !lines
      .slice(0, -1)
      .some((line) => /(?:^|[;\s])(?:exit|exec|return|trap)\b/.test(line))
  );
}

/** Names of jobs whose M13 step blocks a held head; unknown shapes require configuration. */
export function sentinelNames(workflow: unknown, label: string): string[] {
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return [];
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    if (
      !isRecord(job) ||
      job["continue-on-error"] !== undefined ||
      !Array.isArray(job.steps)
    )
      return [];
    const condition =
      typeof job.if === "string"
        ? job.if.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "").trim()
        : undefined;
    const runsHeld =
      condition === "!cancelled()" ||
      (condition === undefined && job.needs === undefined);
    const matches = job.steps.some(
      (step) =>
        isRecord(step) &&
        typeof step.run === "string" &&
        terminalFailure(step.run) &&
        step["continue-on-error"] === undefined &&
        ((runsHeld && holds(step.if, label)) ||
          (holds(job.if, label) &&
            job.needs === undefined &&
            step.if === undefined)),
    );
    const name = job.name ?? id;
    return matches && typeof name === "string" && !name.includes("${{")
      ? [name]
      : [];
  });
}

/** The decision handed to a person, with bounded work for each choice. */
export function advisoryDecision(names: readonly string[]): ParkedDecision {
  return {
    schema: "parked-decision/v1",
    class: "reviewer-posture",
    call: {
      id: "a",
      question: `How should the failing advisory checks (${names.join(", ")}) be handled?`,
      options: [
        {
          id: "fix",
          name: "Fix the finding",
          summary: "Run one CI repair pass aimed at these findings.",
          pay: ["One repair pass and the validation its changes need."],
        },
        {
          id: "waive",
          name: "Waive it",
          summary:
            "Record your waiver on the pull request; the checks remain visibly failing and branch protection still applies.",
          pay: ["You accept the findings on this head."],
        },
        {
          id: "manual",
          name: "Leave it to me",
          summary: "Keep the drive stopped while you handle the findings.",
          pay: ["Your time to resolve the findings and re-arm the drive."],
        },
      ],
      recommended: "fix",
      why: "Repairing the finding preserves the check's protection without accepting its risk.",
    },
    steps: [],
    alreadyDone:
      "Review converged; no CI repair pass has been spent on these advisory failures.",
  };
}

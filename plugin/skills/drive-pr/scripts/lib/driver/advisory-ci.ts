/** Park advisory-only CI failures once per head and exact set of check names. */
import { createHash } from "node:crypto";
import { layeredConfig } from "../../../../../shared/consumer.ts";
import { parkClasses } from "../../../../../shared/autonomy.ts";
import {
  advisoryDecision,
  reviewedSpecialCiSettings,
} from "../ci-special-checks.ts";
import { helperTimeoutSeconds, run, tsArgv } from "../proc.ts";
import { driveState } from "./paths.ts";
import type { ResolutionReceipt } from "../state/resolution-receipt.ts";
import { readDriveState } from "./rearm.ts";

/** The same head and findings share one park, without parsing check-name delimiters. */
export function advisoryKey(head: string, names: readonly string[]): string {
  return `ci-advisory-${head}-${createHash("sha256")
    .update(JSON.stringify([...new Set(names)].sort()))
    .digest("hex")
    .slice(0, 16)}`;
}

export type AdvisoryAction =
  | "ordinary"
  | "fix"
  | "waive"
  | "manual"
  | "parked"
  | "failed";

/** A person's consumed structured choice is the only authority to waive or repair this finding. */
export async function advisoryAction(
  pr: string,
  head: string,
  names: readonly string[],
): Promise<AdvisoryAction> {
  const settings = reviewedSpecialCiSettings();
  if (
    names.length === 0 ||
    !names.every((n) => settings.advisoryChecks.includes(n)) ||
    !parkClasses(layeredConfig()).includes("reviewer-posture")
  )
    return "ordinary";
  const key = advisoryKey(head, names);
  const state = await readDriveState(pr, true);
  if (state === null) return "failed";
  const receipt = state.resolvedParks?.findLast(
    (r) => r.key === key && r.outcome === "answered",
  );
  if (receipt !== undefined) {
    return await receiptAction(pr, key, receipt);
  }
  if (state.parked.some((p) => p.key === key)) return "parked";
  const result = await run(
    tsArgv(driveState, [
      "park",
      pr,
      "--key",
      key,
      "--kind",
      "finding",
      "--class",
      "reviewer-posture",
    ]),
    {
      stdin: JSON.stringify(advisoryDecision(names)),
      stdout: "pipe",
      stderr: "pipe",
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (result.code !== 0)
    console.error(`could not park advisory CI: ${result.stderr}`);
  return result.code === 0 ? "parked" : "failed";
}

/** Interpret the consumed person's choice without guessing from free text. */
async function receiptAction(
  pr: string,
  key: string,
  receipt: ResolutionReceipt,
): Promise<AdvisoryAction> {
  const choices = [...new Set(receipt.answers.map((a) => a.choice?.option))];
  if (choices.length === 1 && choices[0] === "fix") {
    return await claimRepair(pr, key, receipt.resolvedAt);
  }
  if (
    choices.length === 1 &&
    (choices[0] === "waive" || choices[0] === "manual")
  ) {
    if (choices[0] === "waive")
      console.error(
        `Advisory waiver recorded on the pull request: ${receipt.answers.map((a) => a.url).join(", ")}`,
      );
    return choices[0];
  }
  // A free-text answer is for a person/pass to interpret, never permission to waive.
  return "manual";
}

/** Consume the bounded repair authorization before any external repair action. */
async function claimRepair(
  pr: string,
  key: string,
  resolvedAt: string,
): Promise<AdvisoryAction> {
  const claimed = await run(tsArgv(driveState, ["claim-advisory-repair", pr]), {
    stdin: JSON.stringify({ key, resolvedAt: resolvedAt }),
    stdout: "pipe",
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (claimed.code !== 0)
    console.error(
      `Advisory repair authorization ${claimed.code === 3 ? "already consumed; a stopped or pre-dispatch pass can consume authorization without starting repair, so no automatic retry is made" : "could not be claimed"} (exit ${claimed.code}): ${claimed.stderr}`,
    );
  return claimed.code === 0 ? "fix" : claimed.code === 3 ? "manual" : "failed";
}

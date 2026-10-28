#!/usr/bin/env bun
/**
 * Print the consumer values this procedure needs, read from the repository
 * the agent is working in, and refuse when they are missing or invalid.
 *
 * Usage: bun consumer-config.ts
 *   Run from inside the consumer repository (any directory of it). The
 *   repository root and configuration file can be overridden with
 *   JIG_CONSUMER_ROOT and JIG_OVERLAY.
 *
 * Exit codes: 0 configuration usable; 2 configuration missing or invalid.
 */

import { fail, runMain } from "../../../shared/cli.ts";
import {
  consumerRoot,
  overlayPath,
  readOverlay,
  reviewConfig,
  reviewerSelection,
  sourceIn,
  withSource,
} from "../../../shared/consumer.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function main(): Promise<number> {
  let overlay: Record<string, unknown>;
  let review: ReturnType<typeof reviewConfig>;
  try {
    overlay = readOverlay();
    review = reviewConfig();
  } catch (err) {
    fail(2, `consumer-config: ${err instanceof Error ? err.message : err}`);
  }
  const gates = text(section(overlay.gates).command);
  const tracker = section(overlay.issue_tracker);
  // The only value the procedure cannot run without: a fix is pushed only
  // after the repository's checks pass. Threads are worked whoever wrote
  // them, and the deferral team is read only when a finding is deferred.
  if (gates === undefined)
    fail(
      2,
      `consumer-config: ${overlayPath()} lacks required values: gates.command`,
    );
  // The same validation await-round.ts applies, before any work starts.
  try {
    reviewerSelection(review.job_pattern ?? "", review.required_checks ?? []);
  } catch (err) {
    fail(
      2,
      `consumer-config: ${err instanceof Error ? err.message : err}: ${sourceIn(overlay, "review.job_pattern")}; declare the exact required check names, or set job_pattern to null to recognise reviewer checks by name`,
    );
  }
  // The labels a deferral files with: checked now, not when the first
  // finding is deferred.
  try {
    parseTrackerLabels(overlay);
  } catch (err) {
    fail(
      2,
      `consumer-config: ${withSource(overlay, ["issue_tracker", "review"], err).message}`,
    );
  }
  const lines: [string, string][] = [
    ["repository", consumerRoot()],
    ["configuration", overlayPath()],
    ["gates.command", gates ?? ""],
    [
      "review.bots",
      review.bots?.length ? review.bots.join(", ") : "(not set: any reviewer)",
    ],
    [
      "review.job_pattern",
      text(review.job_pattern) ??
        "(not set: reviewer checks are recognised by name)",
    ],
    [
      "review.required_checks",
      review.required_checks?.join(", ") ?? "(not set)",
    ],
    [
      "review.deferral_team",
      text(review.deferral_team) ??
        "(not set: needed only to defer; pass --team)",
    ],
    ["issue_tracker.team", text(tracker.team) ?? "(not set)"],
    ["issue_tracker.file_command", text(tracker.file_command) ?? "(not set)"],
  ];
  for (const [key, value] of lines) console.log(`${key}: ${value}`);
  return 0;
}

if (import.meta.main) runMain("consumer-config", main);

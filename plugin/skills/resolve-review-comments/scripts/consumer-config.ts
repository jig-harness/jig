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

import { fail, isEntryPoint, runMain } from "./lib/cli.ts";
import {
  consumerRoot,
  overlayPath,
  readOverlay,
  reviewConfig,
  reviewerSelection,
} from "./lib/consumer.ts";
import { parseTrackerLabels } from "./lib/tracker-labels.ts";

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
  const missing = [
    gates === undefined && "gates.command",
    !review.bots?.length && "review.bots",
    text(review.deferral_team) === undefined && "review.deferral_team",
  ].filter((field): field is string => typeof field === "string");
  if (missing.length > 0)
    fail(
      2,
      `consumer-config: ${overlayPath()} lacks required values: ${missing.join(", ")}`,
    );
  // The same validation await-round.ts applies, before any work starts.
  try {
    reviewerSelection(review.job_pattern ?? "", review.required_checks ?? []);
  } catch (err) {
    fail(
      2,
      `consumer-config: ${overlayPath()}: ${err instanceof Error ? err.message : err}; declare the exact required check names, or set job_pattern to null to recognise reviewer checks by name`,
    );
  }
  // The labels a deferral files with: checked now, not when the first
  // finding is deferred.
  try {
    parseTrackerLabels(overlay);
  } catch (err) {
    fail(
      2,
      `consumer-config: ${overlayPath()}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const lines: [string, string][] = [
    ["repository", consumerRoot()],
    ["configuration", overlayPath()],
    ["gates.command", gates ?? ""],
    ["review.bots", (review.bots ?? []).join(", ")],
    [
      "review.job_pattern",
      text(review.job_pattern) ??
        "(not set: reviewer checks are recognised by name)",
    ],
    [
      "review.required_checks",
      review.required_checks?.join(", ") ?? "(not set)",
    ],
    ["review.deferral_team", review.deferral_team ?? ""],
    ["issue_tracker.team", text(tracker.team) ?? "(not set)"],
    ["issue_tracker.file_command", text(tracker.file_command) ?? "(not set)"],
  ];
  for (const [key, value] of lines) console.log(`${key}: ${value}`);
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("consumer-config", main);

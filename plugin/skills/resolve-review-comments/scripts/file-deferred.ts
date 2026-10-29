#!/usr/bin/env bun
/**
 * File the findings a pull request deferred into its own `## Deferred`
 * section, where a tracker adapter can, and replace each entry with the
 * issue it was filed as (references/deferral-protocol.md § Deferral without a
 * tracker). Run it from the repository's own post-merge step, or on a pull
 * request closed without merging; it reads and writes only that pull
 * request's body and the tracker, so it runs from any checkout of the
 * repository.
 *
 * Usage:
 *   file-deferred.ts <PR> [--dry-run]
 *
 * Each entry is filed through the configured tracker adapter (`do-item`'s
 * tracker interface, `issue_tracker.adapter`) with the label of the
 * `followup` role, and its entry is replaced, by read-modify-write against
 * the body's `updated_at`, before the next one is filed, so a run stopped
 * part-way leaves no filed entry unrecorded but the one in flight. With no
 * tracker that can file, the entries stay in the body, listed, for a person.
 *
 * Exit codes: 0 every entry filed (or none to file), 1 the forge or the
 * tracker failed, 2 usage, 3 entries remain because no adapter could file.
 */
import { fail, runMain } from "../../../shared/cli.ts";
import { readConfig } from "../../../shared/consumer.ts";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import type { Tracker } from "../../do-item/scripts/lib/tracker/port.ts";
import {
  type DeferredEntry,
  deferredEntries,
  withFiledEntry,
} from "./lib/deferred-section.ts";
import {
  ghPrBodyForge,
  type PrBodyForge,
  updatePrBody,
} from "./lib/pr-body.ts";

/** The issue an entry becomes. */
function issueFor(
  entry: DeferredEntry,
  pr: string,
  prUrl: string,
  label: string,
): { title: string; description: string; labels: string[] } {
  const quote = entry.text
    .split("\n")
    .find((l) => l.startsWith("> ") && l.trim().length > 2);
  const subject = (quote ?? "a deferred review finding")
    .replace(/^>\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();
  return {
    title: `Deferred from PR #${pr}: ${subject.length > 80 ? `${subject.slice(0, 79)}…` : subject}`,
    description: [
      `Filed by \`file-deferred.ts\` from [pull request #${pr}](${prUrl}), whose review deferred it there because no tracker adapter could file it at the time.`,
      "",
      entry.text,
    ].join("\n"),
    labels: [label],
  };
}

export interface FileDeferredResult {
  filed: Array<{ source: string; key: string; url: string | null }>;
  remaining: DeferredEntry[];
  /** Why the remaining entries were not filed; `null` when none remain. */
  why: string | null;
}

/** File every unfiled entry of the pull request's section through `tracker`. */
export async function fileDeferred(
  forge: PrBodyForge,
  tracker: Tracker | null,
  pr: string,
  opts: { label: string; dryRun?: boolean; noTrackerWhy?: string },
): Promise<FileDeferredResult> {
  const { body, url } = await forge.read(pr);
  const open = deferredEntries(body).filter((e) => e.filed === undefined);
  const result: FileDeferredResult = { filed: [], remaining: [], why: null };
  if (tracker === null || opts.dryRun) {
    result.remaining = open;
    result.why =
      open.length === 0
        ? null
        : opts.dryRun
          ? "a dry run files nothing"
          : (opts.noTrackerWhy ?? "no tracker adapter can file");
    return result;
  }
  for (const [i, entry] of open.entries()) {
    let issue: { identifier: string; url: string | null };
    try {
      issue = await tracker.createIssue(issueFor(entry, pr, url, opts.label));
    } catch (err) {
      result.remaining = open.slice(i);
      result.why = `the tracker refused: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
    await updatePrBody(
      forge,
      pr,
      (current) =>
        deferredEntries(current).some(
          (e) =>
            e.source === entry.source &&
            e.fingerprint === entry.fingerprint &&
            e.filed === undefined,
        )
          ? withFiledEntry(current, entry, {
              key: issue.identifier,
              url: issue.url,
            })
          : null,
      (after) =>
        deferredEntries(after).some(
          (e) =>
            e.source === entry.source &&
            e.fingerprint === entry.fingerprint &&
            e.filed?.key === issue.identifier,
        ),
    );
    result.filed.push({
      source: entry.source,
      key: issue.identifier,
      url: issue.url,
    });
  }
  return result;
}

/** The configured tracker and its follow-up label, or why none can file. */
function configuredTracker(): {
  tracker: Tracker | null;
  label: string;
  why?: string;
} {
  try {
    const config = parseTrackerConfig(readConfig());
    return { tracker: openTracker(config), label: config.labels.followup };
  } catch (err) {
    return {
      tracker: null,
      label: "pr-followup",
      why: `no tracker adapter can file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** What a run that left entries in the body prints, and its exit code. */
function reportRemaining(r: FileDeferredResult, dryRun: boolean): number {
  if (dryRun) {
    for (const e of r.remaining)
      process.stdout.write(`would file ${e.source}\n`);
    return 0;
  }
  console.error(
    `file-deferred: ${r.remaining.length} entr${r.remaining.length === 1 ? "y stays" : "ies stay"} in the pull request body: ${r.why}`,
  );
  for (const e of r.remaining)
    console.error(`  ${e.source} ${e.fingerprint ?? ""}`.trimEnd());
  return r.why?.startsWith("the tracker refused") ? 1 : 3;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const pr = rest[0] ?? "";
  if (rest.length !== 1 || !/^\d+$/.test(pr))
    fail(2, "usage: file-deferred.ts <PR> [--dry-run]");
  const { tracker, label, why } = configuredTracker();
  let r: FileDeferredResult;
  try {
    r = await fileDeferred(ghPrBodyForge(), tracker, pr, {
      label,
      dryRun,
      ...(why === undefined ? {} : { noTrackerWhy: why }),
    });
  } catch (err) {
    fail(
      1,
      `file-deferred: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const f of r.filed)
    process.stdout.write(`filed ${f.key} ${f.url ?? ""} for ${f.source}\n`);
  return r.remaining.length === 0 ? 0 : reportRemaining(r, dryRun);
}

if (import.meta.main) runMain("file-deferred", main);

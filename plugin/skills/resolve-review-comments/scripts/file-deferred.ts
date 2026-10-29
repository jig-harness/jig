#!/usr/bin/env bun
/**
 * File the findings a pull request deferred into its own `## Deferred`
 * section, where a tracker adapter can, and replace each entry with the
 * issue it was filed as (references/deferral-protocol.md § Deferral without a
 * tracker). Run it from the repository's own post-merge step, or on a pull
 * request closed without merging; it reads and writes only that pull
 * request's body, its review threads and the tracker, so it runs from any
 * checkout of the repository.
 *
 * Usage:
 *   file-deferred.ts <PR> [--dry-run]
 *
 * Each entry is filed through the configured tracker adapter (`do-item`'s
 * tracker interface, `issue_tracker.adapter`) with the label of the
 * `followup` role, unless the tracker already holds an issue whose body
 * carries the entry's identity line (its source url and fingerprint; a run
 * stopped after filing it): that issue is reused rather than filed twice.
 * Each entry is read afresh before it is filed, so a person's correction
 * since the run began is what gets filed. Each filing is printed the moment
 * it is made, then its entry is replaced by read-modify-write against the
 * body's `updated_at`, before the next one is filed; a filing whose entry
 * could not be replaced (the write failed, or the entry was removed, filed
 * as another issue or changed since it was read) is reported as unrecorded,
 * with its key.
 *
 * The body's write cannot be made atomic against a person's own save, so
 * every run also checks the section against the answers: a resolved thread
 * whose `**deferred**` reply links the section, and a summary finding whose
 * `**deferred**` answer links it (by the fingerprint its marker carries),
 * must still have its entry, filed or not. A missing one is named, and the
 * run exits `4`. A thread whose comments run past one page cannot be checked,
 * and fails the run rather than passing it unread.
 *
 * Exit codes: 0 every entry filed (or none to file), 1 the forge or the
 * tracker failed, a filing could not be recorded, or the answers could not
 * all be read, 2 usage, 3 entries remain because no adapter could file, 4 a
 * `**deferred**` answer links an entry the section lacks.
 */
import { fail, runMain } from "../../../shared/cli.ts";
import { readConfig } from "../../../shared/consumer.ts";
import { parseTrackerConfig } from "../../do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import type { Tracker } from "../../do-item/scripts/lib/tracker/port.ts";
import {
  type DeferredEntry,
  DeferredSectionError,
  deferredEntries,
  withFiledEntry,
} from "./lib/deferred-section.ts";
import {
  type DeferredReply,
  ghPrBodyForge,
  type PrBodyForge,
  updatePrBody,
} from "./lib/pr-body.ts";

/**
 * The line an issue filed for `entry` carries, naming exactly that entry:
 * two summary findings share their comment's url and differ by fingerprint.
 */
export function identityLine(entry: {
  source: string;
  fingerprint?: string;
}): string {
  return `Deferred finding: ${entry.source}${entry.fingerprint === undefined ? "" : ` (fingerprint ${entry.fingerprint})`}`;
}

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
      "",
      identityLine(entry),
    ].join("\n"),
    labels: [label],
  };
}

interface Filing {
  source: string;
  key: string;
  url: string | null;
  /** The tracker already held it, from an earlier run. */
  reused: boolean;
}

export interface FileDeferredResult {
  filed: Filing[];
  /** Filed, but the entry could not be replaced: printed so it is not lost. */
  unrecorded: Filing[];
  remaining: DeferredEntry[];
  /** Why entries remain or a filing went unrecorded; `null` when neither. */
  why: string | null;
}

const sameEntry = (a: DeferredEntry, b: DeferredEntry): boolean =>
  a.source === b.source && a.fingerprint === b.fingerprint;

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * An issue the tracker already holds for the entry: one whose body carries
 * its identity line as a line of its own. An issue that only mentions the
 * source url, or names another fingerprint on it, is not this entry's.
 */
async function alreadyFiled(
  tracker: Tracker,
  entry: DeferredEntry,
): Promise<{ identifier: string; url: string | null } | null> {
  for (const hit of await tracker.searchIssues(entry.source, {
    includeClosed: true,
  })) {
    const issue = await tracker.getIssue(hit.identifier);
    const identity = identityLine(entry);
    if (
      issue?.description
        .replaceAll("\r", "")
        .split("\n")
        .some((l) => l.trim() === identity)
    )
      return { identifier: issue.identifier, url: issue.url };
  }
  return null;
}

/**
 * Replace `entry` with the issue it was filed as. Already recorded as that
 * issue is a no-op; an entry since removed, recorded as another issue, or
 * changed from the text that was filed is refused, so the filing is reported
 * rather than counted as recorded.
 */
async function recordFiling(
  forge: PrBodyForge,
  pr: string,
  entry: DeferredEntry,
  issue: { identifier: string; url: string | null },
): Promise<void> {
  await updatePrBody(
    forge,
    pr,
    (current) => {
      const now = deferredEntries(current).find((e) => sameEntry(e, entry));
      if (now === undefined)
        throw new DeferredSectionError(
          "the entry was removed from the body after it was read",
        );
      if (now.filed !== undefined) {
        if (now.filed.key === issue.identifier) return null;
        throw new DeferredSectionError(
          `the entry is already recorded as ${now.filed.key}`,
        );
      }
      if (now.text !== entry.text)
        throw new DeferredSectionError(
          "the entry changed after it was filed: file the corrected finding by hand or close the issue",
        );
      return withFiledEntry(current, entry, {
        key: issue.identifier,
        url: issue.url,
      });
    },
    (after) =>
      deferredEntries(after).some(
        (e) => sameEntry(e, entry) && e.filed?.key === issue.identifier,
      ),
  );
}

/**
 * `initial` as the body holds it now, or `null` when it is gone or filed:
 * a person may have corrected, removed or filed it while earlier entries
 * were filed.
 */
async function stillOpen(
  forge: PrBodyForge,
  pr: string,
  initial: DeferredEntry,
): Promise<DeferredEntry | null> {
  const now = deferredEntries((await forge.read(pr)).body).find((e) =>
    sameEntry(e, initial),
  );
  return now === undefined || now.filed !== undefined ? null : now;
}

/** The issue for `entry`: one the tracker already holds, else `draft` filed. */
async function issueOf(
  tracker: Tracker,
  entry: DeferredEntry,
  draft: ReturnType<typeof issueFor>,
): Promise<{
  issue: { identifier: string; url: string | null };
  reused: boolean;
}> {
  const found = await alreadyFiled(tracker, entry);
  return found !== null
    ? { issue: found, reused: true }
    : { issue: await tracker.createIssue(draft), reused: false };
}

/**
 * File every unfiled entry of the pull request's section through `tracker`.
 * `onFiled` hears of each filing before its entry is replaced.
 */
export async function fileDeferred(
  forge: PrBodyForge,
  tracker: Tracker | null,
  pr: string,
  opts: {
    label: string;
    dryRun?: boolean;
    noTrackerWhy?: string;
    onFiled?: (f: Filing) => void;
  },
): Promise<FileDeferredResult> {
  const { body, url } = await forge.read(pr);
  const open = deferredEntries(body).filter((e) => e.filed === undefined);
  const result: FileDeferredResult = {
    filed: [],
    unrecorded: [],
    remaining: [],
    why: null,
  };
  if (tracker === null || opts.dryRun) {
    result.remaining = open;
    if (open.length > 0)
      result.why = opts.dryRun
        ? "a dry run files nothing"
        : (opts.noTrackerWhy ?? "no tracker adapter can file");
    return result;
  }
  for (const [i, initial] of open.entries()) {
    const entry = await stillOpen(forge, pr, initial);
    if (entry === null) continue;
    let got: {
      issue: { identifier: string; url: string | null };
      reused: boolean;
    };
    try {
      got = await issueOf(tracker, entry, issueFor(entry, pr, url, opts.label));
    } catch (err) {
      result.remaining = open.slice(i);
      result.why = `the tracker refused: ${message(err)}`;
      return result;
    }
    const { issue, reused } = got;
    const filing = {
      source: entry.source,
      key: issue.identifier,
      url: issue.url,
      reused,
    };
    opts.onFiled?.(filing);
    try {
      await recordFiling(forge, pr, entry, issue);
    } catch (err) {
      result.unrecorded.push(filing);
      result.remaining = open.slice(i + 1);
      result.why = `${issue.identifier} was filed, but its entry could not be replaced: ${message(err)}`;
      return result;
    }
    result.filed.push(filing);
  }
  return result;
}

/**
 * The `**deferred**` answers whose entry the section lacks: an entry a
 * person's save of the body dropped. A thread's entry is keyed on its source,
 * a summary finding's on its fingerprint, so losing one of several findings
 * deferred from the same comment is seen.
 */
export async function missingEntries(
  forge: PrBodyForge,
  pr: string,
): Promise<DeferredReply[]> {
  const [replies, { body }] = await Promise.all([
    forge.deferredReplies(pr),
    forge.read(pr),
  ]);
  const entries = deferredEntries(body);
  const sources = new Set(entries.map((e) => e.source));
  const fingerprints = new Set(
    entries.flatMap((e) =>
      e.fingerprint === undefined ? [] : [e.fingerprint],
    ),
  );
  return replies.filter((r) =>
    "thread" in r ? !sources.has(r.thread) : !fingerprints.has(r.fingerprint),
  );
}

/** What a missing entry's answer was deferring. */
function answered(m: DeferredReply): string {
  return "thread" in m ? m.thread : `the summary finding ${m.fingerprint}`;
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
      why: `no tracker adapter can file: ${message(err)}`,
    };
  }
}

/** What a run that left work undone prints, and its exit code. */
function report(r: FileDeferredResult, dryRun: boolean): number {
  if (dryRun) {
    for (const e of r.remaining)
      process.stdout.write(`would file ${e.source}\n`);
    return 0;
  }
  if (r.why === null) return 0;
  console.error(`file-deferred: ${r.why}`);
  for (const f of r.unrecorded)
    console.error(`  filed, not recorded: ${f.key} for ${f.source}`);
  for (const e of r.remaining)
    console.error(
      `  stays in the body: ${e.source} ${e.fingerprint ?? ""}`.trimEnd(),
    );
  return r.unrecorded.length > 0 || r.why.startsWith("the tracker refused")
    ? 1
    : 3;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((a) => a !== "--dry-run");
  const pr = rest[0] ?? "";
  if (rest.length !== 1 || !/^\d+$/.test(pr))
    fail(2, "usage: file-deferred.ts <PR> [--dry-run]");
  const { tracker, label, why } = configuredTracker();
  const forge = ghPrBodyForge();
  let code: number;
  let missing: DeferredReply[];
  try {
    const r = await fileDeferred(forge, tracker, pr, {
      label,
      dryRun,
      ...(why === undefined ? {} : { noTrackerWhy: why }),
      onFiled: (f) =>
        process.stdout.write(
          `${f.reused ? "found" : "filed"} ${f.key} ${f.url ?? ""} for ${f.source}\n`,
        ),
    });
    code = report(r, dryRun);
    missing = await missingEntries(forge, pr);
  } catch (err) {
    fail(1, `file-deferred: ${message(err)}`);
  }
  for (const m of missing)
    console.error(
      `file-deferred: ${m.reply} answers ${answered(m)} **deferred** and links the Deferred section, which has no entry for it; restore the entry from the reply or file the finding by hand`,
    );
  if (code === 1) return 1;
  return missing.length > 0 ? 4 : code;
}

if (import.meta.main) runMain("file-deferred", main);

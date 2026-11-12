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
 * `followup` role and every facet: the type the entry records, the priority
 * its severity maps to (`lib/severity-priority.ts`, `unknown` as medium) and
 * the size it names, else `small`. A label of each other group the
 * repository's label taxonomy requires, which the filing check inside
 * `createIssue` asks for, is derived from the change-area catalog's tracker
 * projection for the areas covering the file a review thread is on
 * (`lib/deferred-labels.ts`); an entry whose group cannot be derived with
 * certainty (a summary finding, a file no area covers, areas that carry no
 * label of the group or more than one) is left for a person, naming the
 * group. The tracker already holding an issue whose
 * body carries the entry's identity line (its source url and fingerprint; a
 * run stopped after filing it) reuses that issue rather than filing twice.
 * An entry that records no type or severity, written before entries
 * recorded them, or one whose type or size the repository does not have, is
 * left in the body for a person to file through `/jig:file-issue`, and the
 * others are filed.
 * Each entry is read afresh before it is filed, so a person's correction
 * since the run began is what gets filed. An issue carries a digest of the
 * text it was filed from, and one filed from an earlier text of a corrected
 * entry is reported as unrecorded rather than replacing the correction. Each filing is printed the moment
 * it is made, then its entry is replaced by read-modify-write against the
 * body's `updated_at`, before the next one is filed; a filing whose entry
 * could not be replaced (the write failed, or the entry was removed, filed
 * as another issue or changed since it was read) is reported as unrecorded,
 * with its key.
 *
 * The body's write cannot be made atomic against a person's own save, so
 * every run also checks the section against the answers: a resolved thread
 * whose `**deferred**` reply links this pull request's section, and a summary
 * finding whose `**deferred**` answer links it (by the fingerprint its marker
 * carries), must still have its entry, filed or not. Only an answer from an
 * author the forge vouches for counts (`shared/trusted-authors.ts`). A missing one is named, and the
 * run exits `4`. A thread whose comments run past one page cannot be checked,
 * and fails the run rather than passing it unread.
 *
 * Exit codes: 0 every entry filed (or none to file), 1 the forge or the
 * tracker failed, a filing could not be recorded, or the answers could not
 * all be read, 2 usage, 3 entries remain because no adapter could file them
 * or a person files them, 4 a `**deferred**` answer links an entry the
 * section lacks.
 */
import { createHash } from "node:crypto";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import {
  facetsOf,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import {
  type Facets,
  type FacetSlot,
  facetValueOf,
  usable,
} from "../../do-item/scripts/lib/tracker/facets/config.ts";
import { readTaxonomy } from "../../do-item/scripts/lib/tracker/facets/complete.ts";
import { openTracker } from "../../do-item/scripts/lib/tracker/index.ts";
import type {
  NewIssue,
  Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import type { Taxonomy } from "../../file-issue/scripts/lib/taxonomy.ts";
import {
  type CatalogSource,
  configuredCatalog,
  entryLabels,
  unfilledGroups,
} from "./lib/deferred-labels.ts";
import {
  type DeferredEntry,
  DeferredSectionError,
  deferredEntries,
  withFiledEntry,
} from "./lib/deferred-section.ts";
import {
  type DeferredReply,
  deferredReplies,
  ghPrBodyForge,
  type PrBodyForge,
  updatePrBody,
} from "./lib/pr-body.ts";
import {
  SEVERITY_TO_PRIORITY,
  severityPriority,
} from "./lib/severity-priority.ts";

/** Where a person files an entry this script leaves in the body. */
const BY_HAND = "/jig:file-issue";

/** The size an entry is filed at when it names none. */
const DEFAULT_SIZE = "small";

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

/**
 * The line an issue filed for `entry` carries naming the text it was filed
 * from, so a run that finds the issue again can tell whether the entry has
 * been corrected since.
 */
export function textLine(entry: { text: string }): string {
  const digest = createHash("sha256")
    .update(entry.text.replaceAll("\r", "").trim())
    .digest("hex");
  return `Deferred finding text: sha256 ${digest}`;
}

/**
 * The value of a facet `recorded` names: the value itself, or the value one
 * of its labels is, ignoring case; `null` when it names none.
 */
function facetValue(slot: FacetSlot, recorded: string): string | null {
  if (!usable(slot)) return null;
  const named = facetValueOf(slot)(recorded);
  return slot.values.includes(named) ? named : null;
}

/**
 * The facets an entry is filed with, or why a person files it: its type,
 * the priority its severity maps to, and its size (else `small`). A facet the
 * repository has no store for is left out, as the write would refuse it.
 * Without the repository's facets (no tracker to file with) only the
 * recorded fields are checked.
 */
export function entryFacets(
  entry: DeferredEntry,
  facets: Facets | null,
): Pick<NewIssue, "type" | "priority" | "size"> | { why: string } {
  if (entry.type === undefined || entry.severity === undefined)
    return {
      why: "it records no type or severity, as an entry deferred before entries recorded them",
    };
  if (!Object.hasOwn(SEVERITY_TO_PRIORITY, entry.severity))
    return {
      why: `its severity '${entry.severity}' is none of ${Object.keys(SEVERITY_TO_PRIORITY).join(", ")}`,
    };
  const out: Pick<NewIssue, "type" | "priority" | "size"> = {
    priority: severityPriority(entry.severity),
  };
  for (const [facet, recorded] of [
    ["type", entry.type],
    ["size", entry.size ?? DEFAULT_SIZE],
  ] as const) {
    if (facets === null) continue;
    const slot = facets[facet];
    if (!usable(slot)) continue;
    const value = facetValue(slot, recorded);
    if (value === null)
      return {
        why: `its ${facet} '${recorded}' is no ${facet} of this repository (${slot.values.join(", ")})`,
      };
    out[facet] = value;
  }
  return out;
}

/** What an entry is filed as: its facets and its labels. */
interface Plan {
  facets: Pick<NewIssue, "type" | "priority" | "size">;
  labels: string[];
}

/** The issue an entry becomes. */
function issueFor(
  entry: DeferredEntry,
  pr: string,
  prUrl: string,
  labels: string[],
  facets: Pick<NewIssue, "type" | "priority" | "size">,
): NewIssue {
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
      `Severity: ${entry.severity ?? "unknown"}. Category: ${entry.category ?? "unknown"}.`,
      "",
      identityLine(entry),
      textLine(entry),
    ].join("\n"),
    labels,
    ...facets,
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
  /** Left in the body for a person to file, each with why. */
  forPerson: Array<{ entry: DeferredEntry; why: string }>;
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
 * `sameText` says whether it was filed from the entry's current text.
 */
async function alreadyFiled(
  tracker: Tracker,
  entry: DeferredEntry,
): Promise<{
  identifier: string;
  url: string | null;
  sameText: boolean;
} | null> {
  const identity = identityLine(entry);
  const text = textLine(entry);
  for (const hit of await tracker.searchIssues(entry.source, {
    includeClosed: true,
  })) {
    const issue = await tracker.getIssue(hit.identifier);
    const lines = (issue?.description ?? "")
      .replaceAll("\r", "")
      .split("\n")
      .map((l) => l.trim());
    if (issue !== null && lines.includes(identity))
      return {
        identifier: issue.identifier,
        url: issue.url,
        sameText: lines.includes(text),
      };
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

/**
 * The issue for `entry`: one the tracker already holds, else `draft` filed.
 * `stale` marks a held issue filed from an earlier text of the entry, which
 * must not replace the corrected entry.
 */
async function issueOf(
  tracker: Tracker,
  entry: DeferredEntry,
  draft: ReturnType<typeof issueFor>,
): Promise<{
  issue: { identifier: string; url: string | null };
  reused: boolean;
  stale: boolean;
}> {
  const found = await alreadyFiled(tracker, entry);
  return found !== null
    ? {
        issue: { identifier: found.identifier, url: found.url },
        reused: true,
        stale: !found.sameText,
      }
    : {
        issue: await tracker.createIssue(draft),
        reused: false,
        stale: false,
      };
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
    /** The repository's facets, which it has and their values; `null` with no tracker. */
    facets: Facets | null;
    /** The repository's label taxonomy, whose required groups an issue carries a label of; absent or `null` with none. */
    taxonomy?: Taxonomy | null;
    /** The change-area catalog those labels are derived from, read only when a group needs one; the configured one by default. */
    catalog?: () => CatalogSource;
    dryRun?: boolean;
    noTrackerWhy?: string;
    onFiled?: (f: Filing) => void;
  },
): Promise<FileDeferredResult> {
  const { body, url } = await forge.read(pr);
  const result: FileDeferredResult = {
    filed: [],
    unrecorded: [],
    remaining: [],
    forPerson: [],
    why: null,
  };
  const plan = planner(forge, pr, opts);
  const open = await fileable(deferredEntries(body), plan, result);
  const skipped = whyNotFiling(tracker, opts);
  if (tracker === null || skipped !== null) {
    result.remaining = open;
    if (open.length > 0) result.why = skipped;
    return result;
  }
  for (const [i, initial] of open.entries()) {
    const entry = await stillOpen(forge, pr, initial);
    if (entry === null) continue;
    const planned = await plan(entry);
    if ("why" in planned) {
      result.forPerson.push({ entry, why: planned.why });
      continue;
    }
    const step = await fileOne(forge, tracker, pr, entry, {
      ...opts,
      url,
      plan: planned,
    });
    if (step.why === null) {
      result.filed.push(step.filing);
      continue;
    }
    const held = step.filing === null ? [] : [step.filing];
    result.unrecorded.push(...held);
    result.remaining = open.slice(i + held.length);
    result.why = step.why;
    return result;
  }
  return result;
}

/**
 * What each entry is filed as, or why a person files it. The review threads'
 * files are read once, and the catalog once, the first time an entry needs a
 * label derived; a repository whose taxonomy requires no other group reads
 * neither.
 */
function planner(
  forge: PrBodyForge,
  pr: string,
  opts: {
    label: string;
    facets: Facets | null;
    taxonomy?: Taxonomy | null;
    catalog?: () => CatalogSource;
  },
): (entry: DeferredEntry) => Promise<Plan | { why: string }> {
  const taxonomy = opts.taxonomy ?? null;
  let paths: Promise<Map<string, string>> | undefined;
  let catalog: CatalogSource | undefined;
  const readCatalog = () => {
    catalog ??= (opts.catalog ?? configuredCatalog)();
    return catalog;
  };
  return async (entry) => {
    const facets = entryFacets(entry, opts.facets);
    if ("why" in facets) return facets;
    let path: string | null = null;
    if (
      unfilledGroups(opts.label, taxonomy).length > 0 &&
      entry.fingerprint === undefined
    ) {
      paths ??= forge.threadPaths(pr);
      path = (await paths).get(entry.source) ?? null;
    }
    const labels = entryLabels(opts.label, path, taxonomy, readCatalog);
    return "why" in labels ? labels : { facets, labels: labels.labels };
  };
}

/**
 * The unfiled entries this run can file; each it cannot (no type or
 * severity recorded, a value the repository lacks, or a required group whose
 * label cannot be derived) goes to `result`'s `forPerson`, with why.
 */
async function fileable(
  entries: DeferredEntry[],
  plan: (entry: DeferredEntry) => Promise<Plan | { why: string }>,
  result: FileDeferredResult,
): Promise<DeferredEntry[]> {
  const open: DeferredEntry[] = [];
  for (const entry of entries) {
    if (entry.filed !== undefined) continue;
    const found = await plan(entry);
    if ("why" in found) result.forPerson.push({ entry, why: found.why });
    else open.push(entry);
  }
  return open;
}

/** Why a run files nothing at all, or `null` when it can file. */
function whyNotFiling(
  tracker: Tracker | null,
  opts: { dryRun?: boolean; noTrackerWhy?: string },
): string | null {
  if (opts.dryRun) return "a dry run files nothing";
  if (tracker === null)
    return opts.noTrackerWhy ?? "no tracker adapter can file";
  return null;
}

/**
 * File one open entry and record its issue in the entry. `why` names what
 * stopped the run; `filing` is the issue the tracker holds, or `null` when it
 * refused before holding one.
 */
async function fileOne(
  forge: PrBodyForge,
  tracker: Tracker,
  pr: string,
  entry: DeferredEntry,
  opts: {
    url: string;
    plan: Plan;
    onFiled?: (f: Filing) => void;
  },
): Promise<
  { filing: Filing; why: null } | { filing: Filing | null; why: string }
> {
  let got: Awaited<ReturnType<typeof issueOf>>;
  try {
    got = await issueOf(
      tracker,
      entry,
      issueFor(entry, pr, opts.url, opts.plan.labels, opts.plan.facets),
    );
  } catch (err) {
    return { filing: null, why: `the tracker refused: ${message(err)}` };
  }
  const { issue, reused, stale } = got;
  const filing = {
    source: entry.source,
    key: issue.identifier,
    url: issue.url,
    reused,
  };
  opts.onFiled?.(filing);
  if (stale)
    return {
      filing,
      why: `${issue.identifier} was filed from an earlier text of this entry, which has been corrected since; update or close that issue, then record it in the entry by hand`,
    };
  try {
    await recordFiling(forge, pr, entry, issue);
  } catch (err) {
    return {
      filing,
      why: `${issue.identifier} was filed, but its entry could not be replaced: ${message(err)}`,
    };
  }
  return { filing, why: null };
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
  const [answers, { body, url }] = await Promise.all([
    forge.answers(pr),
    forge.read(pr),
  ]);
  const replies = deferredReplies(answers, url);
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

/** The configured tracker, its follow-up label, facets and label taxonomy, or why none can file. */
function configuredTracker(): {
  tracker: Tracker | null;
  label: string;
  facets: Facets | null;
  taxonomy: Taxonomy | null;
  why?: string;
} {
  try {
    const config = parseTrackerConfig(readConfig());
    return {
      tracker: openTracker(config),
      label: config.labels.followup,
      facets: facetsOf(config, consumerRoot()),
      taxonomy: readTaxonomy(consumerRoot(), config.taxonomy),
    };
  } catch (err) {
    return {
      tracker: null,
      label: "pr-followup",
      facets: null,
      taxonomy: null,
      why: `no tracker adapter can file: ${message(err)}`,
    };
  }
}

/** An entry by its source, and its fingerprint where it has one. */
const named = (e: DeferredEntry) =>
  `${e.source} ${e.fingerprint ?? ""}`.trimEnd();

/** What a run that left work undone prints, and its exit code. */
function report(r: FileDeferredResult, dryRun: boolean): number {
  const byHand = () => {
    for (const p of r.forPerson)
      console.error(
        `  stays in the body for a person to file through ${BY_HAND}: ${named(p.entry)}: ${p.why}`,
      );
  };
  if (dryRun) {
    for (const e of r.remaining)
      process.stdout.write(`would file ${e.source}\n`);
    byHand();
    return 0;
  }
  if (r.why === null) {
    if (r.forPerson.length === 0) return 0;
    console.error(
      `file-deferred: ${r.forPerson.length} entr${r.forPerson.length === 1 ? "y stays" : "ies stay"} in the body for a person to file`,
    );
    byHand();
    return 3;
  }
  console.error(`file-deferred: ${r.why}`);
  for (const f of r.unrecorded)
    console.error(`  filed, not recorded: ${f.key} for ${f.source}`);
  for (const e of r.remaining)
    console.error(`  stays in the body: ${named(e)}`);
  byHand();
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
  const { tracker, label, facets, taxonomy, why } = configuredTracker();
  const forge = ghPrBodyForge();
  let code: number;
  let missing: DeferredReply[];
  try {
    const r = await fileDeferred(forge, tracker, pr, {
      label,
      facets,
      taxonomy,
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

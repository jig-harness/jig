import {
  authoritativeLines,
  hasEntry,
  summaryEntryKey,
} from "./deferred-identity.ts";
import { JigError } from "../../../../shared/outcome.ts";
/** One backlog issue per repository, pull request and work type, on every tracker. */
import type {
  Issue,
  Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import {
  batchKeyMarker,
  batchTitle,
  hasBatchKey,
  isSafeKeyComponent,
} from "./batch-description.ts";

export interface TrackerDeferral {
  repo: string;
  pr: string;
  type: string;
  /** A whole line identifying the source finding, never a substring match. */
  identity: string;
  text: string;
  category: string;
  priority: number;
  size?: string | undefined;
  labels: string[];
  /** Refuse a combined label set that violates this consumer's taxonomy. */
  labelConflict?: (labels: string[]) => string | undefined;
  originating?: string | undefined;
  dryRun?: boolean;
}

const open = (i: Issue) =>
  !["completed", "canceled", "duplicate"].includes(i.state.type);
export const findingIdentityLines = (text: string) =>
  authoritativeLines(text.replaceAll("\r", "")).map((l) =>
    l.replace(/\[[^\]]*\]\(<?(https?:\/\/[^)>]+)>?\)/g, "$1").trim(),
  );
const higher = (a: number, b: number) =>
  a === 0 ? b : b === 0 ? a : Math.min(a, b);

/** Read the epic through live ancestry; a native Epic type is as authoritative as its label. */
async function relatedTargets(
  tracker: Tracker,
  key: string | undefined,
): Promise<string[]> {
  if (!key) return [];
  const targets = [key];
  const seen = new Set<string>();
  let next: string | undefined = key;
  while (next !== undefined) {
    if (seen.has(next) || seen.size >= 100)
      throw new JigError(
        "deferral",
        `Cannot resolve epic ancestry for ${key}: cycle or depth limit`,
      );
    seen.add(next);
    const issue = await tracker.getIssue(next);
    if (issue === null)
      throw new JigError(
        "deferral",
        `Origin ancestry issue ${next} could not be read`,
      );
    if (issue.isEpic) return [...new Set([...targets, issue.identifier])];
    next = issue.parent?.identifier;
  }
  return targets;
}

async function findBatch(
  tracker: Tracker,
  d: TrackerDeferral,
): Promise<Issue | null> {
  const candidates: Issue[] = [];
  for (const hit of await tracker.searchIssues(
    batchKeyMarker(d.repo, d.pr, d.type),
  )) {
    const issue = await tracker.getIssue(hit.identifier);
    if (issue === null)
      throw new JigError(
        "deferral",
        `Batch candidate ${hit.identifier} disappeared`,
      );
    if (open(issue) && hasBatchKey(issue.description, d.repo, d.pr, d.type))
      candidates.push(issue);
  }
  if (candidates.length > 1)
    throw new JigError(
      "deferral",
      `Several open batches share this pull request and type: ${candidates.map((i) => i.identifier).join(", ")}; consolidate them before deferring`,
    );
  return candidates[0] ?? null;
}

/** A whole legacy heading also identifies a finding after an upgrade. */
function hasFinding(description: string, identity: string): boolean {
  if (findingIdentityLines(description).includes(identity)) return true;
  const match = /^Deferred finding: (\S+)(?: \(fingerprint (\S+)\))?$/.exec(
    identity,
  );
  const source = match?.[1];
  if (source === undefined) return false;
  const fingerprint = match?.[2];
  return hasEntry(
    description,
    fingerprint === undefined ? source : summaryEntryKey(source, fingerprint),
  );
}

/** Add a category to the scaffold's union, preserving entries and any hand-written prose. */
function descriptionFor(description: string, d: TrackerDeferral): string {
  const section = description.indexOf("\n## Entries");
  const scaffold = section < 0 ? description : description.slice(0, section);
  const categoryLine = /^\*\*Category\*\*: ([^\r\n]*)$/m;
  const current =
    categoryLine
      .exec(scaffold)?.[1]
      ?.split(",")
      .map((c) => c.trim()) ?? [];
  const categories = [...new Set([...current, d.category])].sort((a, b) =>
    a.localeCompare(b),
  );
  const header = `**Category**: ${categories.join(", ")}`;
  let out = categoryLine.test(scaffold)
    ? description.replace(categoryLine, header)
    : `${scaffold.trimEnd()}\n\n${header}${section < 0 ? "\n\n## Entries\n" : description.slice(section)}`;
  if (!findingIdentityLines(out).includes(d.identity)) {
    const text = hasFinding(out, d.identity)
      ? findingIdentityLines(d.text)
          .filter((l) => l.startsWith("Deferred finding text:"))
          .join("\n")
      : d.text.trim();
    out = `${out.trimEnd()}\n\n${text}${findingIdentityLines(text).includes(d.identity) ? "" : `\n\n${d.identity}`}\n`;
  }
  return out;
}

/**
 * All reads and writes use the tracker port's governed adapter. Re-read after
 * writes before reporting a ready deferral link; a failed relation or backlog
 * transition is retried when the same batch is met again. Whole-body writes
 * cannot exclude a writer that saves after verification, so callers must not
 * interpret this as cross-host compare-and-swap.
 */
function validateInput(d: TrackerDeferral): void {
  if (
    !isSafeKeyComponent(d.repo) ||
    !isSafeKeyComponent(d.type) ||
    !/^[1-9]\d*$/.test(d.pr)
  )
    throw new JigError(
      "deferral",
      "Invalid repository, pull request or type in the deferral batch key",
    );
  if (/[\r\n]/.test(d.identity) || d.identity.trim() === "")
    throw new JigError(
      "deferral",
      "A finding identity must be one nonempty line",
    );
}

function assertBatch(issue: Issue, d: TrackerDeferral): void {
  if (!open(issue))
    throw new JigError(
      "deferral",
      `Batch ${issue.identifier} closed during deferral`,
    );
  if (!hasBatchKey(issue.description, d.repo, d.pr, d.type))
    throw new JigError(
      "deferral",
      `Batch ${issue.identifier} lost or changed its key; do not resolve the finding`,
    );
  if (issue.type !== null && issue.type.toLowerCase() !== d.type.toLowerCase())
    throw new JigError(
      "deferral",
      `Batch ${issue.identifier} has type ${issue.type}, which contradicts its key ${d.type}`,
    );
  if (issue.size !== null && d.size !== undefined && issue.size !== d.size)
    throw new JigError(
      "deferral",
      `Batch ${issue.identifier} has size ${issue.size}, which contradicts the finding size ${d.size}`,
    );
  const conflict = d.labelConflict?.([...issue.labels, ...d.labels]);
  if (conflict !== undefined) throw new JigError("deferral", conflict);
}

async function createBatch(
  tracker: Tracker,
  d: TrackerDeferral,
): Promise<Issue> {
  const made = await tracker.createIssue({
    title: batchTitle(d.pr, d.type),
    description: descriptionFor(
      `${batchKeyMarker(d.repo, d.pr, d.type)}\n\nDeferred review findings from pull request #${d.pr}.\n\n## Entries\n`,
      d,
    ),
    labels: [...new Set(d.labels)],
    type: d.type,
    priority: d.priority,
    ...(d.size === undefined ? {} : { size: d.size }),
  });
  const issue = await tracker.getIssue(made.identifier);
  if (issue === null)
    throw new JigError(
      "deferral",
      `Created ${made.identifier}, but could not verify it`,
    );
  const found = await findBatch(tracker, d);
  if (found !== null && found.identifier !== issue.identifier)
    throw new JigError(
      "deferral",
      `Concurrent creation produced multiple batches; keep ${made.identifier} for reconciliation`,
    );
  return issue;
}

async function persist(
  tracker: Tracker,
  issue: Issue,
  d: TrackerDeferral,
  targets: string[],
): Promise<Issue> {
  assertBatch(issue, d);
  const description = descriptionFor(issue.description, d);
  const priority = higher(issue.priority, d.priority);
  const missing = d.labels.filter((l) => !issue.labels.includes(l));
  const patch = {
    ...(description !== issue.description ? { description } : {}),
    ...(priority !== issue.priority ? { priority } : {}),
    ...(missing.length > 0 ? { addLabels: missing } : {}),
    ...(issue.type === null ? { type: d.type } : {}),
    ...(issue.size === null && d.size !== undefined ? { size: d.size } : {}),
  };
  if (Object.keys(patch).length > 0)
    await tracker.updateIssue(issue.identifier, patch);
  // Existing batches keep their parent until epic closure, and started batches keep their state.
  if (!["backlog", "started"].includes(issue.state.type))
    await tracker.transition(issue.identifier, "backlog");
  const relations = await tracker.listRelations(issue.identifier);
  for (const target of targets)
    if (!relations.some((r) => r.type === "related" && r.issue === target))
      await tracker.relate(issue.identifier, "related", target);
  const live = await tracker.getIssue(issue.identifier);
  if (live === null)
    throw new JigError(
      "deferral",
      `Could not verify batch ${issue.identifier}`,
    );
  assertBatch(live, d);
  return live;
}

async function confirmed(
  tracker: Tracker,
  issue: Issue,
  d: TrackerDeferral,
  targets: string[],
): Promise<boolean> {
  const related = await tracker.listRelations(issue.identifier);
  return [
    ["backlog", "started"].includes(issue.state.type),
    findingIdentityLines(issue.description).includes(d.identity),
    descriptionFor(issue.description, d) === issue.description,
    higher(issue.priority, d.priority) === issue.priority,
    d.labels.every((l) => issue.labels.includes(l)),
    issue.type?.toLowerCase() === d.type.toLowerCase(),
    d.size === undefined || issue.size === d.size,
    targets.every((t) =>
      related.some((r) => r.type === "related" && r.issue === t),
    ),
  ].every(Boolean);
}

export async function deferToTracker(
  tracker: Tracker,
  d: TrackerDeferral,
): Promise<{
  identifier: string;
  url: string | null;
  created: boolean;
  alreadyPresent: boolean;
}> {
  validateInput(d);
  const targets = await relatedTargets(tracker, d.originating);
  const found = await findBatch(tracker, d);
  const created = found === null;
  const alreadyPresent =
    found !== null && hasFinding(found.description, d.identity);
  if (found !== null) assertBatch(found, d);
  if (d.dryRun)
    return {
      identifier: found?.identifier ?? "(new batch)",
      url: found?.url ?? null,
      created,
      alreadyPresent,
    };
  let issue = found ?? (await createBatch(tracker, d));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    issue = await persist(tracker, issue, d, targets);
    if (await confirmed(tracker, issue, d, targets))
      return {
        identifier: issue.identifier,
        url: issue.url,
        created,
        alreadyPresent,
      };
  }
  throw new JigError(
    "deferral",
    `Batch ${issue.identifier} did not retain its entry, facets or related links; do not resolve the finding`,
  );
}

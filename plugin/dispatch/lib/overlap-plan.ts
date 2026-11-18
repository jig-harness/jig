/**
 * Overlap, reported: the plan phase's part of overlap-aware admission
 * (design/overlap-aware-admission.md, build step 6). Once a repository's
 * plan is made, its planned pickups, in rank order, are weighed against the
 * work in flight (`overlap.ts`): every open pull request by its changed files
 * (`sources/pr-files.ts`), and every pickup in flight with no linked open
 * pull request (this host's running pickups and the identity's claimed
 * items) by its footprint record (`overlap-observe.ts`). Each pickup's cost,
 * tier and reason go on the report (`report.overlap`), the dashboard's queue
 * and `jig ask`; the waits are kept in the state database
 * (`overlap-waits.ts`) by a tick that applies.
 *
 * It changes nothing the tick starts: the plan's actions, their order and
 * the per-epic width stay as they were.
 */
import { matchesGlob } from "../../shared/glob.ts";
import { isRecord } from "../../shared/guards.ts";
import { attempt } from "../../shared/outcome.ts";
import { isoFromMs, parseMs } from "../../shared/time.ts";
import type { FootprintReading } from "../../skills/do-item/scripts/lib/tracker/footprint-port.ts";
import type { ChangeAreaCatalog } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import { readConflictRates } from "./conflict-rates.ts";
import type { ReadRecord } from "./launches.ts";
import { holdsItem } from "./launch-pickups.ts";
import {
  type InFlight,
  type Footprint,
  type OverlapModel,
  type Placed,
  UNKNOWN_FOOTPRINT,
  type Wait,
  walkOverlap,
} from "./overlap.ts";
import {
  type OverlapSettings,
  overlapOf,
  patienceKey,
} from "./overlap-config.ts";
import {
  entryOf,
  footprintNote,
  HOTSPOT_TICKS,
  hotspotProposal,
  type OverlapHotspot,
  type OverlapReport,
} from "./overlap-reasons.ts";
import { countHotspots, readWaits, settleWaits } from "./overlap-waits.ts";
import { membersOf } from "./priorities-order.ts";
import { branchPattern } from "./section.ts";
import { allRecords, type TickContext } from "./tick-context.ts";
import type { RepoObservation } from "./tick-observe.ts";
import { workLinks } from "./work-links.ts";

const DAY_MS = 86_400_000;

/** A footprint reading as the walk weighs it: unknown, or its paths and areas. */
export function footprintOf(reading: FootprintReading | undefined): Footprint {
  if (reading === undefined || reading.source === "unknown")
    return UNKNOWN_FOOTPRINT;
  return {
    known: true,
    files: reading.paths.filter((p) => !p.endsWith("/")),
    dirs: reading.paths.filter((p) => p.endsWith("/")),
    areas: reading.areas,
  };
}

/** One footprint for a batch: the known members' files, directories and areas together, marked incomplete when a member's is unknown. */
export function combinedFootprint(parts: readonly Footprint[]): Footprint {
  const [only] = parts;
  if (parts.length === 1 && only !== undefined) return only;
  const known = parts.filter((f) => f.known);
  if (known.length === 0) return UNKNOWN_FOOTPRINT;
  const union = (pick: (f: Footprint) => readonly string[]) => [
    ...new Set(known.flatMap(pick)),
  ];
  return {
    known: true,
    files: union((f) => f.files),
    dirs: union((f) => f.dirs),
    areas: union((f) => f.areas),
    ...(known.length < parts.length ? { incomplete: true } : {}),
  };
}

/** One wait for a batch from its members' waits: the earliest start, and a promotion or tier-3 start any member has. */
export function combinedWait(
  waits: readonly (Wait | undefined)[],
): Wait | undefined {
  const kept = waits.filter((w): w is Wait => w !== undefined);
  if (kept.length === 0) return undefined;
  const earliest = (values: readonly (number | null)[]) => {
    const some = values.filter((v): v is number => v !== null);
    return some.length === 0 ? null : Math.min(...some);
  };
  return {
    sinceMs: Math.min(...kept.map((w) => w.sinceMs)),
    tier3SinceMs: earliest(kept.map((w) => w.tier3SinceMs)),
    promotedMs: earliest(kept.map((w) => w.promotedMs)),
  };
}

/** The note beside a pickup's rank for its footprint reading; `null` for a footprint record. */
export function readingNote(
  reading: FootprintReading | undefined,
  unread: string,
): string | null {
  if (reading === undefined) return `footprint unknown: ${unread}`;
  if (
    reading.stale &&
    reading.readAt !== null &&
    reading.source !== "labels" &&
    reading.source !== "unknown"
  ) {
    const detail = reading.failure?.reason ?? reading.reason;
    return `footprint stale: ${detail ?? "the last footprint read could not be refreshed"}`;
  }
  const note = footprintNote({
    source: reading.source,
    areas: reading.areas,
    ...(reading.reason === undefined ? {} : { reason: reading.reason }),
    ...(reading.failure === undefined
      ? {}
      : {
          failure: {
            class: reading.failure.code,
            reason: reading.failure.reason,
          },
        }),
  });
  if (note === null || reading.source !== "labels" || !reading.stale)
    return note;
  const detail = reading.failure?.reason ?? reading.reason;
  return `${note}; stale: ${detail ?? "its comments could not be refreshed"}`;
}

/** The globs of the files the catalog marks generated: each area's `generated[].outputs`. */
function generatedGlobs(catalog: ChangeAreaCatalog | null): string[] {
  if (catalog === null) return [];
  return [...catalog.values()].flatMap((area) => {
    const generated = area.fields.generated;
    if (!Array.isArray(generated)) return [];
    return generated.flatMap((g) =>
      isRecord(g) && Array.isArray(g.outputs)
        ? g.outputs.filter((o): o is string => typeof o === "string")
        : [],
    );
  });
}

/** The model the walk weighs units with. */
export function overlapModel(
  settings: OverlapSettings,
  rate: (path: string) => number,
  catalog: ChangeAreaCatalog | null,
): OverlapModel {
  const ignoredGlobs = [...settings.ignore, ...generatedGlobs(catalog)];
  const ignored = new Map<string, boolean>();
  return {
    settings,
    rate,
    areaGlobs: (area) => catalog?.get(area)?.globs ?? [],
    ignored: (path) => {
      let known = ignored.get(path);
      if (known === undefined) {
        known = ignoredGlobs.some((g) => matchesGlob(path, g));
        ignored.set(path, known);
      }
      return known;
    },
  };
}

/** Every open pull request, by its changed files. */
function pullRequestsInFlight(
  observation: RepoObservation,
  settings: OverlapSettings,
  nowMs: number,
): InFlight[] {
  const files = new Map<number, readonly string[]>();
  for (const e of observation.prFiles?.evidence ?? [])
    if ("files" in e) files.set(e.pr, e.files);
  return observation.forge.open.map((pr) => {
    const updated =
      pr.updatedAt === undefined ? Number.NaN : parseMs(pr.updatedAt);
    const quiet =
      Number.isFinite(updated) && nowMs - updated > settings.quietAfterMs;
    const changed = files.get(pr.number);
    return {
      kind: "pull request",
      ref: `#${pr.number}`,
      url: pr.url,
      state: quiet ? "open, quiet" : "open",
      footprint:
        changed === undefined
          ? UNKNOWN_FOOTPRINT
          : { known: true, files: changed, dirs: [], areas: [] },
      quiet,
    };
  });
}

/** Every pickup in flight with no linked open pull request: this host's running pickups, then the claimed items. */
function pickupsInFlight(
  observation: RepoObservation,
  candidates: ReadonlySet<string>,
  records: readonly ReadRecord[],
): InFlight[] {
  const { tracked, forge, opened } = observation;
  const links =
    tracked.keys == null || forge.linkTexts === undefined
      ? null
      : workLinks(forge.linkTexts, {
          keys: tracked.keys,
          branchPattern: branchPattern(opened.values),
          repository: opened.repo.slug,
          issueRepository: tracked.issueRepository ?? null,
        });
  const readings = observation.overlap?.readings;
  const urls = new Map<string, string | null>();
  for (const w of tracked.pickups) urls.set(w.key, w.url);
  for (const c of tracked.claimed ?? []) urls.set(c.key, c.url ?? null);
  const states = new Map<string, string>();
  for (const r of opened.report.running)
    if (r.stage === "pickup") states.set(r.target, "running");
  for (const c of tracked.claimed ?? [])
    if (!states.has(c.key)) states.set(c.key, "claimed");
  // The members of one launch are one piece of work: one entry, under the
  // launch's own target, with the members' footprints together.
  const launchOf = new Map<string, string>();
  for (const { record } of records) {
    if (
      record.repo !== opened.repo.slug ||
      record.action !== "pickup" ||
      record.batchItems === undefined
    )
      continue;
    for (const { key } of record.batchItems)
      if (holdsItem(record, key)) launchOf.set(key, record.id);
  }
  const groups = new Map<string, string[]>();
  for (const [key] of states) {
    if (candidates.has(key) || (links?.prsOf(key)?.length ?? 0) > 0) continue;
    const group = launchOf.get(key) ?? key;
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  return [...groups.values()].map((keys) => {
    const [lead = ""] = keys;
    return {
      kind: "pickup",
      ref: lead,
      url: urls.get(lead) ?? null,
      state: states.get(lead) ?? "claimed",
      footprint: combinedFootprint(
        keys.map((key) => footprintOf(readings?.get(key))),
      ),
      quiet: false,
    };
  });
}

/**
 * The wait one member of a placed batch keeps: its own recorded history, with
 * the batch's tier-3 start and promotion added only where the batch gained
 * them this tick, so joining a promoted member's batch never promotes another.
 * A member joining a batch already in tier 3 starts its own tier-3 timer now,
 * never the batch's older one and never none.
 */
export function memberWait(
  p: Placed,
  own: Wait | undefined,
  before: Wait | undefined,
  nowMs: number,
): Wait | null {
  if (p.wait === null) return null;
  return {
    sinceMs: own?.sinceMs ?? nowMs,
    tier3SinceMs:
      own?.tier3SinceMs ??
      (before?.tier3SinceMs == null || p.wait.tier3SinceMs === null
        ? p.wait.tier3SinceMs
        : nowMs),
    promotedMs:
      own?.promotedMs ??
      (before?.promotedMs == null ? p.wait.promotedMs : null),
  };
}

/** The waits the state database keeps for the repository; none, with a note, when they do not read. */
function loadWaits(slug: string, notes: string[]): Map<string, Wait> {
  const read = attempt("unreadable", "the overlap waits did not read", () =>
    readWaits(slug),
  );
  if (read.ok) return read.value;
  notes.push(`${read.failure.reason}, so every wait is counted from this tick`);
  return new Map();
}

/**
 * Keep the walk's waits, by a tick that applies, and remove the rows of the
 * pickups that started or are no longer wanted, when the tracker's read was
 * whole.
 */
function storeWaits(
  context: TickContext,
  observation: RepoObservation,
  placed: readonly Placed[],
  memberKeys: ReadonlyMap<string, readonly string[]>,
  stored: ReadonlyMap<string, Wait>,
  joined: ReadonlyMap<string, Wait>,
  notes: string[],
): void {
  if (context.apply === null) return;
  const { tracked, opened } = observation;
  const started = new Set(
    opened.report.running
      .filter((r) => r.stage === "pickup")
      .map((r) => r.target),
  );
  const wanted =
    tracked.claimed === null
      ? null
      : new Set(
          tracked.pickups.map((p) => p.key).filter((k) => !started.has(k)),
        );
  const written = attempt("unwritable", "the overlap waits were not kept", () =>
    settleWaits(
      opened.repo.slug,
      new Map(
        placed.flatMap((p) =>
          (memberKeys.get(p.candidate.item) ?? [p.candidate.item]).map(
            (key): [string, Wait | null] => [
              key,
              memberWait(
                p,
                stored.get(key),
                joined.get(p.candidate.item),
                context.nowMs,
              ),
            ],
          ),
        ),
      ),
      wanted,
    ),
  );
  if (!written.ok) notes.push(written.failure.reason);
}

/** The files that kept a pickup over the bound in enough ticks of today, counted once more by a tick that applies. */
function hotspots(
  context: TickContext,
  slug: string,
  placed: readonly Placed[],
  notes: string[],
): OverlapHotspot[] {
  const paths = placed.flatMap((p) =>
    p.tier === 3 ? p.evaluation.boundPaths : [],
  );
  if (paths.length === 0 || context.apply === null) return [];
  const day = isoFromMs(context.nowMs).slice(0, 10);
  const counted = attempt(
    "unwritable",
    "the overlap hotspots were not counted",
    () =>
      countHotspots(
        slug,
        day,
        isoFromMs(context.nowMs - DAY_MS).slice(0, 10),
        paths,
      ),
  );
  if (!counted.ok) {
    notes.push(counted.failure.reason);
    return [];
  }
  return [...counted.value]
    .filter(([, ticks]) => ticks >= HOTSPOT_TICKS)
    .map(([path, ticks]) => ({
      path,
      day,
      ticks,
      proposal: hotspotProposal(path, day, ticks),
    }));
}

/** Weigh one planned repository's pickups against the work in flight, and report it. */
export function planOverlap(
  context: TickContext,
  observation: RepoObservation,
): void {
  const { opened, tracked } = observation;
  const { report, section, repo } = opened;
  const pickups = report.actions.filter((a) => a.stage === "pickup");
  const facts = observation.overlap;
  const notes = [...(facts?.notes ?? [])];
  if (pickups.length === 0) {
    storeWaits(
      context,
      observation,
      [],
      new Map(),
      new Map(),
      new Map(),
      notes,
    );
    return;
  }
  const settings = overlapOf(section);
  const rates = readConflictRates(
    repo.slug,
    context.nowMs,
    undefined,
    settings.fileRate,
  );
  const model = overlapModel(settings, rates.rate, facts?.catalog ?? null);
  const wanted = new Map(tracked.pickups.map((w) => [w.key, w]));
  // A batch is one prospective launch: one candidate under the action's own
  // target, with its members' footprints combined, so members never charge
  // one another. Each member still gets an entry of its own below.
  const memberKeys = new Map<string, string[]>();
  const seen = new Set<string>();
  const candidates = pickups.flatMap((a) => {
    if (seen.has(a.target)) return [];
    const members = membersOf(a).filter((key) => !seen.has(key));
    for (const key of members) seen.add(key);
    memberKeys.set(a.target, members);
    const item = wanted.get(a.target);
    return [
      {
        item: a.target,
        url: item?.url ?? null,
        priority: patienceKey(item?.queueIssue?.priority),
        footprint: combinedFootprint(
          members.map((key) => footprintOf(facts?.readings.get(key))),
        ),
      },
    ];
  });
  const batched = new Set(
    candidates.flatMap((c) => memberKeys.get(c.item) ?? []),
  );
  const inFlight = [
    ...pullRequestsInFlight(observation, settings, context.nowMs),
    ...pickupsInFlight(observation, batched, allRecords(context)),
  ];
  const stored = loadWaits(repo.slug, notes);
  // A batch starts from its members' waits together, so one member's wait or
  // promotion is not lost by joining another's batch.
  const waits = new Map<string, Wait>();
  for (const c of candidates) {
    const joined = combinedWait(
      (memberKeys.get(c.item) ?? [c.item]).map((key) => stored.get(key)),
    );
    if (joined !== undefined) waits.set(c.item, joined);
  }
  const placed = walkOverlap(candidates, inFlight, waits, model, context.nowMs);
  storeWaits(context, observation, placed, memberKeys, stored, waits, notes);
  // A member shares its batch's placement, with its own footprint reading beside it.
  const members = placed.flatMap((p) =>
    (memberKeys.get(p.candidate.item) ?? [p.candidate.item]).map((item) => ({
      placed: p,
      item,
    })),
  );
  const unread = "it was not read this tick";
  const overlap: OverlapReport = {
    rates: { measuredAt: rates.generatedAt, defaulted: rates.defaulted },
    inFlight: {
      pullRequests: inFlight.filter((w) => w.kind === "pull request").length,
      pickups: inFlight.filter((w) => w.kind === "pickup").length,
      unknown: inFlight.filter((w) => !w.footprint.known).map((w) => w.ref),
    },
    entries: members.map(({ placed: p, item }, i) => {
      const reading = facts?.readings.get(item);
      return entryOf(
        { ...p, candidate: { ...p.candidate, item } },
        i + 1,
        {
          source: reading?.source ?? "unknown",
          note: readingNote(reading, unread),
        },
        context.nowMs,
      );
    }),
    hotspots: hotspots(context, repo.slug, placed, notes),
    notes,
  };
  report.overlap = overlap;
}

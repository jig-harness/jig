import {
  copyPlan,
  destinationProblem as representationProblem,
} from "./move-copy-plan.ts";
/**
 * The move between facet stores (design/tracker-facets.md, "Moving a
 * repository from one store to another"): labels to fields, fields to
 * labels, field to field. Every open issue is read through two trackers, one
 * keeping each moved facet in its source store and one in its destination,
 * so each side's value is read and written by the store's own code.
 *
 * - **Preview** lists what each open issue would get, and each issue whose
 *   source gives a moved facet no value or two: it is unresolved, and a
 *   person gives it one value in its source first (an epic needs no size).
 * - **Copy** sets each open issue's destination from its source, keeping the
 *   source, and records the value it copied as the copy snapshot. It refuses
 *   to start while an open issue is unresolved or a destination store fails.
 * - **Retire** reads each open issue again and compares its source with the
 *   snapshot: an unchanged source is retired (its labels taken off, or its
 *   field cleared) once its destination holds a value; a changed source whose
 *   destination is still at the snapshot has its new value copied first; a
 *   source and a destination that both changed conflict, and are left for a
 *   person, as is a destination someone cleared. An issue with no snapshot
 *   has both stores read: a source value alone is copied, both equal retire
 *   the source, both different conflict.
 * - **Restore** puts back every store's value from before the move, from the
 *   record, where the store still holds what the move left in it.
 *
 * Every run writes at most one update per open issue (restore one per
 * store), each recorded before it is sent and marked once it lands. Where a
 * retire must both copy an issue's value and take its source off, it copies
 * in this run and retires in the next, so no run writes an issue twice. A
 * run that stopped is resumed by running it again: an issue whose phase is
 * complete is skipped. Closed issues are never read or written, so they keep
 * their labels as history, and no label is ever deleted.
 */

import type {
  Facets,
  FacetSlot,
  ResolvedFacet,
} from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import { usable } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import {
  carriedLabels,
  facetValue,
  sourceValues,
  setting,
} from "./move-values.ts";
import { labelCodec } from "../../../do-item/scripts/lib/tracker/facets/label.ts";
import { fold } from "../../../do-item/scripts/lib/tracker/facets/values.ts";
import {
  FACETS,
  type Facet,
  type IssuePatch,
  type PoolIssue,
  type Tracker,
} from "../../../do-item/scripts/lib/tracker/port.ts";
import type {
  FacetValue,
  MoveChange,
  MoveRecord,
  StoreChange,
} from "./move-record.ts";
import { assertUnchanged, moveProblem } from "./move-safety.ts";
import { failureLine, type Writer, WriteRefused } from "./pace.ts";

/** The two trackers of a move, and the facets each keeps. */
export interface MoveSides {
  source: Tracker;
  target: Tracker;
  sourceFacets: Facets;
  targetFacets: Facets;
}

/** What one run of a phase found and did, by issue key. */
export interface MoveReport {
  phase: "preview" | "copy" | "retire" | "restore";
  apply: boolean;
  moved: Facet[];
  /** Open issues read in both stores. */
  open: number;
  /** What each open issue holds once the move is done (the preview's list). */
  gets: Array<{ issue: string; values: Partial<Record<Facet, FacetValue>> }>;
  /** The writes this run makes (or, without `apply`, would make). */
  writes: Array<{
    issue: string;
    tracker: "source" | "target";
    set: Partial<Record<Facet, FacetValue>>;
    /** The value each set facet replaces, where it held one. */
    replaces: Partial<Record<Facet, FacetValue>>;
  }>;
  /** Issues this run wrote. */
  written: string[];
  /** Issues a person settles before the phase can finish. */
  unresolved: Array<{ issue: string; why: string }>;
  conflicts: Array<{ issue: string; why: string }>;
  /** Issues the next run of this phase finishes. */
  again: string[];
  /** Read in one store's read but not the other's: opened or closed during the read. */
  skipped: string[];
  /** Why the run refused to start, or `null`. */
  problem: string | null;
  /** Why a write stopped the run, or `null`. */
  stopped: string | null;
}

/**
 * Whether two slots keep a facet in the same place, the same way: the same
 * field and the same written value. Names only read back are no move, since
 * the stored value is unchanged and a retire would clear the destination.
 */
function sameStore(a: FacetSlot, b: FacetSlot): boolean {
  if (!usable(a) || !usable(b)) return usable(a) === usable(b);
  const labels = (s: ResolvedFacet) =>
    JSON.stringify(
      (s.labels ?? []).map(([v, ls]) => [v, fold(ls[0] ?? "")] as const),
    );
  const map = (s: ResolvedFacet) =>
    JSON.stringify(
      (s.map?.names ?? []).map(([v, ns]) => [v, fold(ns[0] ?? "")] as const),
    );
  return (
    a.store === b.store &&
    (a.field ?? "") === (b.field ?? "") &&
    labels(a) === labels(b) &&
    map(a) === map(b)
  );
}

/** The facets whose store the target changes. */
export function movedFacets(source: Facets, target: Facets): Facet[] {
  return FACETS.filter(
    (f) => usable(source[f]) && !sameStore(source[f], target[f]),
  );
}

/** One store's change, with the labels a label store adds and takes off. */
function storeChange(
  slot: ResolvedFacet,
  side: StoreChange["side"],
  issue: PoolIssue,
  before: FacetValue,
  after: FacetValue,
): StoreChange {
  const change: StoreChange = {
    facet: slot.facet,
    side,
    store: slot.store,
    ...(slot.field === null || slot.store === "label"
      ? {}
      : { field: slot.field }),
    before,
    after,
  };
  if (slot.store === "label") {
    const carried = carriedLabels(slot, issue, before);
    const label = after === null ? null : labelCodec(slot).labelOf(after);
    change.labelsAdded =
      label === null || carried.some((l) => fold(l) === fold(label))
        ? []
        : [label];
    change.labelsRemoved = carried.filter(
      (l) => label === null || fold(l) !== fold(label),
    );
  }
  return change;
}

export interface Pair {
  key: string;
  src: PoolIssue;
  dst: PoolIssue;
}

/** Every open issue, read through each tracker and joined by key. */
async function readPairs(
  sides: MoveSides,
  signal?: AbortSignal,
): Promise<{ pairs: Pair[]; skipped: string[] }> {
  const options = signal === undefined ? {} : { signal };
  const src = await sides.source.openPopulation(options);
  const dst = new Map(
    (await sides.target.openPopulation(options)).map((i) => [i.identifier, i]),
  );
  const pairs: Pair[] = [];
  const skipped: string[] = [];
  for (const s of src) {
    const d = dst.get(s.identifier);
    if (d === undefined) skipped.push(s.identifier);
    else pairs.push({ key: s.identifier, src: s, dst: d });
    dst.delete(s.identifier);
  }
  skipped.push(...dst.keys());
  return { pairs, skipped };
}

const isEpic = (issue: PoolIssue, facets: Facets) =>
  issue.labels.some((l) => fold(l) === fold(facets.epic));

function emptyReport(
  phase: MoveReport["phase"],
  apply: boolean,
  moved: Facet[],
): MoveReport {
  return {
    phase,
    apply,
    moved,
    open: 0,
    gets: [],
    writes: [],
    written: [],
    unresolved: [],
    conflicts: [],
    again: [],
    skipped: [],
    problem: null,
    stopped: null,
  };
}

/** Why a destination store cannot take the move's writes, or `null`. */
async function destinationProblem(
  sides: MoveSides,
  moved: Facet[],
  signal?: AbortSignal,
): Promise<string | null> {
  const stores = await sides.target.facetStores({
    discovery: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const bad = stores.facets
    .filter((f) => moved.includes(f.facet))
    .flatMap((f) =>
      f.problem !== undefined
        ? [`${f.facet}: ${f.problem}`]
        : f.health?.status === "failed"
          ? [`${f.facet}: ${f.health.error}`]
          : [],
    );
  return bad.length === 0
    ? null
    : `the destination cannot be written: ${bad.join("; ")}`.slice(0, 600);
}

/** The slot of a facet the move moves: usable on both sides. */
function slotOf(facets: Facets, f: Facet): ResolvedFacet {
  return facets[f] as ResolvedFacet;
}

/**
 * A run's report, and every open issue read through both trackers. Every
 * phase but restore first checks that the destination can be written.
 */
async function begin(
  sides: MoveSides,
  phase: MoveReport["phase"],
  apply: boolean,
  moved: Facet[],
  signal?: AbortSignal,
): Promise<{ report: MoveReport; pairs: Pair[] }> {
  const report = emptyReport(phase, apply, moved);
  report.problem = moveProblem(sides, moved);
  if (phase !== "restore" && report.problem === null)
    report.problem = await destinationProblem(sides, moved, signal);
  const { pairs, skipped } = await readPairs(sides, signal);
  report.open = pairs.length;
  report.skipped = skipped;
  return { report, pairs };
}

/** The destination changes of a write that sets each facet of `set`. */
function destinationChanges(
  sides: MoveSides,
  pair: Pair,
  set: Partial<Record<Facet, FacetValue>>,
): StoreChange[] {
  return Object.entries(set).map(([f, v]) =>
    storeChange(
      slotOf(sides.targetFacets, f as Facet),
      "destination",
      pair.dst,
      facetValue(pair.dst, f as Facet),
      v ?? null,
    ),
  );
}

/** Keeps the record as each write lands. */
interface Recording {
  record: MoveRecord;
  save: (record: MoveRecord) => void;
  now: () => string;
  /** Told of each update as it lands, by key, so a run cut short still shows what it did. */
  progress?: (line: string) => void;
}

/**
 * Send one update, recorded before it is sent and marked once it lands.
 * Throws `WriteRefused` when the writer stops the run.
 */
async function recordedWrite(
  rec: Recording,
  writer: Writer,
  change: Omit<MoveChange, "at" | "done">,
  send: (signal?: AbortSignal) => Promise<void>,
  verify: (signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  await writer.write(`update ${change.issue}`, async (signal) => {
    await verify(signal);
    writer.signal?.throwIfAborted();
    const entry: MoveChange = { ...change, at: rec.now(), done: false };
    rec.record.changes.push(entry);
    rec.save(rec.record);
    await send(signal);
    entry.done = true;
    rec.save(rec.record);
  });
  rec.progress?.(`${change.phase}: updated ${change.issue}`);
}

/** The patch that sets each facet of `set`. */
function patchOf(set: Partial<Record<Facet, FacetValue>>): IssuePatch {
  return Object.assign(
    {},
    ...Object.entries(set).map(([f, v]) => setting(f as Facet, v ?? null)),
  );
}

/** Note a stopped run: a refused write, or a write that failed otherwise. */
function stoppedBy(err: unknown, key: string): string {
  return err instanceof WriteRefused
    ? err.message
    : failureLine(`update ${key}`, err);
}

/** One write a run plans: what the report shows, and what is sent and recorded. */
interface PlannedWrite {
  issue: string;
  tracker: "source" | "target";
  set: Partial<Record<Facet, FacetValue>>;
  replaces: Partial<Record<Facet, FacetValue>>;
  patch: IssuePatch;
  stores: StoreChange[];
  /** What the record learns once the write lands, such as a new snapshot. */
  landed?: () => void;
  expected?: Pair;
}

/** What the report shows of each planned write. */
function shown(writes: PlannedWrite[]): MoveReport["writes"] {
  return writes.map(({ issue, tracker, set, replaces }) => ({
    issue,
    tracker,
    set,
    replaces,
  }));
}

/** A changed issue is a conflict; any other failure stops the write run. */
function noteFailure(err: unknown, issue: string, report: MoveReport): boolean {
  const conflict = err instanceof WriteRefused ? err.cause : err;
  if (conflict instanceof Error && conflict.name === "MoveConflict") {
    report.conflicts.push({ issue, why: conflict.message });
    return true;
  }
  report.stopped = stoppedBy(err, issue);
  return false;
}

/**
 * Send each planned write through its tracker, recorded, paced and in
 * order; a refused write stops the run, noted in `report`.
 */
async function applyWrites(
  sides: MoveSides,
  rec: Recording,
  writer: Writer,
  phase: MoveChange["phase"],
  writes: PlannedWrite[],
  report: MoveReport,
): Promise<void> {
  for (const w of writes) {
    const tracker = w.tracker === "source" ? sides.source : sides.target;
    try {
      await recordedWrite(
        rec,
        writer,
        { issue: w.issue, phase, stores: w.stores },
        (signal) => tracker.updateIssue(w.issue, w.patch, signal),
        async (signal) => {
          if (w.expected !== undefined)
            await assertUnchanged(
              sides,
              w.expected,
              phase === "restore" ? w.tracker : undefined,
              signal,
            );
          writer.signal?.throwIfAborted();
        },
      );
    } catch (err) {
      if (!noteFailure(err, w.issue, report)) return;
      continue;
    }
    if (!report.written.includes(w.issue)) report.written.push(w.issue);
    if (w.landed !== undefined) {
      w.landed();
      rec.save(rec.record);
    }
  }
}

/** Record `values` as the copy snapshot of `issue`. */
function snapshot(
  rec: Recording,
  issue: string,
  values: Partial<Record<Facet, FacetValue>>,
): void {
  rec.record.snapshots[issue] = { ...rec.record.snapshots[issue], ...values };
}

type CopyPlan = { pair: Pair } & ReturnType<typeof copyPlan>;

/** The copy's write of one issue, when its destination needs one. */
function copyWrite(
  p: CopyPlan,
  sides: MoveSides,
  rec: Recording,
): PlannedWrite[] {
  if (Object.keys(p.set).length === 0) return [];
  return [
    {
      expected: p.pair,
      issue: p.pair.key,
      tracker: "target",
      set: p.set,
      replaces: p.replaces,
      patch: patchOf(p.set),
      stores: destinationChanges(sides, p.pair, p.set),
      landed: () => snapshot(rec, p.pair.key, p.copied),
    },
  ];
}

/** Attach issue keys to the reasons produced by each plan. */
function planReasons(
  plans: Array<{ pair: Pair; unresolved: string[]; conflicts: string[] }>,
  kind: "unresolved" | "conflicts",
) {
  return plans.flatMap((p) =>
    p[kind].map((why) => ({ issue: p.pair.key, why })),
  );
}

/** The preview, or a copy run: `apply` writes the destination of every issue that needs it. */
export async function copy(
  sides: MoveSides,
  rec: Recording,
  opts: { apply: boolean; writer: Writer; preview?: boolean },
): Promise<MoveReport> {
  const moved = rec.record.moved;
  const { report, pairs } = await begin(
    sides,
    opts.preview === true ? "preview" : "copy",
    opts.apply,
    moved,
    opts.writer.signal,
  );
  const plans = pairs.map((p) => ({
    pair: p,
    ...copyPlan(p, moved, sides, rec.record.snapshots[p.key]),
  }));
  const writes = plans
    .filter((p) => p.conflicts.length === 0)
    .flatMap((p) => copyWrite(p, sides, rec));
  report.conflicts = planReasons(plans, "conflicts");
  report.gets = plans.map((p) => ({ issue: p.pair.key, values: p.gets }));
  report.unresolved = planReasons(plans, "unresolved");
  report.writes = shown(writes);
  if (report.unresolved.length > 0 && report.problem === null)
    report.problem = `${new Set(report.unresolved.map((i) => i.issue)).size} open issue(s) are unresolved: give each one value in its source first`;
  if (!opts.apply || report.problem !== null) return report;
  // An issue already copied: its destination holds the source's value.
  for (const p of plans)
    if (Object.keys(p.set).length === 0 && Object.keys(p.copied).length > 0)
      snapshot(rec, p.pair.key, p.copied);
  rec.save(rec.record);
  await applyWrites(sides, rec, opts.writer, "copy", writes, report);
  rec.save(rec.record);
  return report;
}

/** What the retire does with one facet of one issue. */
type Decision =
  | { kind: "none" }
  | { kind: "retire" }
  | { kind: "copy"; value: string; replaces: FacetValue }
  | { kind: "unresolved" | "conflict"; why: string };

/**
 * The retire's decision for facet `f`, from its source values, its
 * destination value `d` and the copy snapshot `snap`.
 */
function retireDecision(
  f: Facet,
  values: string[],
  d: FacetValue,
  snap: FacetValue | undefined,
): Decision {
  if (values.length > 1)
    return {
      kind: "unresolved",
      why: `${f} has two values in its source (${values.join(", ")})`,
    };
  const s = values[0];
  if (s === undefined)
    return d !== null
      ? { kind: "none" }
      : {
          kind: "unresolved",
          why: `${f}: neither source nor destination has a value`,
        };
  if (d === s) return { kind: "retire" };
  if (snap === undefined)
    return d === null
      ? { kind: "copy", value: s, replaces: null }
      : {
          kind: "conflict",
          why: `${f}: its source holds ${s} and its destination ${d}`,
        };
  if (s === snap)
    return d !== null
      ? { kind: "retire" }
      : {
          kind: "unresolved",
          why: `${f}: its destination was cleared or names no value, and its source still holds ${s}`,
        };
  if (d === snap) return { kind: "copy", value: s, replaces: d };
  return {
    kind: "conflict",
    why: `${f}: its source changed to ${s} and its destination to ${d ?? "none"} since the copy wrote ${snap}`,
  };
}

/** What the retire does to one issue. */
function retirePlan(
  pair: Pair,
  moved: Facet[],
  sides: MoveSides,
  snapshotOf: Partial<Record<Facet, FacetValue>> | undefined,
) {
  const copyNow: Partial<Record<Facet, FacetValue>> = {};
  const replaces: Partial<Record<Facet, FacetValue>> = {};
  const retire: Facet[] = [];
  const unresolved: string[] = [];
  const conflicts: string[] = [];
  for (const f of moved) {
    const problem = representationProblem(
      pair,
      f,
      slotOf(sides.targetFacets, f),
    );
    if (problem !== null) {
      unresolved.push(problem);
      continue;
    }
    if (
      f === "size" &&
      isEpic(pair.src, sides.sourceFacets) &&
      facetValue(pair.src, f) === null &&
      facetValue(pair.dst, f) === null
    )
      continue;
    const decision = retireDecision(
      f,
      sourceValues(slotOf(sides.sourceFacets, f), pair.src, f),
      facetValue(pair.dst, f),
      snapshotOf?.[f],
    );
    if (decision.kind === "retire") retire.push(f);
    else if (decision.kind === "copy") {
      copyNow[f] = decision.value;
      if (decision.replaces !== null) replaces[f] = decision.replaces;
    } else if (decision.kind === "unresolved") unresolved.push(decision.why);
    else if (decision.kind === "conflict") conflicts.push(decision.why);
  }
  return { copyNow, replaces, retire, unresolved, conflicts };
}

/** The patch that takes the source of `facets` off, never a destination label. */
function retirement(facets: Facet[], pair: Pair, sides: MoveSides): IssuePatch {
  const patch: IssuePatch = {};
  const remove: string[] = [];
  for (const f of facets) {
    const src = slotOf(sides.sourceFacets, f);
    const dst = slotOf(sides.targetFacets, f);
    if (src.store === "label" && dst.store === "label") {
      // Both in labels: take off only the source's own, never a destination label.
      const theirs = labelCodec(dst);
      remove.push(
        ...carriedLabels(src, pair.src, facetValue(pair.src, f)).filter(
          (l) => !theirs.owns(l),
        ),
      );
    } else Object.assign(patch, setting(f, null));
  }
  if (remove.length > 0) patch.removeLabels = remove;
  return patch;
}

type RetirePlan = { pair: Pair } & ReturnType<typeof retirePlan>;

/**
 * The retire's write of one issue: a value to copy first, which the next
 * run retires, or else the source to take off.
 */
function retireWrite(
  p: RetirePlan,
  sides: MoveSides,
  rec: Recording,
): PlannedWrite[] {
  if (Object.keys(p.copyNow).length > 0)
    return [
      {
        expected: p.pair,
        issue: p.pair.key,
        tracker: "target",
        set: p.copyNow,
        replaces: p.replaces,
        patch: patchOf(p.copyNow),
        stores: destinationChanges(sides, p.pair, p.copyNow),
        landed: () => snapshot(rec, p.pair.key, p.copyNow),
      },
    ];
  if (p.retire.length === 0) return [];
  return [
    {
      expected: p.pair,
      issue: p.pair.key,
      tracker: "source",
      set: Object.fromEntries(p.retire.map((f) => [f, null])),
      replaces: Object.fromEntries(
        p.retire.map((f) => [f, facetValue(p.pair.src, f)]),
      ),
      patch: retirement(p.retire, p.pair, sides),
      stores: p.retire.map((f) =>
        storeChange(
          slotOf(sides.sourceFacets, f),
          "source",
          p.pair.src,
          facetValue(p.pair.src, f),
          null,
        ),
      ),
    },
  ];
}

/** A retire run: `apply` takes the source off every issue whose destination holds its value. */
export async function retire(
  sides: MoveSides,
  rec: Recording,
  opts: { apply: boolean; writer: Writer },
): Promise<MoveReport> {
  const moved = rec.record.moved;
  const { report, pairs } = await begin(
    sides,
    "retire",
    opts.apply,
    moved,
    opts.writer.signal,
  );
  const plans = pairs.map((p): RetirePlan => {
    const plan = retirePlan(p, moved, sides, rec.record.snapshots[p.key]);
    // An issue a person must settle is left as it is, every facet of it.
    return plan.unresolved.length + plan.conflicts.length === 0
      ? { pair: p, ...plan }
      : { pair: p, ...plan, copyNow: {}, replaces: {}, retire: [] };
  });
  report.unresolved = planReasons(plans, "unresolved");
  report.conflicts = planReasons(plans, "conflicts");
  report.again = plans
    .filter((p) => Object.keys(p.copyNow).length > 0)
    .map((p) => p.pair.key);
  const writes = plans.flatMap((p) => retireWrite(p, sides, rec));
  report.writes = shown(writes);
  if (!opts.apply || report.problem !== null) return report;
  await applyWrites(sides, rec, opts.writer, "retire", writes, report);
  report.again = report.again.filter((key) => report.written.includes(key));
  return report;
}

/** One issue's stores, by side and facet: the value before the move, and each it left. */
type StoreHistory = Map<
  string,
  {
    before: FacetValue;
    afters: FacetValue[];
    labels: Array<{ add: string[]; remove: string[] }>;
  }
>;

/** Reverse only the labels recorded by the migration, preserving unrelated labels. */
function restoredLabels(
  deltas: Array<{ add: string[]; remove: string[] }>,
  current: string[],
): string[] {
  let labels = current;
  for (const delta of [...deltas].reverse()) {
    labels = labels.filter((l) => !delta.add.some((a) => fold(a) === fold(l)));
    for (const l of delta.remove)
      if (!labels.some((a) => fold(a) === fold(l))) labels.push(l);
  }
  return labels;
}

function rememberStore(seen: StoreHistory, s: StoreChange): void {
  const key = `${s.side} ${s.facet}`;
  const h = seen.get(key) ?? { before: s.before, afters: [], labels: [] };
  h.afters.push(s.after);
  if (s.store === "label")
    h.labels.push({ add: s.labelsAdded ?? [], remove: s.labelsRemoved ?? [] });
  seen.set(key, h);
}

/** Per issue, facet and side: the value before the move first changed it, and every value it left. */
function history(record: MoveRecord): Map<string, StoreHistory> {
  const out = new Map<string, StoreHistory>();
  for (const change of record.changes)
    for (const s of change.stores) {
      const perIssue: StoreHistory = out.get(change.issue) ?? new Map();
      out.set(change.issue, perIssue);
      rememberStore(perIssue, s);
    }
  return out;
}

/** The current value of one store of an issue, or `undefined` when a source names two. */
function storeNow(
  pair: Pair,
  f: Facet,
  side: "source" | "target",
  sides: MoveSides,
): FacetValue | undefined {
  const issue = side === "target" ? pair.dst : pair.src;
  if (issue.unmappedFacets?.includes(f)) return undefined;
  const slots = side === "target" ? sides.targetFacets : sides.sourceFacets;
  const values = sourceValues(slotOf(slots, f), issue, f);
  return values.length > 1 ? undefined : (values[0] ?? null);
}

/** The restore's write to one side of one issue. */
function restoreWrite(
  pair: Pair,
  side: "source" | "target",
  set: Partial<Record<Facet, FacetValue>>,
  replaces: Partial<Record<Facet, FacetValue>>,
  sides: MoveSides,
): PlannedWrite {
  const facets = side === "source" ? sides.sourceFacets : sides.targetFacets;
  const issue = side === "source" ? pair.src : pair.dst;
  return {
    expected: pair,
    issue: pair.key,
    tracker: side,
    set,
    replaces,
    patch: patchOf(set),
    stores: Object.entries(set).map(([f, v]) =>
      storeChange(
        slotOf(facets, f as Facet),
        side === "source" ? "source" : "destination",
        issue,
        replaces[f as Facet] ?? null,
        v ?? null,
      ),
    ),
  };
}

/** A native store has no labels to restore. */
function restoreExactLabels(
  out: Partial<Record<Facet, string[]>>,
  f: Facet,
  deltas: Array<{ add: string[]; remove: string[] }>,
  pair: Pair,
  sides: MoveSides,
  side: "source" | "target",
  now: FacetValue,
): boolean {
  const slot = slotOf(
    side === "source" ? sides.sourceFacets : sides.targetFacets,
    f,
  );
  const issue = side === "source" ? pair.src : pair.dst;
  if (deltas.length === 0) return false;
  const current = carriedLabels(slot, issue, now);
  const wanted = restoredLabels(deltas, current);
  out[f] = wanted;
  return !(
    wanted.length === current.length &&
    wanted.every((l) => current.some((c) => fold(c) === fold(l)))
  );
}

/**
 * The restore's writes to one issue: each store put back to its value
 * before the move, where it still holds one the move left; one that
 * changed since is noted in `report` and left.
 */
function issueRestores(
  pair: Pair,
  stores: StoreHistory,
  sides: MoveSides,
  report: MoveReport,
): PlannedWrite[] {
  const sets = { source: {}, target: {} } as Record<
    "source" | "target",
    Partial<Record<Facet, FacetValue>>
  >;
  const was = { source: {}, target: {} } as typeof sets;
  const exact: Record<"source" | "target", Partial<Record<Facet, string[]>>> = {
    source: {},
    target: {},
  };
  for (const [key, h] of stores) {
    const [sideName, f] = key.split(" ") as ["source" | "destination", Facet];
    const side = sideName === "source" ? "source" : "target";
    const now = storeNow(pair, f, side, sides);
    if (now === undefined || (now !== h.before && !h.afters.includes(now))) {
      report.conflicts.push({
        issue: pair.key,
        why: `${f} in its ${sideName} changed since the move (now ${now ?? "two values"}), so it is left as it is`,
      });
      continue;
    }
    const labelsChanged = restoreExactLabels(
      exact[side],
      f,
      h.labels,
      pair,
      sides,
      side,
      now,
    );
    if (now === h.before && !labelsChanged) continue;
    sets[side][f] = h.before;
    was[side][f] = now;
  }
  return (["source", "target"] as const)
    .filter((side) => Object.keys(sets[side]).length > 0)
    .map((side) => {
      const w = restoreWrite(pair, side, sets[side], was[side], sides);
      w.patch.facetLabels = exact[side];
      return w;
    });
}

/** A restore run: `apply` puts back every store's value from before the move. */
export async function restore(
  sides: MoveSides,
  rec: Recording,
  opts: { apply: boolean; writer: Writer },
): Promise<MoveReport> {
  const { report, pairs } = await begin(
    sides,
    "restore",
    opts.apply,
    rec.record.moved,
    opts.writer.signal,
  );
  const byKey = new Map(pairs.map((p) => [p.key, p]));
  const writes: PlannedWrite[] = [];
  for (const [issue, stores] of history(rec.record)) {
    const pair = byKey.get(issue);
    if (pair === undefined)
      report.unresolved.push({
        issue,
        why: "it is not open now, so it is left as it is",
      });
    else writes.push(...issueRestores(pair, stores, sides, report));
  }
  report.writes = shown(writes);
  if (!opts.apply) return report;
  await applyWrites(sides, rec, opts.writer, "restore", writes, report);
  return report;
}

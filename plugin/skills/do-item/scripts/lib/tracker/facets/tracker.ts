import {
  addRestores,
  restoringChange,
  forwardRestores,
  censusReader,
} from "./restore-labels.ts";
/**
 * The facets every adapter shares: an adapter (its core) reads and writes
 * the facets it keeps in the tracker's own fields, and `withFacets` adds the
 * rest from labels, checks every facet value a write names, narrows a pool
 * by facet, lists the incomplete issues and reports each facet's store.
 *
 * A facet the core keeps is read from what the core returns; one kept in
 * labels is read from the issue's labels, and written by adding its value's
 * label and taking the facet's other labels off. A change of such a facet
 * reads the issue's labels first, so a write never leaves two values. A
 * label a label store owns is the facet's to write: naming one among a new
 * issue's labels, or among the labels a change adds, is refused, pointing at
 * the facet.
 */

import { checkPriority } from "../requests.ts";
import {
  type CanonicalState,
  FACETS,
  type Facet,
  type FacetReadOptions,
  type FacetStores,
  type FacetValues,
  type FacetStoreReport,
  type IncompleteIssue,
  type IncompletePage,
  type IncompleteQuery,
  type Issue,
  type IssuePatch,
  type NewIssue,
  type PoolIssue,
  type PoolQuery,
  type QueueIssue,
  type Tracker,
  TrackerRequestError,
} from "../port.ts";
import { TrackerConfigError } from "../config-error.ts";
import { readSignal, refuseStopped } from "./bounds.ts";
import {
  baseReport,
  type FacetSlot,
  type Facets,
  type ResolvedFacet,
  usable,
} from "./config.ts";
import {
  type LabelCodec,
  labelCodec,
  priorityFromLabels,
  priorityLabel,
} from "./label.ts";
import { canonical, fold, PRIORITY_NAMES } from "./values.ts";
import { isEpic } from "../../../../../../shared/tracker-labels.ts";

/**
 * An issue as an adapter's core reads it: the facets it keeps, at most, and
 * no `isEpic`, which `withFacets` sets.
 */
export type CoreIssue = Omit<Issue, "type" | "size" | "isEpic"> &
  Partial<Pick<Issue, "type" | "size">>;

/**
 * A pool issue as an adapter's core reads it. `hiddenLabels` are labels the
 * core keeps out of `labels` (GitHub's priority labels): only the open
 * population carries them, so `incompleteIssues` can list a retired one.
 * `withFacets` reads `isEpic` from its labels and `nativeType`.
 */
export type CorePoolIssue = Omit<PoolIssue, "type" | "size" | "isEpic"> &
  Partial<Pick<PoolIssue, "type" | "size">> & { hiddenLabels?: string[] };

/** A queue issue as an adapter's core reads it: its parent in core form too. */
export type CoreQueueIssue = CorePoolIssue &
  Pick<QueueIssue, "relations"> & {
    parent: {
      issue: CorePoolIssue;
      description: string;
      parent: string | null;
    } | null;
  };

/** The adapter's own part of `facetStores`. */
export interface CoreFacetReport {
  facets: Partial<
    Record<Facet, Pick<FacetStoreReport, "health" | "detection" | "moveTo">>
  >;
  discovery: FacetStores["discovery"];
}

/** What an adapter implements; `withFacets` makes it a `Tracker`. */
export interface CoreTracker
  extends Omit<
    Tracker,
    | "getIssue"
    | "openIssues"
    | "openChildren"
    | "poolIssue"
    | "poolIssues"
    | "queueIssues"
    | "queueIssuesByKey"
    | "assignedIssues"
    | "unassignedIssues"
    | "incompleteIssues"
    | "openPopulation"
    | "facetStores"
  > {
  getIssue(key: string): Promise<CoreIssue | null>;
  openIssues(query: PoolQuery): Promise<CorePoolIssue[]>;
  openChildren(key: string): Promise<CorePoolIssue[]>;
  poolIssue(key: string, signal?: AbortSignal): Promise<CorePoolIssue | null>;
  poolIssues?(
    keys: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, CorePoolIssue | null>>;
  queueIssues?(
    identity: string,
    states: ReadonlyArray<CanonicalState>,
    signal?: AbortSignal,
  ): Promise<CoreQueueIssue[]>;
  queueIssuesByKey?(
    keys: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, CoreQueueIssue>>;
  assignedIssues(
    identity: string,
    states: ReadonlyArray<CanonicalState>,
    signal?: AbortSignal,
  ): Promise<CorePoolIssue[]>;
  unassignedIssues?(
    states: ReadonlyArray<CanonicalState>,
    signal?: AbortSignal,
  ): Promise<CorePoolIssue[]>;
  /**
   * Every open issue of this team, in pool form, read whole; `signal` ends
   * the read in flight and starts no further page.
   */
  openPopulation(signal?: AbortSignal): Promise<CorePoolIssue[]>;
  /** Store health, detection and discovery, where the adapter has them, within `options`' bounds. */
  facetReport?(options?: FacetReadOptions): Promise<CoreFacetReport>;
}

/** The value `value` names among a facet's values, refusing one it does not. */
export function checkFacetValue(slot: FacetSlot, value: string): string {
  if (!usable(slot)) {
    if (slot.problem !== null)
      throw new TrackerConfigError("issue_tracker.taxonomy", slot.problem);
    throw new TrackerRequestError(
      "invalid",
      `this repository has no ${slot.facet} facet: its label taxonomy has no ${slot.facet} group`,
    );
  }
  const found = canonical(slot.values, value);
  if (found === null)
    throw new TrackerRequestError(
      "invalid",
      `'${value}' is not a ${slot.facet} of this repository (${slot.values.join(", ")})`,
    );
  return found;
}

const LABEL_FACETS = ["type", "size"] as const;

/** Whether a patch changes anything. */
function changes(patch: IssuePatch): boolean {
  return Object.values(patch).some((v) =>
    Array.isArray(v) ? v.length > 0 : v !== undefined,
  );
}

/**
 * The tracker an adapter's core makes: `coreFacets` names the facets the
 * core reads and writes itself; every other facet with a store is a label
 * store, kept here.
 */
export function withFacets(
  core: CoreTracker,
  facets: Facets,
  coreFacets: ReadonlySet<Facet>,
): Tracker {
  const {
    openPopulation,
    facetReport,
    poolIssues: _batch,
    queueIssues: _queue,
    queueIssuesByKey: _queueByKey,
    unassignedIssues,
    ...rest
  } = core;
  const codecs = new Map<Facet, LabelCodec>();
  for (const f of FACETS) {
    const slot = facets[f];
    if (usable(slot) && slot.store === "label" && !coreFacets.has(f))
      codecs.set(f, labelCodec(slot));
  }

  function withValues<T extends CoreIssue | CorePoolIssue>(
    issue: T,
  ): T & FacetValues & { isEpic: boolean } {
    const read = (f: "type" | "size"): string | null => {
      const codec = codecs.get(f);
      if (codec !== undefined) return codec.read(issue.labels ?? []);
      return coreFacets.has(f) ? (issue[f] ?? null) : null;
    };
    const priority = codecs.get("priority");
    const values: FacetValues & { isEpic: boolean } = {
      type: read("type"),
      size: read("size"),
      priority:
        priority === undefined
          ? issue.priority
          : priorityFromLabels(priority, issue.labels ?? []),
      isEpic: isEpic(
        { labels: issue.labels ?? [], nativeType: issue.nativeType ?? null },
        facets,
      ),
    };
    return { ...issue, ...values };
  }

  /**
   * Refuse a label a label store owns among labels a write names: it is the
   * facet's to write, so the caller gives the facet instead.
   */
  function refuseFacetLabels(
    labels: ReadonlyArray<string>,
    where: string,
  ): void {
    for (const codec of codecs.values()) {
      const owned = labels.find((l) => codec.owns(l));
      if (owned === undefined) continue;
      const value = codec.read([owned]) as string;
      const given =
        codec.facet === "priority"
          ? `priority: ${PRIORITY_NAMES.indexOf(value as (typeof PRIORITY_NAMES)[number]) + 1} (${value})`
          : `${codec.facet}: ${value}`;
      throw new TrackerRequestError(
        "invalid",
        `the label '${owned}' ${where} is the ${codec.facet} ${value}; give it as the issue's ${codec.facet} (${given}), not as a label`,
      );
    }
  }

  /**
   * Refuse a retired label of a type or size kept outside labels among the
   * labels a write adds: it would put back a label the store no longer
   * reads, beside the value the store holds. Taking one off stays allowed.
   * Jira's adapter refuses its native-type fallback labels and a label
   * behind a `field_labels` prefix itself, so only its field stores are
   * checked here, and not for those labels.
   */
  function refuseRetiredLabels(labels: ReadonlyArray<string>): void {
    for (const f of LABEL_FACETS) {
      const slot = facets[f];
      if (!usable(slot) || slot.store === "label") continue;
      if (facets.adapter === "jira" && slot.store !== "field") continue;
      const retired = labelCodec({
        ...slot,
        store: "label",
        labels: slot.retired ?? [],
      });
      const refused = slot.refusedPrefixes ?? [];
      const owned = labels.find(
        (l) =>
          retired.owns(l) &&
          fold(l) !== fold(facets.epic) &&
          !refused.some((p) => l.startsWith(p)),
      );
      if (owned === undefined) continue;
      const value = retired.read([owned]) as string;
      const where =
        slot.field === null ? `its ${f}` : `the field '${slot.field}'`;
      throw new TrackerRequestError(
        "invalid",
        `the label '${owned}' stands for the ${f} ${value}, which this repository keeps in ${where}, not in labels; give it as the issue's ${f} (${f}: ${value})`,
      );
    }
  }

  /** Refuse removing the label of the value a patch sets its facet to. */
  function refuseEditContradiction(
    codec: LabelCodec,
    value: string | null,
    patch: IssuePatch,
  ): void {
    const dropped =
      value === null
        ? undefined
        : (patch.removeLabels ?? []).find(
            (l) => codec.owns(l) && codec.read([l]) === value,
          );
    if (dropped !== undefined)
      throw new TrackerRequestError(
        "invalid",
        `the label '${dropped}' to remove is the ${codec.facet} '${value}' this write sets`,
      );
  }

  /** `issue` as the core receives it: label-kept facets turned into labels. */
  function forCore(issue: NewIssue): NewIssue {
    refuseFacetLabels(issue.labels, "to file");
    refuseRetiredLabels(issue.labels);
    const out: NewIssue = { ...issue, labels: [...issue.labels] };
    const add = (label: string) => {
      if (!out.labels.some((l) => fold(l) === fold(label)))
        out.labels.push(label);
    };
    for (const f of LABEL_FACETS) {
      const given = issue[f];
      if (given === undefined) continue;
      const value = checkFacetValue(facets[f], given);
      const codec = codecs.get(f);
      if (codec === undefined) out[f] = value;
      else {
        delete out[f];
        add(codec.labelOf(value));
      }
    }
    const priority = codecs.get("priority");
    if (priority !== undefined && issue.priority !== undefined) {
      checkPriority(issue.priority);
      delete out.priority;
      const label = priorityLabel(priority, issue.priority);
      if (label !== null) add(label);
    }
    return out;
  }

  async function createIssue(issue: NewIssue) {
    return rest.createIssue(forCore(issue));
  }

  /** What the core would file `issue` as, after the same facet conversion as the write. */
  const coreFiledAs = rest.filedAs?.bind(rest);
  const filedAs =
    coreFiledAs === undefined
      ? undefined
      : (issue: NewIssue) => coreFiledAs(forCore(issue));

  /** The label changes a patch's label-kept facets make, from the issue's labels. */
  async function facetLabels(
    key: string,
    patch: IssuePatch,
    signal?: AbortSignal,
  ): Promise<{ add: string[]; remove: string[] }> {
    const changes: Array<[LabelCodec, string | null]> = [];
    for (const f of LABEL_FACETS) {
      const given = patch[f];
      const codec = codecs.get(f);
      if (given === undefined || codec === undefined) continue;
      const value = given === null ? null : checkFacetValue(facets[f], given);
      refuseEditContradiction(codec, value, patch);
      changes.push([codec, value]);
    }
    const priority = codecs.get("priority");
    if (priority !== undefined && patch.priority !== undefined) {
      checkPriority(patch.priority);
      const name = priorityLabel(priority, patch.priority);
      const value = name === null ? null : (priority.read([name]) as string);
      refuseEditContradiction(priority, value, patch);
      changes.push([priority, value]);
    }
    addRestores(changes, patch.facetLabels, codecs, coreFacets);
    if (changes.length === 0) return { add: [], remove: [] };
    const current = await rest.poolIssue(key, signal);
    if (current === null)
      throw new TrackerRequestError(
        "unresolved",
        `issue ${key} does not exist`,
      );
    if (current.truncated.includes("labels"))
      throw new TrackerRequestError(
        "invalid",
        `issue ${key} has more labels than one read takes, so a facet kept in labels cannot be changed safely`,
      );
    const add: string[] = [];
    const remove: string[] = [];
    for (const [codec, value] of changes) {
      const change = restoringChange(
        codec,
        current.labels,
        value,
        patch.facetLabels?.[codec.facet],
      );
      add.push(...change.add);
      remove.push(...change.remove);
    }
    return { add, remove };
  }

  async function updateIssue(
    key: string,
    patch: IssuePatch,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    refuseFacetLabels(patch.addLabels ?? [], "to add");
    refuseRetiredLabels(patch.addLabels ?? []);
    const labels = await facetLabels(key, patch, signal);
    const out: IssuePatch = { ...patch };
    forwardRestores(out, codecs);
    for (const f of LABEL_FACETS) {
      if (patch[f] === undefined) continue;
      if (codecs.has(f)) delete out[f];
      else if (patch[f] !== null)
        out[f] = checkFacetValue(facets[f], patch[f] as string);
    }
    if (codecs.has("priority")) delete out.priority;
    if (labels.add.length > 0)
      out.addLabels = [...(out.addLabels ?? []), ...labels.add];
    if (labels.remove.length > 0)
      out.removeLabels = [...(patch.removeLabels ?? []), ...labels.remove];
    // A facet already at its value is no change, and no error either; an
    // empty patch still reaches the adapter, which refuses it.
    if (!changes(out) && changes(patch)) return;
    signal?.throwIfAborted();
    await rest.updateIssue(key, out, signal);
  }

  /** A census or a facet filter read from partial labels would miscount, so it refuses. */
  function refuseTruncatedLabels(issues: ReadonlyArray<CorePoolIssue>): void {
    const cut = issues.find((i) => i.truncated?.includes("labels"));
    if (cut !== undefined)
      throw new TrackerRequestError(
        "invalid",
        `issue ${cut.identifier} has more labels than one read takes, so its facets cannot be read exactly`,
      );
  }

  function poolFilter(query: PoolQuery): (issue: PoolIssue) => boolean {
    const oneOf = Object.entries(query.facets?.oneOf ?? {}).map(
      ([f, list]) =>
        [
          f as "type" | "size",
          (list ?? []).map((v) => checkFacetValue(facets[f as Facet], v)),
        ] as const,
    );
    const missing = query.facets?.missing ?? [];
    for (const f of missing) requireStore(f);
    return (issue) =>
      oneOf.every(
        ([f, list]) => issue[f] !== null && list.includes(issue[f]),
      ) &&
      (missing.length === 0 || missing.some((f) => lacks(issue, f, false)));
  }

  function requireStore(f: Facet): ResolvedFacet {
    if (!(FACETS as readonly string[]).includes(f))
      throw new TrackerRequestError(
        "invalid",
        `'${f}' is not a facet (${FACETS.join(", ")})`,
      );
    const slot = facets[f];
    if (!usable(slot))
      throw new TrackerRequestError(
        "invalid",
        slot.problem ?? `this repository has no ${f} facet`,
      );
    return slot;
  }

  /** Whether an issue lacks `f`; an epic needs no size where `epicExempt`. */
  function lacks(issue: PoolIssue, f: Facet, epicExempt: boolean): boolean {
    if (f === "size" && epicExempt && issue.isEpic) return false;
    return f === "priority" ? issue.priority === 0 : issue[f] === null;
  }

  const census = censusReader(openPopulation);

  async function incompleteIssues(
    query: IncompleteQuery,
    options?: FacetReadOptions,
  ): Promise<IncompletePage> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
      throw new TrackerRequestError(
        "invalid",
        `an incomplete-issues page holds 1 to 100 issues, not ${JSON.stringify(query.limit)}`,
      );
    for (const f of query.missing) requireStore(f);
    const signal = readSignal(options);
    refuseStopped(signal);
    const population = await census(options?.census, signal);
    refuseStopped(signal);
    refuseTruncatedLabels(population);
    const open = population.map(withValues);
    const outside = open.filter((i) => i.state.type !== "triage");
    const counts: IncompletePage["counts"] = {};
    for (const f of query.missing) {
      const required = outside.filter((i) => !(f === "size" && i.isEpic));
      counts[f] = {
        required: required.length,
        lacking: required.filter((i) => lacks(i, f, false)).length,
      };
    }
    const retired = query.retired.map(fold);
    const listed: Array<IncompleteIssue & { createdAt: string }> = [];
    const wanted = (type: string) =>
      query.started === true
        ? type === "started"
        : type === "backlog" || type === "unstarted";
    for (const i of outside) {
      if (!wanted(i.state.type)) continue;
      const missing = query.missing.filter((f) => lacks(i, f, true));
      const carried = [...i.labels, ...(i.hiddenLabels ?? [])].filter((l) =>
        retired.includes(fold(l)),
      );
      if (missing.length === 0 && carried.length === 0) continue;
      listed.push({
        identifier: i.identifier,
        url: i.url,
        state: { name: i.state.name, type: i.state.type },
        missing,
        retired: carried,
        createdAt: i.createdAt,
      });
    }
    const cursorOf = (i: { createdAt: string; identifier: string }) =>
      `${i.createdAt}|${i.identifier}`;
    listed.sort((a, b) => cursorOf(a).localeCompare(cursorOf(b)));
    const after = query.after ?? null;
    const from =
      after === null ? listed : listed.filter((i) => cursorOf(i) > after);
    const page = from.slice(0, query.limit);
    const last = page.at(-1);
    return {
      issues: page.map(({ createdAt: _, ...i }) => i),
      next:
        from.length > page.length && last !== undefined ? cursorOf(last) : null,
      counts,
    };
  }

  return {
    ...rest,
    configKey:
      core.configKey === undefined
        ? JSON.stringify(facets)
        : JSON.stringify([core.configKey, facets]),
    async getIssue(key) {
      const issue = await rest.getIssue(key);
      return issue === null ? null : withValues(issue);
    },
    async openIssues(query) {
      const keep = poolFilter(query);
      const { facets: _, ...labels } = query;
      const pool = await rest.openIssues(labels);
      if (query.facets !== undefined) refuseTruncatedLabels(pool);
      return pool.map(withValues).filter(keep);
    },
    async openChildren(key) {
      return (await rest.openChildren(key)).map(withValues);
    },
    async poolIssue(key, signal) {
      const issue = await rest.poolIssue(key, signal);
      return issue === null ? null : withValues(issue);
    },
    async assignedIssues(identity, states, options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      return (await rest.assignedIssues(identity, states, signal)).map(
        withValues,
      );
    },
    ...(unassignedIssues === undefined
      ? {}
      : {
          async unassignedIssues(states, options) {
            const signal = readSignal(options);
            refuseStopped(signal);
            return (await unassignedIssues(states, signal)).map(withValues);
          },
        }),
    ...batchedReads(core, withValues),
    async ledger(query, onPage) {
      const issues = await rest.ledger(query, onPage);
      const codec = codecs.get("priority");
      if (codec === undefined) return issues;
      return issues.map((i) =>
        i.truncated.includes("labels")
          ? i
          : { ...i, priority: priorityFromLabels(codec, i.labels) },
      );
    },
    createIssue,
    ...(filedAs === undefined ? {} : { filedAs }),
    updateIssue,
    incompleteIssues,
    async openPopulation(options) {
      const signal = readSignal(options);
      refuseStopped(signal);
      const population = await openPopulation(signal);
      refuseStopped(signal);
      refuseTruncatedLabels(population);
      return population.map(withValues);
    },
    async facetStores(options) {
      refuseStopped(readSignal(options));
      const extra: CoreFacetReport =
        facetReport === undefined
          ? {
              facets: {},
              discovery: {
                status: "none",
                reason: `the ${core.adapter} adapter discovers no organization's fields`,
              },
            }
          : await facetReport(options);
      return {
        facets: FACETS.map((f) => ({
          ...baseReport(facets[f]),
          ...extra.facets[f],
        })),
        discovery: extra.discovery,
      };
    },
  };
}

/** The batched reads of a core that has them, each issue given its facet values. */
function batchedReads(
  core: CoreTracker,
  withValues: <T extends CorePoolIssue>(
    issue: T,
  ) => T & FacetValues & { isEpic: boolean },
): Pick<Tracker, "poolIssues" | "queueIssues" | "queueIssuesByKey"> {
  const { poolIssues, queueIssues, queueIssuesByKey } = core;
  const queued = (q: CoreQueueIssue) => ({
    ...withValues(q),
    parent:
      q.parent === null
        ? null
        : { ...q.parent, issue: withValues(q.parent.issue) },
  });
  return {
    ...(poolIssues === undefined
      ? {}
      : {
          async poolIssues(keys, signal) {
            const read = await poolIssues(keys, signal);
            return new Map(
              [...read].map(([k, v]) => [k, v === null ? null : withValues(v)]),
            );
          },
        }),
    ...(queueIssues === undefined
      ? {}
      : {
          async queueIssues(identity, states, options) {
            const signal = readSignal(options);
            refuseStopped(signal);
            return (await queueIssues(identity, states, signal)).map(queued);
          },
        }),
    ...(queueIssuesByKey === undefined
      ? {}
      : {
          async queueIssuesByKey(keys, options) {
            const signal = readSignal(options);
            refuseStopped(signal);
            const read = await queueIssuesByKey(keys, signal);
            return new Map([...read].map(([k, q]) => [k, queued(q)]));
          },
        }),
  };
}

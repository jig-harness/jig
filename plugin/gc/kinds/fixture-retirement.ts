/** Registrations whose every root is gone, retired in bounded batches that name what they retired. */
import { basename, join } from "node:path";
import { fixtureCapacityFailure } from "../../shared/fixture-health.ts";
import { processTable } from "../../shared/process-table.ts";
import {
  cachedFixtureEnclosure,
  withoutRetired,
  type FixtureEnclosureIndex,
  fixtureRetirementProof,
  fixtureRootGone,
  retireFixtureRegistrations,
  type FixtureRegistryPage,
  type FixtureScope,
} from "../../shared/test-fixture-registry.ts";
import type { KindFailure, Proof, Receipt, Resource } from "../types.ts";
import { recordFixtureFailure } from "./fixture-scratch.ts";

/**
 * Registrations per receipt line. Each line's proof runs again under the
 * exclusive lock, which refuses every new test registration meanwhile: on a
 * warm cache that is a process-table read and about 0.3 ms a registration.
 */
const BATCH = 500;
/** Kept registrations a line names; the rest are counted, so a line stays small. */
const KEPT_NAMED = 20;
const BATCH_PREFIX = "fixture-registrations:";
const MALFORMED_PREFIX = "fixture-registration:";

/**
 * What a scheduled run owes the fixture registry, which only the scratch kind
 * reads: over its limit, it fails that kind alone and every other kind keeps
 * what it collected. A collecting run that retired registrations in its page
 * owes nothing yet, and a report-only run retires none.
 */
export function verifyFixtureRegistry(collecting: boolean) {
  return (receipt: Receipt): KindFailure | null => {
    const planned = receipt.kinds.some((kind) => kind.name === "scratch");
    if (collecting && planned && retiredAny(receipt)) return null;
    const failure = fixtureCapacityFailure(
      !collecting
        ? "The scheduled run is report-only."
        : planned
          ? "The scheduled run did not retire any fixture registrations in its page."
          : "The scheduled run has no scratch collection plan.",
    );
    return failure === null ? null : { kind: "scratch", failure };
  };
}

function retiredAny(receipt: Receipt): boolean {
  return receipt.resources.some(
    (line) =>
      line.kind === "scratch" &&
      line.resource.startsWith(BATCH_PREFIX) &&
      retiredCount(line.details) > 0,
  );
}

/** Registrations a batch line records as retired, whether or not the whole batch succeeded. */
function retiredCount(details: unknown): number {
  const retired = (details as { retired?: unknown } | null | undefined)
    ?.retired;
  return Array.isArray(retired) ? retired.length : 0;
}

type Kept = { registration: string; state: Proof["state"]; reason: string };
type Collected = {
  outcome: "collected" | "failed";
  reason: string;
  details: unknown;
};

/** A page's scopes whose registration keeps a root, which the scratch proof handles; the rest are retirement candidates. */
function split(page: FixtureRegistryPage): {
  present: FixtureScope[];
  gone: string[];
} {
  const present: FixtureScope[] = [];
  const gone: string[] = [];
  for (const { registry, scopes } of page.registrations)
    if (scopes.every((scope) => fixtureRootGone(scope.root)))
      gone.push(registry);
    else present.push(...scopes);
  return { present, gone };
}

function keptDetails(kept: Kept[]): { kept: Kept[]; keptCount: number } {
  return { kept: kept.slice(0, KEPT_NAMED), keptCount: kept.length };
}
function keptSummary(kept: Kept[]): Proof {
  const first = kept[0];
  return {
    state: kept.some((entry) => entry.state !== "live") ? "unverified" : "live",
    reason: first
      ? `no registration in this batch can be retired; first: ${first.reason}`
      : "the batch holds no registration",
    details: keptDetails(kept),
  };
}

export function fixtureRetirement(store: string, batchSize = BATCH) {
  const batches = new Map<string, string[]>();
  const malformed = new Map<string, string>();
  const proved = new Map<string, string[]>();
  let cached: ReturnType<typeof cachedFixtureEnclosure> | undefined;
  return {
    /** List a page: its root-keeping scopes for the scratch proof, and a resource per batch and per malformed folder. */
    list(page: FixtureRegistryPage): {
      present: FixtureScope[];
      resources: Resource[];
    } {
      batches.clear();
      malformed.clear();
      proved.clear();
      cached = undefined;
      const { present, gone } = split(page);
      const resources: Resource[] = [];
      for (let start = 0; start < gone.length; start += batchSize) {
        const registries = gone.slice(start, start + batchSize);
        const id = `${BATCH_PREFIX}${basename(registries[0] ?? "")}..${basename(registries.at(-1) ?? "")}`;
        batches.set(id, registries);
        resources.push({
          id,
          details: {
            action: "retire registrations whose roots are gone",
            store,
            registrations: registries.length,
          },
        });
      }
      for (const { registry, reason } of page.malformed) {
        const id = `${MALFORMED_PREFIX}${registry}`;
        malformed.set(id, reason);
        resources.push({ id });
      }
      return { present, resources };
    },
    owns: (id: string) => batches.has(id) || malformed.has(id),
    /** Run again under the exclusive lock before `collect`, which retires only what this proof found. */
    async prove(resource: Resource): Promise<Proof> {
      const reason = malformed.get(resource.id);
      if (reason !== undefined)
        return {
          state: "unverified",
          reason: `malformed registration: ${reason}`,
        };
      const rows = await processTable();
      const retirable: string[] = [];
      const kept: Kept[] = [];
      /** Read at most once a proof, only when needed. Later batches reuse it while the store's witness is unchanged, else it is read again under this admission. */
      let enclosure: FixtureEnclosureIndex | undefined;
      const enclosureFor = (): FixtureEnclosureIndex => {
        if (!enclosure) {
          cached = cachedFixtureEnclosure(store, cached);
          enclosure = cached.index;
        }
        return enclosure;
      };
      for (const registry of batches.get(resource.id) ?? []) {
        const proof = fixtureRetirementProof(registry, rows, enclosureFor);
        if (proof.state === "dead") retirable.push(registry);
        else
          kept.push({
            registration: basename(registry),
            state: proof.state,
            reason: proof.reason,
          });
      }
      proved.set(resource.id, retirable);
      if (retirable.length === 0) return keptSummary(kept);
      return {
        state: "dead",
        reason: `${retirable.length} registration(s) whose roots are gone have no running registered process`,
        ...(kept.length > 0 ? { details: keptDetails(kept) } : {}),
      };
    },
    collect(resource: Resource): Collected {
      const retired: string[] = [];
      const failures: { registration: string; reason: string }[] = [];
      const retirable = proved.get(resource.id) ?? [];
      proved.delete(resource.id);
      const removal = retireFixtureRegistrations(store, retirable);
      if (!removal.ok)
        return {
          outcome: "failed",
          reason: recordFixtureFailure(removal.failure),
          details: { store, retired },
        };
      for (const { registry, result } of removal.value) {
        if (result.ok) {
          retired.push(basename(registry));
        } else
          failures.push({
            registration: basename(registry),
            reason: recordFixtureFailure(result.failure),
          });
      }
      if (cached && retired.length > 0)
        cached = withoutRetired(
          cached,
          retired.map((name) => join(store, name)),
        );
      return {
        outcome: failures.length > 0 ? "failed" : "collected",
        reason:
          `retired ${retired.length} registration(s) whose roots are gone` +
          (failures.length > 0
            ? `; ${failures.length} could not be retired`
            : ""),
        details: {
          store,
          retired,
          ...(failures.length > 0 ? { failed: failures } : {}),
        },
      };
    },
    describe(resource: Resource): string {
      const registries = batches.get(resource.id);
      return registries
        ? `${registries.length} fixture registration(s) whose roots are gone, in ${store}`
        : `malformed fixture registration ${resource.id.slice(MALFORMED_PREFIX.length)}`;
    },
  };
}

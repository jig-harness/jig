/** Registrations whose every root is gone, retired in bounded batches that name what they retired. */
import { statSync } from "node:fs";
import { basename } from "node:path";
import { processTable } from "../../shared/process-table.ts";
import {
  fixtureEnclosureIndex,
  type FixtureEnclosureIndex,
  fixtureRetirementProof,
  fixtureRootGone,
  retireFixtureRegistration,
  type FixtureRegistryPage,
  type FixtureScope,
} from "../../shared/test-fixture-registry.ts";
import type { Proof, Resource } from "../types.ts";
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

/** The store's change stamp: a registration created or removed moves it. */
function storeStamp(store: string): bigint | null {
  try {
    return statSync(store, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

export function fixtureRetirement(store: string, batchSize = BATCH) {
  const batches = new Map<string, string[]>();
  const malformed = new Map<string, string>();
  const proved = new Map<string, string[]>();
  /**
   * One enclosure read shared by every batch of a page, so a large store is
   * scanned once rather than once per batch. A registration created or removed
   * by anyone else moves the store's stamp and forces a fresh read; retirements
   * made here are taken out of the index in place.
   */
  let cached: { index: FixtureEnclosureIndex; stamp: bigint } | undefined;
  const enclosureFor = (): FixtureEnclosureIndex => {
    const stamp = storeStamp(store);
    if (cached && stamp !== null && cached.stamp === stamp) return cached.index;
    const index = fixtureEnclosureIndex(store);
    cached = stamp === null ? undefined : { index, stamp };
    return index;
  };
  const forget = (retired: string[]): void => {
    if (!cached) return;
    for (const holders of cached.index.roots.values())
      for (const registry of retired) holders.delete(registry);
    const stamp = storeStamp(store);
    cached = stamp === null ? undefined : { ...cached, stamp };
  };
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
      const retiredPaths: string[] = [];
      const failures: { registration: string; reason: string }[] = [];
      for (const registry of proved.get(resource.id) ?? []) {
        const result = retireFixtureRegistration(registry);
        if (result.ok) {
          retired.push(basename(registry));
          retiredPaths.push(registry);
        } else
          failures.push({
            registration: basename(registry),
            reason: recordFixtureFailure(result.failure),
          });
      }
      proved.delete(resource.id);
      forget(retiredPaths);
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

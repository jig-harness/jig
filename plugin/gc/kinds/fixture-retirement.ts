/** Registrations whose every root is gone, retired in bounded batches that name what they retired. */
import { basename } from "node:path";
import { processTable } from "../../shared/process-table.ts";
import {
  fixtureRetirementProof,
  fixtureRootGone,
  retireFixtureRegistration,
  type FixtureRegistryPage,
  type FixtureScope,
} from "../../shared/test-fixture-registry.ts";
import type { Proof, Resource } from "../types.ts";
import { recordFixtureFailure } from "./fixture-scratch.ts";

/** Enough registrations per receipt line to keep up with a busy host, few enough to hold the exclusive lock briefly. */
const BATCH = 1000;
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

function keptSummary(kept: Kept[]): Proof {
  const first = kept[0];
  return {
    state: kept.some((entry) => entry.state !== "live") ? "unverified" : "live",
    reason: first
      ? `no registration in this batch can be retired; first: ${first.reason}`
      : "the batch holds no registration",
    details: { kept },
  };
}

export function fixtureRetirement(store: string, batchSize = BATCH) {
  const batches = new Map<string, string[]>();
  const malformed = new Map<string, string>();
  const proved = new Map<string, string[]>();
  return {
    /** List a page: its root-keeping scopes for the scratch proof, and a resource per batch and per malformed folder. */
    list(page: FixtureRegistryPage): {
      present: FixtureScope[];
      resources: Resource[];
    } {
      batches.clear();
      malformed.clear();
      proved.clear();
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
        const proof = fixtureRetirementProof(registry, rows);
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
        ...(kept.length > 0 ? { details: { kept } } : {}),
      };
    },
    collect(resource: Resource): Collected {
      const retired: string[] = [];
      const failures: { registration: string; reason: string }[] = [];
      for (const registry of proved.get(resource.id) ?? []) {
        const result = retireFixtureRegistration(registry);
        if (result.ok) retired.push(basename(registry));
        else
          failures.push({
            registration: basename(registry),
            reason: recordFixtureFailure(result.failure),
          });
      }
      proved.delete(resource.id);
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

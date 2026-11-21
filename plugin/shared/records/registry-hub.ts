/**
 * The records registry's kinds in the hub (`registry.ts`): the tables of
 * the hub's storage, one kind each, declared in `plugin/hub/storage/schema.ts`
 * and kept in every partition the hub holds (each repository's, each
 * host's and the directory). The hub is optional; a host that enrolls in
 * none keeps none of these.
 */
import type { RecordKind } from "./registry-kind.ts";

const SCHEMA = "hub/storage/schema.ts";
const AT = "the hub's storage, every partition";
/** The hub's schema version: the number of its migrations (`hub/storage/migrations/meta/_journal.json`). */
export const HUB_SCHEMA = 1;

/** A table of the hub's storage. */
function hubTable(name: string, table: string, meaning: string): RecordKind {
  return {
    name,
    medium: "hub",
    owner: SCHEMA,
    at: AT,
    table,
    version: HUB_SCHEMA,
    meaning,
  };
}

export const HUB: RecordKind[] = [
  hubTable(
    "hub-in-flight-read",
    "in_flight_reads",
    "The one unit reading a target through to the forge or the tracker, and until when. A unit that finds it held waits for that read's result in storage instead of reading again; once its deadline passes another unit may take it over.",
  ),
  hubTable(
    "hub-job-lease",
    "job_leases",
    "A scheduled job's lease: the run that holds it and until when, the progress that run stored, and when a run last started and finished. A run that finds the lease held does not run, and the next run after a lease lapsed resumes from the stored progress.",
  ),
];

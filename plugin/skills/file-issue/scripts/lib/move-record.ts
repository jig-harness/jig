import { MoveRecordError } from "./move-error.ts";
/**
 * The move record (design/tracker-facets.md, "Moving a repository from one
 * store to another"): the file `check-fields.ts move --record <file>` names.
 * The preview writes the source section in force when the move starts and
 * the target section beside it; copy, retire and restore read both from it,
 * so the source stays named after the switch commits the target. Every
 * change a run makes is added before its write (`done: false`) and marked
 * once the write lands, with each store's value before and after and the
 * labels it added and took off, so `--restore` can put every before-state
 * back. The copy snapshot is the value the copy wrote to each issue's
 * destination.
 *
 * Written whole to a file beside it and renamed into place, so a run that
 * stops leaves the record as its last completed write left it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { validateRecordContents } from "./move-record-validation.ts";
import { isRecord } from "../../../../shared/guards.ts";
import type { FacetEntries } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import {
  FACETS,
  type Facet,
  type FacetStoreKind,
} from "../../../do-item/scripts/lib/tracker/port.ts";

export const MOVE_RECORD_KIND = "facet-move";
export const MOVE_RECORD_VERSION = 1;

/** A facet's value as the record keeps it: a type or size, a priority's name, or `null` for none. */
export type FacetValue = string | null;

/** One store's change on one issue. */
export interface StoreChange {
  facet: Facet;
  /** The store the move leaves (`source`) or the one it fills (`destination`). */
  side: "source" | "destination";
  store: FacetStoreKind;
  field?: string;
  before: FacetValue;
  after: FacetValue;
  labelsAdded?: string[];
  labelsRemoved?: string[];
}

/** The changes one write makes to one issue. */
export interface MoveChange {
  issue: string;
  phase: "copy" | "retire" | "restore";
  at: string;
  /** Set once the write landed; a change left unset may or may not have. */
  done: boolean;
  stores: StoreChange[];
}

export interface MoveRecord {
  kind: typeof MOVE_RECORD_KIND;
  version: typeof MOVE_RECORD_VERSION;
  /** Where the issues live (`owner/name` on GitHub, the team key elsewhere). */
  team: string;
  adapter: string;
  /** The `issue_tracker.facets` section in force when the move started. */
  source: FacetEntries;
  /** The section the repository will commit. */
  target: FacetEntries;
  /** The facets whose store the move changes. */
  moved: Facet[];
  previewedAt: string;
  /** Per issue, the value the copy wrote to each moved facet's destination. */
  snapshots: Record<string, Partial<Record<Facet, FacetValue>>>;
  changes: MoveChange[];
}

/** A record that cannot be read. */
export { MoveRecordError } from "./move-error.ts";

function check(ok: boolean, path: string, what: string): void {
  if (!ok) throw new MoveRecordError(`${path} is not a move record: ${what}`);
}

/** The record at `path`; throws `MoveRecordError` when it is missing or malformed. */
export function readMoveRecord(path: string): MoveRecord {
  if (!existsSync(path))
    throw new MoveRecordError(
      `no move record at ${path}: run the preview (move --target <file> --record ${path}) first`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const why =
      err instanceof SyntaxError ? "is not JSON" : "could not be read";
    throw new MoveRecordError(`${path} ${why}`, { cause: err });
  }
  check(isRecord(raw), path, "not an object");
  const r = raw as Record<string, unknown>;
  check(
    r.kind === MOVE_RECORD_KIND,
    path,
    `its kind is not ${MOVE_RECORD_KIND}`,
  );
  check(
    r.version === MOVE_RECORD_VERSION,
    path,
    `version ${JSON.stringify(r.version)}, and this release reads ${MOVE_RECORD_VERSION}`,
  );
  check(typeof r.team === "string", path, "no team");
  check(typeof r.adapter === "string", path, "no adapter");
  check(isRecord(r.source) && isRecord(r.target), path, "no source or target");
  check(
    Array.isArray(r.moved) &&
      r.moved.every((f) => (FACETS as readonly unknown[]).includes(f)),
    path,
    "its moved facets are not facets",
  );
  check(isRecord(r.snapshots), path, "no snapshots");
  check(Array.isArray(r.changes), path, "no changes");
  validateRecordContents(r, path);
  return raw as MoveRecord;
}

/** Write `record` to `path` whole: to a file beside it, then renamed into place. */
export function writeMoveRecord(path: string, record: MoveRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.${process.pid}.next`;
  writeFileSync(next, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(next, path);
}

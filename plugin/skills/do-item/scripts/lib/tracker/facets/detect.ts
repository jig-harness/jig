/**
 * The GitHub default's rules and their cache: which store a facet whose
 * store the configuration does not name is kept in, from what detection read
 * of the tracker (design/tracker-facets.md, "Defaults per adapter").
 *
 * - A key of today that names the facet's labels, or labels of the facet on
 *   any issue, open or closed, are evidence for the label store; a value in
 *   the tracker's own field (an issue type, an issue field's value) is
 *   evidence for that store, whatever wrote it.
 * - Both together are a conflict, never resolved by guessing: the facet's
 *   reads and writes fail closed until the configuration names a store.
 * - One alone selects its store.
 * - Neither selects the tracker's own field where it qualifies (issue types
 *   named like the types, a Priority field whose options name the
 *   priorities, an Effort field whose options are the sizes), else labels;
 *   a Priority field whose options were renamed is an error naming the ways
 *   out, never a quiet fall back to labels.
 *
 * Detection reads only the tracker, so every clone reaches the same answer.
 * A read that fails is an error carried to the caller, never read as "the
 * organization has no field", and is never cached; an answer is cached for
 * one hour on this machine, keyed by the repository, its organization, the
 * facets asked about and a salted hash of the credential that read it.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { swallow } from "../../../../../../shared/errors.ts";
import { renameWithRetry } from "../../../../../../shared/rename-with-retry.ts";
import type { Facet, FacetDetection, FacetStoreKind } from "../port.ts";
import { fold, PRIORITY_NAMES } from "./values.ts";
import { currentMs } from "../../../../../../shared/time.ts";

/** What detection read for one facet. */
export interface Evidence {
  labelEvidence: boolean;
  nativeEvidence: boolean;
  /** The store the facet could move to; `null` for none. */
  candidate: { store: FacetStoreKind; field?: string } | null;
  /** Why the tracker's own field does not qualify, when it does not. */
  candidateProblem?: string;
}

/** The store the rules select from `evidence`, or a conflict. */
export function wouldSelect(evidence: Evidence): FacetStoreKind | "conflict" {
  const native = evidence.candidate?.store ?? "native";
  if (evidence.labelEvidence && evidence.nativeEvidence) return "conflict";
  if (evidence.labelEvidence) return "label";
  if (evidence.nativeEvidence) return native;
  return evidence.candidate === null ? "label" : evidence.candidate.store;
}

/** A detection result as `facetStores()` reports it. */
export function detection(evidence: Evidence): FacetDetection {
  return {
    status: "read",
    labelEvidence: evidence.labelEvidence,
    nativeEvidence: evidence.nativeEvidence,
    candidate: evidence.candidate,
    ...(evidence.candidateProblem === undefined
      ? {}
      : { candidateProblem: evidence.candidateProblem }),
    wouldSelect: wouldSelect(evidence),
  };
}

/** What detection found for the facets asked, and whether the cache answered. */
export interface Detected {
  found: Partial<Record<Facet, FacetDetection>>;
  cached: boolean;
}

/** The issue types and issue fields an organization offers a repository. */
export interface Offered {
  types: ReadonlyArray<string>;
  fields: ReadonlyArray<{
    name: string;
    dataType: string;
    options: ReadonlyArray<string>;
  }>;
}

/**
 * The tracker's own store `facet` could move to among what is `offered`, and
 * why it does not qualify when it does not. `values` are the facet's
 * canonical values (the taxonomy's types or sizes).
 */
export function candidateFor(
  facet: Facet,
  values: ReadonlyArray<string>,
  offered: Offered,
): { candidate: Evidence["candidate"]; problem?: string } {
  const same = (a: string, b: string) => fold(a) === fold(b);
  if (facet === "type") {
    if (offered.types.length === 0) return { candidate: null };
    const missing = values.filter(
      (v) => !offered.types.some((t) => same(t, v)),
    );
    return {
      candidate: { store: "native" },
      ...(missing.length === 0
        ? {}
        : {
            problem: `no issue type is named ${missing.join(", ")}; such a type is refused when filed unless issue_tracker.facets.type.values names its issue type`,
          }),
    };
  }
  const name = facet === "priority" ? "Priority" : "Effort";
  const field = offered.fields.find(
    (d) => same(d.name, name) && d.dataType === "SINGLE_SELECT",
  );
  if (field === undefined) return { candidate: null };
  const wanted = facet === "priority" ? [...PRIORITY_NAMES] : [...values];
  const matches =
    wanted.length === field.options.length &&
    wanted.every((v) => field.options.some((o) => same(o, v)));
  if (matches)
    return {
      candidate:
        facet === "priority"
          ? { store: "native", field: field.name }
          : { store: "field", field: field.name },
    };
  return {
    candidate: null,
    problem: `the ${field.name} field's options (${field.options.join(", ")}) are not the ${facet === "priority" ? "priorities" : "sizes"} (${wanted.join(", ")}); name them in issue_tracker.facets.${facet}.values, or keep ${facet} in labels (store: label)`,
  };
}

/** What the default selects for one facet. */
export type Selection =
  | {
      kind: "store";
      store: FacetStoreKind;
      why: "kept in labels" | "detected" | "default";
      field?: string;
    }
  | { kind: "conflict"; problem: string }
  | { kind: "refused"; problem: string };

const STORE_NAMES: Record<FacetStoreKind, string> = {
  label: "labels",
  native: "the tracker's own field",
  field: "an issue field",
};

/**
 * What the GitHub default selects for `facet` from what detection `found`:
 * a store and why, a conflict, or a refusal (a Priority field whose options
 * no longer name the priorities, with no labels to keep priority in).
 */
export function select(facet: Facet, found: FacetDetection): Selection {
  if (found.status !== "read") return { kind: "refused", problem: found.error };
  if (found.wouldSelect === "conflict")
    return { kind: "conflict", problem: conflict(facet, found.candidate) };
  if (found.wouldSelect !== "label") return native(facet, found);
  if (
    facet === "priority" &&
    !found.labelEvidence &&
    found.candidateProblem !== undefined
  )
    return { kind: "refused", problem: found.candidateProblem };
  return {
    kind: "store",
    store: "label",
    why: found.labelEvidence ? "kept in labels" : "default",
  };
}

/** Why a facet with labels and native values both is in conflict, and the lines that settle it. */
function conflict(facet: Facet, candidate: Evidence["candidate"]): string {
  const native = candidate ?? { store: "native" as const };
  const where =
    native.field === undefined
      ? STORE_NAMES[native.store]
      : `the ${native.field} field`;
  const line =
    native.store === "field"
      ? `{ store: field, field: ${native.field} }`
      : `{ store: ${native.store} }`;
  return `${facet} is in conflict: issues carry ${facet} labels and values in ${where} too, and issue_tracker.facets.${facet} names no store; name one: issue_tracker.facets.${facet}: { store: label }, or ${line}`;
}

/** The tracker's own store, where detection found the facet's values in it. */
function native(
  facet: Facet,
  found: Extract<FacetDetection, { status: "read" }>,
): Selection {
  if (found.candidate === null)
    return {
      kind: "refused",
      problem:
        found.candidateProblem ??
        `${facet} has values in the tracker's own field, which this repository cannot read as ${facet}s; name its store in issue_tracker.facets.${facet}`,
    };
  const { store, field } = found.candidate;
  return {
    kind: "store",
    store,
    why: "detected",
    ...(field === undefined ? {} : { field }),
  };
}

// ── The cache ──────────────────────────────────────────────────────────────

/** How long a detection answer is reused. */
export const DETECTION_TTL_MS = 3_600_000;

const ENTRY_VERSION = 1;

/** Detection answers kept on this machine, by key. */
export interface DetectionCache {
  get(key: string): Partial<Record<Facet, FacetDetection>> | null;
  set(key: string, found: Partial<Record<Facet, FacetDetection>>): void;
  drop(key: string): void;
  /** A salted, non-secret fingerprint of `token`; `null` when the cache is off. */
  fingerprint(token: string): string | null;
}

/**
 * The cache's folder: `$JIG_FACET_CACHE_DIR`, else under this machine's
 * state folder; `null` (off) for `JIG_FACET_CACHE=off`, and under a test
 * run unless a folder is named, so a suite never reads a neighbour's answer.
 */
export function detectionCacheDir(env = process.env): string | null {
  if ((env.JIG_FACET_CACHE ?? "") === "off") return null;
  const explicit = env.JIG_FACET_CACHE_DIR ?? "";
  if (explicit !== "") return explicit;
  if (env.NODE_ENV === "test") return null;
  const home = env.HOME || homedir();
  return home ? join(home, ".local", "state", "jig", "facet-detection") : null;
}

/** The key of one repository's answer: its parts hashed, never stored as written. */
export function detectionKey(parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** The machine's salt; empty when there is none yet or it cannot be read. */
function readSalt(file: string): string {
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch (err) {
    swallow(
      err,
      "an unreadable salt is replaced, which only empties the cache",
    );
    return "";
  }
}

/** A file's JSON; `null` when it is missing or unreadable, which is a miss. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    swallow(err, "a detection cache entry that cannot be read is a miss");
    return null;
  }
}

function writeOwnerOnly(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameWithRetry(tmp, file);
}

/**
 * The detection cache in `dir` (off when `null`): one file per key, each
 * holding when it was read and what was found. An unreadable, stale or
 * foreign entry is a miss; a cache that cannot be written costs a read, no
 * more.
 */
export function fileDetectionCache(
  dir: string | null,
  now: () => number = currentMs,
): DetectionCache {
  const fileOf = (key: string) =>
    dir === null ? null : join(dir, `${key.slice(0, 40)}.json`);
  return {
    get(key) {
      const file = fileOf(key);
      if (file === null) return null;
      const entry = readJson(file);
      if (entry === null || typeof entry !== "object") return null;
      const {
        version,
        key: stored,
        at,
        found,
      } = entry as Record<string, unknown>;
      if (
        version !== ENTRY_VERSION ||
        stored !== key ||
        typeof at !== "number" ||
        now() - at > DETECTION_TTL_MS ||
        now() < at ||
        found === null ||
        typeof found !== "object"
      )
        return null;
      return found as Partial<Record<Facet, FacetDetection>>;
    },
    set(key, found) {
      const file = fileOf(key);
      if (file === null || dir === null) return;
      // Only an answer is kept: a failed read is asked again next time.
      if (Object.values(found).some((d) => d?.status !== "read")) return;
      try {
        writeOwnerOnly(
          dir,
          file,
          JSON.stringify({ version: ENTRY_VERSION, key, at: now(), found }),
        );
      } catch (err) {
        swallow(err, "an unwritable cache costs a detection read, no more");
      }
    },
    drop(key) {
      const file = fileOf(key);
      if (file !== null) rmSync(file, { force: true });
    },
    fingerprint(token) {
      if (dir === null) return null;
      const saltFile = join(dir, "salt");
      let salt = readSalt(saltFile);
      if (!/^[0-9a-f]{64}$/.test(salt)) {
        salt = randomBytes(32).toString("hex");
        try {
          writeOwnerOnly(dir, saltFile, salt);
        } catch (err) {
          swallow(
            err,
            "without a salt kept on this machine, nothing is cached",
          );
          return null;
        }
      }
      return createHash("sha256").update(`${salt}\n${token}`).digest("hex");
    },
  };
}

/** Canonical inventory of every top-level entry drive-pr owns in its state dir. */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CLONE_ID_FILE } from "./clone-key.ts";
import { MIGRATED_MARKER_FILENAME } from "./legacy-state.ts";
import { LOCK_GENERATION_RE } from "./lock.ts";
import {
  type ArtifactFamily,
  anchorOf as anchorOfWithGeneration,
  COMPACTING_STAGING_RE as PATTERN_COMPACTING_STAGING_RE,
  LOCK_ANCHORS as PATTERN_LOCK_ANCHORS,
  PLAIN_ENTRIES as PATTERN_PLAIN_ENTRIES,
} from "./state-file-patterns.ts";

/** Re-exported so existing consumers of this module need no import change. */
export type { ArtifactFamily } from "./state-file-patterns.ts";

export interface Family {
  readonly id: string;
  readonly kind: "pr" | "actor";
  readonly subject: string;
  readonly names: string[];
  readonly anchors: Set<string>;
}

export type ArtifactEntry =
  | {
      readonly category: "family";
      readonly name: string;
      readonly path: string;
      readonly family: ArtifactFamily;
      readonly ownerKind: "pr" | "actor";
      readonly subject: string;
      readonly anchor: string | null;
    }
  | {
      readonly category: "driver-lock" | "reaper";
      readonly name: string;
      readonly path: string;
      readonly family: ArtifactFamily;
    }
  | {
      readonly category: "unknown-drive-pr" | "unrelated";
      readonly name: string;
      readonly path: string;
    };

export type OwnedArtifactEntry = Exclude<
  ArtifactEntry,
  { readonly category: "unknown-drive-pr" | "unrelated" }
>;

export interface ArtifactInventory {
  readonly stateDir: string;
  /** Every entry drive-pr owns and a migration must move. */
  readonly artifacts: readonly OwnedArtifactEntry[];
  /** Drive-pr-shaped entries whose producer grammar is unknown. */
  readonly unknown: readonly ArtifactEntry[];
  /**
   * Entries owned by Git or another tool, PLUS drive-pr's own directory-
   * identity metadata (`isCloneIdentityArtifact`) that must stay bound to
   * this exact directory rather than migrate with the state population —
   * never moved either way.
   */
  readonly unrelated: readonly ArtifactEntry[];
}

interface OwnedPattern {
  readonly re: RegExp;
  readonly ownerKind: "pr" | "actor";
  readonly family: ArtifactFamily;
}

/**
 * The regexes and the family tag itself come from `state-file-patterns.ts`,
 * the one module this, `legacy-state.ts` and `migrate-legacy-state.ts` read
 * (`reap-state.ts` reaches it through this module), so a lock/lease prefix
 * renamed in `lock.ts`/`lease.ts` cannot silently blind one consumer while
 * the others stay current. A second, independently maintained copy here is
 * exactly the drift `state-file-patterns.ts`'s own doc comment warns about.
 *
 * `family` lives on the pattern object itself rather than in a separate array
 * paired by position: a length check cannot catch a same-length reorder
 * upstream silently reassigning every family to the wrong pattern. So this is
 * a plain per-element rename (`key` → `ownerKind`) with nothing left to fall
 * out of sync.
 */
function toOwnedPatterns(
  patterns: readonly {
    re: RegExp;
    key: "pr" | "actor";
    family: ArtifactFamily;
  }[],
): readonly OwnedPattern[] {
  return patterns.map((pattern) => ({
    re: pattern.re,
    ownerKind: pattern.key,
    family: pattern.family,
  }));
}

const LOCK_ANCHORS: readonly OwnedPattern[] =
  toOwnedPatterns(PATTERN_LOCK_ANCHORS);

const PLAIN_ENTRIES: readonly OwnedPattern[] = toOwnedPatterns(
  PATTERN_PLAIN_ENTRIES,
);

export const REAPER_SNAPSHOT_FILENAME = ".reap-state-snapshot.json";
const SNAPSHOT_RE = /^\.reap-state-snapshot\.json(?:\.[0-9a-f]{6})?$/;
const REAPER_DELETE_ANCHOR = ".reap-state-delete";
export const COMPACTING_STAGING_RE = PATTERN_COMPACTING_STAGING_RE;

/**
 * A deliberate SUPERSET of `state-file-patterns.ts`'s `FOREIGN_LOCKS`, not
 * derived from it: this module also needs to recognise a driver lock's
 * `.staging` variant (`drive.ts`'s `stagingDirFor`) as the SAME family, which
 * `FOREIGN_LOCKS`'s exact-match grammar deliberately does not — its own
 * consumers (`legacy-state.ts`, `migrate-legacy-state.ts`) only ever ask
 * "is this drive.ts's own single-instance lock", never which lifecycle stage
 * it is in. If either grammar's base pattern for `pr-drive-…`/
 * `pr-drive-worktree-…` changes, check the other.
 */
const DRIVER_LOCKS: readonly { re: RegExp; family: ArtifactFamily }[] = [
  {
    re: /^pr-drive-[0-9]+\.lock(?:\.[1-9][0-9]*\..+\.staging)?$/,
    family: "driver-pr-lock",
  },
  {
    re: /^pr-drive-worktree-[0-9a-f]{16}\.lock(?:\.[1-9][0-9]*\..+\.staging)?$/,
    family: "driver-worktree-lock",
  },
] as const;

/** Recover the createLock anchor for every exact lock/quarantine shape. */
export function anchorOf(name: string): string | null {
  return anchorOfWithGeneration(name, LOCK_GENERATION_RE);
}

export function isSnapshotArtifact(name: string): boolean {
  return SNAPSHOT_RE.test(name);
}

export function isReaperArtifact(name: string): boolean {
  return isSnapshotArtifact(name) || anchorOf(name) === REAPER_DELETE_ANCHOR;
}

/**
 * `legacy-state.ts`'s per-clone migration marker — not this script's own
 * bookkeeping, but permanently present in every migrated default state
 * directory and equally not backlog. Kept apart from `isReaperArtifact` (rather
 * than folded into it): the marker is `legacy-state.ts`'s artifact, not the
 * reaper's, and every consumer that skips one for "not backlog" reasons skips
 * the other for the identical reason.
 */
export function isLegacyMigrationMarker(name: string): boolean {
  return name === MIGRATED_MARKER_FILENAME;
}

/**
 * `clone-key.ts`'s persisted clone-identity file — present at the top level
 * of the legacy `--git-common-dir` (and of any other directory `cloneKey()`
 * has ever been computed against) the moment ANY drive-pr script runs, since
 * `defaultStateDirFor()` mints it as a side effect regardless of whether
 * this clone's state has been migrated. It is drive-pr's own file but is
 * NOT part of the artifact population a migration moves: it must stay
 * physically bound to its `commonDir` (that binding is the entire point of
 * `persistedCloneId` — see that module's doc comment), so `migrate-state-
 * dir.ts`'s `source` = the legacy common dir (a documented flow —
 * using-drive-pr.md § Relocating the state dir) would otherwise see it, find it matches no
 * known family/lock/reaper shape, and abort the whole migration with
 * "unclassified drive-pr artifacts" over a file this tool was never meant to
 * touch.
 */
export function isCloneIdentityArtifact(name: string): boolean {
  return name === CLONE_ID_FILE;
}

function looksDrivePrOwned(name: string): boolean {
  return /^(?:\.compacting\.|\.drive-pr-|\.reap-state-|drive-arm-|drive-pr-|drive-tree-lease-|pr-drive-)/.test(
    name,
  );
}

/** Classify one name without touching disk. */
export function classifyArtifactName(
  stateDir: string,
  name: string,
): ArtifactEntry {
  const path = join(stateDir, name);
  if (isSnapshotArtifact(name)) {
    return { category: "reaper", name, path, family: "reaper-snapshot" };
  }
  if (anchorOf(name) === REAPER_DELETE_ANCHOR) {
    return { category: "reaper", name, path, family: "reaper-delete-lock" };
  }
  if (isLegacyMigrationMarker(name)) {
    return {
      category: "reaper",
      name,
      path,
      family: "legacy-migration-marker",
    };
  }
  if (isCloneIdentityArtifact(name)) {
    return { category: "unrelated", name, path };
  }
  const driverLock = DRIVER_LOCKS.find(({ re }) => re.test(name));
  if (driverLock !== undefined) {
    return {
      category: "driver-lock",
      name,
      path,
      family: driverLock.family,
    };
  }

  const anchor = anchorOf(name);
  const subjectName = anchor ?? name;
  const locked = LOCK_ANCHORS.find(({ re }) => re.test(subjectName));
  if (locked !== undefined) {
    const match = locked.re.exec(subjectName);
    if (match !== null) {
      return {
        category: "family",
        name,
        path,
        family: locked.family,
        ownerKind: locked.ownerKind,
        subject: match[1] as string,
        anchor: subjectName,
      };
    }
  }
  if (anchor === null) {
    const plain = PLAIN_ENTRIES.find(({ re }) => re.test(name));
    if (plain !== undefined) {
      const match = plain.re.exec(name);
      if (match !== null) {
        return {
          category: "family",
          name,
          path,
          family: plain.family,
          ownerKind: plain.ownerKind,
          subject: match[1] as string,
          anchor: null,
        };
      }
    }
  }
  return {
    category: looksDrivePrOwned(name) ? "unknown-drive-pr" : "unrelated",
    name,
    path,
  };
}

/** Exact, side-effect-free inventory used by reaping and migration. */
export function enumerateStateArtifacts(stateDir: string): ArtifactInventory {
  const entries = readdirSync(stateDir)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => classifyArtifactName(stateDir, name));
  return {
    stateDir,
    artifacts: entries.filter(
      (entry): entry is OwnedArtifactEntry =>
        entry.category !== "unknown-drive-pr" && entry.category !== "unrelated",
    ),
    unknown: entries.filter((entry) => entry.category === "unknown-drive-pr"),
    unrelated: entries.filter((entry) => entry.category === "unrelated"),
  };
}

/** Reaper compatibility view, derived only from the canonical inventory. */
export function classify(names: readonly string[]): {
  families: Map<string, Family>;
  foreign: string[];
  unrecognised: string[];
} {
  const families = new Map<string, Family>();
  const foreign: string[] = [];
  const unrecognised: string[] = [];
  for (const name of names) {
    const entry = classifyArtifactName("", name);
    if (entry.category === "reaper") continue;
    if (entry.category === "driver-lock") {
      foreign.push(name);
      continue;
    }
    if (entry.category !== "family") {
      unrecognised.push(name);
      continue;
    }
    const id = `${entry.ownerKind}:${entry.subject}`;
    let family = families.get(id);
    if (family === undefined) {
      family = {
        id,
        kind: entry.ownerKind,
        subject: entry.subject,
        names: [],
        anchors: new Set(),
      };
      families.set(id, family);
    }
    family.names.push(name);
    if (entry.anchor !== null) family.anchors.add(entry.anchor);
  }
  return { families, foreign, unrecognised };
}

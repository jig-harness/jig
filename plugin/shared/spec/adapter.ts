/**
 * What every spec adapter declares, and what it hands the resolver.
 *
 * A work item names where its requirements and acceptance criteria live: in
 * its own body, or by a path to an artifact in the repository. An adapter
 * reads one layout of such artifacts, read-only, into three lists with the
 * ids the artifact gives them. The resolver (`resolve.ts`) finds the
 * references, checks every path before any adapter sees it, and qualifies
 * each id by its source; an adapter never reads a path the resolver has not
 * passed it.
 */

/** A requirement as an adapter reads it: its id within the source and its text. */
export interface SpecEntry {
  id: string;
  text: string;
}

/** An acceptance criterion; `requirement` names the requirement it serves by id. */
export interface AdapterCriterion extends SpecEntry {
  requirement: string | null;
}

/** A task, and whether the artifact marks it done. */
export interface AdapterTask extends SpecEntry {
  done: boolean;
}

/** What one reference yields. Ids are unique within each list. */
export interface AdapterRead {
  requirements: SpecEntry[];
  acceptance: AdapterCriterion[];
  tasks: AdapterTask[];
}

/** The sections of an issue body the resolver recognises. */
export type BodySectionKind = "spec" | "requirements" | "acceptance";

/**
 * A reference the resolver has checked and passes to an adapter.
 *
 * `body`: one recognised section of the issue's own body, its text as the
 * issue carries it. `file`: a path in the repository, `ref` its canonical
 * form relative to the root (a folder ends in `/`) and `path` its real,
 * absolute location, already known to be inside the root, not ignored by
 * Git and matched by the adapter's own `patterns`.
 */
export type SpecReference =
  | { kind: "body"; ref: string; section: BodySectionKind; text: string }
  | { kind: "file"; ref: string; path: string };

export interface SpecAdapter {
  /** The name `specs.adapters` lists it by. */
  readonly name: string;
  /**
   * The paths its artifacts take, as globs relative to the repository root
   * (`specs/*.spec.md`; a folder ends in `/`). The resolver reads no path
   * that no enabled adapter's patterns match.
   */
  readonly patterns: readonly string[];
  /** Whether the repository holds this adapter's layout. */
  detect(root: string): Promise<boolean>;
  /** The requirements, criteria and tasks one checked reference holds. */
  read(ref: SpecReference): Promise<AdapterRead>;
}

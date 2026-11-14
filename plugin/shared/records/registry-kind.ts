/**
 * The shape of an entry of the records registry (`registry.ts`): one kind of
 * record, and a hidden-marker literal that is not one. The registry's
 * entries are kept by medium beside it (`registry-machine.ts`,
 * `registry-tree.ts`, `registry-forge.ts`).
 */
import type { Medium } from "./writer.ts";

export interface RecordKind {
  /** Its registered name: what a record's envelope says as its `kind`. */
  readonly name: string;
  readonly medium: Medium;
  /**
   * The plugin file, from `plugin/`, that writes it; for a kind written
   * outside Jig (`foreign`), the one that reads it.
   */
  readonly owner: string;
  /** Who writes a kind Jig only reads: another tool, or a person. */
  readonly foreign?: string;
  /** Where it lives: on the machine (from `~` or `<tmp>`), in the tree (its root or `<git dir>`), on the forge or tracker. */
  readonly at: string;
  /** The hidden markers it carries, each as written after `<!--`. */
  readonly markers?: readonly string[];
  /** The family the drive's state library tags its file patterns with. */
  readonly stateFamily?: string;
  /** The SQLite table it is. */
  readonly table?: string;
  /** The schema version writers write now; `0` when it carries none. */
  readonly version: number;
  /** For a kind whose records carry the envelope, its key's whole shape. */
  readonly key?: RegExp;
  /**
   * What the record is for, in plain language, to a reader that meets it:
   * what it says, and what that reader does with it. The Jig Protocol's
   * chapters print it beside the kinds they list, and their gate fails an
   * empty one.
   */
  readonly meaning: string;
}

/** A kind that is only its medium, name, owner, place, version and meaning. */
export function plain(
  medium: Medium,
  name: string,
  owner: string,
  at: string,
  version: number,
  meaning: string,
): RecordKind {
  return { name, medium, owner, at, version, meaning };
}

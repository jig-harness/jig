/**
 * What every spec adapter declares, and what it hands the resolver.
 *
 * A work item names where its requirements and acceptance criteria live: in
 * its own body, or by a path to an artifact in the repository. An adapter
 * reads one layout of such artifacts, read-only, into three lists with the
 * ids the artifact gives them. The resolver (`resolve.ts`) finds the
 * references, checks every path before any adapter sees it, and qualifies
 * each id by its source. An adapter reads an artifact only through the
 * reader the resolver hands it with the reference, which checks every file
 * before it lists or reads it, and never opens a path itself.
 */
import type { MarkdownLine } from "./markdown.ts";

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

/**
 * What one reference yields. Ids are unique across the three lists, since a
 * source qualifies each id into one key whatever its kind; the resolver
 * refuses a reference whose lists share an id.
 */
export interface AdapterRead {
  requirements: SpecEntry[];
  acceptance: AdapterCriterion[];
  tasks: AdapterTask[];
}

/** The sections of an issue body the resolver recognises. */
export type BodySectionKind = "spec" | "requirements" | "acceptance";

/**
 * The files of a checked file reference. Each file is checked on its own
 * (inside the root and inside the reference through every symbolic link,
 * not ignored by Git, a regular file) before it is listed and again before
 * it is read, so a folder's contents pass the same checks as the folder; the
 * resolver reports each one the checks leave out. Pass the adapter's own
 * signal, so its deadline stops a long listing or read.
 */
export interface CheckedFiles {
  /** The reference itself, or every file under the folder that passes the checks, relative to the root. */
  list(signal?: AbortSignal): Promise<string[]>;
  /** The text of the reference or a file under it; rejects one that fails the checks. */
  read(ref: string, signal?: AbortSignal): Promise<string>;
}

/**
 * A reference the resolver has checked and passes to an adapter.
 *
 * `body`: one recognised section of the issue's own body, its text as the
 * issue carries it, and its `lines` as the resolver classified them while
 * scanning the whole body (code or content): read code from `lines`, never
 * by scanning `text` again, since the section is cut out of its context (the
 * headings around it, a list it continues). `file`: a path in the repository, `ref` its canonical
 * form relative to the root (a folder ends in `/`), already known to be
 * inside the root, not ignored by Git and matched by the adapter's own
 * `patterns`; `files` is the only way to its contents.
 */
export type SpecReference =
  | {
      kind: "body";
      ref: string;
      section: BodySectionKind;
      text: string;
      lines: readonly MarkdownLine[];
    }
  | { kind: "file"; ref: string; files: CheckedFiles };

export interface SpecAdapter {
  /** The name `specs.adapters` lists it by. */
  readonly name: string;
  /**
   * The paths its artifacts take, as globs relative to the repository root
   * (`specs/*.spec.md`; a folder ends in `/`). The resolver reads no path
   * that no enabled adapter's patterns match.
   */
  readonly patterns: readonly string[];
  /**
   * Whether the repository holds this adapter's layout. The resolver
   * gives up on it when `signal` aborts, at its deadline.
   */
  detect(root: string, signal: AbortSignal): Promise<boolean>;
  /**
   * The requirements, criteria and tasks one checked reference holds. The
   * resolver gives up on the read when `signal` aborts, at its deadline; an
   * adapter that runs a tool stops it then.
   */
  read(ref: SpecReference, signal: AbortSignal): Promise<AdapterRead>;
}

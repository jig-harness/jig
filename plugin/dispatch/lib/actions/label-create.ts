/**
 * A dispatch label the repository does not have yet, met by a write: a
 * release that adds a label reaches a host before its repositories have
 * it, and every write that adds it is refused. The tick creates the label
 * as `jig dispatch labels` does (its name under the repository's prefix,
 * its color and description from this release) and writes again. The
 * forge classes the refusal (`missing-label` from `editLabels`), so the
 * tick never reads it from the refusal's text; a create the forge answers
 * with `exists` (another writer created the label first) counts as made.
 *
 * When the forge refuses the create (the signed-in account may not create
 * labels), the refusal is one row of the failure ledger for the
 * repository, keyed by the label (`label create <name>`), never one per
 * pull request: past `failures.notify_after` it is one need, naming the
 * label and the command a person runs. The pull requests' writes that add
 * the label are not counted on their own rows, and while the create backs
 * off they wait without asking the forge.
 */
import type { ActionBook } from "../failures.ts";
import { createLabel, type LabelEditFailure } from "../forge.ts";
import type { LabelSpec } from "../labels.ts";
import { failureText } from "../text.ts";

/** The failure ledger's key of one label's create, a row for the repository. */
export const createKey = (name: string): string => `label create ${name}`;

/** The labels a refused write added that the repository lacks, as the forge classed the refusal (`missing-label`); none for any other refusal. */
export function missingOf(failure: LabelEditFailure): string[] {
  return failure.code === "missing-label" ? failure.missing : [];
}

/** How a tick creates the dispatch labels its writes miss. */
export interface LabelCreate {
  /** The labels the tick may create, by name: the set under the prefix, and the marker labels. */
  specs: ReadonlyMap<string, LabelSpec>;
  /** The forge's create; `createLabel` unless a test gives another. */
  write?: typeof createLabel;
}

/** Why a write adding one of these labels waits: its create backs off; `null` when none does. */
export function createWaits(
  add: readonly string[],
  book: ActionBook | null | undefined,
): string | null {
  for (const name of add) {
    const waits = book?.waits(createKey(name)) ?? null;
    if (waits !== null) return `'${name}' could not be created: ${waits}`;
  }
  return null;
}

/** A write that added these labels succeeded, so each exists: the row of a create that failed for one goes (a person created the label meanwhile). */
export function createsSettled(
  slug: string,
  add: readonly string[],
  book: ActionBook | null | undefined,
): void {
  for (const name of add) {
    const key = createKey(name);
    if (book?.standing(key) === true)
      book.ran({ key, kind: "label", target: slug }, null);
  }
}

/** One shell word, in single quotes. */
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The creates of one tick's writes: each missing label is created at most
 * once a tick, its outcome counted once on its own row. `knows` says
 * whether a label is one the tick creates; `ensure` answers `null` once
 * every such label it is given exists, else why one does not.
 */
export function labelCreator(
  slug: string,
  create: LabelCreate | undefined,
  book: ActionBook | null | undefined,
): {
  knows(name: string): boolean;
  ensure(names: readonly string[]): Promise<string | null>;
} | null {
  if (create === undefined) return null;
  const write = create.write ?? createLabel;
  const tried = new Map<string, Promise<string | null>>();
  const once = async (spec: LabelSpec): Promise<string | null> => {
    const of = {
      key: createKey(spec.name),
      kind: "label" as const,
      target: slug,
    };
    let why: string;
    try {
      const created = await write(slug, spec);
      // A label another writer created first (another host, a person running `jig dispatch labels`) is there to write.
      if (created.ok || created.failure.code === "exists") {
        book?.ran(of, null);
        return null;
      }
      why = created.failure.reason;
    } catch (error) {
      why = failureText(error);
    }
    const reason = `the dispatch label '${spec.name}' does not exist in ${slug}, and the signed-in account could not create it: ${why}. A person who may create labels runs \`jig dispatch labels --yes\` for the repository, or gh label create ${quote(spec.name)} --repo ${slug} --color ${spec.color} --description ${quote(spec.description)}`;
    book?.ran(of, reason);
    return reason;
  };
  return {
    knows: (name) => create.specs.has(name),
    async ensure(names) {
      for (const name of names) {
        const spec = create.specs.get(name);
        if (spec === undefined) continue;
        let attempt = tried.get(name);
        if (attempt === undefined) {
          attempt = once(spec);
          tried.set(name, attempt);
        }
        const why = await attempt;
        if (why !== null) return why;
      }
      return null;
    },
  };
}

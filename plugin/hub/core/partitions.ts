/**
 * The hub's partitions: the unit its storage keeps apart and changes
 * atomically ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * There is one partition per repository (its deliveries, its world view,
 * its leases), one per host (what one host told the hub), and one
 * directory (which repositories and hosts the hub knows). Every row the
 * hub keeps sits in exactly one, every key starts with it, and no change
 * spans two: a change that touches two partitions is two changes, ordered
 * so that either alone is safe. A partition is named by a string the
 * builders here make; the storage implementation refuses one that does not
 * parse, so a malformed name never reaches a table.
 */
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

/** The one partition of the hub's own directory. */
export const DIRECTORY_PARTITION = "directory";

const REPOSITORY_PREFIX = "repo:";
const HOST_PREFIX = "host:";
/** `owner/name` as the forge writes it: an owner of letters, digits and hyphens; a name of those, dots and underscores. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** A host's id: letters, digits, dots, underscores and hyphens, at most 128 of them. */
const HOST = /^[A-Za-z0-9._-]{1,128}$/;

/** A partition, as its name says what it holds. */
export type Partition =
  | { readonly kind: "repository"; readonly repository: string }
  | { readonly kind: "host"; readonly host: string }
  | { readonly kind: "directory" };

/** The partition of the repository `owner/name`. */
export function repositoryPartition(repository: string): string {
  return `${REPOSITORY_PREFIX}${repository}`;
}

/** The partition of the host `id`. */
export function hostPartition(id: string): string {
  return `${HOST_PREFIX}${id}`;
}

/** What `name` names, or why it names no partition (`malformed-partition`). */
export function parsePartition(
  name: string,
): Outcome<Partition, "malformed-partition"> {
  if (name === DIRECTORY_PARTITION) return ok({ kind: "directory" });
  if (name.startsWith(REPOSITORY_PREFIX)) {
    const repository = name.slice(REPOSITORY_PREFIX.length);
    if (REPOSITORY.test(repository))
      return ok({ kind: "repository", repository });
  } else if (name.startsWith(HOST_PREFIX)) {
    const host = name.slice(HOST_PREFIX.length);
    if (HOST.test(host)) return ok({ kind: "host", host });
  }
  return failed(
    "malformed-partition",
    `${JSON.stringify(name)} names no partition: a partition is "${DIRECTORY_PARTITION}", "${REPOSITORY_PREFIX}<owner>/<name>" or "${HOST_PREFIX}<id>"`,
  );
}

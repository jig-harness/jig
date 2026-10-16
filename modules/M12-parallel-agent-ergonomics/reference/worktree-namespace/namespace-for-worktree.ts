#!/usr/bin/env bun
// The data namespace of a worktree: a database schema, database or key
// prefix derived from the worktree's identity, so the same worktree always
// gets the same namespace and two worktrees never share one, with no registry
// and no lock. The same move the port allocator makes for ports.
//
// The identity is the worktree's branch, as `git branch --show-current`
// prints it; the reaper (find-stale-namespaces.ts) derives the live names
// from the same branches, so a namespace named from anything else looks
// orphaned to it. A detached worktree has no branch and so no namespace.
//
// The rule. The identity is lowered, every run of characters outside a-z and
// 0-9 becomes one underscore, the ends are trimmed of underscores, and a
// prefix goes in front; the name ends in `_` and 16 hex characters (64 bits)
// of a SHA-256 hash of the identity as given. That slug alone maps many
// identities to one (`feature/refunds`, `feature-refunds` and
// `Feature/Refunds` share it); the hash of the unchanged identity keeps their
// names apart. 64 bits makes an accidental collision negligible, not
// impossible, so the reaper refuses a live census in which two branches derive
// one name rather than trusting the suffix. The prefix is never empty, because the namespace
// with no prefix is the one production uses: an identity that leaves nothing
// after trimming is refused rather than mapped to the bare prefix. A name
// longer than the limit (63 characters for a PostgreSQL identifier, the
// default) has its slug cut to fit before the hash.
//
// Exit codes: 0 the name is printed, 2 usage error or an identity with no
// name.
//
// Usage:
//   namespace-for-worktree.ts [--prefix wt_] [--max-length 63] [<worktree-id>]
// The identity comes from the argument or, failing that, WORKTREE_ID.
import { createHash } from "node:crypto";
import { cli, strictOptions } from "../../../../lib/cli.ts";

const usage =
  "usage: namespace-for-worktree.ts [--prefix <p>] [--max-length <n>] [<worktree-id>]";

export interface NamingOptions {
  prefix: string;
  maxLength: number;
}

export const DEFAULT_PREFIX = "wt_";
export const DEFAULT_MAX_LENGTH = 63;
const HASH_HEX = 16;
const HASH_SUFFIX = HASH_HEX + 1;

/** Refuse a prefix that is empty or not a plain lower-case identifier head. */
export function checkPrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(prefix))
    throw new Error(
      `--prefix must be a non-empty lower-case identifier (a-z, 0-9, _) starting with a letter: ${JSON.stringify(prefix)}`,
    );
  return prefix;
}

export function checkMaxLength(value: string, prefix: string): number {
  const least = prefix.length + HASH_SUFFIX + 1;
  if (!/^[0-9]{1,4}$/.test(value) || Number(value) < least)
    throw new Error(
      `--max-length must be an integer of at least ${least} (the prefix, one character and a hash suffix): ${value}`,
    );
  return Number(value);
}

/** The namespace name of a worktree identity; throw when nothing is left of it. */
export function namespaceFor(
  identity: string,
  { prefix, maxLength }: NamingOptions,
): string {
  const slug = identity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug === "")
    throw new Error(
      `the identity ${JSON.stringify(identity)} leaves no name, and the bare prefix is never a worktree's namespace`,
    );
  const hash = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, HASH_HEX);
  const room = maxLength - prefix.length - HASH_SUFFIX;
  return `${prefix}${slug.slice(0, room).replace(/_+$/, "")}_${hash}`;
}

/** The naming options and the identity from the arguments; throw with the usage on any other shape. */
export function parseOptions(
  args: string[],
  env: Record<string, string | undefined>,
): { identity: string; naming: NamingOptions } {
  const { values, positionals } = strictOptions(
    {
      args,
      options: {
        prefix: { type: "string" },
        "max-length": { type: "string" },
      },
      allowPositionals: true,
    },
    usage,
  );
  if (positionals.length > 1)
    throw new Error(`more than one identity\n${usage}`);
  const identity = positionals[0] ?? env.WORKTREE_ID;
  if (identity === undefined)
    throw new Error(
      `no worktree identity: pass one or set WORKTREE_ID\n${usage}`,
    );
  const prefix = checkPrefix(values.prefix ?? DEFAULT_PREFIX);
  const maxLength = checkMaxLength(
    values["max-length"] ?? String(DEFAULT_MAX_LENGTH),
    prefix,
  );
  return { identity, naming: { prefix, maxLength } };
}

export function main(
  args = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): number {
  const { identity, naming } = parseOptions(args, env);
  console.log(namespaceFor(identity, naming));
  return 0;
}

if (import.meta.main) cli(() => main());

#!/usr/bin/env bun
// The reaper's decision for per-worktree data namespaces: which of one
// owner's namespaces are stale, and which were created without the keys a
// reaper needs. It only decides; dropping is the adapter's step, after the
// report and an explicit opt-in.
//
// Every namespace the delivery system creates carries its owner and its
// expiry from the moment it is created (a schema comment, a label, a row in a
// registry table). A reaper runs as one owner and touches only that owner's
// namespaces: another owner's are left alone, so two people's reapers never
// race, and a shared namespace with no owner is never someone's to drop. A
// namespace is stale when its expiry has passed or when no live worktree
// derives its name any more (orphaned). One created without an owner or an
// expiry is reported as unlabelled, never reaped: the missing key is the
// finding. The production namespace, named by the required `--production`,
// is refused outright: it is never a candidate, however it is labelled.
//
// Input. `--inventory`: a JSON array of `{ "name", "owner", "expires_at" }`
// (the last two may be absent, which is what unlabelled means). `--live`: the
// output of `git worktree list --porcelain`. Each worktree's branch is its
// identity, mapped to a namespace name by the same rule as
// namespace-for-worktree.ts. A worktree on no branch (detached) is one whose
// namespace the census cannot name, so no orphan could be told from its
// namespace: the run stops instead.
//
// Fail closed. An inventory that is not JSON or not an array, an entry
// without a string name, an owner that is blank, an `expires_at` that is not
// an ISO 8601 time with a zone, two entries of one name that disagree, a live
// listing that is empty (a failed `git worktree list` leaves one; a real one
// always holds the main checkout), holds a record that is not a complete
// porcelain record (an unexpected line, a field given twice or with a value
// of the wrong shape, no HEAD object id, not exactly one of branch and
// detached, a branch name git would refuse), holds a detached worktree or
// two branches that derive one name, or a bad option exits 2.
//
// Exit codes: 0 nothing stale and nothing unlabelled, 1 at least one
// namespace to reap or one unlabelled, 2 usage or input error.
//
// Usage:
//   find-stale-namespaces.ts --owner <id> --inventory <file|-> --live <file|->
//     --production <name> [--prefix wt_] [--max-length 63] [--now <ISO 8601>] [--json]
import { readFileSync } from "node:fs";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import { isRecord } from "../../../../lib/record.ts";
import {
  checkMaxLength,
  checkPrefix,
  DEFAULT_MAX_LENGTH,
  DEFAULT_PREFIX,
  type NamingOptions,
  namespaceFor,
} from "./namespace-for-worktree.ts";

const usage =
  "usage: find-stale-namespaces.ts --owner <id> --inventory <file|-> --live <file|-> --production <name> [--prefix <p>] [--max-length <n>] [--now <ISO 8601>] [--json]";

export interface Namespace {
  name: string;
  owner?: string;
  expires_at?: string;
}

export type Reason = "expired" | "orphaned";

export interface Plan {
  owner: string;
  reap: { name: string; reason: Reason; expires_at?: string }[];
  unlabelled: { name: string; missing: string[] }[];
  live: string[];
  foreign: number;
  outside: number;
  production: string | null;
}

// A time zone is required: without one the verdict would depend on the
// machine's zone. Date.UTC rolls an impossible date over (30 February becomes
// 2 March), so a real date is one that comes back unchanged.
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/;

export function parseTime(value: unknown, what: string): number {
  const f = typeof value === "string" ? ISO.exec(value) : null;
  if (f !== null) {
    const ms = Date.parse(f[0]);
    const day = new Date(
      Date.UTC(Number(f[1]), Number(f[2]) - 1, Number(f[3])),
    );
    if (
      !Number.isNaN(ms) &&
      day.toISOString().startsWith(`${f[1]}-${f[2]}-${f[3]}`)
    )
      return ms;
  }
  throw new Error(
    `${what} is not an ISO 8601 time with a zone: ${String(value)}`,
  );
}

/**
 * The inventory entries, one per name; throw on any shape this check cannot
 * read. A blank owner is refused rather than read as someone else's, and two
 * entries of one name must agree, since the reaper could act on either.
 */
export function parseInventory(input: unknown): Namespace[] {
  if (!Array.isArray(input))
    throw new Error("the inventory is not a JSON array of namespaces");
  const byName = new Map<string, Namespace>();
  input.forEach((raw, index) => {
    const ns = inventoryEntry(raw, index);
    const seen = byName.get(ns.name);
    if (seen === undefined) byName.set(ns.name, ns);
    else if (seen.owner !== ns.owner || seen.expires_at !== ns.expires_at)
      throw new Error(
        `inventory entry ${ns.name} appears twice with different owners or expiries`,
      );
  });
  return [...byName.values()];
}

/** Throw when an entry's owner or expiry is present but not a string. */
function checkStringFields(raw: Record<string, unknown>, name: string): void {
  for (const field of ["owner", "expires_at"])
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      throw new Error(
        `inventory entry ${name} has a ${field} that is not a string`,
      );
}

/** One inventory entry, checked; throw on any shape this check cannot read. */
function inventoryEntry(raw: unknown, index: number): Namespace {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "")
    throw new Error(`inventory entry #${index} has no name`);
  checkStringFields(raw, raw.name);
  if (typeof raw.owner === "string" && raw.owner.trim() === "")
    throw new Error(`inventory entry ${raw.name} has a blank owner`);
  if (raw.expires_at !== undefined)
    parseTime(raw.expires_at, `expires_at of ${raw.name}`);
  return raw as unknown as Namespace;
}

/**
 * The namespace names the live worktrees derive to, from
 * `git worktree list --porcelain` output; throw when the listing is empty or
 * not that output, when a worktree has no branch to derive a name from, or
 * when two branches derive one name (a namespace two worktrees would share).
 * `derive` is the naming rule, replaceable so a test can force a collision.
 */
export function liveNames(
  text: string,
  naming: NamingOptions,
  derive: (identity: string, naming: NamingOptions) => string = namespaceFor,
): Set<string> {
  const owners = new Map<string, string>();
  for (const { path, branch, bare } of porcelainWorktrees(text)) {
    if (bare) continue;
    if (branch === undefined)
      throw new Error(
        `the worktree at ${path} is on no branch, so its namespace cannot be named and no orphan can be told apart from it; put it on a branch or remove it`,
      );
    const name = derive(branch, naming);
    const other = owners.get(name);
    if (other !== undefined && other !== branch)
      throw new Error(
        `the branches ${other} and ${branch} both derive ${name}, so their worktrees would share one namespace; rename one of them`,
      );
    owners.set(name, branch);
  }
  return new Set(owners.keys());
}

interface PorcelainWorktree {
  path: string;
  branch?: string;
  bare: boolean;
}

// The attribute lines `git worktree list --porcelain` documents after a
// record's `worktree` line, by the value each takes: `HEAD` and `branch`
// always carry one, `bare` and `detached` are labels that never do, and
// `locked` and `prunable` may carry a reason.
const ATTRIBUTES = {
  HEAD: "value",
  branch: "value",
  bare: "label",
  detached: "label",
  locked: "either",
  prunable: "either",
} as const;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The worktrees in `git worktree list --porcelain` output, one record per
 * blank-line-separated block; throw when the listing is empty or any record
 * is not a complete, consistent porcelain record.
 */
function porcelainWorktrees(text: string): PorcelainWorktree[] {
  const records = text
    .split(/\r?\n(?:\r?\n)+/)
    .map((block) => block.split(/\r?\n/).filter((line) => line !== ""))
    .filter((lines) => lines.length > 0);
  if (records.length === 0)
    throw new Error(
      "the live listing is empty: a failed worktree listing leaves one, and a real listing always holds the main checkout",
    );
  return records.map(porcelainRecord);
}

function notPorcelain(why: string): Error {
  return new Error(
    `the live listing is not \`git worktree list --porcelain\` output: ${why}`,
  );
}

/** One porcelain record, checked field by field. */
function porcelainRecord(lines: string[]): PorcelainWorktree {
  const [head, ...rest] = lines as [string, ...string[]];
  if (!head.startsWith("worktree ") || head === "worktree ")
    throw notPorcelain(`a record starts with ${JSON.stringify(head)}`);
  const path = head.slice("worktree ".length);
  const fields = recordFields(rest, path);
  if (fields.has("bare")) {
    if (["HEAD", "branch", "detached"].some((key) => fields.has(key)))
      throw notPorcelain(`the bare ${path} has a HEAD, a branch or detached`);
    return { path, bare: true };
  }
  if (!OBJECT_ID.test(fields.get("HEAD") ?? ""))
    throw notPorcelain(`${path} has no HEAD object id`);
  const ref = fields.get("branch");
  if ((ref === undefined) === !fields.has("detached"))
    throw notPorcelain(`${path} needs exactly one of branch and detached`);
  if (ref === undefined) return { path, bare: false };
  return { path, branch: localBranch(ref, path), bare: false };
}

/**
 * A record's attribute lines by key; throw on an unexpected or repeated one,
 * or one whose value does not have its attribute's shape.
 */
function recordFields(lines: string[], path: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    if (!Object.hasOwn(ATTRIBUTES, key))
      throw notPorcelain(`unexpected line in ${path}: ${line}`);
    if (fields.has(key)) throw notPorcelain(`${key} appears twice in ${path}`);
    const value = space === -1 ? undefined : line.slice(space + 1);
    const wrong = wrongShape(ATTRIBUTES[key as keyof typeof ATTRIBUTES], value);
    if (wrong) throw notPorcelain(`${key} carries ${wrong} in ${path}`);
    fields.set(key, value ?? "");
  }
  return fields;
}

/** What is wrong with an attribute's value for its shape, if anything. */
function wrongShape(
  shape: (typeof ATTRIBUTES)[keyof typeof ATTRIBUTES],
  value: string | undefined,
): string | undefined {
  if (value === "") return "an empty value";
  if (shape === "label" && value !== undefined) return `the value ${value}`;
  if (shape === "value" && value === undefined) return "no value";
  return undefined;
}

/** The branch name of a `refs/heads/` ref; throw on any other ref. */
function localBranch(ref: string, path: string): string {
  if (!ref.startsWith("refs/heads/") || ref === "refs/heads/")
    throw notPorcelain(`${path} is on ${ref}, not a local branch`);
  const branch = ref.slice("refs/heads/".length);
  if (!isBranchName(branch))
    throw notPorcelain(`${path} is on ${JSON.stringify(ref)}, not a ref name`);
  return branch;
}

/**
 * Whether a branch name meets `git check-ref-format --branch`. Git writes
 * no other, so one that fails (a trailing space, say) is a damaged listing,
 * and its name would derive a namespace the real branch does not have.
 */
export function isBranchName(name: string): boolean {
  if (name === "@" || name.startsWith("-")) return false;
  if ([...name].some((c) => c.charCodeAt(0) <= 0x20 || c === "\x7f"))
    return false;
  if (/[~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/.test(name)) return false;
  return name
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

export interface Decision {
  owner: string;
  now: number;
  live: Set<string>;
  naming: NamingOptions;
  production: string;
}

export type Bucket =
  | { kind: "production" | "outside" | "foreign" | "live" }
  | { kind: "unlabelled"; missing: string[] }
  | { kind: "reap"; reason: Reason; expires_at: string };

/** The bucket one namespace falls into. */
export function classify(ns: Namespace, decision: Decision): Bucket {
  const { owner, now, live, naming, production } = decision;
  if (ns.name === production) return { kind: "production" };
  if (!ns.name.startsWith(naming.prefix)) return { kind: "outside" };
  if (ns.owner !== undefined && ns.owner !== owner) return { kind: "foreign" };
  const { owner: nsOwner, expires_at: expiresAt } = ns;
  if (nsOwner === undefined || expiresAt === undefined) {
    const missing = (["owner", "expires_at"] as const).filter(
      (field) => ns[field] === undefined,
    );
    return { kind: "unlabelled", missing };
  }
  if (parseTime(expiresAt, `expires_at of ${ns.name}`) <= now)
    return { kind: "reap", reason: "expired", expires_at: expiresAt };
  if (!live.has(ns.name))
    return { kind: "reap", reason: "orphaned", expires_at: expiresAt };
  return { kind: "live" };
}

/** Sort each namespace of the inventory into the plan. */
export function plan(inventory: Namespace[], decision: Decision): Plan {
  const result: Plan = {
    owner: decision.owner,
    reap: [],
    unlabelled: [],
    live: [],
    foreign: 0,
    outside: 0,
    production: null,
  };
  for (const ns of inventory) {
    const bucket = classify(ns, decision);
    if (bucket.kind === "reap")
      result.reap.push({
        name: ns.name,
        reason: bucket.reason,
        expires_at: bucket.expires_at,
      });
    else if (bucket.kind === "unlabelled")
      result.unlabelled.push({ name: ns.name, missing: bucket.missing });
    else if (bucket.kind === "production") result.production = ns.name;
    else if (bucket.kind === "outside") result.outside++;
    else if (bucket.kind === "foreign") result.foreign++;
    else result.live.push(ns.name);
  }
  return result;
}

export interface Options {
  owner: string;
  inventory: string;
  live: string;
  naming: NamingOptions;
  production: string;
  now: number;
  json: boolean;
}

const OPTIONS = {
  owner: { type: "string" },
  inventory: { type: "string" },
  live: { type: "string" },
  prefix: { type: "string" },
  "max-length": { type: "string" },
  production: { type: "string" },
  now: { type: "string" },
  json: { type: "boolean" },
} as const;

/** The options; throw with the usage when a required one is missing or any other shape is given. */
export function parseOptions(args: string[]): Options {
  const { values } = strictOptions(
    { args, options: OPTIONS, allowPositionals: false },
    usage,
  );
  const required = (
    flag: "owner" | "inventory" | "live" | "production",
  ): string => {
    const v = values[flag];
    if (v === undefined || v.trim() === "")
      throw new Error(`--${flag} is required\n${usage}`);
    return v;
  };
  const prefix = checkPrefix(values.prefix ?? DEFAULT_PREFIX);
  return {
    owner: required("owner"),
    inventory: required("inventory"),
    live: required("live"),
    naming: {
      prefix,
      maxLength: checkMaxLength(
        values["max-length"] ?? String(DEFAULT_MAX_LENGTH),
        prefix,
      ),
    },
    production: required("production"),
    now: values.now === undefined ? Date.now() : parseTime(values.now, "--now"),
    json: values.json === true,
  };
}

function read(path: string): string {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function render(p: Plan): string {
  const counts = `${p.reap.filter((r) => r.reason === "expired").length} expired, ${p.reap.filter((r) => r.reason === "orphaned").length} orphaned`;
  const tail = `${p.live.length} live, ${p.foreign} of other owners, ${p.outside} outside the prefix${p.production === null ? "" : `, ${p.production} refused as production`}`;
  const head =
    p.reap.length === 0 && p.unlabelled.length === 0
      ? `OK — nothing to reap for ${p.owner}; ${tail}`
      : `STALE — ${p.reap.length} namespace(s) to reap for ${p.owner} (${counts}), ${p.unlabelled.length} unlabelled; ${tail}`;
  return [
    head,
    ...p.reap.map(
      (r) =>
        `  - ${r.name}: ${r.reason}${r.reason === "expired" ? ` ${r.expires_at}` : " (no live worktree derives it)"}`,
    ),
    ...p.unlabelled.map(
      (u) =>
        `  - ${u.name}: unlabelled (no ${u.missing.join(", no ")}), not reaped`,
    ),
  ].join("\n");
}

function readInventory(path: string): Namespace[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch {
    throw new Error(`the inventory is not JSON: ${path}`);
  }
  return parseInventory(parsed);
}

export function main(args = process.argv.slice(2)): number {
  const options = parseOptions(args);
  const inventory = readInventory(options.inventory);
  const live = liveNames(read(options.live), options.naming);
  const result = plan(inventory, {
    owner: options.owner,
    now: options.now,
    live,
    naming: options.naming,
    production: options.production,
  });
  console.log(options.json ? JSON.stringify(result, null, 2) : render(result));
  return result.reap.length > 0 || result.unlabelled.length > 0 ? 1 : 0;
}

if (import.meta.main) cli(() => main());

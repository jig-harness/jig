/** Durable fixture membership. An opaque launch never becomes a completion witness. */
import { randomUUID, createHash } from "node:crypto";
import {
  lstatSync,
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { sharedGcLock } from "./gc-lock.ts";
import {
  decodeIdentity,
  encodeIdentity,
  judge,
  ownIdentity,
  type ProcessIdentity,
} from "./liveness.ts";
import { processTable, type ProcessRow } from "./process-table.ts";
import { SCRATCH_OWNER_FILE } from "./scratch-owner.ts";
import { attempt, failed, ok, type Outcome } from "./outcome.ts";
import { isRecord } from "./guards.ts";
import { failureFields, swallow } from "./errors.ts";
import { log } from "./log.ts";
import { currentIso, currentMs, parseMs } from "./time.ts";

export const FIXTURE_REGISTRY_ENV = "JIG_TEST_FIXTURE_REGISTRY";
export const FIXTURE_NODE_ENV = "JIG_TEST_FIXTURE_NODE";
export interface FixtureMembership {
  registry: string;
  node: string;
}
export interface FixtureScope {
  root: string;
  registry: string;
  createdAt: string;
  registeredBy: ProcessIdentity;
}
type NodeRecord = {
  version: 1;
  state: "registered" | "pending" | "opaque";
  parent: string | null;
  identity?: string;
  opaqueReason?: "native" | "prior-work";
};
export type FixtureProof = {
  state: "dead" | "live" | "unverified";
  reason: string;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECORDS = 100_000;
const MAX_RECORD_BYTES = 64 * 1024;
export function testFixtureRegistryRoot(home = homedir()): string {
  return join(home, ".local", "state", "jig", "test-fixtures-v1");
}
function scopeName(root: string): string {
  return `scope-${createHash("sha256").update(resolve(root)).digest("hex")}.json`;
}
function nodePath(membership: FixtureMembership): string {
  return join(membership.registry, "nodes", `${membership.node}.json`);
}
function publish(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function admitted<T>(registry: string, action: () => T): Outcome<T> {
  return attempt("fixture-registration", "Cannot register test fixture", () => {
    // Membership's original machine store fixes admission, even in a child
    // whose fixture changes HOME to a disposable fake home.
    const release = sharedGcLock(
      "scratch",
      join(dirname(dirname(registry)), "gc-locks"),
    );
    try {
      return action();
    } finally {
      release();
    }
  });
}
/** Register outside disposable scratch, so a surviving child cannot erase membership by recreating its root. */
export function registerFixtureScope(
  root: string,
  inherited?: FixtureMembership,
  store = testFixtureRegistryRoot(),
): Outcome<FixtureMembership> {
  const membership = inherited ?? {
    registry: join(store, randomUUID()),
    node: randomUUID(),
  };
  return admitted(membership.registry, () => {
    mkdirSync(join(membership.registry, "nodes"), {
      recursive: true,
      mode: 0o700,
    });
    if (!inherited)
      publish(nodePath(membership), {
        version: 1,
        state: "registered",
        parent: null,
        identity: encodeIdentity(ownIdentity()),
      } satisfies NodeRecord);
    publish(join(membership.registry, scopeName(root)), {
      version: 1,
      root: resolve(root),
      createdAt: currentIso(),
      registeredBy: encodeIdentity(ownIdentity()),
    });
    return membership;
  });
}
/** This pending edge must land before the spawn. A missed acknowledgement keeps the whole tree unverified. */
export function beginFixtureLaunch(
  parent: FixtureMembership,
  participating: boolean,
  opaqueReason: "native" | "prior-work" = "native",
): Outcome<FixtureMembership> {
  return admitted(parent.registry, () => {
    const node = randomUUID();
    publish(nodePath({ registry: parent.registry, node }), {
      version: 1,
      state: participating ? "pending" : "opaque",
      parent: parent.node,
      ...(participating ? {} : { opaqueReason }),
    } satisfies NodeRecord);
    return { registry: parent.registry, node };
  });
}
/** A child acknowledges itself before its fixture program runs; parent exit is never an acknowledgement. */
export function acknowledgeFixtureLaunch(
  membership: FixtureMembership,
): Outcome<boolean> {
  const acknowledged = admitted(membership.registry, () => {
    const file = nodePath(membership);
    const record = nodeRecord(file);
    const identity = encodeIdentity(ownIdentity());
    if (record?.state === "opaque") return "opaque" as const;
    if (record?.state === "registered") return record.identity === identity;
    if (record?.state !== "pending") return false;
    if (!claimFixtureIdentity(file, identity)) return false;
    publish(file, {
      ...record,
      state: "registered",
      identity,
    });
    return true;
  });
  if (!acknowledged.ok) return acknowledged;
  if (acknowledged.value === "opaque") return ok(false);
  return acknowledged.value
    ? ok(true)
    : failed(
        "fixture-acknowledgement",
        "fixture acknowledgement is invalid or belongs to another process",
      );
}
function claimFixtureIdentity(file: string, identity: string): boolean {
  const claim = file.replace(/\.json$/, ".claim");
  try {
    writeFileSync(claim, identity, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readFileSync(claim, "utf8") === identity;
  }
  return true;
}
function regular(file: string): boolean {
  const stat = lstatSync(file);
  return stat.isFile() && stat.size <= MAX_RECORD_BYTES;
}
function readRecord(file: string): string | null {
  if (!regular(file)) return null;
  return readFileSync(file, "utf8");
}
function nodeState(value: unknown): value is NodeRecord["state"] {
  return value === "registered" || value === "pending" || value === "opaque";
}
function opaqueKind(value: unknown): value is NodeRecord["opaqueReason"] {
  return value === undefined || value === "native" || value === "prior-work";
}
function nodeRecord(file: string): NodeRecord | null {
  const text = readRecord(file);
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.version !== 1) return null;
  const { state, parent, identity, opaqueReason } = value;
  if (!nodeState(state)) return null;
  if (!(parent === null || typeof parent === "string")) return null;
  if (identity !== undefined && typeof identity !== "string") return null;
  if (!opaqueKind(opaqueReason)) return null;
  return {
    version: 1,
    state,
    parent,
    ...(typeof identity === "string" ? { identity } : {}),
    ...(opaqueReason ? { opaqueReason } : {}),
  };
}
function scopeRecord(file: string, registry: string): FixtureScope | null {
  const text = readRecord(file);
  if (text === null) return null;
  const value: unknown = JSON.parse(text);
  const registeredBy = isRecord(value)
    ? decodeIdentity(value.registeredBy)
    : null;
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.root === "string" &&
    isAbsolute(value.root) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(parseMs(value.createdAt)) &&
    registeredBy !== null
    ? {
        root: value.root,
        registry,
        createdAt: value.createdAt,
        registeredBy,
      }
    : null;
}
interface ScanBudget {
  deadline: number;
  count: number;
}
function within(budget: ScanBudget): boolean {
  return ++budget.count <= MAX_RECORDS && currentMs() <= budget.deadline;
}
type ScopeEntry = { kind: "skip" } | { kind: "scope"; scope: FixtureScope };
function scopeIndexEntry(registry: string, entry: Dirent): ScopeEntry | null {
  const name = entry.name;
  if (name === "nodes" || name === "startup") {
    return entry.isDirectory() ? { kind: "skip" } : null;
  }
  if (name.endsWith(".tmp") && entry.isFile()) return { kind: "skip" };
  if (!name.startsWith("scope-") || !name.endsWith(".json")) return null;
  const record = scopeRecord(join(registry, name), registry);
  if (!record || name !== scopeName(record.root)) return null;
  return { kind: "scope", scope: record };
}
function registryScopes(
  registry: string,
  budget: ScanBudget,
): FixtureScope[] | null {
  const scopes: FixtureScope[] = [];
  for (const entry of readdirSync(registry, { withFileTypes: true })) {
    if (!within(budget)) return null;
    const parsed = scopeIndexEntry(registry, entry);
    if (!parsed) return null;
    if (parsed.kind === "scope") scopes.push(parsed.scope);
  }
  return scopes;
}
/** Inventory is independent of the scratch root, which a child may have removed and recreated. */
export function fixtureScopeInventory(
  store = testFixtureRegistryRoot(),
): Outcome<FixtureScope[]> {
  const read = attempt(
    "fixture-inventory",
    "Cannot inventory fixture registrations",
    () => {
      const budget = { deadline: currentMs() + 5000, count: 0 };
      let entries: Dirent[];
      try {
        entries = readdirSync(store, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const scopes: FixtureScope[] = [];
      for (const entry of entries) {
        if (!within(budget)) return null;
        if (!entry.isDirectory()) return null;
        const found = registryScopes(join(store, entry.name), budget);
        if (!found) return null;
        scopes.push(...found);
      }
      return scopes;
    },
  );
  return !read.ok
    ? read
    : read.value === null
      ? failed(
          "fixture-inventory",
          "Fixture inventory is malformed or exceeded its bounded scan",
        )
      : ok(read.value);
}
/** One registry folder as a page reads it, never as the strict inventory's all-or-nothing read. */
export interface FixtureRegistration {
  registry: string;
  scopes: FixtureScope[];
}
export interface FixtureRegistryPage {
  registrations: FixtureRegistration[];
  /** Folders that are not readable registrations, each with why. */
  malformed: { registry: string; reason: string }[];
  /** True when this page read every folder the store held. */
  complete: boolean;
}
const PAGE_REGISTRIES = 100_000;
const PAGE_MS = 30_000;
type PageEntry =
  | { kind: "registration"; registration: FixtureRegistration }
  | { kind: "malformed"; reason: string }
  | { kind: "vanished" };
function pageEntry(registry: string): PageEntry {
  try {
    if (!lstatSync(registry).isDirectory())
      return { kind: "malformed", reason: "not a registration folder" };
    const budget = { deadline: currentMs() + 5000, count: 0 };
    const scopes = registryScopes(registry, budget);
    return scopes
      ? { kind: "registration", registration: { registry, scopes } }
      : {
          kind: "malformed",
          reason: "registration holds an unreadable or unexpected entry",
        };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      lstatSync(registry, { throwIfNoEntry: false }) === undefined
    )
      return { kind: "vanished" };
    log.warn("Cannot read a fixture registration", {
      registry,
      ...failureFields(error),
    });
    return {
      kind: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
/** One registry's scopes, refused on any unexpected entry as the strict inventory refuses it. */
export function fixtureRegistryScopes(
  registry: string,
): Outcome<FixtureScope[]> {
  const entry = pageEntry(registry);
  if (entry.kind === "registration") return ok(entry.registration.scopes);
  return failed(
    "fixture-inventory",
    entry.kind === "vanished"
      ? "fixture registration disappeared"
      : `malformed registration: ${entry.reason}`,
  );
}
/** A name `readdir` could have returned for a folder of the store. */
function folderName(name: string): boolean {
  return (
    name !== "" &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0") &&
    (process.platform !== "win32" || !name.includes("\\"))
  );
}
/** Where the last page stopped; a missing or unreadable cursor starts from the beginning. */
function readCursor(file: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "string" && folderName(value) ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log.debug("Cannot read the fixture inventory cursor", {
        file,
        ...failureFields(error),
      });
    return null;
  }
}
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
/** The folder names in a stable order, resuming after the name the last page stopped at. */
function resumedOrder(names: string[], after: string | null): string[] {
  // Code-unit order, the order the `>` below compares in; a locale order would disagree.
  const sorted = names.toSorted(compareCodeUnits);
  if (after === null) return sorted;
  const start = sorted.findIndex((name) => name > after);
  return start < 0
    ? sorted
    : [...sorted.slice(start), ...sorted.slice(0, start)];
}
/**
 * Read the next bounded page of the store, resuming where the last page
 * stopped, so a store larger than one read is still read in full over
 * successive runs. A malformed folder is reported as itself. Without
 * `advance`, the page is read and the cursor stays where it was.
 */
export function nextFixtureRegistryPage(
  store = testFixtureRegistryRoot(),
  options: { limit?: number | undefined; advance?: boolean | undefined } = {},
): Outcome<FixtureRegistryPage> {
  const limit = options.limit ?? PAGE_REGISTRIES;
  return attempt(
    "fixture-inventory",
    "Cannot read a page of fixture registrations",
    () => {
      const page: FixtureRegistryPage = {
        registrations: [],
        malformed: [],
        complete: true,
      };
      let names: string[];
      try {
        names = readdirSync(store);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return page;
        throw error;
      }
      const cursor = `${store}.cursor`;
      const order = resumedOrder(names, readCursor(cursor));
      const deadline = currentMs() + PAGE_MS;
      let read = 0;
      for (const name of order) {
        if (read >= limit || currentMs() > deadline) break;
        read++;
        const registry = join(store, name);
        const entry = pageEntry(registry);
        if (entry.kind === "registration")
          page.registrations.push(entry.registration);
        else if (entry.kind === "malformed")
          page.malformed.push({ registry, reason: entry.reason });
      }
      page.complete = read === order.length;
      const last = order[read - 1];
      if (options.advance === false) return page;
      if (page.complete || last === undefined) rmSync(cursor, { force: true });
      else publish(cursor, last);
      return page;
    },
  );
}
/** True only when the root is certainly absent; an unreadable path counts as present. */
export function fixtureRootGone(root: string): boolean {
  try {
    return lstatSync(root, { throwIfNoEntry: false }) === undefined;
  } catch (error) {
    log.debug("Cannot inspect a registered fixture root", {
      root,
      ...failureFields(error),
    });
    return false;
  }
}
/** Every registered root and the registrations holding it, read once for a proof batch. */
export interface FixtureEnclosureIndex {
  roots: Map<string, Set<string>>;
  /** The roots each registration holds, so retiring one touches only those. */
  held: Map<string, Set<string>>;
  /** False when a folder could not be read as a registration, so some root is unknown. */
  complete: boolean;
}
/**
 * Read the roots every registration holds without the strict inventory's
 * count ceiling and all-or-nothing rejection, so a store larger than one
 * strict read can still show which roots enclose which. A folder that is not
 * a readable registration, or a read past its time bound, leaves the index
 * incomplete rather than guessing.
 */
function fixtureEnclosureIndex(
  store = testFixtureRegistryRoot(),
): FixtureEnclosureIndex {
  const index: FixtureEnclosureIndex = {
    roots: new Map(),
    held: new Map(),
    complete: true,
  };
  let names: string[];
  try {
    names = readdirSync(store);
  } catch (error) {
    index.complete = (error as NodeJS.ErrnoException).code === "ENOENT";
    return index;
  }
  const deadline = currentMs() + PAGE_MS;
  for (const name of names) {
    if (currentMs() > deadline) {
      index.complete = false;
      break;
    }
    const registry = join(store, name);
    const entry = pageEntry(registry);
    if (entry.kind === "malformed") index.complete = false;
    if (entry.kind !== "registration") continue;
    for (const scope of entry.registration.scopes) {
      const root = resolve(scope.root);
      const holders = index.roots.get(root) ?? new Set<string>();
      holders.add(registry);
      index.roots.set(root, holders);
      const own = index.held.get(registry) ?? new Set<string>();
      own.add(root);
      index.held.set(registry, own);
    }
  }
  return index;
}
/** What the store looked like when an index was read: entry count and newest registration-folder change. */
interface StoreWitness {
  entries: number;
  newestNs: bigint;
}
const RACY_NS = 2_000_000_000n;
/** Null when the store cannot be summarized inside its time bound. Scope files land by atomic rename, so adding one moves its folder's change time. */
function storeWitness(store: string): StoreWitness | null {
  try {
    const names = readdirSync(store);
    const deadline = currentMs() + PAGE_MS;
    let newestNs = 0n;
    for (const name of names) {
      if (currentMs() > deadline) return null;
      const stat = lstatSync(join(store, name), {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (stat && stat.mtimeNs > newestNs) newestNs = stat.mtimeNs;
    }
    return { entries: names.length, newestNs };
  } catch (error) {
    swallow(
      error,
      "an unreadable store has no witness, so its index is read again",
    );
    return null;
  }
}
/**
 * An enclosure index reused across batches only while the store is provably
 * unchanged: the same entry count and no folder changed since the read, with
 * a guard against a change landing in the clock's last tick before it.
 */
export function cachedFixtureEnclosure(
  store: string,
  previous?: {
    index: FixtureEnclosureIndex;
    witness: StoreWitness | null;
    at: bigint;
  },
): { index: FixtureEnclosureIndex; witness: StoreWitness | null; at: bigint } {
  const witness = storeWitness(store);
  if (
    previous &&
    witness &&
    previous.witness &&
    witness.entries === previous.witness.entries &&
    witness.newestNs <= previous.witness.newestNs &&
    previous.at - previous.witness.newestNs > RACY_NS
  )
    return previous;
  const at = BigInt(currentMs()) * 1_000_000n;
  return { index: fixtureEnclosureIndex(store), witness, at };
}
/**
 * Account for registrations the caller itself just removed, so the next
 * batch's witness still matches without reading the index again. Removing a
 * folder moves no other folder's change time, and the cached newest time only
 * ever bounds from above, so an external addition still shows as a newer one.
 */
export function withoutRetired(
  cached: ReturnType<typeof cachedFixtureEnclosure>,
  retired: string[],
): ReturnType<typeof cachedFixtureEnclosure> {
  const gone = new Set(retired);
  for (const registry of gone) {
    for (const root of cached.index.held.get(registry) ?? []) {
      const holders = cached.index.roots.get(root);
      holders?.delete(registry);
      if (holders?.size === 0) cached.index.roots.delete(root);
    }
    cached.index.held.delete(registry);
  }
  return {
    ...cached,
    witness: cached.witness && {
      ...cached.witness,
      entries: cached.witness.entries - gone.size,
    },
  };
}
/**
 * Whether a scope that still counts this registration's unknown launches
 * encloses the root: a legacy scratch owner, or another registration's root,
 * the root itself included. Null when the registered roots cannot be read.
 */
function enclosedByCountingScope(
  roots: string[],
  registry: string,
  index: FixtureEnclosureIndex,
): boolean | null {
  const others = (directory: string): boolean =>
    [...(index.roots.get(resolve(directory)) ?? [])].some(
      (holder) => holder !== registry,
    );
  for (const root of roots) {
    for (let directory = root; ; directory = dirname(directory)) {
      if (
        others(directory) ||
        lstatSync(join(directory, SCRATCH_OWNER_FILE), {
          throwIfNoEntry: false,
        })
      )
        return true;
      if (dirname(directory) === directory) break;
    }
  }
  return index.complete ? false : null;
}
function retirementVeto(
  registry: string,
  scopes: FixtureScope[],
  nodes: NodeRecord[],
  enclosure: () => FixtureEnclosureIndex,
): FixtureProof | null {
  if (!scopes.every((scope) => fixtureRootGone(scope.root)))
    return { state: "unverified", reason: "a registered root exists again" };
  if (nodes.some((node) => node.state === "pending"))
    return {
      state: "unverified",
      reason: "fixture launch has no child acknowledgement",
    };
  if (nodes.some((node) => node.state === "opaque")) {
    const enclosed = enclosedByCountingScope(
      scopes.map((scope) => scope.root),
      registry,
      enclosure(),
    );
    if (enclosed === null)
      return {
        state: "unverified",
        reason:
          "the registered roots enclosing this registration are unreadable",
      };
    if (enclosed)
      return {
        state: "unverified",
        reason:
          "an enclosing scratch scope or registered root still exists, and this registration's opaque launches still count for it",
      };
  }
  return null;
}
/**
 * An opaque child that inherited membership registers its scopes under its own
 * identity, which no node records. Such a writer, still running, can write the
 * registration again after every root is gone.
 */
function unrecordedWriters(
  scopes: FixtureScope[],
  nodes: NodeRecord[],
  rows: ProcessRow[] | null,
): FixtureProof | null {
  const recorded = new Set(nodes.map((node) => node.identity));
  for (const scope of scopes) {
    if (recorded.has(encodeIdentity(scope.registeredBy))) continue;
    if (!scope.registeredBy.start)
      return {
        state: "unverified",
        reason: "a scope's registering process identity is unreadable",
      };
    const alive = judge(scope.registeredBy, rows);
    if (!alive.ok) return { state: "unverified", reason: alive.failure.reason };
    if (alive.value.state === "alive")
      return {
        state: "live",
        reason: "a process that registered a scope without a node still runs",
      };
  }
  return null;
}
function registeredProcesses(
  nodes: NodeRecord[],
  rows: ProcessRow[] | null,
): FixtureProof {
  for (const node of nodes) {
    if (node.state !== "registered") continue;
    const identity =
      typeof node.identity === "string" ? decodeIdentity(node.identity) : null;
    if (!identity?.start)
      return {
        state: "unverified",
        reason: "fixture process identity is unreadable",
      };
    const alive = judge(identity, rows);
    if (!alive.ok) return { state: "unverified", reason: alive.failure.reason };
    if (alive.value.state === "alive")
      return {
        state: "live",
        reason: "a registered fixture process still runs",
      };
  }
  return {
    state: "dead",
    reason:
      "every registered root is gone and every registered fixture process has exited",
  };
}
/**
 * Whether a registration whose roots are all gone may be retired. Nothing
 * is left to remove, so only its writers matter: a registered process that
 * still runs could write to it again, and so could a process that registered
 * a scope under no node. An opaque launch that has registered nothing is not
 * visible as a writer, but still counts against a scratch scope that
 * encloses its root.
 */
export function fixtureRetirementProof(
  registry: string,
  rows: ProcessRow[] | null,
  enclosure?: () => FixtureEnclosureIndex,
): FixtureProof {
  const enclosureIndex =
    enclosure ??
    ((): FixtureEnclosureIndex => fixtureEnclosureIndex(dirname(registry)));
  const read = attempt(
    "fixture-retirement",
    "Cannot read a fixture registration",
    () => {
      const budget = { deadline: currentMs() + 5000, count: 0 };
      const scopes = registryScopes(registry, budget);
      const nodes = scopes && registryNodes(registry);
      if (!scopes || !nodes)
        return {
          state: "unverified",
          reason: "fixture membership is unreadable or incomplete",
        } satisfies FixtureProof;
      return (
        retirementVeto(registry, scopes, [...nodes.values()], enclosureIndex) ??
        unrecordedWriters(scopes, [...nodes.values()], rows) ??
        registeredProcesses([...nodes.values()], rows)
      );
    },
  );
  if (read.ok) return read.value;
  try {
    if (!lstatSync(registry, { throwIfNoEntry: false }))
      return {
        state: "unverified",
        reason: "fixture registration disappeared",
      };
  } catch {
    // An unreadable registration is reported with the read's own cause below.
  }
  if (read.failure.cause !== undefined)
    log.warn("Cannot read a fixture registration for retirement", {
      registry,
      ...failureFields(read.failure.cause),
    });
  return { state: "unverified", reason: read.failure.reason };
}
/** Caller holds scratch's exclusive lock and has just proved the registration retirable. */
export function retireFixtureRegistration(registry: string): Outcome<void> {
  return attempt(
    "fixture-retirement",
    "Cannot retire fixture registration",
    () => rmSync(registry, { recursive: true, force: true }),
  );
}
function linkedParents(
  nodes: Map<string, NodeRecord>,
  deadline: number,
): boolean {
  if ([...nodes.values()].filter((node) => node.parent === null).length !== 1)
    return false;
  for (const node of nodes.values()) {
    const seen = new Set<NodeRecord>();
    let ancestor = node;
    while (ancestor.parent !== null) {
      if (seen.has(ancestor) || currentMs() > deadline) return false;
      seen.add(ancestor);
      const parent = nodes.get(ancestor.parent);
      if (!parent) return false;
      ancestor = parent;
    }
  }
  return true;
}
type ParsedEntry =
  | { kind: "skip" }
  | { kind: "node"; id: string; node: NodeRecord };
function validClaim(registry: string, entry: Dirent): boolean {
  const id = entry.name.slice(0, -6);
  if (!UUID.test(id) || !entry.isFile()) return false;
  const node = nodeRecord(join(registry, `${id}.json`));
  const identity = readRecord(join(registry, entry.name));
  if (identity === null) return false;
  if (!node || !decodeIdentity(identity)) return false;
  return node.state !== "registered" || node.identity === identity;
}
function registryEntry(registry: string, entry: Dirent): ParsedEntry | null {
  const file = join(registry, entry.name);
  if (entry.name.endsWith(".claim"))
    return validClaim(registry, entry) ? { kind: "skip" } : null;
  if (entry.name.endsWith(".tmp"))
    return entry.isFile() ? { kind: "skip" } : null;
  const id = entry.name.slice(0, -5);
  if (!entry.name.endsWith(".json") || !UUID.test(id)) return null;
  const node = nodeRecord(file);
  return node ? { kind: "node", id, node } : null;
}
function registryNodes(registry: string): Map<string, NodeRecord> | null {
  const budget = { deadline: currentMs() + 5000, count: 0 };
  if (!registryScopes(registry, budget)) return null;
  const directory = join(registry, "nodes");
  if (!lstatSync(directory).isDirectory()) return null;
  const nodes = new Map<string, NodeRecord>();
  const claims = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!within(budget)) return null;
    const parsed = registryEntry(directory, entry);
    if (!parsed) return null;
    if (parsed.kind === "node") nodes.set(parsed.id, parsed.node);
    else if (entry.name.endsWith(".claim")) claims.add(entry.name.slice(0, -6));
  }
  if (
    [...nodes].some(
      ([id, node]) =>
        node.parent !== null && node.state === "registered" && !claims.has(id),
    )
  )
    return null;
  return linkedParents(nodes, budget.deadline) ? nodes : null;
}
/** One validated closed graph, shared by the proof and the registered-child reaper. */
export function readClosedFixtureMembership(
  root: string,
  registry: string,
): Outcome<{ owner: ProcessIdentity; children: ProcessIdentity[] }> {
  const loaded = attempt(
    "fixture-proof",
    "Cannot read fixture registrations",
    () => {
      if (!lstatSync(registry).isDirectory()) return null;
      const scope = scopeRecord(join(registry, scopeName(root)), registry);
      if (!scope || resolve(scope.root) !== resolve(root)) return null;
      return registryNodes(registry);
    },
  );
  if (!loaded.ok) return loaded;
  if (loaded.value === null)
    return failed(
      "fixture-proof",
      "fixture membership is unreadable or incomplete",
    );
  const nodes = [...loaded.value.values()];
  if (
    nodes.some(
      (node) => node.state === "opaque" && node.opaqueReason === "prior-work",
    )
  )
    return failed(
      "fixture-proof",
      "fixture interception started after the program; earlier child membership is unknown",
    );
  if (nodes.some((node) => node.state === "opaque"))
    return failed(
      "fixture-proof",
      "fixture tree contains an opaque native launch or an unverified startup launch; descendant membership is unknown",
    );
  if (nodes.some((node) => node.state === "pending"))
    return failed(
      "fixture-proof",
      "fixture launch has no child acknowledgement",
    );
  let owner: ProcessIdentity | undefined;
  const children: ProcessIdentity[] = [];
  for (const node of nodes) {
    const identity =
      typeof node.identity === "string" ? decodeIdentity(node.identity) : null;
    if (!identity?.start)
      return failed("fixture-proof", "fixture process identity is unreadable");
    if (node.parent === null) owner = identity;
    else children.push(identity);
  }
  return owner
    ? ok({ owner, children })
    : failed("fixture-proof", "fixture owner is missing");
}
/** Caller holds scratch's exclusive lock, preventing new launches between proof and removal. */
export async function proveFixtureScope(
  root: string,
  registry: string,
): Promise<FixtureProof> {
  const membership = readClosedFixtureMembership(root, registry);
  if (!membership.ok) {
    if (membership.failure.cause !== undefined)
      log.warn("Cannot read fixture membership proof", {
        root,
        registry,
        ...failureFields(membership.failure.cause),
      });
    return { state: "unverified", reason: membership.failure.reason };
  }
  const rows = await processTable();
  for (const identity of [
    membership.value.owner,
    ...membership.value.children,
  ]) {
    const alive = judge(identity, rows);
    if (!alive.ok) return { state: "unverified", reason: alive.failure.reason };
    if (alive.value.state === "alive")
      return {
        state: "live",
        reason: "a registered fixture process still runs",
      };
  }
  return {
    state: "dead",
    reason: "every process in the closed fixture membership has exited",
  };
}
/** Retire only after the caller removed scratch under the same exclusive lock. */
export function retireFixtureScope(
  root: string,
  registry: string,
): Outcome<void> {
  return attempt(
    "fixture-retirement",
    "Cannot retire fixture registration",
    () => {
      rmSync(join(registry, scopeName(root)), { force: true });
      if (!readdirSync(registry).some((name) => name.startsWith("scope-")))
        rmSync(registry, { recursive: true });
    },
  );
}

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
import { processTable } from "./process-table.ts";
import { attempt, failed, ok, type Outcome } from "./outcome.ts";
import { isRecord } from "./guards.ts";
import { failureFields } from "./errors.ts";
import { log } from "./log.ts";

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
function testFixtureRegistryRoot(home = homedir()): string {
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
      createdAt: new Date().toISOString(),
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
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.root === "string" &&
    isAbsolute(value.root) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt))
    ? { root: value.root, registry, createdAt: value.createdAt }
    : null;
}
interface ScanBudget {
  deadline: number;
  count: number;
}
function within(budget: ScanBudget): boolean {
  return ++budget.count <= MAX_RECORDS && Date.now() <= budget.deadline;
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
      const budget = { deadline: Date.now() + 5000, count: 0 };
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
      if (seen.has(ancestor) || Date.now() > deadline) return false;
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
  const budget = { deadline: Date.now() + 5000, count: 0 };
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

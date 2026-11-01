/**
 * Admission by account: which subscription account a launch bills, within
 * each account's cap.
 *
 * An account's slots held are its launch records that hold their stage
 * (pending, alive, unknown), a takeover and the record it replaces counted
 * as one while both hold. A re-arm is admitted on an account with a free
 * slot and no wall in effect, the accounts taken in turn starting after the
 * account of the most recent launch record, so the turn survives between
 * ticks without state of its own. A takeover is admitted into the slot of
 * the record it replaces, on that record's account, while that account has
 * no wall. With no account free the action waits, and the reason names
 * every account's slots.
 *
 * Before a launch the tick resolves, with the drive's own resolver, the
 * identity the wrapper's environment yields for the admitted account
 * (`passEnvironment`), and compares it with the account's `identity`; a
 * mismatch, or an identity that does not resolve, starts nothing.
 */
import { resolve } from "node:path";
import { isMapping } from "../../shared/config-layers.ts";
import { run } from "../../shared/proc.ts";
import { holds, type ReadRecord, unrecordedWalls } from "./launches.ts";
import type { MachineAccount } from "./machine-config.ts";
import { accountWall, type Wall } from "./walls.ts";

/** The credential variables the drive's resolver reads before a configuration directory. */
const CREDENTIAL_VARIABLES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

type Env = Record<string, string | undefined>;

/**
 * The environment a pass billed to `account` runs in: `base` with the
 * credential variables removed and the account's configuration directory
 * set, so the drive's resolver and quota adapters read that account.
 */
export function passEnvironment(
  base: Env,
  account: { vendor: "claude" | "codex"; configDir: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined) env[key] = value;
  for (const name of CREDENTIAL_VARIABLES) delete env[name];
  if (account.vendor === "claude") env.CLAUDE_CONFIG_DIR = account.configDir;
  else env.CODEX_HOME = account.configDir;
  return env;
}

/** One account's slots as a tick sees them. */
export interface Slots {
  account: MachineAccount;
  held: number;
  wall: Wall | null;
  /** A launch ended on this account's wall and the wall was never recorded: no launch is admitted until a person clears that record. */
  wallUnrecorded: boolean;
}

/**
 * The listed account a record bills. An account is its vendor and
 * configuration directory; its name is a label a person may change. So the
 * account at the record's vendor and directory is the one, whatever it is
 * called now, and the name decides only when no listed account has them.
 */
function accountOf(
  accounts: MachineAccount[],
  record: { account: string; vendor: string; configDir: string },
): string | null {
  const same = accounts.filter(
    (a) => a.vendor === record.vendor && a.configDir === record.configDir,
  );
  if (same.length === 1) return (same[0] as MachineAccount).name;
  if (same.length > 1) return null;
  return accounts.find((a) => a.name === record.account)?.name ?? null;
}

/** The slots of the account a record bills; `undefined` when the machine file lists none. */
export function slotsOf(
  table: Slots[],
  record: { account: string; vendor: string; configDir: string },
): Slots | undefined {
  const name = accountOf(
    table.map((s) => s.account),
    record,
  );
  return table.find((s) => s.account.name === name);
}

/** The slots a set of records holds, per listed account name. */
function heldByAccount(
  accounts: MachineAccount[],
  records: ReadRecord[],
): Map<string, number> {
  const holding = records.filter((r) => holds(r.state));
  const ids = new Set(holding.map((r) => r.record.id));
  const held = new Map<string, number>();
  for (const { record } of holding) {
    // A takeover shares the slot of the record it replaces while both hold.
    if (record.replaces !== null && ids.has(record.replaces)) continue;
    const name = accountOf(accounts, record);
    if (name === null) continue;
    held.set(name, (held.get(name) ?? 0) + 1);
  }
  return held;
}

/** The accounts whose launches ended on a wall that was never recorded. */
function unrecordedAccounts(
  accounts: MachineAccount[],
  records: ReadRecord[],
  root?: string,
): Set<string | null> {
  const ended = new Set(
    unrecordedWalls(
      records.map((r) => r.record.id),
      root,
    ),
  );
  return new Set(
    records
      .filter(
        (r) =>
          ended.has(r.record.id) ||
          (r.state.kind === "unknown" && r.state.wallUnrecorded === true),
      )
      .map((r) => accountOf(accounts, r.record)),
  );
}

export function slotTable(
  accounts: MachineAccount[],
  records: ReadRecord[],
  nowMs: number,
  root?: string,
): Slots[] {
  const held = heldByAccount(accounts, records);
  const unrecorded = unrecordedAccounts(accounts, records, root);
  return accounts.map((account) => ({
    account,
    held: held.get(account.name) ?? 0,
    wall: accountWall(account, nowMs, root),
    wallUnrecorded: unrecorded.has(account.name),
  }));
}

/**
 * Read every account's wall again, and the exits that ended on a wall that
 * was not recorded, as a wrapper may have written either since the table was
 * built. A closure once seen stays.
 */
export function refreshWalls(
  table: Slots[],
  records: ReadRecord[],
  nowMs: number,
  root?: string,
): void {
  const unrecorded = unrecordedAccounts(
    table.map((s) => s.account),
    records,
    root,
  );
  for (const slots of table) {
    slots.wall = accountWall(slots.account, nowMs, root);
    if (unrecorded.has(slots.account.name)) slots.wallUnrecorded = true;
  }
}

/** Every account's slots, in one line for a report. */
function describeSlots(table: Slots[]): string {
  if (table.length === 0) return "the machine file lists no accounts";
  return table
    .map(
      (s) =>
        `${s.account.name} ${s.held}/${s.account.maxPerAccount}${s.wall === null ? "" : ` (walled until ${s.wall.resetAt})`}${s.wallUnrecorded ? " (wall not recorded)" : ""}`,
    )
    .join(", ");
}

/** Why an account cannot take `what` (a headless drive pass, a pickup's session) now; `null` when it can. */
function closed(slots: Slots, what: string): string | null {
  if (slots.account.vendor !== "claude")
    return `no ${what} is documented for its vendor`;
  if (slots.wallUnrecorded)
    return "its wall was not recorded; it stays closed until that launch record is cleared";
  if (slots.wall !== null) return `walled until ${slots.wall.resetAt}`;
  return slots.held >= slots.account.maxPerAccount ? "full" : null;
}

export type Admission = { admitted: Slots } | { waits: string };

/** The account a re-arm (or a pickup, naming `what`) runs on, taken in turn after `last`. */
export function admitRearm(
  table: Slots[],
  last: string | null,
  excluded: ReadonlySet<string> = new Set(),
  what = "a headless drive pass",
): Admission {
  const start = table.findIndex((s) => s.account.name === last) + 1;
  for (let i = 0; i < table.length; i++) {
    const slots = table[(start + i) % table.length] as Slots;
    if (!excluded.has(slots.account.name) && closed(slots, what) === null)
      return { admitted: slots };
  }
  return { waits: `no account has a free slot: ${describeSlots(table)}` };
}

/** The slot a takeover runs in: the replaced record's, on its account. */
export function admitTakeover(table: Slots[], replaced: ReadRecord): Admission {
  const slots = slotsOf(table, replaced.record);
  if (slots === undefined)
    return {
      waits: `the record it replaces bills ${replaced.record.account}, which the machine file no longer lists`,
    };
  if (slots.account.vendor !== "claude" || replaced.record.vendor !== "claude")
    return {
      waits: `${slots.account.name}: no headless drive pass is documented for its vendor`,
    };
  if (slots.wallUnrecorded)
    return {
      waits: `${slots.account.name}, whose slot it takes, ended on a wall that was not recorded`,
    };
  if (slots.wall !== null)
    return {
      waits: `${slots.account.name}, whose slot it takes, is walled until ${slots.wall.resetAt}`,
    };
  // A record that no longer holds its slot gave it back: the takeover needs a free one.
  if (!holds(replaced.state) && slots.held >= slots.account.maxPerAccount)
    return { waits: `no free slot on ${describeSlots([slots])}` };
  return { admitted: slots };
}

/** The account of the most recent launch record, where the turn resumes. */
export function lastAccount(records: ReadRecord[]): string | null {
  let latest: ReadRecord | null = null;
  for (const r of records)
    if (latest === null || r.record.createdAt >= latest.record.createdAt)
      latest = r;
  return latest?.record.account ?? null;
}

const RUN_TS = resolve(import.meta.dir, "../run.ts");
const BUNFIG = resolve(import.meta.dir, "../bunfig.toml");

export type IdentityCheck = { ok: true } | { ok: false; reason: string };

/**
 * Resolve, with the drive's own resolver, the identity a pass billed to
 * `account` would run under, and compare it with the account's `identity`.
 * The resolver runs in a child given the wrapper's environment, so what it
 * reads is what the pass reads.
 */
export async function checkIdentity(
  account: MachineAccount,
  timeoutSec: number,
): Promise<IdentityCheck> {
  const done = await run(
    [
      process.execPath,
      "--no-env-file",
      `--config=${BUNFIG}`,
      RUN_TS,
      "identity",
      account.vendor,
    ],
    { timeoutSec, env: passEnvironment(process.env, account) },
  );
  if (done.code !== 0)
    return {
      ok: false,
      reason: `the identity resolver failed (exit ${done.code}): ${done.stderr.trim().slice(0, 200)}`,
    };
  let found: unknown;
  try {
    found = JSON.parse(done.stdout);
  } catch {
    found = null;
  }
  if (!isMapping(found))
    return { ok: false, reason: "the identity resolver printed no answer" };
  if (typeof found.account !== "string")
    return {
      ok: false,
      reason: `${account.configDir} resolves to no identity (${String(found.reason ?? "no reason given")})`,
    };
  return found.account.toLowerCase() === account.identity.toLowerCase()
    ? { ok: true }
    : {
        ok: false,
        reason: `${account.configDir} resolves to ${found.account}, not ${account.identity}`,
      };
}

/**
 * The live drivers on this host that no launch record holding its stage
 * accounts for, and the account each bills: a drive a pickup armed after
 * its record ended, or one a person or a repair session started or took
 * over by hand. Each holds a slot of its account, as a launch does, so the
 * per-account cap admission keeps counts every driver running on the host.
 *
 * A holding record accounts for a driver that works the record's workspace
 * (a re-arm's or takeover's drive, a pickup's drive while the pickup still
 * runs: the pickup's slot is the drive's), whichever account each bills, or,
 * for a drive's record, one of the same pull request on the same account. Once the pickup's record stops
 * holding, its drive keeps the slot rather than freeing it.
 *
 * The account is the listed one of the driver's vendor whose identity is
 * the one its claim says its passes bill; failing that, the account of the
 * ended pickup or drive launch that started it: the newest of its tree from
 * before the driver took its lock. A driver no listed account answers is
 * listed and holds no slot.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  type HostDriver,
  liveHostDrivers,
} from "../../skills/drive-pr/scripts/lib/driver/host-drivers.ts";
import { peekCloneKey } from "../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { gitIdentityEnv } from "../../shared/git-env.ts";
import { attempt, type Outcome } from "../../shared/outcome.ts";
import { accountOf } from "./account-of.ts";
import { parseMs } from "../../shared/time.ts";
import { holds, isDrive, type ReadRecord } from "./launches.ts";
import type { MachineAccount } from "./machine-config.ts";

export type { HostDriver };

/** The host's live drivers, or why they could not be read. */
export type HostDrivers = Outcome<readonly HostDriver[], "unreadable">;

/** How a driver no holding record accounts for was started. */
export type DriverStart = "pickup" | "dispatcher" | "unrecorded";

/** A driver no holding record accounts for, with the account it bills. */
export interface UnrecordedDriver {
  driver: HostDriver;
  /** The listed account whose slot it holds; `null` when none is known. */
  account: string | null;
  /** Why the account is `null`; `null` otherwise. */
  accountReason: string | null;
  /** `pickup` or `dispatcher`: an ended launch record of this host started it; `unrecorded`: none did (a person or a repair session). */
  startedBy: DriverStart;
  /** The ended record that started it; `null` when unrecorded. */
  record: string | null;
}

/** Read the host's live drivers (`root` is the drive's state root, for a check). */
export function readHostDrivers(root?: string): HostDrivers {
  return liveHostDrivers(root);
}

/** The drivers of a reading, none when it failed. */
export function driversOf(
  drivers: HostDrivers | undefined,
): readonly HostDriver[] {
  return drivers?.ok === true ? drivers.value : [];
}

/** A path as the file system resolves it, so one tree reached by two spellings compares equal. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The clone key of the checkout at `repoPath`, read from its Git common
 * directory (`.git` is a file in a linked worktree); `null` when either read fails.
 */
export function readCloneKey(repoPath: string): string | null {
  const common = spawnSync(
    "git",
    ["-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 10_000, env: gitIdentityEnv() },
  );
  if (common.status !== 0 || typeof common.stdout !== "string") return null;
  const key = attempt("unreadable", "the clone identity", () =>
    peekCloneKey(common.stdout.trim()),
  );
  return key.ok ? key.value : null;
}

/** The listed account a driver's identity names, or why none. */
function identityAccount(
  accounts: readonly MachineAccount[],
  driver: HostDriver,
): { name: string } | { why: string; unresolved: boolean } {
  if (driver.identity === null || driver.vendor === null)
    return {
      why: "its claim names no resolved account identity",
      unresolved: true,
    };
  const identity = driver.identity.toLowerCase();
  const same = accounts.filter(
    (a) => a.vendor === driver.vendor && a.identity.toLowerCase() === identity,
  );
  if (same.length === 1) return { name: (same[0] as MachineAccount).name };
  return {
    unresolved: false,
    why:
      same.length === 0
        ? `no listed ${driver.vendor} account has its identity ${driver.identity}`
        : `several listed accounts have its identity ${driver.identity}: ${same.map((a) => a.name).join(", ")}`,
  };
}

/**
 * The drivers no record holding its stage accounts for, each with the
 * account whose slot it holds and how it was started.
 */
export function unrecordedDrivers(
  accounts: readonly MachineAccount[],
  records: readonly ReadRecord[],
  drivers: readonly HostDriver[],
): UnrecordedDriver[] {
  const seen = new Map<string, string>();
  const real = (path: string): string => {
    const known = seen.get(path);
    if (known !== undefined) return known;
    const found = canonical(path);
    seen.set(path, found);
    return found;
  };
  const byTree = (path: string | null | undefined, tree: string | null) =>
    path != null && tree !== null && real(path) === real(tree);
  /** The clone key of a record's checkout; `null` when it cannot be read. */
  const cloneOf = new Map<string, string | null>();
  const cloneKeyOf = (repoPath: string): string | null => {
    if (!cloneOf.has(repoPath)) cloneOf.set(repoPath, readCloneKey(repoPath));
    return cloneOf.get(repoPath) ?? null;
  };
  // A record's slot covers one driver; two drivers never share it.
  const used = new Set<string>();
  return drivers.flatMap((driver) => {
    const named = identityAccount(accounts, driver);
    const cover = records.find(
      ({ record, state }) =>
        holds(state) &&
        !used.has(record.id) &&
        // The tree's own record covers a driver billing the account it charges.
        ((byTree(record.workspace?.path, driver.worktree) &&
          ("name" in named
            ? accountOf(accounts, record) === named.name
            : named.unresolved)) ||
          // A drive's record of the same pull request, account and clone.
          (isDrive(record) &&
            record.pr === driver.pr &&
            "name" in named &&
            accountOf(accounts, record) === named.name &&
            cloneKeyOf(record.repoPath) === driver.clone)),
    );
    if (cover !== undefined) {
      used.add(cover.record.id);
      return [];
    }
    // The newest pickup or drive launch of its tree from before it took its lock started it.
    const since = parseMs(driver.since);
    const starter = records
      .filter(
        ({ record }) =>
          (record.action === "pickup" || isDrive(record)) &&
          !(parseMs(record.createdAt) > since) &&
          byTree(record.workspace?.path, driver.worktree),
      )
      .reduce<ReadRecord | null>(
        (latest, r) =>
          latest === null || r.record.createdAt >= latest.record.createdAt
            ? r
            : latest,
        null,
      );
    const fallback =
      starter === null || ("why" in named && !named.unresolved)
        ? null
        : accountOf(accounts, starter.record);
    const account = "name" in named ? named.name : fallback;
    return [
      {
        driver,
        account,
        accountReason: "why" in named && account === null ? named.why : null,
        startedBy:
          starter === null
            ? "unrecorded"
            : starter.record.action === "pickup"
              ? "pickup"
              : "dispatcher",
        record: starter?.record.id ?? null,
      },
    ];
  });
}

/**
 * The fleet-health warning a drive's round brief carries for ONE pull request
 *: read from the snapshot the dev-dashboard
 * collector already published, next to the existing `reflectDue` advisory.
 *
 * Read, not recomputed. A drive reports its status every few minutes, and a
 * sampling run costs tens of GraphQL points per PR against a budget every agent
 * on the token shares — so the round brief consumes the collector's slow-cadence
 * result instead of paying for a second one. The consequence is stated rather
 * than hidden: a PR-level warning is as old as the snapshot behind it, which a
 * failed collection does not refresh, so the brief says how old and marks it
 * STALE past its TTL.
 *
 * ADVISORY and best-effort, exactly like `reflectDue`: it never reaches
 * `report.state` or an exit code, an absent or unreadable snapshot is "no
 * warning" (a machine that does not run the dashboard is the ordinary case,
 * not an error), and it only ever speaks about PR-scoped signals. An
 * epic's ratio is for whoever holds the epic, not for a pass working one PR —
 * nothing here pages an agent that lacks the epic's context.
 *
 * The dashboard that publishes the snapshot is the consumer's; this reads the
 * plain JSON file it writes, defensively, from the directory the consumer
 * names (`fleet_health.snapshot_dir`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  consumerRoot,
  overlayPath,
  readOverlay,
} from "../../../resolve-review-comments/scripts/lib/consumer.ts";
import {
  LIFECYCLE_ACTIVITY,
  prWarnings,
  SEVERITY_RANK,
  SIGNAL_KINDS,
  type Signal,
} from "./fleet-health.ts";

export const PANEL = "fleet-health";

/** Mirrors the dashboard's `CLOCK_SKEW_TOLERANCE_SEC`; a skill ships standalone, so it cannot import it. */
export const CLOCK_SKEW_TOLERANCE_SEC = 60;

export interface FleetHealthAdvisory {
  /** One line per raised PR-scoped signal, e.g. `review-carousel: 26 bot-reviewed heads, …`. */
  warnings: string[];
  /** Seconds since the collector produced the data behind them, `null` when there is none. */
  snapshotAgeSec: number | null;
  /** The snapshot is older than its own `ttlSec`, or the last collection failed. */
  stale: boolean;
  /** The run that produced the snapshot reported gaps (missing samples or sources), so absent warnings prove less. */
  partial: boolean;
}

export const NO_ADVISORY: FleetHealthAdvisory = {
  warnings: [],
  snapshotAgeSec: null,
  stale: false,
  partial: false,
};

/** Where the snapshot is read from when the consumer names no directory. */
export const DEFAULT_SNAPSHOT_SUBDIR = [".local", "state", "jig", "dashboard"];

/** `~` and `~/…` expanded against `home`; a relative path is the consumer root's. */
export function expandDir(raw: string, home: string = homedir()): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : join(consumerRoot(), raw);
}

/** `fleet_health.snapshot_dir` from the consumer overlay, or `null` (no overlay, or unset). */
export function configuredSnapshotDir(): string | null {
  if (!existsSync(overlayPath())) return null;
  const section = readOverlay().fleet_health;
  if (!isRecord(section)) return null;
  const dir = section.snapshot_dir;
  return typeof dir === "string" && dir.trim() !== "" ? dir.trim() : null;
}

/**
 * The snapshot directory: `$DEV_DASHBOARD_DIR` (trimmed), else the
 * consumer's `fleet_health.snapshot_dir` (`~` expanded), else
 * `~/.local/state/jig/dashboard`. An unreadable overlay falls back to
 * the default: the advisory is best-effort.
 */
export function dashboardDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.DEV_DASHBOARD_DIR?.trim();
  if (fromEnv) return fromEnv;
  let configured: string | null = null;
  try {
    configured = configuredSnapshotDir();
  } catch {
    configured = null;
  }
  return configured === null
    ? join(home, ...DEFAULT_SNAPSHOT_SUBDIR)
    : expandDir(configured, home);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The advisory for `pr`, from the published `fleet-health.json` in `dir`.
 * `nowMs` is a parameter so a test pins the instant.
 */
export function readFleetHealthAdvisory(
  pr: number,
  nowMs: number,
  dir: string = dashboardDir(),
): FleetHealthAdvisory {
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${PANEL}.json`), "utf8");
  } catch {
    return NO_ADVISORY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NO_ADVISORY;
  }
  // The dashboard's own `readSnapshot` envelope contract, restated (this file
  // cannot import it): an off-contract file is rejected by the tile, so it is
  // not advice here either, whatever its signals say.
  if (
    !isRecord(parsed) ||
    parsed.panel !== PANEL ||
    typeof parsed.source !== "string" ||
    typeof parsed.ttlSec !== "number" ||
    !Number.isFinite(parsed.ttlSec) ||
    parsed.ttlSec <= 0 ||
    (parsed.error !== null && typeof parsed.error !== "string") ||
    typeof parsed.everSucceeded !== "boolean" ||
    (!parsed.everSucceeded && (parsed.error === null || parsed.data !== null))
  ) {
    return NO_ADVISORY;
  }
  if (!isRecord(parsed.data) || !Array.isArray(parsed.data.signals)) {
    return NO_ADVISORY;
  }
  // Canonical UTC only: bare `Date.parse` also accepts date-only and
  // timezone-less strings, whose instant depends on the reading host.
  const generatedMs =
    typeof parsed.generatedAt === "string"
      ? Date.parse(parsed.generatedAt)
      : Number.NaN;
  if (
    !Number.isFinite(generatedMs) ||
    new Date(generatedMs).toISOString() !== parsed.generatedAt
  ) {
    return NO_ADVISORY;
  }
  // Unrounded, like the tile's own comparison: rounding first would let a
  // snapshot a fraction of a second past its TTL (or skew tolerance) read fresh.
  const rawAgeSec = (nowMs - generatedMs) / 1000;
  const ageSec = Math.max(0, rawAgeSec);
  const ttl: number = parsed.ttlSec;
  const signals = (parsed.data.signals as unknown[]).filter(
    (
      s,
    ): s is Pick<Signal, "kind" | "scope" | "severity" | "headline"> & {
      state: string | null;
    } =>
      isRecord(s) &&
      typeof s.kind === "string" &&
      isRecord(s.scope) &&
      typeof s.headline === "string" &&
      // The vocabularies the collector can publish: `prWarnings` emits any
      // non-null severity and suppresses only `cooling-down`, so an unknown
      // value would otherwise reach a pass as a warning the tile never shows.
      (SIGNAL_KINDS as readonly string[]).includes(s.kind) &&
      typeof s.severity === "string" &&
      Object.hasOwn(SEVERITY_RANK, s.severity) &&
      // The collector always writes `state` (`null` for a signal with no epic
      // lifecycle), so a MISSING key is off-contract: its lifecycle is
      // unreadable and it may be cooling down.
      (s.state === null ||
        (typeof s.state === "string" &&
          Object.hasOwn(LIFECYCLE_ACTIVITY, s.state))),
  );
  return {
    warnings: prWarnings(signals, pr),
    snapshotAgeSec: Math.round(ageSec),
    // A snapshot dated further ahead than the tolerance is clock skew, which
    // the tile reads as stale; clamping the age alone would make it look fresh.
    stale:
      parsed.error !== null ||
      rawAgeSec < -CLOCK_SKEW_TOLERANCE_SEC ||
      ageSec > ttl,
    // The tile labels a run with gaps "partial"; an unreadable `gaps` is
    // treated the same way rather than as a clean run.
    partial: !Array.isArray(parsed.data.gaps) || parsed.data.gaps.length > 0,
  };
}

/** The line a human reading the drive's stderr sees, or `null` when there is nothing to say. */
export function fleetHealthLine(
  pr: number,
  a: FleetHealthAdvisory,
): string | null {
  // A readable snapshot that is STALE or PARTIAL is worth a line even with no
  // warning: a quiet report proves less then. No snapshot at all (the ordinary
  // off-dashboard-host case) stays silent.
  if (a.warnings.length === 0) {
    if (a.snapshotAgeSec === null || (!a.stale && !a.partial)) return null;
    return `fleet-health: no warning for PR #${pr}, but the snapshot is ${a.stale ? "STALE" : ""}${a.stale && a.partial ? " and " : ""}${a.partial ? "PARTIAL (the run had gaps, or its gap list is unreadable)" : ""}, so silence proves less.`;
  }
  const age =
    a.snapshotAgeSec === null
      ? ""
      : ` (fleet-health snapshot ${Math.round(a.snapshotAgeSec / 60)}m old${a.stale ? ", STALE" : ""}${a.partial ? ", PARTIAL: the run had gaps or its gap list is unreadable, so absent warnings prove less" : ""})`;
  return `fleet-health: PR #${pr} — ${a.warnings.join(" | ")}${age}. A suspicion, not a finding.`;
}

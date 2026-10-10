/**
 * The quota registry and the sleep/stop decision built on it.
 *
 * `drive.ts` asks these questions on a failed pass — "was that a quota wall?"
 * and "may I sleep through it?" — and this module answers them, so the driver
 * holds no vendor knowledge and no policy arithmetic.
 *
 * THE DECISION IS ASYMMETRIC ON PURPOSE. Sleeping when we should have stopped
 * strands an unattended drive (and its locks, and its worktree) for days;
 * stopping when we could have slept costs a re-arm. So every uncertainty
 * resolves toward stopping: an unclassified window, an unresolved reset, a
 * reset further out than the bound, an adapter that threw. A reset already
 * in the past is the one exception, and deliberately not this asymmetry's
 * uncertainty case at all: the window is open RIGHT NOW, which is certain,
 * not ambiguous — see `planFor()`'s own `Math.max(rawMs, 0)` (round 26).
 *
 * Runs under Bun and Node >= 22.18: `node:` APIs only, erasable syntax only.
 */

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import type {
  DetectOpts,
  PreparedSpawn,
  QuotaAdapter,
  QuotaBlock,
} from "./types.ts";

export type {
  DetectOpts,
  PreparedSpawn,
  QuotaBlock,
  QuotaWindow,
  SpawnCorrelation,
} from "./types.ts";

/**
 * Every adapter runs on every detection, rather than the driver naming one.
 * The pass command is arbitrary argv — `claude -p …`, `codex exec …`, a
 * wrapper script, a shell function — so inferring the vendor from it is a
 * guess, and a wrong guess reads as "no quota wall" and re-arms straight into
 * the wall again. Probing all of them costs an mtime-filtered directory scan
 * on a path that is already handling a failure, and an absent vendor's state
 * dir simply yields nothing.
 */
const ADAPTERS: readonly QuotaAdapter[] = [claudeAdapter, codexAdapter];

/**
 * The longest a drive may sleep waiting for a window to reopen.
 *
 * Six hours is the five-hour window plus an hour of slack, and it is the
 * SECOND guard rather than the first: the window classification already
 * rejects anything weekly. This bounds the case where an adapter said `short`
 * but the resolved instant disagrees — a mis-parsed clock, a stale record, a
 * vendor that widened its window — which is exactly where a wrong answer would
 * otherwise become a long silent sleep.
 */
const MAX_SLEEP_MS_DEFAULT = 6 * 60 * 60 * 1000;

export function maxSleepMs(): number {
  const raw = process.env.DRIVE_PR_QUOTA_MAX_SLEEP_SEC;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return MAX_SLEEP_MS_DEFAULT;
  const n = Number.parseInt(raw, 10) * 1000;
  // `drive.ts` forwards a block's resolved `ms` (bounded above by exactly
  // this cap) to `sleep()`, which hands it to `setTimeout` — a 32-bit signed
  // MILLISECOND delay. An override above that limit would let a legitimately
  // far-future reset pass this cap uncapped, and the timer then overflows and
  // fires IMMEDIATELY instead of after the real wait, waking the drive mid-
  // wall instead of once it has actually reopened. Fall back to the default
  // rather than honour a cap this runtime cannot represent as a delay.
  if (!Number.isFinite(n) || n > 2_147_483_647) return MAX_SLEEP_MS_DEFAULT;
  return n > 0 ? n : 0;
}

/**
 * Which of two EQUALLY-recent blocks to keep. The adapters normalize
 * evidence to whole-second precision, so a genuine tie across vendors is
 * reachable — e.g. a Claude short-window wall and a Codex weekly wall
 * observed in the same second — and array order in `ADAPTERS` is not a
 * signal about which one actually still blocks the account. Resolved by
 * asking `planFor` itself: whichever block it would refuse to sleep through
 * wins, and between two sleepable blocks the longer wait wins (chatgpt-
 * codex-connector, PR #4431 round 8).
 */
function moreRestrictive(a: QuotaBlock, b: QuotaBlock, now: Date): QuotaBlock {
  const planA = planFor(a, now);
  const planB = planFor(b, now);
  if (planA.action !== planB.action) return planA.action === "stop" ? a : b;
  if (planA.action === "sleep" && planB.action === "sleep") {
    return planA.ms >= planB.ms ? a : b;
  }
  return a;
}

/**
 * Newest wall across every vendor, or `null` if none of them saw one.
 *
 * `truncatedByVendor` — normally `snapshotQuotaSessions()`'s own result —
 * overrides `opts.preexistingSessionsTruncated` PER ADAPTER, so each one
 * judges its own snapshot's reliability rather than every adapter sharing
 * whichever vendor happened to truncate. Omit it (as every direct
 * `adapter.detect(opts)` unit test below the driver does) to fall back to
 * the flat `opts` field for every adapter, unchanged.
 */
export function detectQuotaBlock(
  opts: DetectOpts,
  truncatedByVendor?: ReadonlyMap<string, boolean>,
): QuotaBlock | null {
  let best: QuotaBlock | null = null;
  for (const adapter of ADAPTERS) {
    const vendorOpts: DetectOpts =
      truncatedByVendor === undefined
        ? opts
        : {
            ...opts,
            preexistingSessionsTruncated:
              truncatedByVendor.get(adapter.vendor) ??
              opts.preexistingSessionsTruncated,
          };
    let found: QuotaBlock | null;
    try {
      found = adapter.detect(vendorOpts);
    } catch {
      // The contract says adapters do not throw; this is the belt to that
      // brace. A broken adapter must not convert a diagnosable pass failure
      // into an unhandled rejection inside the driver's error path.
      continue;
    }
    if (found === null) continue;
    if (best === null) {
      best = found;
      continue;
    }
    const foundAt = found.observedAt.getTime();
    const bestAt = best.observedAt.getTime();
    if (foundAt > bestAt) {
      best = found;
    } else if (foundAt === bestAt) {
      best = moreRestrictive(found, best, opts.now);
    }
  }
  return best;
}

/** `snapshotQuotaSessions()`'s result: see that function's own doc comment. */
export interface QuotaSnapshot {
  files: ReadonlySet<string>;
  /**
   * Per vendor (keyed by `QuotaAdapter.vendor`): true when THAT vendor's own
   * walk was cut short by a circuit breaker before it finished enumerating
   * its state tree, or its adapter threw before returning a scan at all — a
   * thrown scan contributed nothing verifiable, which is the unreliable case
   * this flag exists to signal, not a complete empty one. `detectQuotaBlock`
   * reads each adapter's own entry rather than a blanket OR: an aggregate
   * flag let one vendor's truncated walk degrade a DIFFERENT, fully-completed
   * vendor's detection too (docomply-review, a reference-implementation pull request round 3).
   */
  truncatedByVendor: ReadonlyMap<string, boolean>;
}

/**
 * Every session file that exists right now, across every vendor — the
 * "before" half of the before/after pair that binds evidence to the pass this
 * driver spawned rather than to any session that happens to share its
 * worktree. Call it IMMEDIATELY before the spawn and hand `files` to
 * `detectQuotaBlock` as `preexistingSessions`, and `truncatedByVendor` as
 * that same call's second argument.
 *
 * The window between this call and the spawn is the residual: a session
 * created inside it is neither in the snapshot nor this pass. Making that
 * window small is the whole mitigation, which is why this is the last thing
 * before `run()` rather than something computed at the top of the round.
 *
 * `files` is one union across vendors rather than a map keyed by vendor: the
 * adapters scan disjoint state trees, so a path can only have come from one
 * of them, and membership is the only question any caller asks of it.
 * `truncatedByVendor`, by contrast, IS kept per-vendor — see its own doc
 * comment on `QuotaSnapshot` for why a blanket OR is wrong here: a caller
 * degrading every vendor's detection because ONE of them truncated discards
 * a fully-reliable snapshot from the other for no reason the other vendor's
 * own walk gives it.
 *
 * Never throws — an adapter whose vendor is not installed contributes
 * nothing, and this runs on the path to spawning a pass, where a stack from
 * the quota module would abort a round that had nothing wrong with it.
 */
export function snapshotQuotaSessions(): QuotaSnapshot {
  const files = new Set<string>();
  const truncatedByVendor = new Map<string, boolean>();
  for (const adapter of ADAPTERS) {
    try {
      const scan = adapter.snapshotSessions();
      for (const path of scan.files) files.add(path);
      truncatedByVendor.set(adapter.vendor, scan.truncated);
    } catch {
      // Same belt-and-braces as `detectQuotaBlock`'s own catch: a broken
      // adapter degrades correlation for its own vendor, and must not stop
      // the pass from being spawned at all. But a thrown scan contributed
      // NOTHING verifiable — that is the unreliable case this map exists to
      // signal, not a clean empty one, so this vendor's candidates must
      // degrade exactly as they would after a cut-short walk rather than
      // being trusted as "nothing here" (docomply-review, a reference-implementation pull request round 3).
      truncatedByVendor.set(adapter.vendor, true);
    }
  }
  return { files, truncatedByVendor };
}

/**
 * Let the adapters amend an about-to-be-spawned pass so its evidence can be
 * identified exactly, and report what identity it now carries.
 *
 * FIRST claim wins and the rest are not consulted: one pass command is one
 * vendor's CLI, so a second adapter recognising the same argv would mean one
 * of them is wrong, and letting both amend it would produce a command neither
 * one described.
 *
 * Returns `null` when no adapter recognises the command — the ordinary case
 * for a wrapper script, and not a failure. The caller spawns what it already
 * had and detection falls back to `preexistingSessions`.
 *
 * Set `DRIVE_PR_QUOTA_NO_SPAWN_PREP=1` to turn this off wholesale. The escape
 * hatch exists because amending is the one thing here that can break a pass
 * that would otherwise have run: an older CLI that does not know the flag an
 * adapter injects fails instantly with a usage error. Leaving an operator no
 * way to opt out of that would make a detection improvement able to stop a
 * drive outright.
 */
export function prepareQuotaSpawn(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): PreparedSpawn | null {
  if (process.env.DRIVE_PR_QUOTA_NO_SPAWN_PREP === "1") return null;
  for (const adapter of ADAPTERS) {
    if (adapter.prepareSpawn === undefined) continue;
    let prepared: PreparedSpawn | null;
    try {
      prepared = adapter.prepareSpawn(argv, env);
    } catch {
      continue;
    }
    if (prepared !== null) return prepared;
  }
  return null;
}

export type QuotaPlan =
  | { action: "sleep"; until: Date; ms: number; block: QuotaBlock }
  | { action: "stop"; why: string; block: QuotaBlock };

/**
 * Turn a block into the driver's move. `now` is injected rather than read so
 * the tests pin the arithmetic instead of racing it.
 */
export function planFor(block: QuotaBlock, now: Date): QuotaPlan {
  if (block.window !== "short") {
    return {
      action: "stop",
      why:
        block.window === "weekly"
          ? "a weekly window does not reopen within any sleep an unattended drive should take"
          : "the window could not be classified, and an unclassified window is treated as weekly",
      block,
    };
  }
  if (block.resetAt === null) {
    return {
      action: "stop",
      why: "the reset time could not be resolved, so there is nothing to sleep until",
      block,
    };
  }
  const rawMs = block.resetAt.getTime() - now.getTime();
  // A reset that has already passed — the window reopened between the pass
  // dying and this check, OR `nextWallClock()`'s own minute-granularity "at
  // or after" comparison (round 22) resolved to the CURRENT minute, whose
  // second-0 instant can sit a few seconds behind `now` — is treated as
  // `sleep(0)`, not `stop`: the window is open RIGHT NOW, and there is
  // nothing to wait for. Requiring an operator to re-arm the drive by hand
  // for a wall that has already cleared defeats the whole point of sleeping
  // through a short window unattended (docomply-review, a reference-implementation pull request round 26).
  const ms = Math.max(rawMs, 0);
  const cap = maxSleepMs();
  if (ms > cap) {
    return {
      action: "stop",
      why: `the reset is ${Math.round(ms / 60000)} minutes out, beyond the ${Math.round(cap / 60000)}-minute sleep bound`,
      block,
    };
  }
  return { action: "sleep", until: block.resetAt, ms, block };
}

/** One-line, log-shaped rendering of a block — the same text in every surface. */
export function describe(block: QuotaBlock): string {
  const reset =
    block.resetAt === null ? "unresolved" : block.resetAt.toISOString();
  return `${block.vendor} ${block.window}-window quota wall (resets ${reset}): ${block.evidence}`;
}

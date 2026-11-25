/** The faults of a tick's notification channels (names that break the port's rule, channels that cannot be reached), the receipt of a channel's start, and which causes last. */
import {
  channelNameFault,
  type NotificationChannel,
} from "../../../chat/channel.ts";
import type { RepoReport } from "../types.ts";
import type { ApplyState } from "./launch.ts";
import type { Cause } from "./notify.ts";

/**
 * Report each named channel that cannot be reached (its address unset or
 * refused) as the host's fault, once a tick, whether or not anything is due
 * on it: otherwise a channel that is never configured would wait silently.
 * A reachability check that throws is reported where the causes are decided.
 */
export function reportUnreachable(
  state: ApplyState,
  channels: ReadonlyArray<NotificationChannel<Cause>>,
  report: RepoReport,
): void {
  state.channelFaults ??= new Set();
  const reported = state.channelFaults;
  for (const channel of channels) {
    if (reported.has(channel.name)) continue;
    let why: string | null;
    try {
      why = channel.unreachable();
    } catch {
      continue;
    }
    if (why === null) continue;
    reported.add(channel.name);
    report.unplaced.push({
      target: `the ${channel.name} notification channel`,
      record: "runtime",
      channelFault: true,
      reason: `${why}, so every notification on it waits; this host's machine file or the tick's environment must be corrected`,
    });
  }
}

/** The channels whose names hold to the port's rule (`channelNameFault`); another is reported, and nothing goes through it. */
export function namedChannels(
  channels: ReadonlyArray<NotificationChannel<Cause>>,
  report: RepoReport,
): Array<NotificationChannel<Cause>> {
  const kept: Array<NotificationChannel<Cause>> = [];
  for (const channel of channels) {
    const fault = channelNameFault(
      channel.name,
      kept.map((c) => c.name),
    );
    if (fault === null) kept.push(channel);
    else
      report.unplaced.push({
        target: "a notification channel",
        record: "runtime",
        channelFault: true,
        reason: `${fault}, so nothing was sent through it`,
      });
  }
  return kept;
}

/** Tell the tick's receipt, once its marker is durable, that `channel` started from `causes` standing causes, once however many repositories start it. */
export function tellChannelStart(
  state: ApplyState,
  report: RepoReport,
  channel: string,
  causes: number,
): void {
  state.channelStarts ??= new Map();
  let start = state.channelStarts.get(channel);
  if (start === undefined) {
    start = { channel, causes: 0 };
    state.channelStarts.set(channel, start);
    report.channelStarts = [...(report.channelStarts ?? []), start];
  }
  start.causes += causes;
}

/** Whether a cause's record stays, because the condition it names has no end of its own to clear it. */
export function isLasting(c: Cause): boolean {
  return (
    c.cause === "drifting" ||
    c.cause === "ready" ||
    (c.cause === "stopped-unknown" && c.evidence.noCause === true) ||
    typeof c.evidence.failedRearm === "string" ||
    typeof c.evidence.reviewerFailureHead === "string" ||
    typeof c.evidence.usageRefusal === "string"
  );
}

/** Whether the tick read this repository's causes whole: a target it could not observe may hold a standing cause it never saw, so a start waits for a tick that sees it. */
export function readWholeRepo(report: RepoReport): boolean {
  return (
    report.records.every((r) => r.ok) &&
    // Only a notification channel's own fault says nothing about this repository's causes; any other unplaced target may hold one.
    report.unplaced.every((u) => u.channelFault === true) &&
    (report.withheld ?? []).length === 0 &&
    // A converged pull request whose place the board read could not tell may hold a cause not yet seen.
    (report.board?.pending ?? []).length === 0
  );
}

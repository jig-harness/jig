/** The faults of a tick's notification channels: names that break the port's rule, and channels that cannot be reached. */
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

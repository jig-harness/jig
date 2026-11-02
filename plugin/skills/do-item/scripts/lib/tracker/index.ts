/**
 * Open the consumer's issue tracker: read `issue_tracker` from the overlay and
 * hand it to the adapter it names (`linear`, `github`, `jira`). Callers import from here and use the
 * `Tracker` port; they never import an adapter.
 *
 * To add a tracker: implement `Tracker` in a sibling module and register a
 * factory in `ADAPTERS`. No caller changes.
 */

import { consumerRoot } from "../../../../../shared/consumer.ts";
import {
  ownTrackerConfig,
  requireTeamKey,
  type TrackerConfig,
} from "./config.ts";
import { gitHubClient } from "./github/client.ts";
import { gitHubModel } from "./github/model.ts";
import { homeRepo, remoteUrl } from "./github/refs.ts";
import { gitHubTracker } from "./github/tracker.ts";
import { defaultTransport as gitHubTransport } from "./github/transport.ts";
import { jiraClient } from "./jira/client.ts";
import { jiraModel } from "./jira/model.ts";
import { requireSite } from "./jira/settings.ts";
import { jiraTracker } from "./jira/tracker.ts";
import { defaultTransport as jiraTransport } from "./jira/transport.ts";
import { defaultTransport, linearTracker } from "./linear.ts";
import type { Tracker } from "./port.ts";

export type { CanonicalState, Tracker } from "./port.ts";
export { CANONICAL_STATES } from "./port.ts";

/**
 * Builds an adapter for the repository at `root`; throws naming the field
 * when a setting it needs is missing.
 */
type AdapterFactory = (config: TrackerConfig, root: string) => Tracker;

const ADAPTERS: Record<string, AdapterFactory> = {
  linear: (config) =>
    linearTracker({
      team: requireTeamKey(config),
      states: config.states,
      transport: defaultTransport(),
    }),
  github: (config, root) =>
    gitHubTracker(
      gitHubClient({
        home: homeRepo(config.github.repository, () => remoteUrl(root)),
        model: gitHubModel(config.states, config.github),
        settings: config.github,
        transport: gitHubTransport(),
      }),
    ),
  jira: (config) => {
    const project = requireTeamKey(config);
    const site = requireSite(config.jira);
    return jiraTracker(
      jiraClient({
        project,
        site,
        model: jiraModel(config.states, config.jira),
        settings: config.jira,
        transport: jiraTransport(site),
      }),
    );
  },
};

/** The adapters this version knows, by `issue_tracker.adapter` name. */
export function knownAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/**
 * The tracker the consumer configured. Throws with the field to fix when the
 * overlay is missing, names an unknown adapter, or lacks a setting the
 * adapter needs (a team for Linear and Jira, and a site for Jira; for GitHub, a repository when the
 * git remote of the repository at `root` does not name one). `root`
 * defaults to the consumer root, the repository `ownTrackerConfig()` reads
 * its configuration from, so the configuration and the repository it
 * derives always come from the same place.
 */
export function openTracker(
  config: TrackerConfig = ownTrackerConfig(),
  root: string = consumerRoot(),
): Tracker {
  const factory = Object.hasOwn(ADAPTERS, config.adapter)
    ? ADAPTERS[config.adapter]
    : undefined;
  if (factory === undefined)
    throw new Error(
      `issue_tracker.adapter '${config.adapter}' is not supported (known: ${knownAdapters().join(", ")})`,
    );
  return factory(config, root);
}

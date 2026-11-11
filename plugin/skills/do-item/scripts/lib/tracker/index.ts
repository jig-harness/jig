/**
 * Open the consumer's issue tracker: read `issue_tracker` from the overlay and
 * hand it to the adapter it names (`linear`, `github`, `jira`). Callers import from here and use the
 * `Tracker` port; they never import an adapter.
 *
 * Every tracker opened here checks each new issue inside `createIssue`
 * (`facets/complete.ts`): one without a type, a priority or a size is
 * refused before anything is written, naming what it lacks. On GitHub, a facet the configuration
 * leaves to the default gets its store from detection before its first read
 * or write (`facets/detected.ts`).
 *
 * To add a tracker: implement `Tracker` in a sibling module and register a
 * factory in `ADAPTERS`. No caller changes.
 */

import { consumerRoot } from "../../../../../shared/consumer.ts";
import {
  facetsOf,
  ownTrackerConfig,
  requireTeamKey,
  type TrackerConfig,
} from "./config.ts";
import { checkedTracker, readTaxonomy } from "./facets/complete.ts";
import type { Facets } from "./facets/config.ts";
import { detectionCacheDir, fileDetectionCache } from "./facets/detect.ts";
import { defaultedGitHub } from "./github/defaults.ts";
import { gitHubModel } from "./github/model.ts";
import { homeRepo, remoteUrl } from "./github/refs.ts";
import {
  credentialToken,
  defaultTransport as gitHubTransport,
} from "./github/transport.ts";
import { jiraClient } from "./jira/client.ts";
import { jiraModel } from "./jira/model.ts";
import { requestBase, requireSite } from "./jira/settings.ts";
import { jiraTracker } from "./jira/tracker.ts";
import { defaultTransport as jiraTransport } from "./jira/transport.ts";
import { defaultTransport, linearTracker } from "./linear.ts";
import type { Tracker } from "./port.ts";

export type { CanonicalState, Tracker } from "./port.ts";
export { CANONICAL_STATES } from "./port.ts";

/**
 * Builds an adapter for the repository at `root`, its facets resolved;
 * throws naming the field when a setting it needs is missing.
 */
type AdapterFactory = (
  config: TrackerConfig,
  root: string,
  facets: () => Facets,
) => Tracker;

/**
 * The GitHub adapter, with the GitHub default for every facet the
 * configuration does not name: the stores detection selects, its answer
 * cached on this machine for an hour.
 */
function gitHub(
  config: TrackerConfig,
  root: string,
  resolve: () => Facets,
): Tracker {
  const home = homeRepo(config.github.repository, () => remoteUrl(root));
  const model = gitHubModel(config.states, config.github);
  const transport = gitHubTransport();
  return defaultedGitHub({
    home,
    model,
    settings: config.github,
    transport,
    facets: resolve(),
    entries: config.facets,
    resolveWith: (entries) => facetsOf({ ...config, facets: entries }, root),
    cache: fileDetectionCache(detectionCacheDir()),
    token: credentialToken(),
  });
}

const ADAPTERS: Record<string, AdapterFactory> = {
  linear: (config, _root, facets) =>
    linearTracker({
      team: requireTeamKey(config),
      states: config.states,
      transport: defaultTransport(),
      facets: facets(),
    }),
  github: gitHub,
  jira: (config, _root, facets) => {
    const project = requireTeamKey(config);
    const site = requireSite(config.jira);
    return jiraTracker(
      jiraClient({
        project,
        site,
        model: jiraModel(config.states, config.jira),
        settings: config.jira,
        transport: jiraTransport(requestBase(config.jira)),
        facets: facets(),
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
 * git remote of the repository at `root` does not name one), or names a
 * facet store its label taxonomy cannot back. `root`
 * defaults to the consumer root, the repository `ownTrackerConfig()` reads
 * its configuration from, so the configuration, the repository it derives
 * and the label taxonomy the type and size values come from always come
 * from the same place.
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
  let facets: Facets | undefined;
  const resolve = () => {
    facets ??= facetsOf(config, root);
    return facets;
  };
  const tracker = factory(config, root, resolve);
  return checkedTracker(tracker, resolve(), () =>
    readTaxonomy(root, config.taxonomy),
  );
}

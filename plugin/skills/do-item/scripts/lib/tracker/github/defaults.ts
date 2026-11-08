/**
 * The GitHub adapter with GitHub's field default (design/tracker-facets.md,
 * "Defaults per adapter"): every facet the configuration does not name gets
 * the store detection selects before its first read or write
 * (facets/detected.ts); a facet the configuration names never waits on
 * detection.
 */

import type { FacetEntries, Facets } from "../facets/config.ts";
import { usable } from "../facets/config.ts";
import type { DetectionCache } from "../facets/detect.ts";
import { defaultedTracker } from "../facets/detected.ts";
import { FACETS, type Tracker } from "../port.ts";
import { gitHubClient } from "./client.ts";
import type { GitHubModel } from "./model.ts";
import type { Repo } from "./refs.ts";
import type { GitHubSettings } from "./settings.ts";
import type { GitHubTransport } from "./transport.ts";
import { gitHubTracker } from "./tracker.ts";

export interface DefaultedGitHubOptions {
  home: Repo;
  model: GitHubModel;
  settings: GitHubSettings;
  transport: GitHubTransport;
  /** The facets as the configuration names them. */
  facets: Facets;
  /** The facets with `entries` as the configuration's `issue_tracker.facets`. */
  resolveWith: (entries: FacetEntries) => Facets;
  /** The configuration's own `issue_tracker.facets`. */
  entries: FacetEntries;
  /** Names the credential the transport uses, for messages. */
  credential?: string;
  /** Where detection answers are kept, and the token that fingerprints them. */
  cache?: DetectionCache;
  token?: () => Promise<string | null>;
}

/** The facets the configuration leaves to the adapter's default. */
export function unnamedFacets(facets: Facets) {
  return FACETS.filter((f) => {
    const slot = facets[f];
    return usable(slot) && slot.why !== "configured";
  });
}

/** The GitHub tracker, its unnamed facets in the stores detection selects. */
export function defaultedGitHub(opts: DefaultedGitHubOptions): Tracker {
  const { home, model, settings, transport, facets } = opts;
  const detection = {
    ...(opts.cache === undefined ? {} : { cache: opts.cache }),
    ...(opts.token === undefined ? {} : { token: opts.token }),
  };
  const client = (selected: Facets, extra: object) =>
    gitHubClient({
      home,
      model,
      settings,
      transport,
      facets: selected,
      ...(opts.credential === undefined ? {} : { credential: opts.credential }),
      detection: { ...detection, ...extra },
    });
  const base = client(facets, {});
  const unnamed = unnamedFacets(facets);
  return defaultedTracker({
    configured: facets,
    unnamed,
    detect: (signal) => base.facets.detect(unnamed, signal),
    forget: () => base.facets.forget(),
    resolve(chosen, why) {
      const resolved = opts.resolveWith({ ...opts.entries, ...chosen });
      const out: Facets = { ...resolved };
      for (const f of FACETS) {
        const slot = resolved[f];
        const reason = why[f];
        if (reason !== undefined && usable(slot))
          Object.assign(out, { [f]: { ...slot, why: reason } });
      }
      return out;
    },
    build: (selected, detected) =>
      gitHubTracker(detected === null ? base : client(selected, { detected })),
  });
}

/**
 * The fixtures' Ready to merge: converged pull requests as the tick's board
 * read placed them, in merge now, approve first and update next.
 */
import type { LineReady } from "../plugin/dispatch/lib/dashboard-contract.ts";
import type {
  Act,
  Lane,
} from "../plugin/skills/drive-pr/scripts/lib/merge-ready.ts";
import { API, iso, prUrl, T, WEB } from "./fixture-rows.ts";

const MET = [
  { name: "converged", met: true, fact: "the ledger says converged" },
  { name: "verified head", met: true, fact: "the head is the one verified" },
  {
    name: "review witnessed",
    met: true,
    fact: "the reviewer app's check passed on the head",
  },
  { name: "mergeable", met: true, fact: "the forge says MERGEABLE" },
];

function ready(o: {
  repo: string;
  pr: number;
  title: string;
  head: string;
  lane: Lane;
  act: Act;
  says: string;
  since: number;
  requested?: string[];
  unblocks?: number[];
  unmet?: { name: string; fact: string };
}): LineReady {
  return {
    repo: o.repo,
    pr: o.pr,
    url: prUrl(o.repo, o.pr),
    title: o.title,
    head: o.head,
    place: "ready",
    lane: o.lane,
    says: o.says,
    act: o.act,
    waitingFor: null,
    command:
      o.lane === "merge-now"
        ? `gh pr merge ${o.pr} --repo ${o.repo} --match-head-commit ${o.head} --squash`
        : null,
    withheld: null,
    requested: o.requested ?? [],
    failing: [],
    failingOmitted: 0,
    conditions:
      o.unmet === undefined
        ? MET
        : [...MET, { name: o.unmet.name, met: false, fact: o.unmet.fact }],
    unblocks: o.unblocks ?? [],
    since: iso(o.since),
  };
}

/** Approve first and update next: Ready to merge holds work, merge now holds none. */
export function waitingReady(): LineReady[] {
  return [
    ready({
      repo: API,
      pr: 1201,
      title: "Document the retry budget",
      head: "4c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
      lane: "approve-first",
      act: "approve",
      says: "waits on an approval; requested from maintainer-a",
      since: T(14, 10),
      requested: ["maintainer-a"],
      unmet: {
        name: "own author or approved",
        fact: "no approving review of the head",
      },
    }),
    ready({
      repo: WEB,
      pr: 448,
      title: "Trim the session cookie",
      head: "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d",
      lane: "update-next",
      act: "update-branch",
      says: "the repository requires an up-to-date branch: updating moves its head, which costs a re-drive",
      since: T(13, 5),
      unmet: {
        name: "protection lets it merge",
        fact: "the forge says BEHIND",
      },
    }),
  ];
}

/** Merge now holds two pull requests, ahead of the lanes that wait. */
export function mergingReady(): LineReady[] {
  return [
    ready({
      repo: WEB,
      pr: 461,
      title: "Cache the price list for an hour",
      head: "3f2a91c0d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
      lane: "merge-now",
      act: "merge",
      says: "converged, witnessed and mergeable at the verified head",
      since: T(14, 45),
      unblocks: [463],
    }),
    ready({
      repo: API,
      pr: 1199,
      title: "Keep the lease on restart",
      head: "8be04d2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e",
      lane: "merge-now",
      act: "merge",
      says: "converged, witnessed and mergeable at the verified head",
      since: T(16, 7),
    }),
    ...waitingReady(),
  ];
}

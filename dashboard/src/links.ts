/**
 * Where the page links a pull request or an item that its record holds no
 * link for, worked out from the links the line does hold: a pull request
 * from its repository's forge address, an item from another item link of
 * the same repository's tracker (`shared/item-links.ts`). A record written
 * before the dispatcher kept links reads the same way.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  type ItemBases,
  itemBases,
  itemLinkFrom,
} from "../../plugin/shared/item-links.ts";

/** What the line's links tell of each repository, and the title each target was read with. */
export interface Forges {
  /** The forge address a pull request's link starts with, per repository. */
  pulls: Map<string, string>;
  /** The tracker bases an item's link starts with, per repository. */
  items: Map<string, ItemBases>;
  /** Each target's title as the line holds it, by `<repo> <target>`. */
  titles: Map<string, string>;
}

const PULL_URL = /^(.*\/)([^/]+\/[^/]+)\/pull\/\d+$/;

interface Linked {
  repo: string;
  target: string;
  url: string | null;
  title: string | null;
}

/** Every target the line names, with its repository, link and title. */
function linkedOf(line: LineSnapshot): Linked[] {
  return [
    ...line.sessions,
    ...line.needs,
    ...line.queue,
    ...(line.ready ?? []).map((r) => ({ ...r, target: `PR #${r.pr}` })),
  ];
}

/**
 * Where each repository's pull requests and items live, from the links the
 * line holds. A repository no pull-request link names takes the one forge the
 * line shows, when it shows exactly one.
 */
export function forgesOf(line: LineSnapshot | null): Forges {
  const forges: Forges = {
    pulls: new Map(),
    items: new Map(),
    titles: new Map(),
  };
  if (line === null) return forges;
  const linked = linkedOf(line);
  for (const { url } of linked) {
    const found = url === null ? null : PULL_URL.exec(url);
    if (found?.[1] !== undefined && found[2] !== undefined)
      forges.pulls.set(found[2], found[1]);
  }
  for (const repo of new Set(linked.map((x) => x.repo)))
    forges.items.set(repo, itemBases(linked.filter((x) => x.repo === repo)));
  for (const x of linked)
    if (x.title !== null && !forges.titles.has(`${x.repo} ${x.target}`))
      forges.titles.set(`${x.repo} ${x.target}`, x.title);
  return forges;
}

function pullLink(repo: string, pr: string, forges: Forges): string | null {
  const known = forges.pulls.get(repo);
  if (known !== undefined) return `${known}${repo}/pull/${pr}`;
  const bases = new Set(forges.pulls.values());
  const [only] = bases;
  return bases.size === 1 && only !== undefined
    ? `${only}${repo}/pull/${pr}`
    : null;
}

/** A target's link from the line's other links: a pull request's from its forge, an item's from its tracker; `null` when none tells. */
export function derivedLink(
  repo: string,
  target: string,
  forges: Forges,
): string | null {
  const pr = /^PR #(\d+)$/.exec(target)?.[1];
  if (pr !== undefined) return pullLink(repo, pr, forges);
  const bases = forges.items.get(repo);
  return bases === undefined ? null : itemLinkFrom(bases, target);
}

/** What a card says when neither its record nor the line's other links give a target's link: what is missing, and where to look. */
export function noLinkText(repo: string, target: string): string {
  return `No link was recorded for ${target}, and the line holds no other link to ${repo}'s tracker to work it out from: look ${target} up in that tracker.`;
}

/** The line with every target whose record holds no link given the one its other links tell. */
export function withDerivedLinks(line: LineSnapshot): LineSnapshot {
  const forges = forgesOf(line);
  const fill = <T extends { repo: string; target: string; url: string | null }>(
    x: T,
  ): T =>
    x.url === null ? { ...x, url: derivedLink(x.repo, x.target, forges) } : x;
  return {
    ...line,
    sessions: line.sessions.map(fill),
    needs: line.needs.map(fill),
    queue: line.queue.map(fill),
  };
}

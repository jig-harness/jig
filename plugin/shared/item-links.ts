/**
 * A tracker item's link worked out from another item link of the same
 * tracker, for a record that kept the item's key but not its link. An item
 * link names its key as one path segment (`…/issues/123` for `#123`,
 * `…/issue/ENG-4/a-title` or `…/browse/ENG-4` for `ENG-4`), so everything up
 * to that segment is the tracker's base, and another key of the same family
 * goes in its place. What follows the key (a title slug) is dropped: the
 * trackers that write one also open the bare key.
 *
 * Pure and dependency-free: the dispatcher's line and the dashboard's page
 * both read it.
 */

/** A key's family (`#` for a GitHub issue number, the prefix for `ENG-4`) and the segment it takes in a link. */
function keyOf(key: string): { family: string; segment: string } | null {
  const issue = /^#(\d+)$/.exec(key);
  if (issue?.[1] !== undefined) return { family: "#", segment: issue[1] };
  const prefixed = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(key);
  return prefixed?.[1] === undefined
    ? null
    : { family: prefixed[1].toUpperCase(), segment: key };
}

/** The base a link of `key` gives (everything up to the key's segment of its path), or `null` when the path does not name the key exactly once. */
export function itemBaseOf(
  url: string,
  key: string,
): { family: string; base: string } | null {
  const of = keyOf(key);
  if (of === null) return null;
  const parsed = URL.parse(url);
  if (parsed === null || !/^https?:$/.test(parsed.protocol)) return null;
  // Only the path names the item: a query or fragment that repeats the key says nothing about it.
  const segments = parsed.pathname.split("/");
  const at = segments.indexOf(of.segment);
  // A key repeated in the path (a namespace named like the item) leaves its segment unestablished.
  if (at < 0 || segments.indexOf(of.segment, at + 1) >= 0) return null;
  return {
    family: of.family,
    base: `${parsed.origin}${segments.slice(0, at).join("/")}/`,
  };
}

/** The tracker bases known links give, by key family. */
export type ItemBases = Map<string, string>;

/** The bases of every item link in `links`; the first link of a family decides its base. */
export function itemBases(
  links: Iterable<{ target: string; url: string | null }>,
): ItemBases {
  const bases: ItemBases = new Map();
  for (const { target, url } of links) {
    if (url === null) continue;
    const found = itemBaseOf(url, target);
    if (found !== null && !bases.has(found.family))
      bases.set(found.family, found.base);
  }
  return bases;
}

/**
 * The link of `key` from `bases`: its own family's base, else, for a
 * prefixed key, the one base every prefixed family shares (one tracker
 * site holds every team's or project's items); `null` when neither holds.
 */
export function itemLinkFrom(bases: ItemBases, key: string): string | null {
  const of = keyOf(key);
  if (of === null) return null;
  const own = bases.get(of.family);
  if (own !== undefined) return `${own}${of.segment}`;
  if (of.family === "#") return null;
  const shared = new Set(
    [...bases].filter(([family]) => family !== "#").map(([, base]) => base),
  );
  const [only] = shared;
  return shared.size === 1 && only !== undefined
    ? `${only}${of.segment}`
    : null;
}

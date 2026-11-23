/**
 * Which kept token answers for a card. The page keeps one token per GitHub
 * account (`forge-token.ts`), and each names the repository owners it answers
 * for: an owner `example-org` covers every `example-org/*` repository. A
 * card's Send takes the token that names its target repository's owner, or
 * else the one token that names none, which answers for every owner no other
 * token names. One owner has at most one token and one account one token: the
 * settings panel refuses a mapping that would break either rather than choose
 * between tokens. Owners and logins compare without case, as GitHub's do.
 */

/** A tested token, who it signs in as, and the owners it answers for. */
export interface KeptToken {
  token: string;
  login: string;
  /** When it was tested, in milliseconds. */
  at: number;
  /** The repository owners it answers for; none means every owner no other token names. */
  owners: string[];
}

/** A list the person's change makes, or why the panel refuses it. */
export type Mapped<T> = { ok: true; value: T } | { ok: false; reason: string };

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** The owner of `owner/name`. */
export function ownerOf(repo: string): string {
  return repo.split("/")[0] ?? "";
}

/** The token that answers for `owner`'s repositories, or `null` when none does. */
export function tokenFor(
  tokens: readonly KeptToken[],
  owner: string,
): KeptToken | null {
  return (
    tokens.find((t) => t.owners.some((o) => same(o, owner))) ??
    tokens.find((t) => t.owners.length === 0) ??
    null
  );
}

/**
 * Which token a confirmation was given for: its login and when it was
 * tested, never the token itself. Replacing or forgetting that token, or
 * moving the card's owner to another, changes it; a change to another token
 * does not.
 */
export function credentialOf(token: KeptToken | null): string {
  return token === null ? "" : `${token.login.toLowerCase()} ${token.at}`;
}

/** A GitHub account or organization name. */
const OWNER = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

/** Whether `name` is an owner as `parseOwners` keeps it: a bare account or organization name. */
export function isOwnerName(name: unknown): name is string {
  return typeof name === "string" && OWNER.test(name);
}

/** The owners the person wrote, by commas or spaces, `owner/*` read as `owner`. */
export function parseOwners(text: string): Mapped<string[]> {
  const owners: string[] = [];
  for (const word of text.split(/[\s,]+/).filter((w) => w !== "")) {
    const owner = word.replace(/\/\*$/, "");
    if (owner.includes("/"))
      return {
        ok: false,
        reason: `Name owners, not repositories: ${ownerOf(owner)} rather than ${owner}. A token answers for every repository of the owners it names.`,
      };
    if (!OWNER.test(owner))
      return {
        ok: false,
        reason: `${word} is not a GitHub account or organization name.`,
      };
    if (!owners.some((o) => same(o, owner))) owners.push(owner);
  }
  return { ok: true, value: owners };
}

/** Whether two distinct tokens answer for one owner, or two answer for every owner no other names: `tokenFor` would silently choose between them. */
export function hasAmbiguousMapping(tokens: readonly KeptToken[]): boolean {
  const seen = new Set<string>();
  let catchAlls = 0;
  for (const t of tokens) {
    if (t.owners.length === 0) catchAlls++;
    for (const owner of new Set(t.owners.map((o) => o.toLowerCase()))) {
      if (seen.has(owner)) return true;
      seen.add(owner);
    }
  }
  return catchAlls > 1;
}

/** Why `kept` cannot sit beside `others`, or `null` when it can. */
function mappingRefusal(
  others: readonly KeptToken[],
  kept: KeptToken,
): string | null {
  for (const owner of kept.owners) {
    const holder = others.find((t) => t.owners.some((o) => same(o, owner)));
    if (holder !== undefined)
      return `${owner} already answers through ${holder.login}'s token, and one owner takes one token. Remove ${owner} from that token first.`;
  }
  const fallback = others.find((t) => t.owners.length === 0);
  if (kept.owners.length === 0 && fallback !== undefined)
    return `${fallback.login}'s token already answers for every owner no other token names. Name the owners ${kept.login}'s token answers for.`;
  return null;
}

/**
 * `tokens` with a newly tested token kept. A token for an account already
 * kept replaces that one, and keeps its owners when `owners` names none.
 */
export function withToken(
  tokens: readonly KeptToken[],
  next: Omit<KeptToken, "owners">,
  owners: string[],
): Mapped<KeptToken[]> {
  const earlier = tokens.find((t) => same(t.login, next.login));
  const kept: KeptToken = {
    token: next.token,
    login: next.login,
    at: next.at,
    owners:
      owners.length === 0 && earlier !== undefined ? earlier.owners : owners,
  };
  const refused = mappingRefusal(
    tokens.filter((t) => t !== earlier),
    kept,
  );
  if (refused !== null) return { ok: false, reason: refused };
  return {
    ok: true,
    value:
      earlier === undefined
        ? [...tokens, kept]
        : tokens.map((t) => (t === earlier ? kept : t)),
  };
}

/** `tokens` with the owners `login`'s token answers for changed to `owners`. */
export function withOwners(
  tokens: readonly KeptToken[],
  login: string,
  owners: string[],
): Mapped<KeptToken[]> {
  const earlier = tokens.find((t) => same(t.login, login));
  if (earlier === undefined)
    return { ok: false, reason: `No token for ${login} is kept here.` };
  const kept = { ...earlier, owners };
  const refused = mappingRefusal(
    tokens.filter((t) => t !== earlier),
    kept,
  );
  if (refused !== null) return { ok: false, reason: refused };
  return { ok: true, value: tokens.map((t) => (t === earlier ? kept : t)) };
}

/** `tokens` without `login`'s; the others stay as they are. */
export function withoutToken(
  tokens: readonly KeptToken[],
  login: string,
): KeptToken[] {
  return tokens.filter((t) => !same(t.login, login));
}

/** What a token answers for, in words for the settings panel. */
export function ownersSaid(token: KeptToken): string {
  return token.owners.length === 0
    ? "every owner no other token names"
    : token.owners.join(", ");
}

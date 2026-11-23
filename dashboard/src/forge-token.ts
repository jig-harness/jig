/**
 * The GitHub tokens a person pastes so the page can send their answers
 * (`send.tsx`): one per GitHub account, each with the login GitHub named for
 * it when it was tested and the repository owners it answers for
 * (`token-owners.ts`). They are kept in this browser alone and never reach the
 * dashboard's server: the page sends a token only in the `Authorization`
 * header of its own calls to GitHub (`github.ts`). A browser that refuses
 * storage keeps them while the page stays open, and the settings panel says
 * so.
 *
 * They are kept as one list under `github-tokens`. A browser that kept the
 * single token of the earlier shape under `github-token` reads it as a token
 * that names no owner, so it answers for every owner as before; the first
 * change the person makes writes the list and removes the earlier key.
 */
import { useSyncExternalStore } from "react";
import { isRecord } from "../../plugin/shared/guards.ts";
import { readKeptRecord, writeKept } from "./kept.ts";
import {
  credentialOf,
  type KeptToken,
  ownerOf,
  tokenFor,
} from "./token-owners.ts";

export type { KeptToken } from "./token-owners.ts";

const KEY = "github-tokens";
/** Where a browser kept its one token before it could keep several. */
const EARLIER_KEY = "github-token";

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Stored data whose owner mappings cannot be trusted: no token it holds may be used. */
const UNTRUSTED = "untrusted";

/**
 * One stored token, when what is there is one. An empty `owners` means every
 * owner no other token names, so a list entry whose `owners` is missing or
 * malformed makes the whole list untrusted, since dropping it would let a
 * catch-all token answer for the owners it named; only the earlier single
 * token, which never named owners, reads as naming none.
 */
function storedToken(
  value: unknown,
  legacy = false,
): KeptToken | null | "untrusted" {
  const valid = isRecord(value) ? value : null;
  const { token, login, at, owners } = valid ?? {};
  const credentials = isText(token) && isText(login) && typeof at === "number";
  if (legacy) {
    if (valid === null || !credentials) return null;
    return { token, login, at, owners: [] };
  }
  // Any list entry that cannot be read in full may have carried a mapping.
  if (!credentials) return UNTRUSTED;
  if (!Array.isArray(owners) || !owners.every(isText)) return UNTRUSTED;
  return { token, login, at, owners };
}

/** The tokens what storage holds stands for: the list, else the earlier single token, each account once. */
export function tokensFrom(
  list: Record<string, unknown> | null,
  earlier: Record<string, unknown> | null,
): KeptToken[] {
  const read =
    list !== null && Array.isArray(list.tokens)
      ? list.tokens.map((t) => storedToken(t))
      : [storedToken(earlier, true)];
  // A mapping that cannot be read fails closed: nothing is kept until the person pastes the tokens again.
  if (read.includes(UNTRUSTED)) return [];
  const tokens: KeptToken[] = [];
  for (const token of read) {
    if (token === UNTRUSTED || token === null) continue;
    const same = tokens.find(
      (t) => t.login.toLowerCase() === token.login.toLowerCase(),
    );
    if (same === undefined) tokens.push(token);
    // Two entries for one account that disagree leave no mapping to trust.
    else if (same.owners.join(",") !== token.owners.join(",")) return [];
  }
  return tokens;
}

// What this page holds: read from storage once, then whatever the person kept or forgot.
let held: { tokens: KeptToken[]; saved: boolean } | null = null;
const listeners = new Set<() => void>();
let revision = 0;

function now(): { tokens: KeptToken[]; saved: boolean } {
  held ??= {
    tokens: tokensFrom(readKeptRecord(KEY), readKeptRecord(EARLIER_KEY)),
    saved: true,
  };
  return held;
}

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

/** Counts every change to the kept tokens, from this tab or another. */
export function tokensRevision(): number {
  return revision;
}

/** The tokens kept now. */
export function keptTokens(): KeptToken[] {
  return now().tokens;
}

/** The token kept now that answers for `repo`'s owner, or `null`. */
export function tokenForRepo(repo: string): KeptToken | null {
  return tokenFor(keptTokens(), ownerOf(repo));
}

/** Which token a card sending to `repo` would send with now, for its confirmation. */
export function credentialFor(repo: string): string {
  return credentialOf(tokenForRepo(repo));
}

/** Keeps `tokens` in place of those kept; whether this browser stored them rather than holding them only while the page is open. */
export function keepTokens(tokens: KeptToken[]): boolean {
  const saved = writeKept(
    KEY,
    tokens.length === 0 ? null : JSON.stringify({ tokens }),
  );
  // Neither key may revive older tokens once this write is refused.
  if (!saved) writeKept(KEY, null);
  writeKept(EARLIER_KEY, null);
  held = { tokens, saved: tokens.length === 0 || saved };
  changed();
  return saved;
}

/** The tokens kept now, followed as they change, and whether storage holds them. */
export function useKeptTokens(): { tokens: KeptToken[]; saved: boolean } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      // Tokens kept or forgotten in another tab of this page are read again.
      const fromOtherTab = (event: StorageEvent) => {
        if (
          event.key !== null &&
          !event.key.endsWith(`:${KEY}`) &&
          !event.key.endsWith(`:${EARLIER_KEY}`)
        )
          return;
        held = null;
        changed();
      };
      window.addEventListener("storage", fromOtherTab);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", fromOtherTab);
      };
    },
    () => revision,
    () => revision,
  );
  return now();
}

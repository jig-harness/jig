/**
 * The GitHub token a person pastes so the page can send their answers
 * (`send.tsx`), kept in this browser alone with the login GitHub named for it
 * when it was tested. It never reaches the dashboard's server: the page sends
 * it only in the `Authorization` header of its own calls to GitHub
 * (`github.ts`). A browser that refuses storage keeps it while the page stays
 * open, and the settings panel says so.
 */
import { useSyncExternalStore } from "react";
import { isRecord } from "../../plugin/shared/guards.ts";
import { readKept, writeKept } from "./kept.ts";

const KEY = "github-token";

/** A tested token, and who it signs in as. */
export interface KeptToken {
  token: string;
  login: string;
  /** When it was tested, in milliseconds. */
  at: number;
}

function tokenOf(raw: string | null): KeptToken | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    // Something else wrote this key; it holds no token.
    if (!(cause instanceof SyntaxError)) throw cause;
    return null;
  }
  if (!isRecord(value)) return null;
  const { token, login, at } = value;
  return typeof token === "string" &&
    token !== "" &&
    typeof login === "string" &&
    login !== "" &&
    typeof at === "number"
    ? { token, login, at }
    : null;
}

// What this page holds: read from storage once, then whatever the person kept or forgot.
let held: { kept: KeptToken | null; saved: boolean } | null = null;
const listeners = new Set<() => void>();
let revision = 0;

function now(): { kept: KeptToken | null; saved: boolean } {
  held ??= { kept: tokenOf(readKept(KEY)), saved: true };
  return held;
}

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

/** The token kept now, or `null`. */
export function keptToken(): KeptToken | null {
  return now().kept;
}

/** Keeps a tested token, or forgets the one kept when `null`; whether this browser stored it rather than holding it only while the page is open. */
export function keepToken(kept: KeptToken | null): boolean {
  const saved = writeKept(KEY, kept === null ? null : JSON.stringify(kept));
  if (!saved) writeKept(KEY, null);
  held = { kept, saved: kept === null || saved };
  changed();
  return saved;
}

/** The token kept now, followed as it changes, and whether storage holds it. */
export function useKeptToken(): { kept: KeptToken | null; saved: boolean } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      // A token kept or forgotten in another tab of this page is read again.
      const fromOtherTab = (event: StorageEvent) => {
        if (event.key !== null && !event.key.endsWith(`:${KEY}`)) return;
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

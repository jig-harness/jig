/**
 * What this browser sent for a card: the comment and its link, kept in this
 * browser alone under the card's repository and target, so the card says
 * "Sent here" with the link until the next tick reads the answer and the
 * card goes. Forgotten after `KEPT_MS`, as the answers are.
 */
import { useSyncExternalStore } from "react";
import { isRecord } from "../../plugin/shared/guards.ts";
import { keptKeys, readKept, writeKept } from "./kept.ts";

const PREFIX = "sent:";
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** One comment this browser posted for a card. */
export interface SentHere {
  /** The comment's text, as Copy would take it. */
  text: string;
  url: string;
  at: number;
}

const held = new Map<string, SentHere | null>();
const listeners = new Set<() => void>();
let revision = 0;

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

function sentOf(raw: string | null): SentHere | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    // Something else wrote this key; it holds no send.
    if (!(cause instanceof SyntaxError)) throw cause;
    return null;
  }
  if (!isRecord(value)) return null;
  const { text, url, at } = value;
  return typeof text === "string" &&
    typeof url === "string" &&
    url.startsWith("https://github.com/") &&
    typeof at === "number"
    ? { text, url, at }
    : null;
}

function idOf(repo: string, target: string): string {
  return `${PREFIX}${repo} ${target}`;
}

function read(id: string, nowMs: number): SentHere | null {
  const sent = held.has(id) ? (held.get(id) ?? null) : sentOf(readKept(id));
  return sent !== null && nowMs - sent.at <= KEPT_MS ? sent : null;
}

/** Keeps what was sent for a card; held for the page when storage refuses it. */
export function keepSent(repo: string, target: string, sent: SentHere): void {
  const id = idOf(repo, target);
  writeKept(id, JSON.stringify(sent));
  held.set(id, sent);
  changed();
}

/** Forgets what was sent longer ago than `KEPT_MS`, and anything under the prefix that is not a send. */
export function forgetOldSends(nowMs: number): void {
  for (const [id, sent] of held)
    if (sent === null || nowMs - sent.at > KEPT_MS) held.delete(id);
  for (const key of keptKeys(PREFIX)) {
    const sent = sentOf(readKept(key));
    if (sent === null || nowMs - sent.at > KEPT_MS) writeKept(key, null);
  }
}

/** What this browser sent for a card, followed as it changes. */
export function useSentHere(repo: string, target: string): SentHere | null {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
    () => revision,
  );
  return read(idOf(repo, target), Date.now());
}

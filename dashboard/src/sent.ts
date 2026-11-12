/**
 * What this browser sent for a card: the comment and its link, kept in this
 * browser alone under the card's repository and target, so the card says
 * "Sent here" with the link until the next tick reads the answer and the
 * card goes. Forgotten after `KEPT_MS`, as the answers are.
 */
import { useSyncExternalStore } from "react";
import { keptKeys, readKeptRecord, writeKept } from "./kept.ts";

const PREFIX = "sent:";
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** One comment this browser posted for a card. */
export interface SentHere {
  /** The comment's text, as Copy would take it. */
  text: string;
  url: string;
  at: number;
}

const held = new Map<string, SentHere>();
const listeners = new Set<() => void>();
let revision = 0;

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

/** What is kept under `key`, when it is a send this page kept. */
function storedSent(key: string): SentHere | null {
  const { text, url, at } = readKeptRecord(key) ?? {};
  return typeof text === "string" &&
    typeof url === "string" &&
    url.startsWith("https://github.com/") &&
    typeof at === "number"
    ? { text, url, at }
    : null;
}

/** Whether a send is still kept at `nowMs`. */
function fresh(sent: SentHere | null, nowMs: number): sent is SentHere {
  return sent !== null && nowMs - sent.at <= KEPT_MS;
}

function idOf(repo: string, target: string): string {
  return `${PREFIX}${repo} ${target}`;
}

function read(id: string, nowMs: number): SentHere | null {
  const sent = held.has(id) ? (held.get(id) ?? null) : storedSent(id);
  return fresh(sent, nowMs) ? sent : null;
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
  for (const [id, sent] of held) if (!fresh(sent, nowMs)) held.delete(id);
  for (const key of keptKeys(PREFIX))
    if (!fresh(storedSent(key), nowMs)) writeKept(key, null);
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

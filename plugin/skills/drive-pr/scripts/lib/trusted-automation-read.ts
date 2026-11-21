/**
 * The forge read behind trusted automation (`trusted-automation.ts`): a
 * listed bot's pull request's commits and files, in one request pinned to
 * its head.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { ghApiJson } from "./merge-facts.ts";
import type { ForgeFacts, ReadyRules } from "./merge-ready.ts";
import {
  type AutomationFacts,
  parseCompare,
  trustedEntryFor,
} from "./trusted-automation.ts";

/** A base branch name the compare path can carry as it is. */
const BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * A pull request's commits and files at `head`, against its base branch, in
 * one request pinned to the head (the forge's compare of `base...head`).
 * With `slug` `null` the repository is the one the forge client's own view
 * of the working directory names.
 */
export async function readAutomationFacts(
  slug: string | null,
  base: string,
  head: string,
  timeoutSec: number,
): Promise<Outcome<AutomationFacts, "unreadable">> {
  if (!/^[0-9a-f]{40}$/.test(head))
    return failed("unreadable", "the head is not a commit id");
  if (!BRANCH.test(base) || base.includes(".."))
    return failed(
      "unreadable",
      "the base branch's name does not pass its form",
    );
  const repo = slug ?? "{owner}/{repo}";
  const answer = await ghApiJson(
    [`repos/${repo}/compare/${base}...${head}`],
    slug,
    timeoutSec,
    "compare",
  );
  return answer.ok ? parseCompare(answer.value, head) : answer;
}

/** The key prefix of a kept read; the repository's slug and the pull request's number follow. */
export const AUTOMATION_CACHE_PREFIX = "forge:trusted-automation:";

/** Where a caller keeps a read for the next one: the tick's reads between ticks. */
export interface AutomationCache {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/** A kept read: the head and base it was read at, and what it read. */
interface Kept {
  head: string;
  base: string;
  facts: AutomationFacts;
}

function keptOf(value: unknown, head: string, base: string): Kept | null {
  if (!isRecord(value) || value.head !== head || value.base !== base)
    return null;
  const facts = value.facts;
  if (
    !isRecord(facts) ||
    facts.head !== head ||
    !Array.isArray(facts.commits) ||
    !Array.isArray(facts.files)
  )
    return null;
  return value as unknown as Kept;
}

/**
 * Whether the Ready predicate needs a pull request's commits and files: its
 * author is a bot the list names, and its head is known to be in the
 * repository (a fork, or a head not known to be in the repository, already
 * fails the rule).
 */
export function needsAutomation(facts: ForgeFacts, rules: ReadyRules): boolean {
  const list = rules.trustedAutomation;
  return (
    list?.ok === true &&
    trustedEntryFor(facts.author, list.value) !== null &&
    facts.crossRepository === false
  );
}

/**
 * The commits and files the Ready predicate needs for a pull request by a
 * listed bot, read at its head; `undefined` when it needs none
 * (`needsAutomation`). A head's commits and files never change, so a read
 * kept in `cache` for the same head and base is reused.
 */
export async function automationFor(
  slug: string | null,
  facts: ForgeFacts,
  rules: ReadyRules,
  timeoutSec: number,
  cache?: AutomationCache,
): Promise<Outcome<AutomationFacts, "unreadable"> | undefined> {
  if (!needsAutomation(facts, rules)) return undefined;
  const base = facts.base ?? "";
  if (base === "") return failed("unreadable", "its base branch was not read");
  const key =
    slug === null ? null : `${AUTOMATION_CACHE_PREFIX}${slug}:${facts.number}`;
  const kept =
    key === null || cache === undefined
      ? null
      : keptOf(cache.get<unknown>(key), facts.head, base);
  if (kept !== null) return ok(kept.facts);
  const read = await readAutomationFacts(slug, base, facts.head, timeoutSec);
  if (read.ok && key !== null && cache !== undefined)
    cache.set(key, {
      head: facts.head,
      base,
      facts: read.value,
    } satisfies Kept);
  return read;
}

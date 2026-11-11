#!/usr/bin/env bun
/**
 * Whether each item's linked pull request merged, for the parent roll-up
 * (SKILL.md Step 5a) where `pr_open` shares its tracker name with
 * `in_review`. See `lib/linked-pr.ts` for how the pull requests are found
 * and read.
 *
 * Type: Discovery
 * Input: one or more issue keys in the configured tracker's shape.
 * Output: JSON `{ "<KEY>": { pullRequest, pulls, reason } }`, where
 *   `pullRequest` is `merged`, `open`, `none` or `unreadable`.
 *
 * Usage:
 *     bun linked-pr.ts "<KEY>" ["<KEY>" ...]
 *
 * Exit codes: 0 read (an item whose read failed is `unreadable`, not an
 * error), 2 usage, 1 the tracker, the repository or its integration branch
 * cannot be read, so no item can be.
 */

import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { baseBranch } from "../../drive-pr/scripts/lib/overlay.ts";
import { prPolicy } from "../../drive-pr/scripts/lib/pr-policy.ts";
import { ghCall, type RunResult } from "../../drive-pr/scripts/lib/proc.ts";
import { swallow } from "../../../shared/errors.ts";
import { runEntry } from "./lib/cli.ts";
import {
  type LinkedPr,
  type LinkedPrReads,
  type PullFact,
  readLinkedPr,
} from "./lib/linked-pr.ts";
import { trackerConfigFrom } from "./lib/tracker/config.ts";
import {
  homeRepo,
  remoteUrl,
  repoFromRemote,
  slug,
} from "./lib/tracker/github/refs.ts";
import { openTracker } from "./lib/tracker/index.ts";
import { issueKeysOrNull } from "./lib/tracker/keys.ts";
import type { Tracker } from "./lib/tracker/port.ts";

/** The most pull requests one search reads; a full page counts as unreadable. */
export const SEARCH_LIMIT = 100;

const PULL_FIELDS = "number,url,state,baseRefName";

const PULL_STATES = new Set(["OPEN", "MERGED", "CLOSED"]);

function pullFact(v: unknown, repository: string): PullFact | null {
  if (typeof v !== "object" || v === null) return null;
  const p = v as Record<string, unknown>;
  return typeof p.number === "number" &&
    Number.isInteger(p.number) &&
    p.number > 0 &&
    typeof p.url === "string" &&
    p.url
      .toLowerCase()
      .startsWith(`https://github.com/${repository.toLowerCase()}/pull/`) &&
    typeof p.state === "string" &&
    PULL_STATES.has(p.state.toUpperCase()) &&
    typeof p.baseRefName === "string" &&
    p.baseRefName !== ""
    ? {
        number: p.number,
        url: p.url,
        state: p.state,
        baseRefName: p.baseRefName,
      }
    : null;
}

/** The JSON a successful `gh` call printed; `null`, with gh's error output on stderr, otherwise. */
function ghJson(r: RunResult, what: string): unknown {
  if (r.code !== 0) {
    console.error(
      `linked-pr.ts: ${what} failed: ${r.stderr.trim().slice(-400)}`,
    );
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    swallow(err, `${what} printed no JSON, so it reads as unreadable`);
    return null;
  }
}

/** The reads through the tracker and the `gh` command, from `root`. */
function forgeReads(
  tracker: Tracker,
  root: string,
  repository: string,
): LinkedPrReads {
  return {
    async comments(key) {
      try {
        return (await tracker.listComments(key)).map((c) => c.body);
      } catch (err) {
        console.error(
          `linked-pr.ts: the comments of ${key} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
    async search(term) {
      const r = await ghCall(
        [
          "pr",
          "list",
          "--repo",
          repository,
          "--state",
          "all",
          "--search",
          `"${term}" in:body`,
          "--limit",
          String(SEARCH_LIMIT),
          "--json",
          `${PULL_FIELDS},body`,
        ],
        { cwd: root },
      );
      const list = ghJson(r, `the search for pull requests naming ${term}`);
      if (!Array.isArray(list)) return null;
      if (list.length >= SEARCH_LIMIT) {
        console.error(
          `linked-pr.ts: the search for pull requests naming ${term} filled its ${SEARCH_LIMIT}-result page, so it may be incomplete`,
        );
        return null;
      }
      const pulls = list.map((v) => {
        const fact = pullFact(v, repository);
        const body = (v as Record<string, unknown> | null)?.body;
        return fact === null || typeof body !== "string"
          ? null
          : { ...fact, body };
      });
      return pulls.every((p) => p !== null) ? pulls : null;
    },
    async view(number) {
      const r = await ghCall(
        [
          "pr",
          "view",
          String(number),
          "--repo",
          repository,
          "--json",
          `${PULL_FIELDS},body`,
        ],
        { cwd: root },
      );
      const json = ghJson(r, `reading pull request #${number}`);
      const fact = pullFact(json, repository);
      const body = (json as Record<string, unknown> | null)?.body;
      return fact === null || typeof body !== "string"
        ? null
        : { ...fact, body };
    },
  };
}

async function main(): Promise<number> {
  const inputs = process.argv.slice(2);
  if (inputs.length === 0 || inputs.some((a) => a.startsWith("-"))) {
    console.error('usage: linked-pr.ts "<KEY>" ["<KEY>" ...]');
    return 2;
  }
  const keys = issueKeysOrNull();
  if (keys === null) {
    console.error("ERROR: the tracker configuration cannot be read");
    return 1;
  }
  const items: string[] = [];
  for (const input of inputs) {
    const key = keys.normalize(input);
    if (key === null) {
      console.error(
        `not an issue key of this tracker: ${input} (e.g. ${keys.example})`,
      );
      return 2;
    }
    items.push(key);
  }
  const root = consumerRoot();
  const url = remoteUrl(root);
  const repo = url === null ? null : repoFromRemote(url);
  if (repo === null) {
    console.error(
      `ERROR: the git remote (${url ?? "none"}) is not a github.com repository`,
    );
    return 1;
  }
  const trunk = await baseBranch(root);
  if (trunk === null) {
    console.error(
      "ERROR: the integration branch is unknown: set repository.base_branch in .config/jig.yaml",
    );
    return 1;
  }
  let tracker: Tracker;
  try {
    tracker = openTracker();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  let trackerRepository: string | undefined;
  try {
    const config = trackerConfigFrom(readConfig());
    if (config.adapter === "github")
      trackerRepository = slug(homeRepo(config.github.repository, () => url));
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const policy = prPolicy();
  const reads = forgeReads(tracker, root, slug(repo));
  const out: Record<string, LinkedPr> = {};
  for (const key of items)
    out[key] = await readLinkedPr(key, {
      reads,
      repository: slug(repo),
      keySource: keys.source,
      trunk,
      trackerRepository,
      bodyLinkRequired: policy.issueLink !== "none",
    });
  console.log(JSON.stringify(out));
  return 0;
}

if (import.meta.main) runEntry(main);

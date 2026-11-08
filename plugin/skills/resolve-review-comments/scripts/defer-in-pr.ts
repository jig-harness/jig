#!/usr/bin/env bun
/**
 * Defer a review finding into the pull request's own `## Deferred` section,
 * for a repository where no tracker adapter can file it: the deferral batch
 * step (`defer-batch.ts`) files on Linear only, so a repository whose tracker
 * is another, or a machine with no Linear credential, records the finding
 * here, and `file-deferred.ts` files it later where an adapter can
 * (references/deferral-protocol.md § Deferral without a tracker).
 *
 * Usage:
 *   defer-in-pr.ts route
 *       prints `defer-batch` when the batch step can file here, else
 *       `pr-body: <why>`; exit 0 either way.
 *   defer-in-pr.ts <PR> --thread-url <url> <recorded> --reason <one line>  < finding.txt
 *   defer-in-pr.ts <PR> --comment-url <url> --fingerprint <fp> <recorded> --reason <one line>  < finding.txt
 *       adds the finding, quoted from stdin, to the section by
 *       read-modify-write against the body's `updated_at`, and prints the
 *       section's link for the `**deferred**` reply. A finding already in
 *       the section is not added twice.
 *
 *   <recorded> is what `file-deferred.ts` files the finding as, the values
 *   `defer-batch.ts` takes: `--type <type>` (chosen from the finding, from
 *   `review.taxonomy.types` where the repository declares them),
 *   `--severity <blocker|high|medium|low|unknown>` and
 *   `--category <category|unknown>` (`review.taxonomy.categories`), each
 *   required, and `--size <size>` where the fix is not `small`.
 *
 * Exit codes: 0 done, 1 the forge could not be read or written, 2 usage.
 */
import { parseArgs } from "node:util";
import { fail, readStdinAll, runMain } from "../../../shared/cli.ts";
import { parseReviewConfig, readConfig } from "../../../shared/consumer.ts";
import { valueAt } from "../../../shared/config-layers.ts";
import {
  deferredEntries,
  type Recorded,
  SECTION_ANCHOR,
  withDeferredEntry,
} from "./lib/deferred-section.ts";
import {
  CANONICAL_SEVERITIES,
  CATEGORY_UNKNOWN,
  SEVERITY_UNKNOWN,
} from "./lib/ladder.ts";
import {
  ghPrBodyForge,
  type PrBodyForge,
  updatePrBody,
} from "./lib/pr-body.ts";

type Env = Record<string, string | undefined>;

/**
 * Where a deferral goes: the batch step when it can file (the repository's
 * adapter is Linear, the one the batch step speaks, and a Linear credential
 * is set), else the pull request body, with why.
 */
export function deferralRoute(
  values: Record<string, unknown>,
  env: Env = process.env,
): { route: "defer-batch" } | { route: "pr-body"; why: string } {
  const adapter = valueAt(values, "issue_tracker.adapter") ?? "github";
  if (adapter !== "linear")
    return {
      route: "pr-body",
      why: `the batch step files on Linear only, and issue_tracker.adapter is ${String(adapter)}`,
    };
  if (
    [env.LINEAR_API_TOKEN, env.LINEAR_API_KEY].every(
      (v) => v === undefined || v.trim() === "",
    )
  )
    return {
      route: "pr-body",
      why: "no Linear credential (LINEAR_API_TOKEN or LINEAR_API_KEY) is set",
    };
  return { route: "defer-batch" };
}

export interface DeferInPrArgs {
  pr: string;
  source: string;
  fingerprint?: string;
  /** What the finding is filed as; every field but `size` is required. */
  recorded: Required<Omit<Recorded, "size">> & Pick<Recorded, "size">;
  reason: string;
  finding: string;
}

/** The values a repository's review taxonomy declares, where it does. */
export interface RecordedVocabulary {
  types?: readonly string[];
  categories?: readonly string[];
}

/** A value fit to sit in the entry's marker: one token, nothing that ends a comment. */
const TOKEN = /^[^\s<>]+$/;

/**
 * Why `recorded` cannot be written into an entry, or `null` when it can: a
 * type outside `review.taxonomy.types` (where declared), a severity outside
 * the severity vocabulary, a category outside `review.taxonomy.categories`
 * and `unknown`, or a value that is not one token.
 */
export function recordedError(
  recorded: DeferInPrArgs["recorded"],
  vocabulary: RecordedVocabulary,
): string | null {
  for (const [flag, value] of Object.entries(recorded))
    if (value !== undefined && (!TOKEN.test(value) || value.includes("--")))
      return `--${flag} must be one token with no <, > or -- (got '${value}')`;
  const types = vocabulary.types ?? [];
  if (types.length > 0 && !types.includes(recorded.type))
    return `--type must be one of ${types.join("|")} (review.taxonomy.types), got '${recorded.type}'`;
  const severities = [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN];
  if (!severities.includes(recorded.severity))
    return `--severity must be one of ${severities.join("|")}, got '${recorded.severity}'`;
  const categories = [...(vocabulary.categories ?? []), CATEGORY_UNKNOWN];
  if (!categories.includes(recorded.category))
    return `--category must be one of ${categories.join("|")} (review.taxonomy.categories), got '${recorded.category}'`;
  return null;
}

/** Add the finding to the section; the link a reply carries. */
export async function deferInPr(
  forge: PrBodyForge,
  a: DeferInPrArgs,
): Promise<{ link: string; added: boolean }> {
  const id = {
    source: a.source,
    ...(a.fingerprint === undefined ? {} : { fingerprint: a.fingerprint }),
  };
  const r = await updatePrBody(
    forge,
    a.pr,
    (body) => {
      const next = withDeferredEntry(body, {
        ...id,
        ...a.recorded,
        finding: a.finding,
        reason: a.reason,
      });
      return next.added ? next.body : null;
    },
    (body) =>
      deferredEntries(body).some(
        (e) => e.source === id.source && e.fingerprint === id.fingerprint,
      ),
  );
  return { link: `${r.url}#${SECTION_ANCHOR}`, added: r.changed };
}

const text = (v: unknown): v is string => typeof v === "string";

/**
 * A deferral's arguments from the command line, or `null` when they are not
 * a use this script takes: one pull request number, a thread's url or a
 * comment's url with its fingerprint, the recorded fields, and a one-line
 * reason.
 */
function deferralArgs(
  values: Record<string, unknown>,
  positionals: string[],
): Omit<DeferInPrArgs, "finding"> | null {
  const { type, severity, category, size, reason, fingerprint } = values;
  const thread = values["thread-url"];
  const comment = values["comment-url"];
  const pr = positionals[0] ?? "";
  if (
    !/^\d+$/.test(pr) ||
    positionals.length !== 1 ||
    !text(reason) ||
    reason.trim() === "" ||
    /[\n\r]/.test(reason) ||
    text(thread) === text(comment) ||
    text(comment) !== text(fingerprint) ||
    !text(type) ||
    !text(severity) ||
    !text(category) ||
    (size !== undefined && !text(size))
  )
    return null;
  return {
    pr,
    source: (text(thread) ? thread : comment) as string,
    ...(text(fingerprint) ? { fingerprint } : {}),
    recorded: { type, severity, category, ...(text(size) ? { size } : {}) },
    reason,
  };
}

function usage(): never {
  fail(
    2,
    "usage: defer-in-pr.ts route",
    "       defer-in-pr.ts <PR> (--thread-url <url> | --comment-url <url> --fingerprint <fp>) --type <type> --severity <severity> --category <category> [--size <size>] --reason <text>  < finding.txt",
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "route") {
    const r = deferralRoute(readConfig());
    process.stdout.write(
      r.route === "defer-batch" ? "defer-batch\n" : `pr-body: ${r.why}\n`,
    );
    return 0;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "thread-url": { type: "string" },
        "comment-url": { type: "string" },
        fingerprint: { type: "string" },
        type: { type: "string" },
        severity: { type: "string" },
        category: { type: "string" },
        size: { type: "string" },
        reason: { type: "string" },
      },
    });
  } catch {
    usage();
  }
  const args = deferralArgs(parsed.values, parsed.positionals) ?? usage();
  const taxonomy = parseReviewConfig(readConfig().review).taxonomy ?? {};
  const refused = recordedError(args.recorded, taxonomy);
  if (refused !== null) fail(2, `defer-in-pr: ${refused}`);
  const finding = await readStdinAll();
  if (finding.trim() === "")
    fail(2, "defer-in-pr: the finding is read from stdin, and it is empty");
  try {
    const r = await deferInPr(ghPrBodyForge(), { ...args, finding });
    process.stdout.write(`${r.link}\n`);
    if (!r.added)
      console.error("defer-in-pr: the finding is already in the section");
    return 0;
  } catch (err) {
    fail(1, `defer-in-pr: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (import.meta.main) runMain("defer-in-pr", main);

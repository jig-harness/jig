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
 *   defer-in-pr.ts <PR> --thread-url <url> --reason <one line>  < finding.txt
 *   defer-in-pr.ts <PR> --comment-url <url> --fingerprint <fp> --reason <one line>  < finding.txt
 *       adds the finding, quoted from stdin, to the section by
 *       read-modify-write against the body's `updated_at`, and prints the
 *       section's link for the `**deferred**` reply. A finding already in
 *       the section is not added twice.
 *
 * Exit codes: 0 done, 1 the forge could not be read or written, 2 usage.
 */
import { parseArgs } from "node:util";
import { fail, readStdinAll, runMain } from "../../../shared/cli.ts";
import { readConfig } from "../../../shared/consumer.ts";
import { valueAt } from "../../../shared/config-layers.ts";
import {
  deferredEntries,
  SECTION_ANCHOR,
  withDeferredEntry,
} from "./lib/deferred-section.ts";
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
  reason: string;
  finding: string;
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

function usage(): never {
  fail(
    2,
    "usage: defer-in-pr.ts route",
    "       defer-in-pr.ts <PR> (--thread-url <url> | --comment-url <url> --fingerprint <fp>) --reason <text>  < finding.txt",
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
        reason: { type: "string" },
      },
    });
  } catch {
    usage();
  }
  const { values, positionals } = parsed;
  const pr = positionals[0] ?? "";
  const thread = values["thread-url"];
  const comment = values["comment-url"];
  const fingerprint = values.fingerprint;
  const reason = values.reason;
  if (
    !/^\d+$/.test(pr) ||
    positionals.length !== 1 ||
    typeof reason !== "string" ||
    reason.trim() === "" ||
    /[\n\r]/.test(reason) ||
    (typeof thread === "string") === (typeof comment === "string") ||
    (typeof comment === "string") !== (typeof fingerprint === "string")
  )
    usage();
  const finding = await readStdinAll();
  if (finding.trim() === "")
    fail(2, "defer-in-pr: the finding is read from stdin, and it is empty");
  try {
    const r = await deferInPr(ghPrBodyForge(), {
      pr,
      source: (thread ?? comment) as string,
      ...(typeof fingerprint === "string" ? { fingerprint } : {}),
      reason,
      finding,
    });
    process.stdout.write(`${r.link}\n`);
    if (!r.added)
      console.error("defer-in-pr: the finding is already in the section");
    return 0;
  } catch (err) {
    fail(1, `defer-in-pr: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (import.meta.main) runMain("defer-in-pr", main);

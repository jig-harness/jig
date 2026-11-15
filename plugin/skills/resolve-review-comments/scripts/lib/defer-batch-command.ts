import { deferralTrackerConfig } from "./deferral-config.ts";
import { JigError } from "../../../../shared/outcome.ts";
/** Tracker-independent command boundary for deferred findings. */
import { fail } from "../../../../shared/cli.ts";
import { parseArgs } from "node:util";
import {
  consumerRoot,
  readConfig,
  reviewConfig,
} from "../../../../shared/consumer.ts";
import {
  facetsOf,
  type TrackerConfig,
} from "../../../do-item/scripts/lib/tracker/config.ts";
import { readTaxonomy } from "../../../do-item/scripts/lib/tracker/facets/complete.ts";
import { openTracker } from "../../../do-item/scripts/lib/tracker/index.ts";
import {
  missingGroups,
  SIZE_GROUP,
} from "../../../file-issue/scripts/lib/validate.ts";
import { entryFacets, identityLine, textLine } from "../file-deferred.ts";
import { recordedError } from "../defer-in-pr.ts";
import { configuredCatalog, entryLabels } from "./deferred-labels.ts";
import { deferredEntries, withDeferredEntry } from "./deferred-section.ts";
import { ghPrBodyForge } from "./pr-body.ts";
import { deferToTracker } from "./tracker-defer-batch.ts";

const OPTIONS = {
  batch: { type: "boolean" },
  "dry-run": { type: "boolean" },
  "no-parent": { type: "boolean" },
  "no-parent-reason": { type: "string" },
  "thread-url": { type: "string" },
  "comment-url": { type: "string" },
  fingerprint: { type: "string" },
  reason: { type: "string" },
  severity: { type: "string" },
  category: { type: "string" },
  originating: { type: "string" },
  team: { type: "string" },
  fix: { type: "string" },
  size: { type: "string" },
  labels: { type: "string" },
  "repo-label": { type: "string" },
  "repo-slug": { type: "string" },
} as const;
const USAGE =
  "usage: defer-batch.ts <PR> <type> (--thread-url <url> | --comment-url <url> --fingerprint <fp>) --reason <one line> --severity <severity> --category <category> --originating <key|none>; finding body is required on stdin";

function required(value: string | undefined): string {
  if (!value) fail(2, USAGE);
  return value;
}

function commandInput(argv: string[], finding: string) {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: OPTIONS,
  });
  const pr = required(positionals[0]);
  const type = required(positionals[1]);
  const reason = required(a.reason);
  if (
    positionals.length !== 2 ||
    !/^[1-9]\d*$/.test(pr) ||
    /[\r\n]/.test(reason) ||
    !finding.trim()
  )
    fail(2, USAGE);
  if (
    Boolean(a["thread-url"]) === Boolean(a["comment-url"]) ||
    Boolean(a["comment-url"]) !== Boolean(a.fingerprint)
  )
    fail(2, USAGE);
  return {
    ...a,
    pr,
    type,
    reason,
    source: required(a["thread-url"] ?? a["comment-url"]),
    severity: required(a.severity),
    category: required(a.category),
    originating: required(a.originating),
  };
}

type Input = ReturnType<typeof commandInput>;
type Config = TrackerConfig;
type Review = ReturnType<typeof reviewConfig>;

function validateSource(a: Input, repo: string): void {
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = a["thread-url"] ? "discussion_r[0-9]+" : "issuecomment-[0-9]+";
  if (
    !new RegExp(
      `^https://github\\.com/${escaped}/pull/${a.pr}#${suffix}$`,
    ).test(a.source)
  )
    throw new JigError(
      "deferral",
      "The finding source must belong to this repository and pull request",
    );
  if (a.fingerprint && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(a.fingerprint))
    throw new JigError(
      "deferral",
      "The finding fingerprint must be marker-safe",
    );
}

function configured(a: Input) {
  const values = readConfig();
  const review = reviewConfig();
  const refused = recordedError(
    {
      type: a.type,
      severity: a.severity,
      category: a.category,
      ...(a.size ? { size: a.size } : {}),
    },
    review.taxonomy ?? {},
  );
  if (refused) throw new JigError("deferral", refused);
  const adapter = (values.issue_tracker as { adapter?: string } | undefined)
    ?.adapter;
  if (
    adapter === "linear" &&
    ![process.env.LINEAR_API_TOKEN, process.env.LINEAR_API_KEY].some((v) =>
      v?.trim(),
    )
  )
    throw new JigError(
      "deferral",
      "LINEAR_API_TOKEN (or LINEAR_API_KEY) is required for the Linear deferral adapter",
    );
  return { config: deferralTrackerConfig(values, review, a.team), review };
}

async function filingLabels(
  a: Input,
  config: Config,
  review: Review,
  origin: { labels: string[] } | null,
  forge: ReturnType<typeof ghPrBodyForge>,
): Promise<string[]> {
  const prefixes = review.taxonomy?.context_prefixes ?? [
    "agent:",
    "domain:",
    "codearea:",
  ];
  const repoLabel = a["repo-label"] ?? review.repo_label;
  const taxonomy = readTaxonomy(consumerRoot(), config.taxonomy);
  const labelDeclared =
    taxonomy?.groups.some((g) => g.labels.includes(repoLabel ?? "")) ??
    config.adapter === "linear";
  const inherited =
    origin?.labels.filter((l) => prefixes.some((p) => l.startsWith(p))) ?? [];
  const extras =
    a.labels
      ?.split(",")
      .map((l) => l.trim())
      .filter(Boolean) ?? [];
  const labels = [
    ...new Set([
      config.labels.followup,
      ...inherited,
      ...extras,
      ...(repoLabel && labelDeclared ? [repoLabel] : []),
    ]),
  ];
  if (
    taxonomy === null ||
    missingGroups(labels, taxonomy, [SIZE_GROUP]).length === 0
  )
    return labels;
  const path = a["thread-url"]
    ? (await forge.threadPaths(a.pr)).get(a.source)
    : undefined;
  const derived = entryLabels(
    config.labels.followup,
    path ? { path } : { none: "the finding has no review-thread path" },
    taxonomy,
    configuredCatalog,
  );
  if ("why" in derived) throw new JigError("deferral", derived.why);
  return [...new Set([...labels, ...derived.labels])];
}

function findingEntry(a: Input, finding: string) {
  const entry = deferredEntries(
    withDeferredEntry("", {
      source: a.source,
      ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}),
      type: a.type,
      severity: a.severity,
      category: a.category,
      ...(a.size ? { size: a.size } : {}),
      reason: a.reason,
      finding: `${finding.trim()}${a.fix ? `\n\nFix sketch: ${a.fix}` : ""}`,
    }).body,
  )[0];
  if (entry === undefined)
    throw new JigError(
      "deferral",
      "The finding could not be rendered as an entry",
    );
  return entry;
}

async function originFor(tracker: ReturnType<typeof openTracker>, key: string) {
  const originating = key === "none" ? undefined : key;
  const origin = originating ? await tracker.getIssue(originating) : null;
  if (originating && origin === null)
    throw new JigError(
      "deferral",
      `Originating issue ${originating} could not be read`,
    );
  return { originating, origin };
}

function printResult(
  a: Input,
  result: Awaited<ReturnType<typeof deferToTracker>>,
): void {
  process.stdout.write(
    `${JSON.stringify({ ...result, ...(a["dry-run"] ? { dryRun: true } : {}) })}\n`,
  );
  if (!a["dry-run"])
    console.error(
      `**deferred** — ${result.url ?? result.identifier}: ${a.reason}`,
    );
}

export async function deferBatchCommand(
  argv: string[],
  finding: string,
): Promise<number> {
  const a = commandInput(argv, finding);
  const { config, review } = configured(a);
  if (a.severity === "blocker")
    console.error(
      "defer-batch: WARNING — a blocker should be fixed or escalated, not deferred; filing at urgent priority so the finding is tracked.",
    );
  const tracker = openTracker(config);
  const forge = ghPrBodyForge();
  const repo =
    a["repo-slug"] ??
    review.repo_slug ??
    new URL((await forge.read(a.pr)).url).pathname
      .split("/")
      .slice(1, 3)
      .join("/");
  validateSource(a, repo);
  const { originating, origin } = await originFor(tracker, a.originating);
  const entry = findingEntry(a, finding);
  const facets = entryFacets(entry, facetsOf(config, consumerRoot()));
  if ("why" in facets) throw new JigError("deferral", facets.why);
  const result = await deferToTracker(tracker, {
    repo: a["repo-label"] ?? review.repo_label ?? repo,
    pr: a.pr,
    type: facets.type ?? a.type,
    identity: identityLine(entry),
    text: `${entry.text}\n\n${identityLine(entry)}\n${textLine(entry)}`,
    category: a.category,
    priority: facets.priority ?? 3,
    size: facets.size,
    labels: await filingLabels(a, config, review, origin, forge),
    originating,
    dryRun: a["dry-run"] ?? false,
  });
  printResult(a, result);
  return 0;
}

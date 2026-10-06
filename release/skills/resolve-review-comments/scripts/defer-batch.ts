#!/usr/bin/env bun
// @bun

// skills/resolve-review-comments/scripts/lib/consumer.ts
import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
function consumerRoot(cwd = process.cwd()) {
  let current = resolve(cwd);
  let gitRoot;
  for (;; ) {
    if (existsSync(join(current, ".groundwork", "install.lock.json")))
      return current;
    if (!gitRoot && existsSync(join(current, ".git")))
      gitRoot = current;
    const parent = dirname(current);
    if (parent === current)
      break;
    current = parent;
  }
  return gitRoot ?? resolve(cwd);
}
function reviewConfig() {
  const override = process.env.GROUNDWORK_OVERLAY;
  const path = override || join(consumerRoot(), ".groundwork", "overlay.json");
  if (!existsSync(path)) {
    if (override)
      throw new Error(`consumer overlay is missing: ${path}`);
    return {};
  }
  const overlay = JSON.parse(readFileSync(path, "utf8"));
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay))
    throw new Error(`consumer overlay must be an object: ${path}`);
  const review = overlay.review;
  if (review === undefined)
    return {};
  if (!review || typeof review !== "object" || Array.isArray(review))
    throw new Error(`review must be an object: ${path}`);
  for (const [key, value] of Object.entries(review)) {
    if (key === "bots" && (!Array.isArray(value) || value.some((x) => typeof x !== "string")))
      throw new Error("review.bots must be a list of strings");
    if (["job_pattern", "deferral_team", "repo_label", "repo_slug"].includes(key) && typeof value !== "string")
      throw new Error(`review.${key} must be a string`);
    if (key === "taxonomy") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("review.taxonomy must be an object");
      if (["context_prefixes", "types", "repos"].some((field) => Object.hasOwn(value, field)) && !Object.hasOwn(value, "ownership_prefixes"))
        throw new Error("review.taxonomy.ownership_prefixes is required with context_prefixes, types, or repos; declare the ownership label prefixes before filing deferred findings");
      for (const [field, tokens] of Object.entries(value)) {
        if (["provenance_label", "epic_label"].includes(field)) {
          if (typeof tokens !== "string" || !tokens.trim())
            throw new Error(`review.taxonomy.${field} must be a nonempty string`);
        } else if (!Array.isArray(tokens) || !tokens.length || tokens.some((x) => typeof x !== "string" || !x.trim()) || new Set(tokens).size !== tokens.length)
          throw new Error(`review.taxonomy.${field} must contain distinct nonempty strings`);
      }
    }
  }
  return review;
}

// skills/resolve-review-comments/scripts/lib/cli.ts
import { realpathSync } from "fs";
import { resolve as resolve2 } from "path";
import { fileURLToPath } from "url";

class ExitError extends Error {
  code;
  constructor(code, message) {
    super(message ?? `exit ${code}`);
    this.code = code;
  }
}
function fail(code, ...lines) {
  for (const line of lines)
    console.error(line);
  throw new ExitError(code);
}
function runMain(name, main) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    if (e instanceof ExitError) {
      process.exitCode = e.code;
      return;
    }
    console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
function isEntryPoint(moduleUrl) {
  const argv1 = process.argv[1];
  if (argv1 === undefined)
    return false;
  try {
    return realpathSync(resolve2(argv1)) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
async function readStdinAll() {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin)
    s += chunk;
  return s;
}

// skills/resolve-review-comments/scripts/lib/ladder.ts
var SEVERITY_UNKNOWN = "unknown";
var CATEGORY_UNKNOWN = "unknown";
var CANONICAL_SEVERITIES = ["low", "medium", "high", "blocker"];

// skills/resolve-review-comments/scripts/defer-batch.ts
var LINEAR_API = "https://api.linear.app/graphql";
var LINEAR_TIMEOUT_MS = 30000;
var RUN_DEADLINE_MS = 5 * 60000;
var consumer = reviewConfig();
var BATCH_SIZES = consumer.taxonomy?.sizes ?? ["xs", "small"];
var PROVENANCE_LABEL = consumer.taxonomy?.provenance_label ?? "pr-followup";
var EPIC_LABEL = consumer.taxonomy?.epic_label ?? "epic";
var BATCH_REPOS = consumer.taxonomy?.repos ?? [];
var BATCH_TYPES = consumer.taxonomy?.types ?? [];
var REVIEW_CATEGORIES = consumer.taxonomy?.categories ?? [];
var CONTEXT_PREFIXES = consumer.taxonomy?.context_prefixes ?? [];
var OWNERSHIP_PREFIXES = consumer.taxonomy?.ownership_prefixes ?? [];
function isBatchableSize(name) {
  return BATCH_SIZES.includes(name);
}
var SEVERITY_TO_PRIORITY = {
  [SEVERITY_UNKNOWN]: 0,
  low: 4,
  medium: 3,
  high: 2,
  blocker: 1
};
{
  const expected = new Set([...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN]);
  const actual = new Set(Object.keys(SEVERITY_TO_PRIORITY));
  const missing = [...expected].filter((s) => !actual.has(s));
  const extra = [...actual].filter((s) => !expected.has(s));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`defer-batch: SEVERITY_TO_PRIORITY's keys no longer match the canonical severity vocabulary` + `${missing.length > 0 ? ` \u2014 missing [${missing.join(", ")}]` : ""}` + `${extra.length > 0 ? ` \u2014 stale [${extra.join(", ")}]` : ""}. ` + `Update SEVERITY_TO_PRIORITY (and PRIORITY_TO_SEVERITY) to match CANONICAL_SEVERITIES/SEVERITY_UNKNOWN.`);
  }
}
var PRIORITY_TO_SEVERITY = {
  0: SEVERITY_UNKNOWN,
  4: "low",
  3: "medium",
  2: "high",
  1: "blocker"
};
var SEVERITY_RANK_ORDER = [SEVERITY_UNKNOWN, ...CANONICAL_SEVERITIES];
function severityRank(severity) {
  return SEVERITY_RANK_ORDER.indexOf(severity);
}
function priorityReflectsSeverity(currentPriority, severity) {
  const currentSeverity = PRIORITY_TO_SEVERITY[currentPriority] ?? SEVERITY_UNKNOWN;
  return severityRank(currentSeverity) >= severityRank(severity);
}
function priorityAfterSeverity(currentPriority, severity) {
  if (priorityReflectsSeverity(currentPriority, severity)) {
    return currentPriority;
  }
  const priority = SEVERITY_TO_PRIORITY[severity];
  if (priority === undefined)
    throw new Error(`Unknown severity '${severity}'`);
  return priority;
}
var APPEND_ATTEMPTS = 3;
var RETRY_BASE_MS = 250;
var RETRY_MAX_MS = 2000;
function retryBackoffMs(attempt, random = Math.random) {
  const capped = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return Math.round(capped * (0.5 + random() / 2));
}
var realSleep = (ms, signal) => {
  if (signal?.aborted)
    return Promise.resolve();
  return new Promise((resolve3) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve3();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve3();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};
async function sleepUnlessAborted(ms, signal, sleeper) {
  if (signal.aborted)
    return;
  let onAbort = () => {
    return;
  };
  const aborted = new Promise((resolve3) => {
    onAbort = resolve3;
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([sleeper(ms, signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function batchTitle(pr, type) {
  return `PR #${pr} ${type} review follow-ups`;
}
function isBatchTitle(title, pr, type) {
  return title.trim().toLowerCase() === batchTitle(pr, type).toLowerCase();
}
function renderEntry(e) {
  const quoted = e.finding.trimEnd().split(`
`).map((l) => `> ${l}`.trimEnd()).join(`
`);
  const entryKey = e.entryKey ?? e.sourceUrl;
  const lines = [entryHeading(entryKey), ""];
  if (entryKey !== e.sourceUrl) {
    lines.push(`**Source comment**: ${e.sourceUrl}`, "");
  }
  lines.push(quoted, "", `**Severity**: ${e.severity}`, `**Category**: ${e.category}`, `**Why deferred**: ${e.reason}`);
  if (e.fix !== undefined && e.fix !== "") {
    lines.push(`**Fix sketch**: ${e.fix}`);
  }
  return lines.join(`
`);
}
function entryHeading(entryKey) {
  return `### ${entryKey}`;
}
var DEFAULT_REPO_SLUG = consumer.repo_slug ?? "";
function threadUrlPattern(repoSlug, pr) {
  const escaped = `${repoSlug}/pull/${pr}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https://github\\.com/${escaped}#discussion_r[0-9]+$`);
}
function commentUrlPattern(repoSlug, pr) {
  const escaped = `${repoSlug}/pull/${pr}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https://github\\.com/${escaped}#issuecomment-[0-9]+$`);
}
var FINDING_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function summaryEntryKey(commentUrl, fingerprint) {
  const match = /#issuecomment-([0-9]+)$/.exec(commentUrl);
  if (match === null) {
    throw new Error(`cannot derive a summary entry key from '${commentUrl}'`);
  }
  return `ai-review-backlog:issuecomment-${match[1]}:${fingerprint}`;
}
function headingEntryKey(line) {
  const heading = /^ {0,3}### (.*)$/.exec(line.trimEnd());
  if (heading === null)
    return null;
  const rest = (heading[1] ?? "").trim();
  const link = /^\[([^\]]*)\]\(<?([^)>]*)>?\)$/.exec(rest);
  return link ? link[2] || link[1] || "" : rest;
}
function entryHeadings(description) {
  const found = [];
  let fence = null;
  for (const line of description.split(`
`)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    let consumed = false;
    if (marker !== null) {
      const fenceText = marker[1] ?? "";
      const char = fenceText.charAt(0);
      const len = fenceText.length;
      const info = marker[2] ?? "";
      if (fence === null) {
        if (char !== "`" || !info.includes("`")) {
          fence = { char, len };
          consumed = true;
        }
      } else {
        if (char === fence.char && len >= fence.len && info.trim() === "") {
          fence = null;
        }
        consumed = true;
      }
    }
    if (consumed || fence !== null)
      continue;
    const key = headingEntryKey(line);
    if (key !== null)
      found.push(key);
  }
  return found;
}
function hasEntry(description, entryKey) {
  return entryHeadings(description).includes(entryKey);
}
function appendEntry(description, entry, entryKey) {
  if (hasEntry(description, entryKey)) {
    return { description, appended: false };
  }
  const base = description.trimEnd();
  return {
    description: base === "" ? entry : `${base}

${entry}`,
    appended: true
  };
}
function initialDescription(pr, originating, noParent) {
  const provenance = originating === "" ? `Batch of review deferrals from PR #${pr} (no originating issue \u2014 PR has no ticket).` : `Batch of review deferrals from PR #${pr}; originating issue ${originating}.`;
  const lines = [
    provenance,
    "",
    "Filed per the batch-by-default rule in",
    "`.claude/skills/resolve-review-comments/references/deferral-protocol.md` \xA7 Batching",
    "is the default. Each entry is self-contained: the review-source URL, the",
    "reviewer's finding quoted, and why it was deferred rather than fixed in the PR."
  ];
  if (noParent !== undefined) {
    const placement = noParent.rejectedEpic === null ? "" : noParent.rejectedEpic === "" ? " (the originating issue has no epic to inherit)." : ` Originating issue's epic is ${noParent.rejectedEpic} (rejected as unrelated).`;
    lines.push("", `**No epic parent**: ${noParent.reason}${placement}`);
  }
  lines.push("", "## Entries");
  return lines.join(`
`);
}
function noParentRationaleForRepair(hasParent) {
  if (hasParent)
    return;
  return {
    reason: "the batch was filed with no epic parent; the original reason was lost when its description was cleared and this repair could not recover it",
    rejectedEpic: null
  };
}
function descriptionForRepair(liveDescription, pr, originating, hasParent) {
  return liveDescription.trim() === "" ? initialDescription(pr, originating, noParentRationaleForRepair(hasParent)) : liveDescription;
}
function scaffoldPortion(description) {
  return description.split("## Entries", 1)[0] ?? description;
}
function placementMatchesFreshParent(description, hasParent) {
  const claimsNoParent = scaffoldPortion(description).includes("**No epic parent**");
  return claimsNoParent === !hasParent;
}
var TYPE_GROUP = "Type";
var SIZE_GROUP = "Size";
var REPO_GROUP = "Repo";
function groupOf(label) {
  return label.parent?.name ?? "";
}
var RELATED_TYPE = "related";
function isComplete(pageInfo) {
  return pageInfo?.hasNextPage === false;
}
function pickBatch(candidates) {
  return candidates.reduce((best, c) => c.createdAt < best.createdAt ? c : best);
}
function repoVerdict(labels, repoLabel) {
  const repo = labels.filter((l) => groupOf(l) === REPO_GROUP);
  if (repo.length === 0)
    return "unlabelled";
  if (repo.length > 1)
    return "ambiguous";
  return repo[0]?.name === repoLabel ? "this-repo" : "other-repo";
}
function missingSingleValued(present, wanted) {
  const add = [];
  const conflicts = [];
  for (const [group, want] of [
    [TYPE_GROUP, wanted.type],
    [SIZE_GROUP, wanted.size]
  ]) {
    const held = present.filter((l) => groupOf(l) === group);
    const has = held.map((l) => l.name).join(", ");
    if (held.length === 0) {
      add.push(want);
    } else if (held.length > 1) {
      conflicts.push({ group, has, duplicate: true });
    } else if (held[0]?.name !== want) {
      conflicts.push({ group, has, duplicate: false });
    }
  }
  return { add, conflicts };
}
function batchContractHolds(live, wanted, requiredContext, requiredExtras) {
  const problems = [];
  const repo = repoVerdict(live, wanted.repoLabel);
  if (repo !== "this-repo")
    problems.push(`Repo group is ${repo}`);
  if (!live.some((l) => l.name === PROVENANCE_LABEL)) {
    problems.push(`no ${PROVENANCE_LABEL} label`);
  }
  const single = missingSingleValued(live, wanted);
  for (const name of single.add)
    problems.push(`no ${name} label`);
  for (const c of single.conflicts) {
    if (c.duplicate)
      problems.push(`${c.group} holds ${c.has}`);
    else if (c.group === TYPE_GROUP)
      problems.push(`${TYPE_GROUP} is ${c.has}`);
    else if (c.group === SIZE_GROUP && !BATCH_SIZES.includes(c.has)) {
      problems.push(`${SIZE_GROUP} is ${c.has}, which is not batchable (${BATCH_SIZES.join("|")})`);
    }
  }
  const liveNames = new Set(live.map((l) => l.name));
  const missingContext = requiredContext.filter((n) => !liveNames.has(n));
  if (missingContext.length > 0) {
    problems.push(`missing context label(s): ${missingContext.join(", ")}`);
  }
  const missingExtras = requiredExtras.filter((n) => !liveNames.has(n));
  if (missingExtras.length > 0) {
    problems.push(`missing extra label(s): ${missingExtras.join(", ")}`);
  }
  return problems;
}
function inheritedContextLabels(labels) {
  return labels.filter((l) => CONTEXT_PREFIXES.some((prefix) => l.startsWith(prefix)));
}
function contextAfterReconcile(present, inherited, extras) {
  return inheritedContextLabels([...present, ...inherited, ...extras]);
}
function contextLabelsToAdd(present, inherited, extras) {
  const have = new Set(present);
  return [...new Set([...inherited, ...extras])].filter((n) => !have.has(n));
}
function repairableMissingLabels(live, wanted, requiredContext, requiredExtras) {
  const liveNames = new Set(live.map((l) => l.name));
  const repoIsAbsent = repoVerdict(live, wanted.repoLabel) === "unlabelled";
  return [
    ...new Set([
      ...liveNames.has(PROVENANCE_LABEL) ? [] : [PROVENANCE_LABEL],
      ...missingSingleValued(live, wanted).add,
      ...repoIsAbsent ? [wanted.repoLabel] : [],
      ...requiredContext.filter((n) => n !== wanted.repoLabel && !liveNames.has(n)),
      ...requiredExtras.filter((n) => n !== wanted.repoLabel && !liveNames.has(n))
    ])
  ];
}
function ownerDomainMismatches(batchLabels, incomingLabels) {
  const mismatches = [];
  for (const prefix of OWNERSHIP_PREFIXES) {
    const group = prefix.replace(/:$/, "");
    const batchHas = batchLabels.filter((l) => l.startsWith(prefix)).sort();
    const incomingHas = incomingLabels.filter((l) => l.startsWith(prefix)).sort();
    if (batchHas.length === 0 || incomingHas.length === 0)
      continue;
    const batchSet = new Set(batchHas);
    const sharesOwnership = incomingHas.some((l) => batchSet.has(l));
    if (!sharesOwnership)
      mismatches.push({ group, batchHas, incomingHas });
  }
  return mismatches;
}
function hasRelationTo(nodes, otherUuid) {
  return nodes.some((n) => n.type === RELATED_TYPE && (n.issue?.id === otherUuid || n.relatedIssue?.id === otherUuid));
}
function makeClient(token) {
  return async (query, variables, signal) => {
    let resp;
    try {
      resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.any([
          AbortSignal.timeout(LINEAR_TIMEOUT_MS),
          signal
        ])
      });
    } catch (e) {
      throw new Error(`Linear API unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      throw new Error(`Linear API HTTP ${resp.status}`);
    }
    const json = await resp.json();
    if (json.errors) {
      throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
    }
    return json.data ?? {};
  };
}
function assertComplete(pageInfo, what) {
  if (!isComplete(pageInfo)) {
    fail(1, `defer-batch: ${what} did not fit one page \u2014 refusing to act on a partial view. Acting on one mints a second batch issue under a key that already has one, or files a batch missing its context labels.`);
  }
}
function assertMutationOk(payload, what) {
  const success = payload?.success;
  if (success !== true) {
    fail(1, `defer-batch: Linear reported that ${what} did not succeed (success: ${String(success)}) \u2014 nothing was persisted; do NOT resolve the review thread.`);
  }
}
function assertNotAborted(signal, what) {
  if (signal.aborted) {
    fail(1, `defer-batch: aborted \u2014 the run-wide deadline elapsed before ${what} could be dispatched. Do NOT resolve the review thread: this run cannot show the finding is tracked.`);
  }
}
async function fetchLabels(linear, names, signal) {
  if (names.length === 0)
    return [];
  assertNotAborted(signal, "the workspace label lookup");
  const data = await linear(`query($names: [String!]!) { issueLabels(first: 100, filter: { name: { in: $names } }) {
       pageInfo { hasNextPage } nodes { id name parent { name } } } }`, { names }, signal);
  const conn = data.issueLabels;
  assertComplete(conn.pageInfo, "the workspace label lookup");
  const byName = new Map(conn.nodes.map((n) => [n.name, n]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    fail(1, `defer-batch: workspace labels not found: ${missing.join(", ")} \u2014 refusing to file or update a batch issue without its mandatory label groups.`);
  }
  return names.map((n) => byName.get(n));
}
function assertGroupMembership(labels, wanted) {
  const byGroup = [
    [TYPE_GROUP, wanted.type, "<type>"],
    [SIZE_GROUP, wanted.size, "--size"],
    [REPO_GROUP, wanted.repoLabel, "--repo-label"]
  ];
  for (const [group, name, flag] of byGroup) {
    const label = labels.find((l) => l.name === name);
    if (label === undefined)
      continue;
    const actual = groupOf(label);
    if (actual !== group) {
      fail(1, `defer-batch: ${flag} '${name}' is not a ${group}-group label in this workspace (group: ${actual === "" ? "none" : actual}) \u2014 it would file a batch with no ${group} label, and '${name}' would become the lookup key every later round misses.`);
    }
  }
  for (const label of labels) {
    const group = groupOf(label);
    const wantedForGroup = byGroup.find(([g]) => g === group);
    if (wantedForGroup === undefined)
      continue;
    if (label.name !== wantedForGroup[1]) {
      fail(1, `defer-batch: label '${label.name}' is in the single-valued ${group} group, which ${wantedForGroup[2]} already sets to '${wantedForGroup[1]}' \u2014 one issue cannot carry two. Drop it from --labels, or pass it as ${wantedForGroup[2]}.`);
    }
  }
}
async function createRelated(linear, batchId, originatingUuid, signal) {
  const data = await linear(`mutation($issueId: String!, $relatedIssueId: String!) {
       issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: related }) { success }
     }`, { issueId: batchId, relatedIssueId: originatingUuid }, signal);
  assertMutationOk(data.issueRelationCreate, "the related-link creation");
}
var FIND_BATCHES = `query($search: String!) { issues(first: 50, filter: {
     title: { containsIgnoreCase: $search },
     state: { type: { nin: ["completed", "canceled"] } }
   }) {
     pageInfo { hasNextPage }
     nodes { id identifier title url description createdAt priority
       parent { id }
       labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       relations(first: 50) { pageInfo { hasNextPage } nodes { type issue { id } relatedIssue { id } } }
       inverseRelations(first: 50) { pageInfo { hasNextPage } nodes { type issue { id } relatedIssue { id } } }
     } } }`;
var USAGE = `usage: defer-batch.ts [--batch] <PR#> <type> (--thread-url <url> | --comment-url <url> --fingerprint <marker-safe>) --reason <text> \\
         --severity <blocker|high|medium|low|unknown> --category <cat|unknown> \\
         --originating <TEAM-1234|none> [--team <KEY>] [--fix <text>] \\
         [--size xs|small] [--repo-label <name>] [--repo-slug owner/name] \\
         [--labels a,b] [--no-parent --no-parent-reason <text>] [--dry-run] \\
         < finding.txt
The reviewer's finding is read from stdin (quoted heredoc or file) \u2014 never an argument.`;
var VALUE_FLAGS = [
  "thread-url",
  "comment-url",
  "fingerprint",
  "reason",
  "severity",
  "category",
  "originating",
  "team",
  "fix",
  "size",
  "repo-label",
  "repo-slug",
  "labels",
  "no-parent-reason"
];
var BOOLEAN_FLAGS = ["batch", "no-parent", "dry-run"];
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const seen = new Set;
  let noParent = false;
  let dryRun = false;
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined)
      continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const isBoolean = BOOLEAN_FLAGS.includes(name);
      if (!isBoolean && !VALUE_FLAGS.includes(name)) {
        return `unknown option ${a} \u2014 supported: ${[...BOOLEAN_FLAGS, ...VALUE_FLAGS].map((f) => `--${f}`).join(" ")}`;
      }
      if (seen.has(name))
        return `${a} given more than once`;
      seen.add(name);
      if (name === "batch")
        continue;
      if (name === "no-parent") {
        noParent = true;
        continue;
      }
      if (name === "dry-run") {
        dryRun = true;
        continue;
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        return `missing value for ${a}`;
      }
      opts[name] = v;
      i++;
      continue;
    }
    positional.push(a);
  }
  if (positional.length !== 2)
    return "expected exactly <PR#> and <type>";
  const [pr, type] = positional;
  if (pr === undefined || type === undefined)
    return "expected exactly <PR#> and <type>";
  if (!/^[0-9]+$/.test(pr))
    return `PR number must be digits, got '${pr}'`;
  if (!BATCH_TYPES.includes(type)) {
    return `<type> must be one of ${BATCH_TYPES.join("|")}, got '${type}' \u2014 the repository's declared Type taxonomy (consumer review.taxonomy.types)`;
  }
  const repoSlug = opts["repo-slug"] ?? DEFAULT_REPO_SLUG;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug)) {
    return `--repo-slug must look like owner/name, got '${repoSlug}'`;
  }
  const threadUrl = opts["thread-url"] ?? "";
  const commentUrl = opts["comment-url"] ?? "";
  const fingerprint = opts.fingerprint ?? "";
  if (threadUrl === "" === (commentUrl === "")) {
    return "provide exactly one source: --thread-url, or --comment-url with --fingerprint";
  }
  let sourceUrl;
  let entryKey;
  if (threadUrl !== "") {
    if (!threadUrlPattern(repoSlug, pr).test(threadUrl)) {
      return `--thread-url must be a GitHub review-thread URL on this PR \u2014 https://github.com/${repoSlug}/pull/${pr}#discussion_r<id> \u2014 got '${threadUrl}'`;
    }
    if (fingerprint !== "") {
      return "--fingerprint is valid only with --comment-url";
    }
    sourceUrl = threadUrl;
    entryKey = threadUrl;
  } else {
    if (!commentUrlPattern(repoSlug, pr).test(commentUrl)) {
      return `--comment-url must be a GitHub PR conversation-comment URL on this PR \u2014 https://github.com/${repoSlug}/pull/${pr}#issuecomment-<id> \u2014 got '${commentUrl}'`;
    }
    if (!FINDING_FINGERPRINT.test(fingerprint)) {
      return `--fingerprint must be the reviewer's marker-safe finding fingerprint (alphanumeric, optionally with '.', '_', '-', starting alphanumeric), got '${fingerprint}'`;
    }
    sourceUrl = commentUrl;
    entryKey = summaryEntryKey(commentUrl, fingerprint);
  }
  const reason = opts.reason ?? "";
  if (reason === "")
    return "--reason is required";
  for (const [flag, value] of [
    ["--reason", reason],
    ["--fix", opts.fix ?? ""],
    ["--no-parent-reason", opts["no-parent-reason"] ?? ""]
  ]) {
    if (/[\r\n]/.test(value)) {
      return `${flag} must be a single line \u2014 a line break in it can forge the '${entryHeading("<url>")}' marker that keys the idempotent append`;
    }
  }
  const severity = opts.severity ?? "";
  const validSeverities = [...CANONICAL_SEVERITIES, SEVERITY_UNKNOWN];
  if (severity === "") {
    return `--severity is required (${validSeverities.join("|")}) \u2014 it sets the batch's Linear priority, and the whole point of this flag is that severity must never be silently dropped`;
  }
  if (!validSeverities.includes(severity)) {
    return `--severity must be one of ${validSeverities.join("|")}, got '${severity}'`;
  }
  const category = opts.category ?? "";
  const validCategories = [...REVIEW_CATEGORIES, CATEGORY_UNKNOWN];
  if (category === "") {
    return `--category is required (${validCategories.join("|")}) \u2014 an omitted flag can silently discard a real parsed value; pass '${CATEGORY_UNKNOWN}' explicitly when there is none`;
  }
  if (!validCategories.includes(category)) {
    return `--category must be one of ${validCategories.join("|")}, got '${category}' \u2014 the repository's declared category taxonomy (consumer review.taxonomy.categories)`;
  }
  const originatingRaw = opts.originating ?? "";
  if (originatingRaw === "") {
    return "--originating is required (an issue id, or the literal `none` when the PR has no ticket)";
  }
  const originating = originatingRaw === "none" ? "" : originatingRaw;
  if (originating !== "" && !/^[A-Z]+-[0-9]+$/.test(originating)) {
    return `--originating must look like TASK-1234 or be 'none', got '${originatingRaw}'`;
  }
  if (originating === "" && (opts.team ?? consumer.deferral_team ?? "") === "") {
    return "--team <KEY> is required with --originating none";
  }
  const repoLabel = opts["repo-label"] ?? consumer.repo_label ?? "";
  if (!BATCH_REPOS.includes(repoLabel)) {
    return `--repo-label must be one of ${BATCH_REPOS.join("|")}, got '${repoLabel}' \u2014 the repository's declared Repo taxonomy (consumer review.taxonomy.repos)`;
  }
  const extraLabels = (opts.labels ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  for (const name of extraLabels) {
    const owner = BATCH_TYPES.includes(name) ? "<type>" : BATCH_SIZES.includes(name) ? "--size" : BATCH_REPOS.includes(name) ? "--repo-label" : "";
    if (owner !== "") {
      return `--labels may not carry '${name}' \u2014 it belongs to a single-valued mandatory group, which ${owner} already sets. Passing it here adds a SECOND label to that group when the batch's live value differs.`;
    }
  }
  const size = opts.size ?? "small";
  if (!BATCH_SIZES.includes(size)) {
    return `--size must be one of ${BATCH_SIZES.join("|")}, got '${size}' \u2014 a fix sizing above 'small' gets its own issue, not a batch entry (deferral-protocol.md \xA7 Batching is the default)`;
  }
  const noParentReason = opts["no-parent-reason"] ?? "";
  if (noParent && noParentReason === "") {
    return "--no-parent requires --no-parent-reason <text> \u2014 the protocol files a parentless follow-up only with the domain mismatch stated in its description (deferral-protocol.md \xA7 Parent)";
  }
  if (!noParent && noParentReason !== "") {
    return "--no-parent-reason has no effect without --no-parent";
  }
  return {
    pr,
    type,
    sourceUrl,
    entryKey,
    reason,
    severity,
    category,
    originating,
    team: opts.team ?? consumer.deferral_team ?? "",
    fix: opts.fix ?? "",
    size,
    repoLabel,
    repoSlug,
    extraLabels,
    noParent,
    noParentReason,
    dryRun
  };
}
async function rebuildDescriptionAndLabels(linear, liveDescription, hasParent, liveLabels, entry, args, wantedForRepair, requiredContext, signal) {
  const description = appendEntry(descriptionForRepair(liveDescription, args.pr, args.originating, hasParent), entry, args.entryKey).description;
  const missingLabels = repairableMissingLabels(liveLabels, wantedForRepair, requiredContext, args.extraLabels);
  const addLabels = missingLabels.length > 0 ? await fetchLabels(linear, missingLabels, signal) : [];
  if (addLabels.length > 0)
    assertGroupMembership(addLabels, wantedForRepair);
  return {
    description,
    needsDescriptionWrite: description !== liveDescription,
    scaffoldWasWiped: liveDescription.trim() === "",
    missingLabels,
    addLabels
  };
}
function abortOnOwnershipMismatch(liveLabelNames, incomingOwnership, identifier) {
  const freshMismatches = ownerDomainMismatches(liveLabelNames, incomingOwnership);
  if (freshMismatches.length > 0) {
    fail(1, `defer-batch: ${identifier}'s ownership changed mid-append to ${freshMismatches.map((m) => `${m.group}:(${m.batchHas.join(", ")})`).join(", ")}, which shares nothing with this finding's ${freshMismatches.map((m) => `${m.group}:(${m.incomingHas.join(", ")})`).join(", ")} \u2014 a concurrent writer moved this batch to a different owner. Re-adding the erased label would silently fold a differently-owned finding into it. Do NOT resolve the review thread. Re-run once the ownership change is resolved, or file this finding individually.`);
  }
}
async function appendWithRetry(linear, target, seedDescription, seedWasRepaired, needsInitialWrite, seedAddLabels, seedMissingLabels, entry, args, originalSize, originalPriority, incomingOwnership, requiredContext, signal, sleep = realSleep, needsInitialDescriptionWrite) {
  const wantedForRepair = { ...args, size: originalSize };
  let liveLabels = [];
  let livePriority = originalPriority;
  let description = seedDescription;
  let missingLabels = seedMissingLabels;
  let addLabels = seedAddLabels;
  let needsWrite = needsInitialWrite;
  let needsDescriptionWrite = needsInitialDescriptionWrite;
  let unconfirmed = "";
  let everRebuiltScaffold = seedWasRepaired;
  const labelsEverAdded = new Set;
  const checkDeadline = (attempt) => {
    if (signal.aborted) {
      fail(1, `defer-batch: aborted \u2014 the run-wide deadline elapsed before ${target.identifier} could be confirmed (attempt ${attempt}/${APPEND_ATTEMPTS}). Do NOT resolve the review thread: this run cannot show the finding is tracked. Re-run once Linear is responsive.`);
    }
  };
  checkDeadline(1);
  if (needsWrite && (needsInitialDescriptionWrite || !priorityReflectsSeverity(originalPriority, args.severity))) {
    const primed = await linear(`query($id: String!) { issue(id: $id) {
         description
         parent { id }
         priority
         labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       } }`, { id: target.id }, signal);
    const primedIssue = primed.issue;
    if (!primedIssue) {
      fail(1, `defer-batch: ${target.identifier} disappeared mid-append`);
    }
    assertComplete(primedIssue.labels.pageInfo, `the labels on ${target.identifier} before the first append attempt`);
    livePriority = primedIssue.priority;
    liveLabels = primedIssue.labels.nodes;
    abortOnOwnershipMismatch(liveLabels.map((l) => l.name), incomingOwnership, target.identifier);
    const rebuilt = await rebuildDescriptionAndLabels(linear, primedIssue.description ?? "", primedIssue.parent != null, liveLabels, entry, args, wantedForRepair, requiredContext, signal);
    description = rebuilt.description;
    needsDescriptionWrite = rebuilt.needsDescriptionWrite;
    everRebuiltScaffold = rebuilt.scaffoldWasWiped;
    missingLabels = rebuilt.missingLabels;
    addLabels = rebuilt.addLabels;
  }
  for (let attempt = 1;attempt <= APPEND_ATTEMPTS; attempt++) {
    checkDeadline(attempt);
    if (needsWrite) {
      const targetPriority = priorityAfterSeverity(livePriority, args.severity);
      const priorityChanged = targetPriority !== livePriority;
      if (needsDescriptionWrite || priorityChanged) {
        const updateData = await linear(`mutation($id: String!, $input: IssueUpdateInput!) {
             issueUpdate(id: $id, input: $input) { success }
           }`, {
          id: target.id,
          input: {
            ...needsDescriptionWrite ? { description } : {},
            ...priorityChanged ? { priority: targetPriority } : {}
          }
        }, signal);
        assertMutationOk(updateData.issueUpdate, `the update to ${target.identifier}`);
      }
      for (const l of addLabels) {
        const addData = await linear(`mutation($id: String!, $labelId: String!) {
             issueAddLabel(id: $id, labelId: $labelId) { success }
           }`, { id: target.id, labelId: l.id }, signal);
        assertMutationOk(addData.issueAddLabel, `adding '${l.name}' to ${target.identifier}`);
        labelsEverAdded.add(l.name);
      }
    }
    const fresh = await linear(`query($id: String!) { issue(id: $id) {
         description
         parent { id }
         priority
         labels(first: 50) { pageInfo { hasNextPage } nodes { id name parent { name } } }
       } }`, { id: target.id }, signal);
    const issue = fresh.issue;
    if (!issue) {
      fail(1, `defer-batch: ${target.identifier} disappeared mid-append`);
    }
    assertComplete(issue.labels.pageInfo, `the labels on ${target.identifier} after the append`);
    liveLabels = issue.labels.nodes;
    livePriority = issue.priority;
    const liveDescription = issue.description ?? "";
    const liveNames = new Set(liveLabels.map((l) => l.name));
    const entryOk = hasEntry(liveDescription, args.entryKey);
    const stillMissing = missingLabels.filter((n) => !liveNames.has(n));
    const contractProblems = batchContractHolds(liveLabels, args, requiredContext, args.extraLabels);
    const priorityOk = priorityReflectsSeverity(livePriority, args.severity);
    if (entryOk && stillMissing.length === 0 && contractProblems.length === 0 && priorityOk) {
      if (everRebuiltScaffold && !placementMatchesFreshParent(liveDescription, issue.parent != null)) {
        const claimsNoParent = scaffoldPortion(liveDescription).includes("**No epic parent**");
        const surgery = claimsNoParent ? 'remove the "**No epic parent**: \u2026" line (and the blank line directly above it)' : 'add a "**No epic parent**: \u2026" line directly above the "## Entries" heading';
        fail(1, `defer-batch: ${target.identifier}'s description claims ${claimsNoParent ? "no epic parent" : "a parent"}, but the freshly read issue ${issue.parent != null ? "HAS" : "has NO"} parent \u2014 a reparent or unparent raced this run's rebuild of a wiped description between the initial lookup and the write, and that write already landed. Do NOT resolve the review thread. Re-running will NOT self-heal this: the persisted description is no longer empty, so the next run will not rebuild it. Manually edit ${target.identifier}'s description in Linear: ${surgery}. Edit ONLY that scaffold line, above "## Entries" \u2014 do NOT blank the whole description, which would also delete every tracked entry below it (including any a concurrent writer appended since this run's own write). Then re-run.`);
      }
      return {
        confirmed: true,
        labelsAdded: [...labelsEverAdded],
        unconfirmed: ""
      };
    }
    unconfirmed = [
      entryOk ? "" : "the entry",
      stillMissing.length === 0 ? "" : `label(s) ${stillMissing.join(", ")}`,
      contractProblems.length === 0 ? "" : `the batch contract (${contractProblems.join("; ")})`,
      priorityOk ? "" : `the priority (finding severity '${args.severity}' needs the batch's Linear priority to reflect AT LEAST that severity; live priority is ${livePriority} \u2014 '${PRIORITY_TO_SEVERITY[livePriority] ?? SEVERITY_UNKNOWN}', which is less severe)`
    ].filter((x) => x !== "").join(" and ");
    abortOnOwnershipMismatch([...liveNames], incomingOwnership, target.identifier);
    if (attempt === APPEND_ATTEMPTS)
      break;
    await sleepUnlessAborted(retryBackoffMs(attempt), signal, sleep);
    checkDeadline(attempt);
    const rebuilt = await rebuildDescriptionAndLabels(linear, liveDescription, issue.parent != null, liveLabels, entry, args, wantedForRepair, requiredContext, signal);
    description = rebuilt.description;
    needsDescriptionWrite = rebuilt.needsDescriptionWrite;
    everRebuiltScaffold = everRebuiltScaffold || rebuilt.scaffoldWasWiped;
    missingLabels = rebuilt.missingLabels;
    addLabels = rebuilt.addLabels;
    needsWrite = true;
  }
  return {
    confirmed: false,
    labelsAdded: [...labelsEverAdded],
    unconfirmed
  };
}
async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string")
    fail(2, `defer-batch: ${parsed}`, "", USAGE);
  const args = parsed;
  const finding = (await readStdinAll()).trim();
  if (finding === "") {
    fail(2, "defer-batch: the finding body on stdin was empty", "", USAGE);
  }
  const token = [process.env.LINEAR_API_TOKEN, process.env.LINEAR_API_KEY].find((v) => v !== undefined && v !== "") ?? "";
  if (token === "") {
    fail(1, "defer-batch: LINEAR_API_TOKEN (or LINEAR_API_KEY) is required \u2014 the batch issue lives in Linear.");
  }
  const linear = makeClient(token);
  return runDeferBatch(linear, args, finding);
}
async function runDeferBatch(linear, args, finding, signal = AbortSignal.timeout(RUN_DEADLINE_MS)) {
  assertNotAborted(signal, "this run's first call");
  if (args.severity === "blocker") {
    console.error("defer-batch: WARNING \u2014 deferring a 'blocker' severity finding. A deferred blocker is a contradiction (references/deferral-protocol.md \xA7 When to defer): it should have been fixed in the PR or escalated to a human, not batched. Filing it anyway so it is tracked, at Urgent priority.");
  }
  let teamId = "";
  let parentId;
  let projectId;
  let projectMilestoneId;
  let originatingUuid = "";
  let rejectedEpic = "";
  let inherited = [];
  if (args.originating !== "") {
    const data = await linear(`query($id: String!) { issue(id: $id) {
         id team { id } parent { id identifier }
         project { id } projectMilestone { id }
         labels(first: 50) { pageInfo { hasNextPage } nodes { name } }
       } }`, { id: args.originating }, signal);
    const issue = data.issue;
    if (!issue) {
      fail(1, `defer-batch: originating issue ${args.originating} not found`);
    }
    assertComplete(issue.labels.pageInfo, `the labels on originating issue ${args.originating}`);
    originatingUuid = issue.id;
    teamId = issue.team.id;
    rejectedEpic = issue.parent?.identifier ?? "";
    const originatingIsEpic = issue.labels.nodes.some((n) => n.name === EPIC_LABEL);
    if (!args.noParent && !originatingIsEpic && issue.parent) {
      parentId = issue.parent.id;
    }
    if (parentId === undefined) {
      projectId = issue.project?.id;
      projectMilestoneId = issue.projectMilestone?.id;
    }
    inherited = inheritedContextLabels(issue.labels.nodes.map((n) => n.name));
  } else {
    assertNotAborted(signal, "the team lookup");
    const data = await linear(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }`, { key: args.team }, signal);
    const nodes = data.teams.nodes;
    if (nodes.length !== 1) {
      fail(1, `defer-batch: team key '${args.team}' did not resolve to one team`);
    }
    const team = nodes[0];
    if (team === undefined)
      throw new Error("Team lookup returned no result");
    teamId = team.id;
  }
  const noParentRationale = args.noParent ? { reason: args.noParentReason, rejectedEpic } : undefined;
  assertNotAborted(signal, "the FIND_BATCHES lookup");
  const found = await linear(FIND_BATCHES, { search: batchTitle(args.pr, args.type) }, signal);
  const foundConn = found.issues;
  assertComplete(foundConn.pageInfo, `the open \`pr-followup\` issues matching '${batchTitle(args.pr, args.type)}'`);
  const titleMatches = (foundConn.nodes ?? []).filter((c) => isBatchTitle(c.title, args.pr, args.type));
  for (const c of titleMatches) {
    assertComplete(c.labels.pageInfo, `the labels on ${c.identifier}`);
  }
  const candidates = [];
  for (const c of titleMatches) {
    const verdict = repoVerdict(c.labels.nodes, args.repoLabel);
    if (verdict === "this-repo") {
      candidates.push(c);
    } else if (verdict === "other-repo") {
      console.error(`defer-batch: ignoring ${c.identifier} \u2014 same title, different Repo label than '${args.repoLabel}'.`);
    } else if (verdict === "ambiguous") {
      fail(1, `defer-batch: ${c.identifier} matches the batch key '${batchTitle(args.pr, args.type)}' but carries MORE THAN ONE Repo label, so which repository it belongs to is undecidable even though '${args.repoLabel}' is among them. Fix ${c.identifier}'s Repo group in Linear, then re-run.`);
    } else {
      fail(1, `defer-batch: ${c.identifier} matches the batch key '${batchTitle(args.pr, args.type)}' but carries no Repo label, so there is no way to tell whether it is this repository's batch or another's. Refusing to append: claiming it would file this finding into someone else's backlog AND stamp that issue '${args.repoLabel}'. Label ${c.identifier} with its Repo group in Linear, then re-run.`);
    }
  }
  const entry = renderEntry({
    sourceUrl: args.sourceUrl,
    entryKey: args.entryKey,
    finding,
    reason: args.reason,
    severity: args.severity,
    category: args.category,
    fix: args.fix === "" ? undefined : args.fix
  });
  let identifier;
  let url;
  let created = false;
  let appended = false;
  let alreadyPresent = false;
  let labelsAdded = [];
  let relatedLinked = false;
  if (candidates.length > 0) {
    const target = pickBatch(candidates);
    for (const c of candidates) {
      if (c !== target) {
        console.error(`defer-batch: WARNING \u2014 duplicate open batch issue ${c.identifier} under the same key; appending to the oldest (${target.identifier}). Merge the duplicates.`);
      }
    }
    assertComplete(target.relations.pageInfo, `the relations on ${target.identifier}`);
    assertComplete(target.inverseRelations.pageInfo, `the inverse relations on ${target.identifier}`);
    identifier = target.identifier;
    url = target.url;
    const existingDescription = target.description ?? "";
    const seedWasRepaired = existingDescription.trim() === "";
    const baseDescription = descriptionForRepair(existingDescription, args.pr, args.originating, target.parent != null);
    const next = appendEntry(baseDescription, entry, args.entryKey);
    appended = next.appended || baseDescription !== existingDescription;
    alreadyPresent = !next.appended;
    const incomingOwnership = [...new Set([...inherited, ...args.extraLabels])];
    const ownerMismatches = ownerDomainMismatches(target.labels.nodes.map((n) => n.name), incomingOwnership);
    if (ownerMismatches.length > 0) {
      fail(1, `defer-batch: ${identifier} is owned by ${ownerMismatches.map((m) => `${m.group}:(${m.batchHas.join(", ")})`).join(", ")}, but this finding's originating issue carries ${ownerMismatches.map((m) => `${m.group}:(${m.incomingHas.join(", ")})`).join(", ")} \u2014 a finding owned by a different agent/domain than the rest of the batch gets its own issue, not a fold into this one (deferral-protocol.md \xA7 Filing the follow-up issue, lines 105-108). Drop --batch and file it individually.`);
    }
    const originalSize = target.labels.nodes.find((l) => groupOf(l) === SIZE_GROUP)?.name ?? args.size;
    const originalPriority = target.priority;
    const singleValued = missingSingleValued(target.labels.nodes, args);
    for (const c of singleValued.conflicts) {
      if (c.duplicate) {
        fail(1, `defer-batch: ${identifier} carries more than one ${c.group} label (${c.has}) \u2014 that group admits exactly one, so the batch is taxonomy-invalid and which value governs is undecidable. Fix ${identifier}'s ${c.group} group in Linear, then re-run.`);
      }
      if (c.group === SIZE_GROUP && !isBatchableSize(c.has)) {
        fail(1, `defer-batch: ${identifier} carries ${SIZE_GROUP} '${c.has}', which is not batchable (${BATCH_SIZES.join("|")}) \u2014 the protocol sends anything above 'small' to its own issue, so this batch must not collect further entries. File this finding individually instead.`);
      }
      if (c.group === TYPE_GROUP) {
        fail(1, `defer-batch: ${identifier} matches the key '${batchTitle(args.pr, args.type)}' but carries ${TYPE_GROUP} '${c.has}'. Type is the lookup key, so a batch whose Type disagrees with its title is mislabelled \u2014 appending here would file a '${args.type}' finding into a '${c.has}' batch. Fix ${identifier}'s Type in Linear, then re-run.`);
      }
      console.error(`defer-batch: NOTE \u2014 ${identifier} already carries ${c.group} '${c.has}'; keeping it. The group is satisfied, and this run's value is not authoritative over the batch's first entry.`);
    }
    const contextAfter = contextAfterReconcile(target.labels.nodes.map((n) => n.name), inherited, args.extraLabels);
    if (contextAfter.length === 0) {
      fail(1, `defer-batch: ${identifier} carries no agent:/domain:/codearea: label and this run supplies none to add \u2014 the Context group is mandatory on every issue (deferral-protocol.md \xA7 Filing the follow-up issue). Re-run with --labels domain:...,codearea:... .`);
    }
    const wantedForRepair = { ...args, size: originalSize };
    const missingLabels = repairableMissingLabels(target.labels.nodes, wantedForRepair, contextAfter, args.extraLabels);
    const needsRelation = originatingUuid !== "" && !hasRelationTo([...target.relations.nodes, ...target.inverseRelations.nodes], originatingUuid);
    let addLabels = [];
    if (missingLabels.length > 0) {
      addLabels = await fetchLabels(linear, missingLabels, signal);
      assertGroupMembership(addLabels, wantedForRepair);
    }
    if (args.dryRun) {
      const priorityBump = !priorityReflectsSeverity(originalPriority, args.severity);
      console.error(`defer-batch: dry-run \u2014 would ${appended ? "append to" : "skip (entry already present in)"} ${identifier}` + (missingLabels.length > 0 ? `, add label(s) ${missingLabels.join(", ")}` : "") + (priorityBump ? `, and bump priority to ${SEVERITY_TO_PRIORITY[args.severity]} (severity '${args.severity}', currently ${originalPriority})` : "") + (needsRelation ? `, and add the missing related link to ${args.originating}` : ""));
      process.stdout.write(`${JSON.stringify({
        identifier,
        url,
        title: batchTitle(args.pr, args.type),
        created: false,
        appended: false,
        alreadyPresent: false,
        labelsAdded: [],
        relatedLinked: false,
        dryRun: true
      })}
`);
      return 0;
    }
    {
      const retryResult = await appendWithRetry(linear, { id: target.id, identifier }, next.description, seedWasRepaired, appended || addLabels.length > 0 || !priorityReflectsSeverity(originalPriority, args.severity), addLabels, missingLabels, entry, args, originalSize, originalPriority, incomingOwnership, contextAfter, signal, undefined, appended);
      if (!retryResult.confirmed) {
        fail(1, `defer-batch: updated ${identifier} ${APPEND_ATTEMPTS} times and ${retryResult.unconfirmed} did not survive \u2014 a concurrent writer keeps overwriting it. Do NOT resolve the review thread: this run cannot show the finding is tracked. Re-run once the other agent has finished.`);
      }
      labelsAdded = retryResult.labelsAdded;
    }
    if (needsRelation) {
      await createRelated(linear, target.id, originatingUuid, signal);
      relatedLinked = true;
    }
  } else {
    const context = contextAfterReconcile([], inherited, args.extraLabels);
    if (context.length === 0) {
      fail(1, `defer-batch: no agent:/domain:/codearea: label to apply \u2014 the Context group is mandatory on every issue (deferral-protocol.md \xA7 Filing the follow-up issue). ${args.originating === "" ? "With --originating none there is nothing to inherit: pass --labels domain:...,codearea:... ." : `Originating issue ${args.originating} carries none either: pass --labels domain:...,codearea:... .`}`);
    }
    const wanted = [
      ...new Set([
        PROVENANCE_LABEL,
        args.type,
        args.size,
        args.repoLabel,
        ...inherited,
        ...args.extraLabels
      ])
    ];
    const labels = await fetchLabels(linear, wanted, signal);
    assertGroupMembership(labels, args);
    const labelIds = labels.map((l) => l.id);
    if (args.dryRun) {
      console.error(`defer-batch: dry-run \u2014 would create '${batchTitle(args.pr, args.type)}' and append the entry`);
      process.stdout.write(`${JSON.stringify({
        identifier: null,
        url: null,
        title: batchTitle(args.pr, args.type),
        created: false,
        appended: false,
        alreadyPresent: false,
        labelsAdded: [],
        relatedLinked: false,
        dryRun: true
      })}
`);
      return 0;
    }
    const desc = appendEntry(initialDescription(args.pr, args.originating, noParentRationale), entry, args.entryKey).description;
    assertNotAborted(signal, "the batch-issue creation");
    const createData = await linear(`mutation($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier url } }
       }`, {
      input: {
        teamId,
        title: batchTitle(args.pr, args.type),
        description: desc,
        labelIds,
        priority: SEVERITY_TO_PRIORITY[args.severity],
        ...parentId !== undefined ? { parentId } : {},
        ...projectId !== undefined ? { projectId } : {},
        ...projectMilestoneId !== undefined ? { projectMilestoneId } : {}
      }
    }, signal);
    const createPayload = createData.issueCreate;
    assertMutationOk(createPayload, "the batch-issue creation");
    const createdIssue = createPayload?.issue;
    if (!createdIssue) {
      fail(1, "defer-batch: issueCreate reported success but returned no issue");
    }
    identifier = createdIssue.identifier;
    url = createdIssue.url;
    created = true;
    appended = true;
    labelsAdded = wanted;
    const after = await linear(FIND_BATCHES, { search: batchTitle(args.pr, args.type) }, signal);
    const afterConn = after.issues;
    assertComplete(afterConn.pageInfo, `the post-create re-query for '${batchTitle(args.pr, args.type)}'`);
    const sameKey = (afterConn.nodes ?? []).filter((c) => isBatchTitle(c.title, args.pr, args.type) && c.id !== createdIssue.id);
    for (const c of sameKey) {
      assertComplete(c.labels.pageInfo, `the labels on ${c.identifier}`);
    }
    const others = [];
    for (const c of sameKey) {
      const verdict = repoVerdict(c.labels.nodes, args.repoLabel);
      if (verdict === "this-repo") {
        others.push(c);
      } else if (verdict !== "other-repo") {
        fail(1, `defer-batch: created ${identifier}, then found ${c.identifier} under the same batch key '${batchTitle(args.pr, args.type)}' whose Repo group is ${verdict} \u2014 ownership is undecidable, so this run cannot say whether it just made a duplicate. ${identifier} exists and carries the entry; do NOT resolve the review thread yet. Fix ${c.identifier}'s Repo group (and merge if it is a duplicate), then re-run.`);
      }
    }
    for (const c of others) {
      console.error(`defer-batch: WARNING \u2014 ${c.identifier} carries the same batch key '${batchTitle(args.pr, args.type)}' as the ${identifier} just created; a concurrent run created one too. Both are open: merge them, keeping the oldest.`);
    }
    if (originatingUuid !== "") {
      await createRelated(linear, createdIssue.id, originatingUuid, signal);
      relatedLinked = true;
    }
  }
  process.stdout.write(`${JSON.stringify({
    identifier,
    url,
    title: batchTitle(args.pr, args.type),
    created,
    appended,
    alreadyPresent,
    labelsAdded,
    relatedLinked
  })}
`);
  console.error(`defer-batch: ${created ? "created" : alreadyPresent ? "entry already present in" : "appended to"} ${identifier} \u2014 reply with:`);
  console.error(`  **deferred** \u2014 ${args.reason}; batched in ${identifier}: ${url}`);
  return 0;
}
if (isEntryPoint(import.meta.url))
  runMain("defer-batch", main);
export {
  APPEND_ATTEMPTS,
  BATCH_REPOS,
  BATCH_SIZES,
  BATCH_TYPES,
  DEFAULT_REPO_SLUG,
  EPIC_LABEL,
  FINDING_FINGERPRINT,
  PRIORITY_TO_SEVERITY,
  PROVENANCE_LABEL,
  RELATED_TYPE,
  REPO_GROUP,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  REVIEW_CATEGORIES,
  RUN_DEADLINE_MS,
  SEVERITY_RANK_ORDER,
  SEVERITY_TO_PRIORITY,
  SIZE_GROUP,
  TYPE_GROUP,
  appendEntry,
  appendWithRetry,
  batchContractHolds,
  batchTitle,
  commentUrlPattern,
  contextAfterReconcile,
  contextLabelsToAdd,
  descriptionForRepair,
  entryHeading,
  entryHeadings,
  groupOf,
  hasEntry,
  hasRelationTo,
  headingEntryKey,
  inheritedContextLabels,
  initialDescription,
  isBatchTitle,
  isBatchableSize,
  isComplete,
  missingSingleValued,
  noParentRationaleForRepair,
  ownerDomainMismatches,
  parseArgs,
  pickBatch,
  placementMatchesFreshParent,
  priorityAfterSeverity,
  priorityReflectsSeverity,
  renderEntry,
  repairableMissingLabels,
  repoVerdict,
  retryBackoffMs,
  runDeferBatch,
  scaffoldPortion,
  severityRank,
  summaryEntryKey,
  threadUrlPattern
};

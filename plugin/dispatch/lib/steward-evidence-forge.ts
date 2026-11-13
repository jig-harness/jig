/** Bounded forge evidence for the steward; it never authorizes an effect. */
import { isRecord } from "../../shared/guards.ts";
import { failed, ok } from "../../shared/outcome.ts";
import { ghRepoEnv } from "../../skills/drive-pr/scripts/lib/proc.ts";
import type { ReadRecord } from "./launches.ts";
import type { RepoObservation } from "./tick-observe.ts";
import { mentionedKeys, workLinks } from "./work-links.ts";
import {
  evidenceCommand,
  type EvidenceRead,
  type EvidenceRoom,
} from "./steward-evidence-git.ts";

export interface LinkedPullRequest {
  number: number;
  url: string;
  state: string;
  headRefName: string;
  createdAt: string;
  /** Inferred pickup origin from its handoff, workspace branch and creation time; null means unknown, never authority. */
  launch: string | null;
  launchProvenance: "inferred" | "unknown";
}
export interface CheckConclusion {
  conclusion: string | null;
  at?: string;
  url?: string;
}
export interface CheckHistory {
  name: string;
  source?: string;
  head: CheckConclusion[];
  base: CheckConclusion[];
}
export interface PullRequestChecks {
  pr: number;
  head: string;
  base: string;
  recentLimit: number;
  truncated: boolean;
  failing: CheckHistory[];
}

export type EvidenceJson = (
  args: string[],
  observation: RepoObservation,
  room: EvidenceRoom,
) => Promise<EvidenceRead<unknown>>;

async function json(
  args: string[],
  observation: RepoObservation,
  room: EvidenceRoom,
): Promise<EvidenceRead<unknown>> {
  const out = await evidenceCommand(
    ["gh", ...args],
    observation.opened.repo.path,
    room,
    ghRepoEnv(),
  );
  if (!out.ok) return out;
  try {
    return ok(JSON.parse(out.value));
  } catch (error) {
    return failed(
      "unreadable",
      "the steward's forge evidence was not JSON",
      error,
    );
  }
}

export async function linkedPullRequests(
  target: string,
  observation: RepoObservation,
  records: ReadRecord[],
  room: EvidenceRoom,
  readJson: EvidenceJson = json,
): Promise<EvidenceRead<LinkedPullRequest[]>> {
  const { repo } = observation.opened;
  const keys = observation.join?.keys;
  if (!keys)
    return failed("unreadable", "the tracker's key rules did not read");
  const read = await readJson(
    [
      "pr",
      "list",
      "--repo",
      repo.slug,
      "--state",
      "all",
      "--search",
      `${JSON.stringify(target)} in:body`,
      "--limit",
      "50",
      "--json",
      "number,url,state,headRefName,body,createdAt",
    ],
    observation,
    room,
  );
  if (!read.ok) return read;
  if (!Array.isArray(read.value) || read.value.length >= 50)
    return failed(
      "unreadable",
      "the item's pull requests did not read in full (limit 50)",
    );
  const prs: Array<LinkedPullRequest & { body: string }> = [];
  for (const p of read.value) {
    if (
      !isRecord(p) ||
      !Number.isInteger(p.number) ||
      typeof p.url !== "string" ||
      typeof p.state !== "string" ||
      typeof p.headRefName !== "string" ||
      typeof p.body !== "string" ||
      typeof p.createdAt !== "string"
    )
      return failed(
        "unreadable",
        "the item's pull request listing has unreadable fields",
      );
    if (p.state !== "OPEN" && p.state !== "MERGED") continue;
    const number = Number(p.number);
    const launch =
      records.find(
        (r) =>
          r.record.repo === repo.slug &&
          r.record.action === "pickup" &&
          r.record.item === target &&
          observation.sessions?.ok === true &&
          observation.sessions.workspaces.some(
            (w) =>
              w.path === r.record.workspace?.path &&
              w.branch === p.headRefName &&
              w.prs.includes(number),
          ) &&
          Date.parse(p.createdAt as string) >= Date.parse(r.record.createdAt) &&
          r.next !== null &&
          r.next !== undefined &&
          "address" in r.next &&
          r.next.address === `drive@${repo.slug}#${number}`,
      )?.record.id ?? null;
    prs.push({
      number,
      url: p.url,
      state: p.state,
      headRefName: p.headRefName,
      createdAt: p.createdAt,
      body: p.body,
      launch,
      launchProvenance: launch === null ? "unknown" : "inferred",
    });
  }
  const links = workLinks(
    prs.map((p) => ({ ...p, closing: [] })),
    {
      keys,
      branchPattern: observation.join.branchPattern,
      repository: repo.slug,
      issueRepository: observation.tracked.issueRepository,
    },
  );
  return ok(
    prs
      .filter(
        (p) =>
          links.itemsOf(p.number)?.includes(target) ||
          ((!keys.sharesPullRequestNumbers ||
            observation.tracked.issueRepository?.toLowerCase() ===
              repo.slug.toLowerCase()) &&
            mentionedKeys(p.body, keys).includes(target)),
      )
      .map(({ body: _body, ...p }) => p),
  );
}

interface NamedConclusion extends CheckConclusion {
  name: string;
  source: string;
  started: string;
  id: number | null;
}
function textField(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof row[key] === "string" ? row[key] : undefined;
}

function conclusionIdentity(
  row: Record<string, unknown>,
  name: string,
  source: string,
): Pick<NamedConclusion, "name" | "source" | "id"> {
  return { name, source, id: typeof row.id === "number" ? row.id : null };
}

function checkSource(row: Record<string, unknown>): string {
  if (!isRecord(row.app)) return "check:unknown";
  return `check:${String(row.app.id ?? row.app.slug ?? "unknown")}`;
}

function checkRun(row: unknown): NamedConclusion | null {
  if (!isRecord(row) || typeof row.name !== "string") return null;
  if (row.conclusion !== null && typeof row.conclusion !== "string")
    return null;
  const at = textField(row, "completed_at");
  const url = textField(row, "html_url");
  return {
    ...conclusionIdentity(row, row.name, checkSource(row)),
    conclusion: row.conclusion,
    started: textField(row, "started_at") ?? at ?? "",
    ...(at === undefined ? {} : { at }),
    ...(url === undefined ? {} : { url }),
  };
}

function commitStatus(row: unknown): NamedConclusion | null {
  if (
    !isRecord(row) ||
    typeof row.context !== "string" ||
    typeof row.state !== "string"
  )
    return null;
  const at = textField(row, "created_at");
  const url = textField(row, "target_url");
  return {
    ...conclusionIdentity(row, row.context, "status"),
    conclusion: row.state,
    started: at ?? "",
    ...(at === undefined ? {} : { at }),
    ...(url === undefined ? {} : { url }),
  };
}

function normalizedConclusions(
  checks: unknown,
  statuses: unknown,
): EvidenceRead<{ rows: NamedConclusion[]; truncated: boolean }> {
  if (
    !isRecord(checks) ||
    !Array.isArray(checks.check_runs) ||
    !Array.isArray(statuses)
  )
    return failed(
      "unreadable",
      "the check history's runs or statuses did not read",
    );
  const runs = checks.check_runs.map(checkRun);
  if (runs.includes(null))
    return failed("unreadable", "a check-run conclusion did not read");
  const states = statuses.map(commitStatus);
  if (states.includes(null))
    return failed("unreadable", "a commit-status conclusion did not read");
  return ok({
    rows: [...runs, ...states].filter(
      (row): row is NamedConclusion => row !== null,
    ),
    truncated: checks.check_runs.length >= 100 || statuses.length >= 100,
  });
}

async function conclusions(
  sha: string,
  observation: RepoObservation,
  room: EvidenceRoom,
  readJson: EvidenceJson,
): Promise<EvidenceRead<{ rows: NamedConclusion[]; truncated: boolean }>> {
  const path = `repos/${observation.opened.repo.slug}/commits/${encodeURIComponent(sha)}`;
  const checks = await readJson(
    ["api", `${path}/check-runs?filter=all&per_page=100`],
    observation,
    room,
  );
  if (!checks.ok) return checks;
  const statuses = await readJson(
    ["api", `${path}/statuses?per_page=100`],
    observation,
    room,
  );
  if (!statuses.ok) return statuses;
  return normalizedConclusions(checks.value, statuses.value);
}

/** Both histories are pinned to the exact head and base the PR view read. */
export async function pullRequestChecks(
  pr: number,
  observation: RepoObservation,
  room: EvidenceRoom,
  readJson: EvidenceJson = json,
): Promise<EvidenceRead<PullRequestChecks>> {
  const view = await readJson(
    [
      "pr",
      "view",
      String(pr),
      "--repo",
      observation.opened.repo.slug,
      "--json",
      "headRefOid,baseRefOid",
    ],
    observation,
    room,
  );
  if (!view.ok) return view;
  if (
    !isRecord(view.value) ||
    typeof view.value.headRefOid !== "string" ||
    typeof view.value.baseRefOid !== "string"
  )
    return failed(
      "unreadable",
      "the pull request's head and base did not read",
    );
  const head = await conclusions(
    view.value.headRefOid,
    observation,
    room,
    readJson,
  );
  if (!head.ok) return head;
  const base = await conclusions(
    view.value.baseRefOid,
    observation,
    room,
    readJson,
  );
  if (!base.ok) return base;
  if (head.value.rows.some((row) => row.started === "" && row.id === null))
    return failed(
      "unreadable",
      "a head check has no timestamp or id to order its attempts",
    );
  const newest = new Map<string, NamedConclusion>();
  for (const row of [...head.value.rows].sort((a, b) =>
    a.id !== null && b.id !== null
      ? b.id - a.id
      : b.started.localeCompare(a.started),
  ))
    if (!newest.has(`${row.source}\0${row.name}`))
      newest.set(`${row.source}\0${row.name}`, row);
  const failing = [...newest.values()].filter(
    (r) =>
      r.conclusion !== null &&
      !["success", "neutral", "skipped", "pending"].includes(r.conclusion),
  );
  return ok({
    pr,
    head: view.value.headRefOid,
    base: view.value.baseRefOid,
    recentLimit: 100,
    truncated: head.value.truncated || base.value.truncated,
    failing: failing.map((r) => ({
      name: r.name,
      source: r.source,
      head: head.value.rows.filter(
        (x) => x.name === r.name && x.source === r.source,
      ),
      base: base.value.rows.filter(
        (x) => x.name === r.name && x.source === r.source,
      ),
    })),
  });
}

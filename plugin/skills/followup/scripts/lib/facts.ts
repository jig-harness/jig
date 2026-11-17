/**
 * The merge facts every arm keys off, gathered once per run: the pull
 * request's state (merged: the post-merge run; open: a preview; anything
 * else refused), its merge commit and the diff range the merge brought in,
 * the files that range changes and the change areas they touch, the
 * tracker item and epic its description and branch name, its
 * `## Out-of-tree follow-ups` steps, and the added lines in the diff that
 * look like temporary scaffolding.
 *
 * The diff range is derived from the merge commit's parents: a squash (one
 * parent) and a merge commit (two) both brought in `<first parent>..<merge>`,
 * and a merge commit's second parent is the branch's own head. A preview's
 * range is the branch since it left the base branch.
 */
import { isMapping, valueAt } from "../../../../shared/config-layers.ts";
import { swallow } from "../../../../shared/errors.ts";
import {
  attempt,
  failed,
  ok,
  type Outcome,
} from "../../../../shared/outcome.ts";
import type { OutboundFailure } from "../../../../shared/outbound/failure.ts";
import type { RunResult } from "../../../../shared/proc.ts";
import { isoFromMs } from "../../../../shared/time.ts";
import {
  type OutOfTreeSection,
  outOfTreeSteps,
} from "../../../../dispatch/lib/owed-steps.ts";
import { branchPattern } from "../../../../dispatch/lib/section.ts";
import {
  closingKeys,
  partOfKeys,
} from "../../../../dispatch/lib/work-links.ts";
import { trackerConfigFrom } from "../../../do-item/scripts/lib/tracker/config.ts";
import {
  type IssueKeys,
  issueKeysOf,
  keyFromBranch,
} from "../../../do-item/scripts/lib/tracker/keys.ts";
import type { ConfigOrigin } from "./settings.ts";
import { type ScaffoldingHit, scanAddedLines } from "./scaffolding.ts";

export type Mode = "post-merge" | "preview";

/** The commits the merge brought in, or a preview's branch. */
export interface DiffRange {
  /** `squash` (one parent), `merge-commit` (two or more), or `open` (a preview's branch). */
  kind: "squash" | "merge-commit" | "rebase" | "open";
  /** The commit the change is compared with: the merge's first parent, or where the branch left its base. */
  base: string;
  /** The merge commit, or the branch's head. */
  head: string;
  /** For a merge commit, the branch's head it merged (its second parent). */
  branchHead?: string;
}

/** The change areas the changed files touch, or why they could not be read. */
export type ChangeAreas =
  | {
      known: true;
      seedAreas: string[];
      areas: string[];
      postDeploy: Array<{ area: string; action: unknown }>;
    }
  | { known: false; reason: string };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** The change areas a resolver's or a validation plan's JSON names; `known: false` with why when `stdout` does not read. */
export function areasFromPlan(stdout: string, by: string): ChangeAreas {
  const parsed = attempt("invalid", by, (): unknown => JSON.parse(stdout));
  if (!parsed.ok || !isMapping(parsed.value))
    return { known: false, reason: `${by} printed no JSON object` };
  const plan = parsed.value;
  if (
    !Array.isArray(plan.seedAreas) ||
    !plan.seedAreas.every((area) => typeof area === "string") ||
    !Array.isArray(plan.areas) ||
    !plan.areas.every((area) => typeof area === "string") ||
    !Array.isArray(plan.postDeploy) ||
    !plan.postDeploy.every(
      (entry) =>
        isMapping(entry) && typeof entry.area === "string" && "action" in entry,
    )
  )
    return {
      known: false,
      reason: `${by} printed JSON without valid seedAreas, areas and postDeploy collections`,
    };
  const postDeploy = plan.postDeploy.map((p) => ({
    area: p.area as string,
    action: p.action,
  }));
  return {
    known: true,
    seedAreas: strings(plan.seedAreas),
    areas: strings(plan.areas),
    postDeploy,
  };
}

export interface Facts {
  schema: 1;
  pr: number;
  url: string;
  title: string;
  mode: Mode;
  remote: string;
  integrationBranch: string;
  baseBranch: string;
  headRefName: string;
  headRefOid: string;
  mergeSha: string | null;
  range: DiffRange | null;
  changedFiles: string[];
  changeAreas: ChangeAreas;
  /** The item the merge closes: a closing keyword in the description, else the branch name's key. */
  item: { key: string; source: "description" | "branch" } | null;
  /** Every item the merge closes: all the closing keywords of the description (a batch closes several), else the branch name's key. `item` is the first. */
  items: { key: string; source: "description" | "branch" }[];
  /** Whether tracker linkage was read, rather than merely absent. */
  itemRead: boolean;
  /** The epics the description says it is part of. */
  epics: string[];
  outOfTree: OutOfTreeSection;
  labels: string[];
  scaffolding: ScaffoldingHit[];
  /** Where the follow-up's own settings were read from. */
  configOrigin: ConfigOrigin;
  /** What a reader should know about how these facts were read. */
  notes: string[];
}

/** What `gh pr view` says of the pull request. */
export interface PrView {
  number: number;
  url: string;
  title: string;
  state: string;
  mergeCommit: { oid: string } | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  body: string;
  labels: string[];
  files: string[];
  commits: string[];
  /** The first line of each commit's message, oldest first. */
  commitSubjects: string[];
}

/** The `gh pr view` fields `parsePrView` reads. */
export const PR_VIEW_FIELDS =
  "number,url,title,state,mergeCommit,baseRefName,headRefName,headRefOid,body,labels,files,commits";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `gh pr view --json <PR_VIEW_FIELDS>` output, read; `null` when it is not that. */
export function parsePrView(text: string): PrView | null {
  const parsed = attempt("invalid", "gh pr view's output", (): unknown =>
    JSON.parse(text),
  );
  if (!parsed.ok) return null;
  const raw = parsed.value;
  if (!isMapping(raw) || typeof raw.number !== "number") return null;
  const names = (list: unknown, key: string): string[] =>
    Array.isArray(list)
      ? list.flatMap((e) =>
          isMapping(e) && typeof e[key] === "string" ? [e[key] as string] : [],
        )
      : [];
  const merge = isMapping(raw.mergeCommit) ? str(raw.mergeCommit.oid) : "";
  return {
    number: raw.number,
    url: str(raw.url),
    title: str(raw.title),
    state: str(raw.state),
    mergeCommit: merge === "" ? null : { oid: merge },
    baseRefName: str(raw.baseRefName),
    headRefName: str(raw.headRefName),
    headRefOid: str(raw.headRefOid),
    body: str(raw.body),
    labels: names(raw.labels, "name"),
    files: names(raw.files, "path"),
    commits: names(raw.commits, "oid"),
    commitSubjects: names(raw.commits, "messageHeadline"),
  };
}

/** The pull request `gh pr view` answered, or how it failed: a rate limit names when it clears. */
export function prViewOf(
  pr: number,
  failure: OutboundFailure | null,
  stdout: string,
): Outcome<PrView, "unreadable" | "rate-limited"> {
  if (failure?.code === "rate-limited")
    return failed(
      "rate-limited",
      `RATE-LIMITED until ${isoFromMs(failure.until ?? 0)}: ${failure.reason}`,
    );
  if (failure !== null)
    return failed(
      "unreadable",
      `PR #${pr} could not be read: ${failure.reason}`,
    );
  const view = parsePrView(stdout);
  return view === null
    ? failed(
        "unreadable",
        `gh pr view ${pr} answered in a form that does not read`,
      )
    : ok(view);
}

export type GitRunner = (args: string[]) => Promise<RunResult>;

const SHA = /^[0-9a-f]{7,64}$/;

/** The range a merge commit brought in, from its parents. */
export async function mergeRange(
  git: GitRunner,
  merge: string,
): Promise<Outcome<DiffRange, "unreadable">> {
  const r = await git(["rev-list", "--parents", "-n", "1", merge]);
  const [self, ...parents] = r.stdout.trim().split(/\s+/);
  if (r.code !== 0 || self === undefined || !SHA.test(self))
    return failed(
      "unreadable",
      `the merge commit ${merge} is not in this clone (git rev-list exited ${r.code})`,
    );
  const [first, second] = parents;
  if (first === undefined)
    return failed(
      "unreadable",
      `the merge commit ${merge} has no parent: it brought in no change of its own`,
    );
  if (second === undefined)
    return ok({ kind: "squash", base: first, head: self });
  return ok({
    kind: "merge-commit",
    base: first,
    head: self,
    branchHead: second,
  });
}

/** A preview's range: the branch's head since it left `baseRef`. */
export async function previewRange(
  git: GitRunner,
  baseRef: string,
  head: string,
): Promise<Outcome<DiffRange, "unreadable">> {
  const r = await git(["merge-base", baseRef, head]);
  const base = r.stdout.trim();
  if (r.code !== 0 || !SHA.test(base))
    return failed(
      "unreadable",
      `cannot tell where ${head} left ${baseRef} (git merge-base exited ${r.code})`,
    );
  return ok({ kind: "open", base, head });
}

/** The files a range changes, by name, each once. */
export async function changedFilesOf(
  git: GitRunner,
  range: DiffRange,
): Promise<Outcome<string[], "unreadable">> {
  const r = await git(["diff", "--name-only", "-z", range.base, range.head]);
  if (r.code !== 0)
    return failed(
      "unreadable",
      `git diff ${range.base} ${range.head} exited ${r.code}`,
    );
  return ok(r.stdout.split("\0").filter((p) => p !== ""));
}

/** The integration branch: `repository.base_branch`, else the remote's HEAD. */
export async function integrationBranchOf(
  values: Record<string, unknown>,
  remote: string,
  git: GitRunner,
): Promise<string | null> {
  const configured = valueAt(values, "repository.base_branch");
  if (typeof configured === "string" && configured !== "") return configured;
  const r = await git([
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  const name = r.stdout.trim();
  return r.code === 0 && name.startsWith(`${remote}/`)
    ? name.slice(remote.length + 1)
    : null;
}

/** The bases a merge may land on: the integration branch and every base `pull_requests.base_rules` names. */
export function allowedBases(
  values: Record<string, unknown>,
  integration: string,
): string[] {
  const rules = valueAt(values, "pull_requests.base_rules");
  const bases = Array.isArray(rules)
    ? rules.flatMap((r) =>
        isMapping(r) && typeof r.base === "string" ? [r.base] : [],
      )
    : [];
  return [integration, ...bases.filter((b) => b !== integration)];
}

/** The tracker's key shape, or `null` when the tracker cannot be told. */
function keysOf(values: Record<string, unknown>): IssueKeys | null {
  try {
    return issueKeysOf(trackerConfigFrom(values));
  } catch (error) {
    swallow(error, "the tracker configuration does not read, so no key shape");
    return null;
  }
}

/** The item the merge closes and the epics it is part of. */
export function itemOf(
  values: Record<string, unknown>,
  body: string,
  branch: string,
): {
  item: Facts["item"];
  items: Facts["items"];
  itemRead: boolean;
  epics: string[];
  note: string | null;
} {
  const keys = keysOf(values);
  if (keys === null)
    return {
      item: null,
      items: [],
      itemRead: false,
      epics: [],
      note: "the tracker's key shape cannot be told from the configuration, so no item is read",
    };
  const closing = [...new Set(closingKeys(body, keys))];
  const fromBranch = keyFromBranch(branch, keys, branchPattern(values));
  const items: Facts["items"] =
    closing.length > 0
      ? closing.map((key) => ({ key, source: "description" as const }))
      : fromBranch !== null
        ? [{ key: fromBranch, source: "branch" as const }]
        : [];
  return {
    item: items[0] ?? null,
    items,
    itemRead: true,
    epics: partOfKeys(body, keys),
    note: null,
  };
}

/** What `gatherFacts` needs from outside. */
export interface FactsDeps {
  view: (pr: number) => Promise<Outcome<PrView, "unreadable" | "rate-limited">>;
  git: GitRunner;
  /** A remote-facing git call (a fetch): bounded by its own deadline. */
  fetch: (args: string[]) => Promise<RunResult>;
  areas: (files: string[]) => Promise<ChangeAreas>;
  values: Record<string, unknown>;
  remote: string;
  configOrigin: ConfigOrigin;
}

export type FactsFailure = "unreadable" | "refused" | "rate-limited";

/**
 * A single-parent merge is a squash or a rebase of several commits.  A rebase
 * lands one single-parent commit per pull request commit, with its message
 * subject; a squash lands one commit whose subject is the pull request's own.
 * A landed sequence whose subjects are the pull request's, in order, widens
 * the range back over it only when the files it changes are the pull
 * request's own: equal subjects alone do not prove the commits are the pull
 * request's.  A history that cannot be read, or whose files disagree with the
 * pull request's list, is unreadable rather than guessed.
 */
export async function settleSquash(
  view: PrView,
  squash: DiffRange,
  git: GitRunner,
): Promise<Outcome<DiffRange, "unreadable">> {
  const wanted = view.commitSubjects;
  if (squash.kind !== "squash" || wanted.length < 2) return ok(squash);
  const log = await git([
    "log",
    "--first-parent",
    `-n${wanted.length}`,
    "--format=%P%x1f%s%x1e",
    squash.head,
  ]);
  if (log.code !== 0)
    return failed(
      "unreadable",
      `git log of the merge exited ${log.code}: whether it landed as a rebase is unknown`,
    );
  const landed = log.stdout
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r !== "")
    .map((r) => r.split("\x1f") as [string, string]);
  if (landed.length < wanted.length) {
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.code !== 0 || shallow.stdout.trim() !== "false")
      return failed(
        "unreadable",
        "the clone's history is too short to tell a squash from a rebase: fetch more history",
      );
    return ok(squash);
  }
  const linear = landed.every(([parents]) => SHA.test(parents.trim()));
  const subjects = landed.map(([, subject]) => subject.trim()).reverse();
  const same = subjects.every((subject, i) => subject === wanted[i]?.trim());
  if (!linear || !same) return ok(squash);
  const base = landed.at(-1)?.[0].trim() ?? "";
  const widened: DiffRange = {
    kind: "rebase",
    base,
    head: squash.head,
    branchHead: squash.head,
  };
  const files = await changedFilesOf(git, widened);
  if (!files.ok) return files;
  const own = new Set(view.files);
  const sameFiles =
    files.value.length === own.size && files.value.every((f) => own.has(f));
  if (!sameFiles)
    return failed(
      "unreadable",
      "the landed commits share the pull request's subjects but not its files: whether they are its rebase is ambiguous",
    );
  return (await sameContent(view, git, squash.head))
    ? ok(widened)
    : failed(
        "unreadable",
        "the landed commits share the pull request's subjects and files but not its content, or its head is not in the clone: whether they are its rebase is ambiguous",
      );
}

/**
 * A path's tree entry at a commit: its mode and blob, `""` when the commit
 * confirmably lacks the path, `null` when the commit cannot be read.
 */
async function entryAt(
  git: GitRunner,
  commit: string,
  file: string,
): Promise<string | null> {
  const tree = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${commit}^{tree}`,
  ]);
  if (tree.code !== 0) return null;
  const entry = await git(["ls-tree", commit, "--", file]);
  if (entry.code !== 0) return null;
  return entry.stdout.split("\t")[0]?.trim() ?? "";
}

/**
 * Whether every file the pull request lists is, at the landed head, what its
 * own head holds: the same blob, or absent from both (a deletion or a rename
 * away).  A commit that cannot be read is not a match.
 */
async function sameContent(
  view: PrView,
  git: GitRunner,
  landedHead: string,
): Promise<boolean> {
  for (const file of view.files) {
    const landed = await entryAt(git, landedHead, file);
    const own = await entryAt(git, view.headRefOid, file);
    if (landed === null || own === null || landed !== own) return false;
  }
  return true;
}

/** The range of a merged pull request, fetching its merge commit when the clone lacks it. */
async function mergedRange(
  view: PrView,
  deps: FactsDeps,
): Promise<Outcome<DiffRange, "unreadable">> {
  const merge = view.mergeCommit?.oid ?? "";
  let read = await mergeRange(deps.git, merge);
  if (!read.ok) {
    await deps.fetch(["fetch", "--no-tags", deps.remote, merge]);
    read = await mergeRange(deps.git, merge);
  }
  await deps.fetch([
    "fetch",
    "--no-tags",
    deps.remote,
    `refs/pull/${view.number}/head`,
  ]);
  return read.ok ? settleSquash(view, read.value, deps.git) : read;
}

/** The range of a merged or open pull request, after fetching its base (and a preview's head). */
async function rangeOf(
  view: PrView,
  mode: Mode,
  deps: FactsDeps,
  notes: string[],
): Promise<Outcome<DiffRange, "unreadable">> {
  const baseRef = `${deps.remote}/${view.baseRefName}`;
  const head = mode === "preview" ? [`refs/pull/${view.number}/head`] : [];
  const fetched = await deps.fetch([
    "fetch",
    "--no-tags",
    deps.remote,
    `+refs/heads/${view.baseRefName}:refs/remotes/${baseRef}`,
    ...head,
  ]);
  if (fetched.code !== 0)
    notes.push(
      `git fetch from ${deps.remote} exited ${fetched.code}: the range is read from what the clone already holds`,
    );
  const read =
    mode === "preview"
      ? await previewRange(deps.git, baseRef, view.headRefOid)
      : await mergedRange(view, deps);
  return read;
}

/** Whether the pull request lists a file a squash range does not change: the sign of a rebase merge. */
function listsMore(view: PrView, range: DiffRange, files: string[]): boolean {
  const fromRange = new Set(files);
  return range.kind === "squash" && view.files.some((f) => !fromRange.has(f));
}

/** The changed files: the range's, else the pull request's own list. */
async function filesOf(
  view: PrView,
  range: DiffRange,
  git: GitRunner,
  notes: string[],
): Promise<string[]> {
  const read = await changedFilesOf(git, range);
  if (!read.ok) {
    notes.push(read.failure.reason);
    notes.push("the changed files are the pull request's own list");
    return view.files;
  }
  if (listsMore(view, range, read.value))
    notes.push(
      "the pull request lists files the merge commit's range does not change: the merge may have rebased several commits, so read the pull request's own diff as well",
    );
  return read.value;
}

/** What a pull request's state makes the run, or why it is refused. */
function modeOf(view: PrView): Outcome<Mode, FactsFailure> {
  if (view.state === "OPEN") return ok("preview");
  if (view.state !== "MERGED")
    return failed(
      "refused",
      `PR #${view.number} is ${view.state.toLowerCase() || "in no state gh names"}, neither merged nor open: there is no merge to follow up`,
    );
  return view.mergeCommit === null
    ? failed(
        "unreadable",
        `PR #${view.number} is merged but names no merge commit`,
      )
    : ok("post-merge");
}

/** Refused unless the pull request's base is one the follow-up settles merges into. */
function baseCheck(
  view: PrView,
  values: Record<string, unknown>,
  integration: string,
): Outcome<true, FactsFailure> {
  const bases = allowedBases(values, integration);
  if (bases.includes(view.baseRefName)) return ok(true);
  const ruled =
    bases.length > 1
      ? ` or a base pull_requests.base_rules names (${bases.slice(1).join(", ")})`
      : "";
  return failed(
    "refused",
    `PR #${view.number} is based on ${view.baseRefName}, not the integration branch ${integration}${ruled}: its merge reaches no branch the follow-up settles`,
  );
}

/** The facts a pull request's description and branch give. */
function describedFacts(
  view: PrView,
  values: Record<string, unknown>,
  notes: string[],
): Pick<
  Facts,
  "item" | "items" | "itemRead" | "epics" | "outOfTree" | "labels"
> {
  const { item, items, itemRead, epics, note } = itemOf(
    values,
    view.body,
    view.headRefName,
  );
  if (note !== null) notes.push(note);
  return {
    item,
    items,
    itemRead,
    epics,
    outOfTree: outOfTreeSteps(view.body),
    labels: view.labels,
  };
}

/** The facts the range gives: its files, their change areas and the scaffolding it adds. */
async function changeFacts(
  view: PrView,
  mode: Mode,
  deps: FactsDeps,
  notes: string[],
): Promise<
  Outcome<
    Pick<Facts, "range" | "changedFiles" | "changeAreas" | "scaffolding">,
    "unreadable"
  >
> {
  const read = await rangeOf(view, mode, deps, notes);
  if (!read.ok) return read;
  const range = read.value;
  const changedFiles = await filesOf(view, range, deps.git, notes);
  const scaffolding = await scanAddedLines(
    deps.git,
    range.base,
    range.head,
    notes,
  );
  return ok({
    range,
    changedFiles,
    changeAreas: await deps.areas(changedFiles),
    scaffolding,
  });
}

/** The merge facts of pull request `pr`. */
export async function gatherFacts(
  pr: number,
  integration: string,
  deps: FactsDeps,
): Promise<Outcome<Facts, FactsFailure>> {
  const viewed = await deps.view(pr);
  if (!viewed.ok) return viewed;
  const view = viewed.value;
  const mode = modeOf(view);
  if (!mode.ok) return mode;
  const base = baseCheck(view, deps.values, integration);
  if (!base.ok) return base;
  const notes: string[] = [];
  const changes = await changeFacts(view, mode.value, deps, notes);
  if (!changes.ok) return changes;
  return ok({
    schema: 1,
    pr: view.number,
    url: view.url,
    title: view.title,
    mode: mode.value,
    remote: deps.remote,
    integrationBranch: integration,
    baseBranch: view.baseRefName,
    headRefName: view.headRefName,
    headRefOid: view.headRefOid,
    mergeSha: view.mergeCommit?.oid ?? null,
    ...changes.value,
    ...describedFacts(view, deps.values, notes),
    configOrigin: deps.configOrigin,
    notes,
  });
}

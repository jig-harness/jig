/**
 * Code-scanning threads: review threads GitHub opens for a code scanning
 * alert, the way it reports the findings of CodeQL, SonarQube Cloud, Semgrep
 * or any other tool that uploads results to GitHub code scanning.
 *
 * Such a thread is a view of an alert, not the finding itself. The alert is
 * what keeps the scanner's check failing and what reopens on the default
 * branch after the merge, so an outcome that does not fix the code has to
 * reach the alert as well as the thread: a resolved thread over an open alert
 * hides a finding nobody answered. The alert also carries the severity the
 * thread's text leaves out.
 *
 * A thread is a code-scanning thread when its opening comment was posted by
 * GitHub's code scanning account and its one details link names an alert of
 * the same repository.
 * Authorship is what makes the link trustworthy: anyone can paste an alert
 * link into a comment of their own.
 */
import { ghCall, type RunResult } from "../../../../shared/proc.ts";
import { isRecord } from "../../../../shared/guards.ts";

/** The account GitHub posts code scanning alerts from (GraphQL login). */
export const CODE_SCANNING_LOGIN = "github-advanced-security";

/** A login compared the way GitHub does: case-insensitively, `[bot]` optional. */
function isCodeScanningLogin(login: string | null | undefined): boolean {
  return (
    typeof login === "string" &&
    login
      .trim()
      .toLowerCase()
      .replace(/\[bot\]$/, "") === CODE_SCANNING_LOGIN
  );
}

/**
 * The comment's own details link,
 * `[Show more details](https://github.com/<owner>/<repo>/security/code-scanning/<n>)`.
 * Only this link names the alert: the tool's message above it can quote any
 * URL, an alert link included.
 */
const DETAILS_LINK =
  /\[Show more details\]\(https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/security\/code-scanning\/([0-9]+)\)/g;

/**
 * The alert number a code-scanning comment links, when `author` is GitHub's
 * code scanning account and the comment carries exactly one details link,
 * pointing into `owner/repo`; else `null`. Two details links are ambiguous and
 * name no alert.
 */
export function alertNumberOf(
  body: string | null | undefined,
  author: string | null | undefined,
  owner: string,
  repo: string,
): number | null {
  if (!isCodeScanningLogin(author) || typeof body !== "string") return null;
  const matches = [...body.matchAll(DETAILS_LINK)];
  if (matches.length !== 1) return null;
  const [, linkOwner, linkRepo, digits] = matches[0] ?? [];
  if (
    linkOwner?.toLowerCase() !== owner.toLowerCase() ||
    linkRepo?.toLowerCase() !== repo.toLowerCase()
  ) {
    return null;
  }
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type JigSeverity = "blocker" | "high" | "medium" | "low";

/**
 * Jig's severity for an alert's rule. A security rule's
 * `security_severity_level` decides where present; otherwise the rule's own
 * level, with `error` taken as high because it fails GitHub's code scanning
 * check by default, as `high` and `critical` do.
 */
const SECURITY_LEVELS: Readonly<Record<string, JigSeverity>> = {
  critical: "blocker",
  high: "high",
  medium: "medium",
  low: "low",
};
const RULE_LEVELS: Readonly<Record<string, JigSeverity>> = {
  error: "high",
  warning: "medium",
  note: "low",
};

/** What a code-scanning thread record carries about its alert. */
export interface AlertSummary {
  number: number;
  /**
   * The alert's state on the pull request: `dismissed` when the alert is
   * dismissed (a dismissal holds on every branch), else what its instances
   * at the pull request's current revision say, `open`, `fixed` or `closed`
   * (`prInstanceState`). `null` when that could not be established;
   * `stateUnknown` then says why.
   */
  state: string | null;
  stateUnknown?: string;
  /** The tool that raised it (`CodeQL`, `SonarCloud`, …). */
  tool: string | null;
  rule: string | null;
  severity: JigSeverity | "unknown";
  /** `security` for a rule with a security severity, else `unknown`. */
  category: "security" | "unknown";
  /** Why the alert could not be read; present only then. */
  unreadable?: string;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

/**
 * Summarize the REST code scanning alert document. Its `state` is the
 * alert's own, read on the default branch, or its most recent instance's when
 * the alert was raised only on another ref; `readAlert` replaces it with the
 * pull request's.
 */
export function summarizeAlert(number: number, raw: unknown): AlertSummary {
  if (!isRecord(raw)) return unreadableAlert(number, "not a JSON object");
  const rule = isRecord(raw.rule) ? raw.rule : {};
  const tool = isRecord(raw.tool) ? raw.tool : {};
  const instance = isRecord(raw.most_recent_instance)
    ? raw.most_recent_instance
    : {};
  const securityLevel = str(rule.security_severity_level)?.toLowerCase();
  const ruleLevel = str(rule.severity)?.toLowerCase();
  const isSecurity =
    securityLevel !== undefined &&
    Object.hasOwn(SECURITY_LEVELS, securityLevel);
  const severity =
    (isSecurity ? SECURITY_LEVELS[securityLevel] : undefined) ??
    (ruleLevel !== undefined && Object.hasOwn(RULE_LEVELS, ruleLevel)
      ? RULE_LEVELS[ruleLevel]
      : undefined) ??
    "unknown";
  return {
    number,
    state: str(raw.state) ?? str(instance.state),
    tool: str(tool.name),
    rule: str(rule.id),
    severity,
    category: isSecurity ? "security" : "unknown",
  };
}

export function unreadableAlert(number: number, why: string): AlertSummary {
  return {
    number,
    state: null,
    tool: null,
    rule: null,
    severity: "unknown",
    category: "unknown",
    unreadable: why,
  };
}

/** The tail of a failed `gh` call, for a one-line reason. */
export function ghFailure(r: RunResult): string {
  if (r.timedOut) return "gh timed out";
  const last = r.stderr.trim().split("\n").at(-1) ?? "";
  return last === "" ? `gh exited ${r.code}` : last;
}

/** The revision pull request `pr` is at, and the refs its analyses land on. */
interface PrRevision {
  /** Each ref an analysis of the pull request is uploaded against, with the commit a current one analysed there. */
  refs: { ref: string; sha: string | null }[];
  head: string;
}

/** Why something could not be read. */
type Unreadable = { unreadable: string };

/** `r`'s standard output as JSON, or why it is not. */
function ghJson(r: RunResult): { json: unknown } | Unreadable {
  if (r.code !== 0 || r.timedOut) return { unreadable: ghFailure(r) };
  try {
    return { json: JSON.parse(r.stdout) };
  } catch {
    return { unreadable: "gh returned unparsable JSON" };
  }
}

/**
 * The pull request's current revision, from its REST document: its merge ref
 * analysed at the test merge commit, and its head analysed at the head
 * commit, both on `refs/pull/<pr>/head` and, for a branch of this
 * repository, on the source branch a push-triggered scan uploads to. The
 * merge commit is `null` while GitHub has not computed one; no merge-ref
 * instance is current then.
 */
function revisionOf(
  raw: unknown,
  owner: string,
  repo: string,
  pr: string,
): PrRevision | Unreadable {
  const head = isRecord(raw) && isRecord(raw.head) ? raw.head : {};
  const headSha = str(head.sha);
  if (!isRecord(raw) || headSha === null) {
    return { unreadable: "the pull request carries no head commit" };
  }
  const refs = [
    { ref: `refs/pull/${pr}/merge`, sha: str(raw.merge_commit_sha) },
    { ref: `refs/pull/${pr}/head`, sha: headSha },
  ];
  const branch = str(head.ref);
  const headRepo = isRecord(head.repo) ? str(head.repo.full_name) : null;
  if (
    branch !== null &&
    headRepo?.toLowerCase() === `${owner}/${repo}`.toLowerCase()
  ) {
    refs.push({ ref: `refs/heads/${branch}`, sha: headSha });
  }
  return { refs, head: headSha };
}

/** Every instance of the alert on `ref`, all pages of them. */
async function instancesOn(
  owner: string,
  repo: string,
  number: number,
  ref: string,
): Promise<unknown[] | Unreadable> {
  const read = ghJson(
    await ghCall([
      "api",
      "--paginate",
      "--slurp",
      `repos/${owner}/${repo}/code-scanning/alerts/${number}/instances?per_page=100&ref=${encodeURIComponent(ref)}`,
    ]),
  );
  if ("unreadable" in read) return read;
  const pages = read.json;
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    return { unreadable: "the instances are not JSON arrays" };
  }
  return (pages as unknown[][]).flat();
}

/** The states an instance settles: anything else leaves the alert unknown. */
const INSTANCE_STATES = new Set(["open", "fixed", "closed"]);

/** What the instances on the pull request's refs say about its revision. */
interface Witnesses {
  /** The states of the instances analysed at the current revision. */
  current: string[];
  /** How many instances were analysed at an earlier one. */
  stale: number;
}

/**
 * Add `ref`'s instances to `w`: an instance analysed at `sha` is current, any
 * other is stale. A current instance in a state that settles nothing makes
 * the whole answer unknown.
 */
function witness(
  w: Witnesses,
  instances: unknown[],
  ref: string,
  sha: string | null,
): string | null {
  for (const i of instances) {
    if (!isRecord(i) || i.ref !== ref) continue;
    if (sha === null || str(i.commit_sha) !== sha) {
      w.stale += 1;
      continue;
    }
    const state = str(i.state);
    if (state === null || !INSTANCE_STATES.has(state)) {
      return `an instance on ${ref} has state ${state ?? "none"}`;
    }
    w.current.push(state);
  }
  return null;
}

/**
 * The alert's state from its witnesses: `open` when any current instance is
 * open, `fixed` or `closed` only when all of them are; unknown when none is
 * current.
 */
function settle(
  w: Witnesses,
  pr: string,
  head: string,
): { state: string } | { unknown: string } {
  if (w.current.includes("open")) return { state: "open" };
  if (w.current.length > 0) {
    return { state: w.current.includes("fixed") ? "fixed" : "closed" };
  }
  return {
    unknown:
      w.stale > 0
        ? `its instances on pull request #${pr} predate its current revision ${head.slice(0, 12)}`
        : `it has no instance on pull request #${pr}`,
  };
}

/**
 * The alert's state on pull request `pr` at its current revision. An alert
 * can be fixed on the default branch and still open on the pull request, and
 * fixed in one analysis configuration while open in another, so the state is
 * read from every instance on every ref the pull request is analysed on,
 * keeping only those analysed at the current revision (`settle`). An
 * instance of an earlier revision proves nothing about this one.
 */
async function prInstanceState(
  owner: string,
  repo: string,
  number: number,
  pr: string,
): Promise<{ state: string } | { unknown: string }> {
  const read = ghJson(
    await ghCall(["api", `repos/${owner}/${repo}/pulls/${pr}`]),
  );
  const revision =
    "unreadable" in read ? read : revisionOf(read.json, owner, repo, pr);
  if ("unreadable" in revision) {
    return {
      unknown: `pull request #${pr} could not be read (${revision.unreadable})`,
    };
  }
  const w: Witnesses = { current: [], stale: 0 };
  for (const { ref, sha } of revision.refs) {
    const instances = await instancesOn(owner, repo, number, ref);
    if ("unreadable" in instances) {
      return {
        unknown: `its instances could not be read (${instances.unreadable})`,
      };
    }
    const odd = witness(w, instances, ref, sha);
    if (odd !== null) return { unknown: odd };
  }
  return settle(w, pr, revision.head);
}

/**
 * Read one alert, with its state on pull request `pr`. Never exits: a
 * repository whose token cannot read code scanning alerts still gets its
 * threads listed, with the alert marked unreadable and the severity `unknown`.
 */
export async function readAlert(
  owner: string,
  repo: string,
  number: number,
  pr: string,
): Promise<AlertSummary> {
  const r = await ghCall([
    "api",
    `repos/${owner}/${repo}/code-scanning/alerts/${number}`,
  ]);
  if (r.code !== 0 || r.timedOut) return unreadableAlert(number, ghFailure(r));
  let alert: AlertSummary;
  try {
    alert = summarizeAlert(number, JSON.parse(r.stdout));
  } catch {
    return unreadableAlert(number, "gh returned unparsable JSON");
  }
  if (alert.unreadable !== undefined || alert.state === "dismissed") {
    return alert;
  }
  const scoped = await prInstanceState(owner, repo, number, pr);
  return "unknown" in scoped
    ? { ...alert, state: null, stateUnknown: scoped.unknown }
    : { ...alert, state: scoped.state };
}

/**
 * The alert behind a listed thread: `undefined` unless `readAlerts` is set
 * and the thread is an unresolved code-scanning thread. An alert that cannot
 * be read is said on stderr and returned marked `unreadable`.
 */
export async function codeScanningOf(
  thread: {
    isResolved: boolean;
    comments: {
      nodes: { author?: { login?: string } | null; body?: string }[];
    };
  },
  owner: string,
  repo: string,
  pr: string,
  readAlerts: boolean,
): Promise<AlertSummary | undefined> {
  if (!readAlerts || thread.isResolved !== false) return undefined;
  const opening = thread.comments.nodes[0];
  const number = alertNumberOf(
    opening?.body,
    opening?.author?.login,
    owner,
    repo,
  );
  if (number === null) return undefined;
  const alert = await readAlert(owner, repo, number, pr);
  if (alert.unreadable !== undefined) {
    console.error(
      `list-unresolved-threads: code scanning alert ${number} could not be read (${alert.unreadable}); its thread lists with unknown severity`,
    );
  }
  return alert;
}

/**
 * The dismissal reason GitHub records for each outcome that leaves the code
 * as it is. GitHub's words; SonarQube Cloud maps `false positive` to its
 * False Positive and the other two to Accept.
 *
 * `accepted` and `moot` are absent: a fix closes the alert when the scanner
 * next analyses the head, and a moot finding's alert is already fixed,
 * closed or dismissed.
 */
export const DISMISS_REASONS = {
  rejected: "false positive",
  "wont-fix": "won't fix",
  deferred: "won't fix",
} as const;
export type DismissOutcome = keyof typeof DISMISS_REASONS;

export function isDismissOutcome(s: string): s is DismissOutcome {
  return Object.hasOwn(DISMISS_REASONS, s);
}

/** GitHub refuses a dismissal comment longer than this. */
export const DISMISS_COMMENT_MAX = 280;

/**
 * `drives.ts --report`: the morning report, the one thing a person reads
 * after an unattended night.
 *
 * Its population is every pull request this clone's state knows that has
 * something to say since the report's time (a state written since, a park,
 * a quota wall, a provisional decision still standing, a live driver), and
 * every open pull request the signed-in account authored or drove, found
 * through the forge's search for the drive ledger (`listLedgerPullRequests`)
 * and narrowed to those whose author, or whose ledger's writer, is that
 * account. For each it says the terminal state and what it means for the
 * person; the provisional decisions, first; the takeovers and re-arms; the
 * parked decisions in their framed form; the issues filed and the deferred
 * entries not yet filed. Every other open pull request the account authored
 * is listed too, for its deferred entries. Of a clone's own state and the
 * ledger, the newer speaks for a pull request both describe: the ledger
 * when another clone wrote a later generation of it, else the state, which
 * is written every round and after the ledger's last write.
 *
 * The time defaults to the last report's, remembered in the state directory
 * (`drives-report.json`); with no report remembered, the last day
 * (`FIRST_REPORT_HOURS`).
 * Every forge read goes through `ghCall`, under its deadline; one that fails
 * is said in the report, never read as nothing.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { deferredEntries } from "../../../resolve-review-comments/scripts/lib/deferred-section.ts";
import { fail } from "./cli.ts";
import { stallThresholdMs } from "./doctor.ts";
import { renderMorningReport } from "./morning-report-render.ts";
import { resolveStateDir } from "./state/store.ts";
import { ghCall } from "./proc.ts";
import { readReversals, type ReversalRead } from "./provisional.ts";
import {
  isProvisional,
  standingProvisional,
  type UnattendedDecision,
} from "./state/decisions.ts";
import { type DriveEvent, lastStop } from "./state/events.ts";
import type { Ledger } from "./state/ledger.ts";
import {
  listAuthoredPullRequests,
  listLedgerPullRequests,
  resolveLogin,
} from "./state/ledger-forge.ts";
import {
  type DriveState,
  isUsableState,
  type ParkedItem,
} from "./state/schema.ts";
import type { TakeoverRecord } from "./state/takeover.ts";
import { TERMINAL_STATES } from "./status/terminal-states.ts";

/** How far back a first report reaches, with no earlier report remembered. */
export const FIRST_REPORT_HOURS = 24;

/** Where the last report's time is remembered, in the state directory. */
export const REPORT_MEMORY = "drives-report.json";

const STATE_FILE = /^drive-pr-(\d+)\.json$/;

export interface ReportProvisional {
  at: string;
  class: string;
  what: string;
  key: string;
  outcome: string | null;
  level: string;
  record: string;
  /** `standing`, `reversed` (with by and url), or `unread` when the forge could not say. */
  status: "standing" | "reversed" | "unread";
  reversedBy?: string;
  reversedUrl?: string;
}

export interface ReportPullRequest {
  number: number;
  url: string;
  title: string;
  /** The forge's state, `OPEN`, `MERGED` or `CLOSED`; `''` when unread. */
  prState: string;
  /** Where the drive's record came from. */
  source: "state" | "ledger";
  terminal: { name: string; exit: number | null; meaning: string };
  provisional: ReportProvisional[];
  takeovers: Array<{ at: string; verdict: string; fromActor: string | null }>;
  rearms: Array<{ at: string; cause: string }>;
  parked: ParkedItem[];
  issuesFiled: Array<{ at: string; what: string; record: string }>;
  deferredUnfiled: Array<{ source: string; text: string }>;
}

export interface MorningReport {
  now: string;
  /** The report's lower bound. */
  since: string;
  sinceSource: "flag" | "last report" | "first report";
  pullRequests: ReportPullRequest[];
  /** What could not be read, each a sentence. */
  unread: string[];
}

/** The drive's record for one pull request, from the state or the ledger. */
interface DriveRecord {
  source: "state" | "ledger";
  decisions: UnattendedDecision[];
  events: DriveEvent[];
  takeovers: Array<Pick<TakeoverRecord, "at" | "verdict" | "fromActor">>;
  parked: ParkedItem[];
  quotaParked: boolean;
  exit: number | null;
  /** The ledger names a driver running in another clone. */
  runningElsewhere: boolean;
}

const DRIVER_MEANINGS: Record<string, string> = {
  running: "a driver is on it; nothing to do yet",
  MERGED: "merged; run the repository's post-merge step",
  CLOSED: "closed without merging; nothing left to drive",
  CONVERGED:
    "the review settled: read its provisional decisions below, then merge it",
  HITL_PARKED:
    "only the parked decisions below remain: answer each on its thread, then re-arm",
  QUOTA_PARKED:
    "stopped at a usage wall: re-arm from a session on another account, or after the reset",
  MAX_ROUNDS:
    "the round budget ran out before the review settled: read the handoff file, then re-arm",
  STALLED:
    "rounds stopped changing anything: read what the passes decided in the handoff file before re-arming",
  PASS_DEADLINE:
    "passes kept running past their deadline: read the handoff file before re-arming",
  PR_NOT_OPEN: "merged or closed; nothing left to drive",
  PR_CONFLICTING:
    "conflicts with its base: merge the base in, push, and re-arm",
  TAKEN_OVER: "another clone took the drive over; its own report says the rest",
  MAILBOX_STOPPED: "stopped on request",
  INDETERMINATE:
    "the last round could not tell where it stood: re-arm to read it again",
};

/** The terminal state's name for a driver's exit code. */
export function exitName(exit: number): string {
  if (exit === 0) return "CONVERGED";
  const entries = Object.entries(TERMINAL_STATES).filter(
    ([, e]) => e !== undefined && e.exitCode === exit,
  );
  const pick =
    entries.find(([, e]) => e?.category === "driver-only") ??
    entries.find(([, e]) => e?.category === "state") ??
    entries[0];
  return pick?.[0] ?? `EXIT_${exit}`;
}

function terminalOf(
  rec: DriveRecord,
  prState: string,
  live: boolean,
): ReportPullRequest["terminal"] {
  const named = (name: string, exit: number | null) => ({
    name,
    exit,
    meaning:
      DRIVER_MEANINGS[name] ?? "read the handoff file, then re-arm the drive",
  });
  if (prState === "MERGED" || prState === "CLOSED") return named(prState, null);
  if (live || rec.runningElsewhere) return named("running", null);
  if (rec.exit !== null) return named(exitName(rec.exit), rec.exit);
  if (rec.parked.length > 0) return named("HITL_PARKED", null);
  if (rec.quotaParked) return named("QUOTA_PARKED", null);
  return {
    name: "stopped",
    exit: null,
    meaning:
      "no driver is on it and its exit is not recorded here: read the handoff file",
  };
}

function fromState(s: DriveState): DriveRecord {
  return {
    source: "state",
    decisions: s.decisions ?? [],
    events: s.events ?? [],
    takeovers: s.takeovers ?? [],
    parked: s.parked,
    quotaParked: s.quotaPark !== null,
    exit: lastStop(s.events ?? []),
    runningElsewhere: false,
  };
}

function fromLedger(l: Ledger, nowMs: number): DriveRecord {
  return {
    source: "ledger",
    decisions: l.decisions,
    events: l.events ?? [],
    takeovers: l.takeovers,
    parked: l.parked,
    quotaParked: l.quotaPark !== null,
    exit:
      l.driver.state === "stopped"
        ? (l.driver.exit ?? lastStop(l.events ?? []))
        : null,
    // A driver that stopped after its last ledger write still reads
    // "running"; past the lease window its heartbeat no longer says it is.
    runningElsewhere:
      l.driver.state === "running" &&
      nowMs - Date.parse(l.driver.heartbeat) <= stallThresholdMs(),
  };
}

const after = (at: string, since: number) => Date.parse(at) >= since;

/** `text` on one line, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  // Remove comments and any stray delimiter (`-->` or `--!>` ends one) until
  // nothing changes, so a nested `<!<!---->--` cannot reassemble one.
  let stripped = text;
  for (let prev = ""; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?--!?>|<!--|--!?>/g, "");
  }
  const line = stripped.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function provisionalEntries(
  rec: DriveRecord,
  since: number,
  reversals: Map<UnattendedDecision, ReversalRead>,
): ReportProvisional[] {
  // A decision still standing is listed whatever its age: it awaits the
  // person's review until they reverse it or merge.
  return rec.decisions
    .filter(isProvisional)
    .filter(
      (d) =>
        d.reversed === undefined ||
        after(d.at, since) ||
        after(d.reversed.at, since),
    )
    .map((d) => {
      const read = reversals.get(d);
      const reversed =
        d.reversed ?? (read ? { by: read.author, url: read.url } : null);
      return {
        at: d.at,
        class: d.class,
        what: d.what,
        key: d.key ?? "",
        outcome: d.outcome ?? null,
        level: d.level,
        record: d.record,
        status:
          reversed !== null
            ? "reversed"
            : reversals.has(d) && read === undefined
              ? "unread"
              : "standing",
        ...(reversed === null
          ? {}
          : { reversedBy: reversed.by, reversedUrl: reversed.url }),
      };
    });
}

interface PrView {
  title: string;
  url: string;
  state: string;
  body: string;
  author: string;
}

async function viewPr(pr: string): Promise<PrView | null> {
  const r = await ghCall(
    ["pr", "view", pr, "--json", "title,url,state,body,author"],
    { stderr: "pipe" },
  );
  if (r.code !== 0) return null;
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (!isRecord(v)) return null;
    const s = (x: unknown) => (typeof x === "string" ? x : "");
    return {
      title: s(v.title),
      url: s(v.url),
      state: s(v.state),
      body: s(v.body),
      author: isRecord(v.author) ? s(v.author.login) : "",
    };
  } catch (err) {
    swallow(err, "gh pr view printed no JSON");
    return null;
  }
}

/** The states in the state directory, by pull request; unreadable ones named. */
function localStates(
  stateDir: string,
  unread: string[],
): Map<string, { state: DriveState; mtime: number }> {
  const out = new Map<string, { state: DriveState; mtime: number }>();
  let entries: string[] = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
    unread.push(`the state directory ${stateDir} could not be read`);
  }
  for (const entry of entries) {
    const pr = STATE_FILE.exec(entry)?.[1];
    if (pr === undefined) continue;
    const file = join(stateDir, entry);
    try {
      const state: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isUsableState(state, Number(pr)))
        out.set(pr, { state, mtime: statSync(file).mtimeMs });
      else
        unread.push(`the drive state of #${pr} is not one this version reads`);
    } catch {
      unread.push(`the drive state of #${pr} could not be read`);
    }
  }
  return out;
}

/** Whether a clone's state has something to say since the report's time. */
function stateSpeaks(
  s: DriveState,
  mtime: number,
  since: number,
  live: boolean,
): boolean {
  return (
    live ||
    mtime >= since ||
    s.parked.length > 0 ||
    s.quotaPark !== null ||
    standingProvisional(s.decisions ?? []).length > 0
  );
}

/** The time remembered from the last report, `null` for none. */
export function rememberedSince(stateDir: string): string | null {
  try {
    const v: unknown = JSON.parse(
      readFileSync(join(stateDir, REPORT_MEMORY), "utf8"),
    );
    return isRecord(v) &&
      typeof v.lastReportAt === "string" &&
      Number.isFinite(Date.parse(v.lastReportAt))
      ? v.lastReportAt
      : null;
  } catch (err) {
    swallow(err, "no report time is remembered");
    return null;
  }
}

export function rememberReport(stateDir: string, at: string): void {
  writeFileSync(
    join(stateDir, REPORT_MEMORY),
    `${JSON.stringify({ lastReportAt: at })}\n`,
  );
}

/** A pull request the forge names for the report, with its ledger; `null` for an authored one without one. */
interface ForgeEntry {
  url: string;
  title: string;
  ledger: Ledger | null;
}

async function forgePopulation(
  unread: string[],
): Promise<Map<string, ForgeEntry>> {
  const out = new Map<string, ForgeEntry>();
  const login = await resolveLogin();
  const search = await listLedgerPullRequests();
  if (search === null)
    unread.push(
      "the forge's search for drive ledgers could not be run, so open pull requests driven from other clones are missing",
    );
  else unread.push(...search.unread);
  if (login === null) {
    unread.push(
      "the signed-in account could not be read, so no open pull request was matched to it",
    );
    return out;
  }
  for (const p of search?.found ?? [])
    if (p.author === login || p.ledgerBy === login)
      out.set(String(p.number), {
        url: p.url,
        title: p.title,
        ledger: p.ledger,
      });
  await addAuthored(out, login, unread);
  return out;
}

/**
 * Add the account's other open pull requests, with no ledger: an authored
 * pull request no drive wrote of still belongs to the report, since its
 * deferred entries may wait for filing.
 */
async function addAuthored(
  out: Map<string, ForgeEntry>,
  login: string,
  unread: string[],
): Promise<void> {
  const authored = await listAuthoredPullRequests(login);
  if (authored === null)
    unread.push(
      "the forge's search for this account's open pull requests could not be run, so those without a drive ledger are missing",
    );
  for (const p of authored ?? [])
    if (!out.has(String(p.number)))
      out.set(String(p.number), { url: p.url, title: p.title, ledger: null });
}

/** The deferred entries a body holds that are not filed yet; a body it cannot read is said. */
function unfiledDeferred(
  pr: string,
  body: string,
  unread: string[],
): ReportPullRequest["deferredUnfiled"] {
  try {
    return deferredEntries(body)
      .filter((e) => e.filed === undefined)
      .map((e) => ({ source: e.source, text: oneLine(e.text, 200) }));
  } catch (err) {
    swallow(err, "the deferred section is malformed");
    unread.push(`#${pr}'s deferred section could not be read`);
    return [];
  }
}

/** The pull request's forge view, with the ledger's url and title as the fallback. */
async function viewOrKnown(
  pr: string,
  known: { url: string; title: string },
  unread: string[],
): Promise<PrView> {
  const view = await viewPr(pr);
  if (view !== null)
    return {
      ...view,
      url: view.url || known.url,
      title: view.title || known.title,
    };
  unread.push(`#${pr} could not be read from the forge`);
  return { ...known, state: "", body: "", author: "" };
}

async function reportOne(
  pr: string,
  rec: DriveRecord,
  since: number,
  live: boolean,
  known: { url: string; title: string },
  unread: string[],
): Promise<ReportPullRequest> {
  const view = await viewOrKnown(pr, known, unread);
  const standing = standingProvisional(rec.decisions);
  const reversals =
    standing.length === 0
      ? new Map<UnattendedDecision, ReversalRead>()
      : await readReversals(pr, standing);
  for (const [d, read] of reversals)
    if (read === undefined)
      unread.push(
        `#${pr}: whether a person reversed the provisional decision on ${d.key ?? "(no key)"} could not be read`,
      );
  return {
    number: Number(pr),
    url: view.url,
    title: view.title,
    prState: view.state,
    source: rec.source,
    terminal: terminalOf(rec, view.state, live),
    provisional: provisionalEntries(rec, since, reversals),
    takeovers: rec.takeovers
      .filter((t) => after(t.at, since))
      .map((t) => ({ at: t.at, verdict: t.verdict, fromActor: t.fromActor })),
    rearms: rec.events
      .filter((e) => e.kind === "rearm" && after(e.at, since))
      .map((e) => ({ at: e.at, cause: e.cause })),
    parked: rec.parked,
    issuesFiled: rec.decisions
      .filter((d) => d.class === "file-issue" && after(d.at, since))
      .map((d) => ({ at: d.at, what: d.what, record: d.record })),
    deferredUnfiled: unfiledDeferred(pr, view.body, unread),
  };
}

/** No drive record at all: an authored pull request no drive has written of. */
const NO_RECORD: DriveRecord = {
  source: "ledger",
  decisions: [],
  events: [],
  takeovers: [],
  parked: [],
  quotaParked: false,
  exit: null,
  runningElsewhere: false,
};

/**
 * The drive's record for a pull request: whichever of this clone's state and
 * the ledger is newer, by the ledger generation the state last wrote or
 * seeded. A ledger of a later generation was written by another clone since
 * (a takeover), so it speaks whole; otherwise this clone's state, written
 * every round and after the ledger's last write, does, and the ledger adds
 * only that another clone runs the drive now.
 */
function recordOf(
  own: { state: DriveState } | undefined,
  remote: { ledger: Ledger | null } | undefined,
  nowMs: number,
): DriveRecord {
  const ledger = remote?.ledger ?? null;
  if (own === undefined)
    return ledger === null ? NO_RECORD : fromLedger(ledger, nowMs);
  const local = fromState(own.state);
  if (ledger === null) return local;
  if (ledger.generation > (own.state.ledgerGeneration ?? 0))
    return fromLedger(ledger, nowMs);
  return {
    ...local,
    // A stop recorded before the run the ledger says is running began ended
    // an earlier run: it says nothing of how this one ended.
    exit: stopEndsRun(own.state, ledger) ? local.exit : null,
    runningElsewhere: fromLedger(ledger, nowMs).runningElsewhere,
  };
}

/** Whether the state's last stop came at or after the start of the run a running ledger names. */
function stopEndsRun(s: DriveState, ledger: Ledger): boolean {
  const started = ledger.driver.started;
  if (ledger.driver.state !== "running" || started === undefined) return true;
  const stop = (s.events ?? []).findLast((e) => e.kind === "stop");
  return stop === undefined || Date.parse(stop.at) >= Date.parse(started);
}

/** Gather the report. `live` holds the pull requests a live driver holds in this clone. */
export async function gatherMorningReport(opts: {
  stateDir: string;
  live: ReadonlySet<string>;
  since: string;
  sinceSource: MorningReport["sinceSource"];
  now: Date;
}): Promise<MorningReport> {
  const unread: string[] = [];
  const since = Date.parse(opts.since);
  const local = localStates(opts.stateDir, unread);
  const forge = await forgePopulation(unread);
  const numbers = new Set<string>([...forge.keys()]);
  for (const [pr, { state, mtime }] of local)
    if (stateSpeaks(state, mtime, since, opts.live.has(pr))) numbers.add(pr);
  const pullRequests: ReportPullRequest[] = [];
  for (const pr of [...numbers].sort((a, b) => Number(a) - Number(b))) {
    const remote = forge.get(pr);
    pullRequests.push(
      await reportOne(
        pr,
        recordOf(local.get(pr), remote, opts.now.getTime()),
        since,
        opts.live.has(pr),
        { url: remote?.url ?? "", title: remote?.title ?? "" },
        unread,
      ),
    );
  }
  return {
    now: opts.now.toISOString(),
    since: opts.since,
    sinceSource: opts.sinceSource,
    pullRequests,
    unread,
  };
}

/** The pull requests a live driver holds, from `drives.ts`'s lock rows. */
export function liveDrives(
  rows: ReadonlyArray<{ kind: string; state: string; key: string }>,
): Set<string> {
  return new Set(
    rows.filter((r) => r.kind === "pr" && r.state === "live").map((r) => r.key),
  );
}

/** Remove `--since <time>` from `argv` and return the time (`''` when absent). */
function takeSince(argv: string[]): string {
  const at = argv.indexOf("--since");
  if (at < 0) return "";
  const [, value = ""] = argv.splice(at, 2);
  if (value === "") fail(2, "--since takes a time");
  return value;
}

/**
 * `drives.ts --report [--since <time>] [--json]`, and nothing else beside
 * it; `live` reads the pull requests a live driver holds in the state
 * directory.
 */
export async function reportMain(
  argv: string[],
  live: (stateDir: string) => Promise<ReadonlySet<string>>,
): Promise<number> {
  const since = takeSince(argv);
  const rest = argv.filter((a) => a !== "--report" && a !== "--json");
  if (rest.length > 0)
    fail(2, "--report combines only with --since and --json");
  const stateDir = await resolveStateDir();
  return morningReportCommand({
    stateDir,
    live: await live(stateDir),
    sinceFlag: since,
    json: argv.includes("--json"),
  });
}

/**
 * `--since` as an instant: an ISO-8601 time, or a span back from `now`
 * (`12h`, `2d`); `null` when it is neither.
 */
export function parseSince(text: string, now: Date): string | null {
  const span = /^(\d+)([hd])$/.exec(text.trim());
  const at =
    span === null
      ? Date.parse(text)
      : now.getTime() -
        Number(span[1]) * (span[2] === "d" ? 24 : 1) * 60 * 60 * 1000;
  // A span too long for a date, like an unparsable time, is no instant.
  const instant = new Date(at);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * `drives.ts --report [--since <time>] [--json]`: gather, print, and
 * remember this report's time as the next one's default.
 */
export async function morningReportCommand(opts: {
  stateDir: string;
  live: ReadonlySet<string>;
  sinceFlag: string;
  json: boolean;
}): Promise<number> {
  const now = new Date();
  let since = parseSince(`${FIRST_REPORT_HOURS}h`, now) as string;
  let sinceSource: MorningReport["sinceSource"] = "first report";
  if (opts.sinceFlag !== "") {
    const flag = parseSince(opts.sinceFlag, now);
    if (flag === null) {
      console.error(
        `drives.ts: --since takes an ISO-8601 time or a span such as 12h or 2d (got '${opts.sinceFlag}')`,
      );
      return 2;
    }
    since = flag;
    sinceSource = "flag";
  } else {
    const last = rememberedSince(opts.stateDir);
    if (last !== null) {
      since = last;
      sinceSource = "last report";
    }
  }
  const report = await gatherMorningReport({
    stateDir: opts.stateDir,
    live: opts.live,
    since,
    sinceSource,
    now,
  });
  process.stdout.write(
    opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderMorningReport(report),
  );
  // Only a report that covered the whole default span moves the next one's
  // start: a --since look, or one that could not read everything, would
  // otherwise hide what it skipped from the person's next report.
  if (opts.sinceFlag !== "" || report.unread.length > 0) return 0;
  try {
    rememberReport(opts.stateDir, report.now);
  } catch (err) {
    console.error(
      `drives.ts: the report's time could not be remembered (${String(err)}); the next report starts from the same point.`,
    );
  }
  return 0;
}

/**
 * The morning report as plain text, for a terminal: the provisional
 * decisions of every pull request first, since they are the ones a person
 * may still want to reverse before the merge, then each pull request with
 * its terminal state and what it means, its takeovers and re-arms, its
 * parked decisions in their framed form, the issues filed and the deferred
 * entries not yet filed; then what the dispatcher launched, refused and
 * notified on this machine. `--json` prints the gathered report instead.
 */
import { join } from "node:path";
import { framedDecisionLines } from "./state/park-frame.ts";
import type {
  MorningReport,
  ReportProvisional,
  ReportPullRequest,
} from "./morning-report.ts";

/** `file-deferred.ts`, which files a pull request's deferred entries. */
const FILE_DEFERRED = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "resolve-review-comments",
  "scripts",
  "file-deferred.ts",
);

function sinceLine(r: MorningReport): string {
  const why = {
    flag: "--since",
    "last report": "the last report",
    "first report": "no earlier report is remembered here, so the last day",
  }[r.sinceSource];
  return `since ${r.since} (${why})`;
}

function provisionalLine(pr: number, p: ReportProvisional): string {
  const outcome = p.outcome === null ? "" : ` \`${p.outcome}\``;
  const status =
    p.status === "reversed"
      ? `REVERSED by ${p.reversedBy} (${p.reversedUrl})`
      : p.status === "unread"
        ? "standing as far as known: its thread could not be read"
        : "standing";
  return `  #${pr}${outcome} ${p.class} on ${p.key}, at ${p.level}, ${p.at}: ${p.what}\n    ${status} · ${p.record || "no record"}`;
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : [`  ${title}:`, ...lines];
}

function pullRequestLines(p: ReportPullRequest): string[] {
  const exit = p.terminal.exit === null ? "" : ` (exit ${p.terminal.exit})`;
  const lines = [
    `#${p.number} ${p.title}`.trimEnd(),
    ...(p.url === "" ? [] : [`  ${p.url}`]),
    `  ${p.terminal.name}${exit}: ${p.terminal.meaning}`,
    ...section(
      "takeovers",
      p.takeovers.map(
        (t) =>
          `    ${t.at} from ${t.fromActor ?? "an unnamed tree"} (${t.verdict})`,
      ),
    ),
    ...section(
      "re-arms",
      p.rearms.map((e) => `    ${e.at}: ${e.cause}`),
    ),
    ...section(
      "parked decisions, each a person's",
      p.parked.flatMap((d) =>
        framedDecisionLines(d).map((l) => (l === "" ? "" : `    ${l}`)),
      ),
    ),
    ...section(
      "issues filed",
      p.issuesFiled.map(
        (i) => `    ${i.at}: ${i.what} · ${i.record || "no record"}`,
      ),
    ),
    ...section(
      "deferred, not yet filed",
      p.deferredUnfiled.length === 0
        ? []
        : [
            ...p.deferredUnfiled.map((d) => `    ${d.text} · ${d.source}`),
            `    file them: bun "${FILE_DEFERRED}" ${p.number}`,
          ],
    ),
  ];
  return lines;
}

export function renderMorningReport(r: MorningReport): string {
  const provisional = r.pullRequests.flatMap((p) =>
    p.provisional.map((d) => provisionalLine(p.number, d)),
  );
  const lines = [
    `Morning report · ${r.now} · ${sinceLine(r)}`,
    "",
    provisional.length === 0
      ? "Provisional decisions: none."
      : "Provisional decisions, each reversible until the merge by a comment on its thread (or `answer <key>: …` on the pull request) from an owner, member or collaborator:",
    ...provisional,
  ];
  if (r.pullRequests.length === 0)
    lines.push("", "No pull request has anything to report.");
  for (const p of r.pullRequests) lines.push("", ...pullRequestLines(p));
  if (r.dispatch.length > 0)
    lines.push(
      "",
      "Dispatched on this machine (jig dispatch: launches, refusals, notifications):",
      ...r.dispatch.map(
        (d) =>
          `  ${d.at} ${d.repo} ${d.kind} ${d.what} ${d.target}: ${d.detail}`,
      ),
    );
  if (r.unread.length > 0)
    lines.push(
      "",
      "Could not read (the report may be missing what these hold):",
      ...r.unread.map((u) => `  - ${u}`),
    );
  return `${lines.join("\n")}\n`;
}

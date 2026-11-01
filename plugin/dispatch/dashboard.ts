/**
 * `jig dispatch dashboard [--port <n>]`: one page over the outcome log
 * (`lib/log.ts`), served while the command runs. It reads the log each time
 * the page asks for rows, and filters them by time, repository, stage,
 * account, class and reason, with the count of each class over the
 * filtered window. A question about yesterday is a filter, not a report:
 * nothing is generated per run and nothing is written to disk.
 *
 * It listens on the address the machine file names (`dashboard.listen`),
 * which must lie in the private or loopback ranges (`lib/listen.ts`), so a
 * phone on the host's private network reaches it and nothing else does.
 * The URL it prints carries a token minted at start; a request without it
 * is refused, since the log names repositories, items and accounts.
 * Nothing installs it or keeps it running: a person starts it from a
 * terminal on the host and stops it with Ctrl-C.
 */
import { timingSafeEqual } from "node:crypto";
import { ExitError } from "../shared/cli.ts";
import type { Listen } from "./lib/listen.ts";
import { type LogRow, OUTCOME_CLASSES, readRows } from "./lib/log.ts";
import { stateRoot } from "./receipts.ts";

/** The port the dashboard listens on when neither `--port` nor the address names one. */
export const DEFAULT_PORT = 8765;

/** What the page filters the log by; an absent field filters nothing. */
interface DashboardFilter {
  fromMs: number;
  toMs: number;
  repo?: string;
  stage?: string;
  account?: string;
  class?: string;
  /** Rows whose reason contains this text, any case. */
  reason?: string;
}

/** The class a row counts under: its class, else (an observation no class names) its event. */
function bucket(row: LogRow): string {
  if (row.class !== null) return row.class;
  return row.kind === "event" ? `event: ${row.event}` : "unknown";
}

/** Whether a field a filter names (absent: any) holds `value`. */
function same(wanted: string | undefined, value: string | null): boolean {
  return wanted === undefined || wanted === value;
}

function matches(row: LogRow, f: DashboardFilter): boolean {
  const at = Date.parse(row.at);
  const reason = f.reason?.toLowerCase();
  return (
    at >= f.fromMs &&
    at <= f.toMs &&
    same(f.repo, row.repo) &&
    same(f.stage, row.stage) &&
    same(f.account, row.account) &&
    same(f.class, bucket(row)) &&
    (reason === undefined || row.reason.toLowerCase().includes(reason))
  );
}

/** The rows a filter keeps, newest first. */
function filterRows(rows: LogRow[], f: DashboardFilter): LogRow[] {
  return rows
    .filter((r) => matches(r, f))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** How many rows each class (and each observation no class names) holds. */
function classCounts(rows: LogRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[bucket(row)] = (counts[bucket(row)] ?? 0) + 1;
  return counts;
}

function text(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function time(params: URLSearchParams, name: string, fallback: number): number {
  const value = text(params, name);
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? ms : fallback;
}

const DAY_MS = 86_400_000;

/** A filter from the page's query: `from` and `to` (any date `Date.parse` reads; the last day by default), and the fields. */
function parseFilter(params: URLSearchParams, nowMs: number): DashboardFilter {
  const filter: DashboardFilter = {
    fromMs: time(params, "from", nowMs - DAY_MS),
    toMs: time(params, "to", nowMs),
  };
  for (const name of ["repo", "stage", "account", "class", "reason"] as const) {
    const value = text(params, name);
    if (value !== undefined) filter[name] = value;
  }
  return filter;
}

/** The page's data for one query: the filtered rows, the counts, and the values each field takes in the window. */
export function dashboardData(
  params: URLSearchParams,
  nowMs: number,
  root = stateRoot(),
): Record<string, unknown> {
  const filter = parseFilter(params, nowMs);
  const window = readRows(filter.fromMs, filter.toMs, root);
  const rows = filterRows(window, filter);
  const values = (pick: (r: LogRow) => string | null) =>
    [
      ...new Set(window.map(pick).filter((v): v is string => v !== null)),
    ].sort();
  return {
    from: new Date(filter.fromMs).toISOString(),
    to: new Date(filter.toMs).toISOString(),
    counts: classCounts(rows),
    rows,
    options: {
      repo: values((r) => r.repo),
      stage: values((r) => r.stage),
      account: values((r) => r.account),
      class: [...new Set([...OUTCOME_CLASSES, ...values(bucket)])],
    },
  };
}

function sameToken(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Dashboard {
  url: string;
  stop(): void;
}

/** Serve the dashboard on `listen`, reading the log under `root`, until `stop`. */
export function serveDashboard(options: {
  listen: Listen;
  port?: number;
  root?: string;
  token?: string;
}): Dashboard {
  const token = options.token ?? crypto.randomUUID().replace(/-/g, "");
  const root = options.root ?? stateRoot();
  const server = Bun.serve({
    hostname: options.listen.host,
    port: options.port ?? options.listen.port ?? DEFAULT_PORT,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET")
        return new Response("method not allowed", { status: 405 });
      if (!sameToken(url.searchParams.get("token"), token))
        return new Response(
          "this dashboard needs the token its command printed",
          {
            status: 403,
          },
        );
      if (url.pathname === "/rows")
        return Response.json(
          dashboardData(url.searchParams, Date.now(), root),
          {
            headers: { "cache-control": "no-store" },
          },
        );
      if (url.pathname === "/")
        return new Response(PAGE, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      return new Response("not found", { status: 404 });
    },
  });
  const host = options.listen.host.includes(":")
    ? `[${options.listen.host}]`
    : options.listen.host;
  return {
    url: `http://${host}:${server.port}/?token=${token}`,
    stop: () => server.stop(true),
  };
}

/** `jig dispatch dashboard`: serve until the process is stopped. */
export async function dashboardMain(
  listen: Listen | null,
  port: number | undefined,
  machinePath: string,
): Promise<number> {
  if (listen === null)
    throw new ExitError(
      2,
      `jig dispatch dashboard needs dashboard.listen in ${machinePath}: an address in the private or loopback ranges the host already trusts (see CONFIGURATION.md § The machine's dispatch file)`,
    );
  const dashboard = serveDashboard({
    listen,
    ...(port === undefined ? {} : { port }),
  });
  console.log(`jig dispatch dashboard: ${dashboard.url}`);
  console.log("It reads the outcome log when the page asks; Ctrl-C stops it.");
  await new Promise<void>((settle) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => settle());
  });
  dashboard.stop();
  return 0;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Dispatch outcomes</title>
<style>
:root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #ffffff; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #161412; --fg: #f5f5f4; --muted: #a8a29e; --line: #2e2a27; --card: #1f1c1a; --accent: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
h1 { font-size: 1.2rem; margin: 0 0 12px; }
form { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 12px; }
label { display: flex; flex-direction: column; font-size: .8rem; color: var(--muted); gap: 2px; }
select, input, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); min-width: 0; }
.presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.presets button { cursor: pointer; }
.presets button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.counts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.count { background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: .85rem; }
.count b { font-variant-numeric: tabular-nums; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.row .head { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: .85rem; color: var(--muted); }
.row .what { font-weight: 600; }
.row .reason { margin-top: 4px; overflow-wrap: anywhere; }
.empty, .meta { color: var(--muted); }
</style>
</head>
<body>
<h1>Dispatch outcomes</h1>
<div class="presets" id="presets">
  <button type="button" data-preset="today">Today</button>
  <button type="button" data-preset="yesterday">Yesterday</button>
  <button type="button" data-preset="7">7 days</button>
  <button type="button" data-preset="30">30 days</button>
</div>
<form id="filters">
  <label>From<input type="datetime-local" name="from"></label>
  <label>To<input type="datetime-local" name="to"></label>
  <label>Repository<select name="repo"></select></label>
  <label>Stage<select name="stage"></select></label>
  <label>Account<select name="account"></select></label>
  <label>Class<select name="class"></select></label>
  <label>Reason contains<input type="search" name="reason"></label>
</form>
<div class="counts" id="counts"></div>
<p class="meta" id="meta"></p>
<div id="rows"></div>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const form = document.getElementById("filters");
const pad = (n) => String(n).padStart(2, "0");
const local = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
function preset(name) {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let from = midnight, to = now;
  if (name === "yesterday") { from = new Date(midnight.getTime() - 86400000); to = new Date(midnight.getTime() - 1); }
  else if (name !== "today") from = new Date(now.getTime() - Number(name) * 86400000);
  form.from.value = local(from); form.to.value = local(to);
  for (const b of document.querySelectorAll("#presets button")) b.setAttribute("aria-pressed", String(b.dataset.preset === name));
  load();
}
function fill(select, values) {
  const keep = select.value;
  select.replaceChildren(new Option("any", ""));
  for (const v of values) select.add(new Option(v, v));
  select.value = values.includes(keep) ? keep : "";
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function minutes(ms) { return ms === null || ms === undefined ? "" : Math.round(ms / 60000) + " min"; }
async function load() {
  const q = new URLSearchParams({ token });
  for (const [k, v] of new FormData(form)) if (v !== "") q.set(k, k === "from" || k === "to" ? new Date(v).toISOString() : v);
  const answer = await fetch("rows?" + q.toString(), { cache: "no-store" });
  if (!answer.ok) { document.getElementById("meta").textContent = "The dashboard refused the request (" + answer.status + ")."; return; }
  const data = await answer.json();
  for (const name of ["repo", "stage", "account", "class"]) fill(form[name], data.options[name]);
  const counts = document.getElementById("counts");
  counts.replaceChildren(...Object.entries(data.counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => { const c = el("span", "count", k + " "); c.append(el("b", "", String(n))); return c; }));
  document.getElementById("meta").textContent = data.rows.length + " row(s) from " + new Date(data.from).toLocaleString() + " to " + new Date(data.to).toLocaleString();
  const rows = document.getElementById("rows");
  if (data.rows.length === 0) { rows.replaceChildren(el("p", "empty", "No rows in this window.")); return; }
  rows.replaceChildren(...data.rows.map((r) => {
    const card = el("div", "row");
    const head = el("div", "head");
    head.append(el("span", "", new Date(r.at).toLocaleString()), el("span", "what", (r.class ?? ("event: " + r.event))), el("span", "", r.stage + " " + r.target), el("span", "", r.repo));
    if (r.account) head.append(el("span", "", r.account));
    if (r.kind === "ended") { head.append(el("span", "", minutes(r.durationMs))); if (r.rounds !== null) head.append(el("span", "", r.rounds + " round(s)")); if (r.model) head.append(el("span", "", r.model)); }
    card.append(head, el("div", "reason", r.reason));
    return card;
  }));
}
form.addEventListener("change", load);
form.reason.addEventListener("input", () => { clearTimeout(form.timer); form.timer = setTimeout(load, 300); });
for (const b of document.querySelectorAll("#presets button")) b.addEventListener("click", () => preset(b.dataset.preset));
preset("today");
</script>
</body>
</html>
`;

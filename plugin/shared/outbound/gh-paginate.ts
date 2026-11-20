/**
 * A paged `gh api --paginate` read, sent one page at a time by the forge
 * client's wrapper (`shared/trace.ts`), so that each page is admitted,
 * observed and recorded as the request it is: a read of forty pages is
 * charged forty requests, and the dispatcher's floor stops it between pages.
 *
 * Which reads are paged here: a captured `gh api --paginate` read, with the
 * forge's budget on (`JIG_FORGE_BUDGET=off` leaves gh to page itself), that
 * is
 *
 * - a REST read (no method, or `GET`, and no field flags unless the method
 *   is `GET`; no `--input`): the next page is the URL the answer's `Link`
 *   header names `rel="next"`, sent as the route with the caller's other
 *   flags (`-H`, `--jq`, `--template`, `--hostname`) and without its fields,
 *   which that URL already carries, as gh does; a next link off the API
 *   origin of the read's host ends the read (nothing is sent to it);
 * - a GraphQL read with neither `--jq` nor `--template`: the next page is
 *   asked with the `endCursor` variable set to the cursor of the first
 *   `pageInfo` in the answer whose `hasNextPage` is true, as gh does.
 *
 * Any other paged read (streamed output, the caller's own `--include`,
 * `--silent`, `--verbose`, `--input`, GraphQL with `--jq` or `--template`,
 * `--slurp` with either) is left to gh, admitted against a bounded
 * reservation (`PAGINATED_RESERVE` in `github-budget.ts`).
 *
 * The output is what gh prints without `--include`: the pages' arrays
 * merged into one, each page's `--jq` or `--template` output in turn, each
 * page's object in turn, or with `--slurp` one array of the pages.
 *
 * How a paged read ends short of its last page:
 *
 * - a page the budget record or the forge's hold refuses ends it with that
 *   refusal (nothing more is sent; the pages already sent stay charged);
 * - a page that fails ends it with that page's failure, the output of the
 *   pages before it kept, as gh prints them; a failing first page answers
 *   exactly as a single call does;
 * - the whole read keeps the call's one deadline: each page gets what is
 *   left of it, and once it has passed no page is sent;
 * - past `PAGE_CAP` pages it fails as `too-costly` instead of sending more.
 */
import { apiRoute, apiRouteAt, splitHeaders } from "./github-budget.ts";
import { type OutboundFailure, outboundFailure } from "./failure.ts";
import type { GhRun } from "./github.ts";
import { isRecord } from "../guards.ts";
import { swallow } from "../errors.ts";
import { currentMs } from "../time.ts";

/** The most pages one paged read sends. */
export const PAGE_CAP = 100;

/** How a paged read the wrapper sends goes. */
export interface PagePlan {
  /** The first page's command line. */
  first: string[];
  /** The next page's command line from the page just read, `null` after the last. */
  next(headers: Headers | null, body: string): string[] | null;
  /** The read's output from each page's output. */
  assemble(pages: readonly string[]): string;
}

const FIELDS = new Set(["-f", "--raw-field", "-F", "--field"]);
const TEMPLATED = new Set(["-q", "--jq", "-t", "--template"]);
/** Flags whose paged output the wrapper does not reproduce. */
const LEFT_TO_GH = new Set([
  "-i",
  "--include",
  "--silent",
  "--verbose",
  "--input",
]);

/** The flag an argument names, with a joined value (`--jq=…`, `-q…`) read as its flag. */
function flagOf(arg: string): string {
  if (arg.startsWith("--")) return arg.split("=")[0] ?? arg;
  return arg.startsWith("-") ? arg.slice(0, 2) : arg;
}

/** Whether an argument is a field flag or its joined form. */
function isField(arg: string): boolean {
  return FIELDS.has(flagOf(arg));
}

/** The method the command line names, upper case; `null` when it names none. */
function methodOf(args: readonly string[]): string | null {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-X" || arg === "--method")
      return (args[i + 1] ?? "").toUpperCase();
    if (arg.startsWith("--method=")) return arg.slice(9).toUpperCase();
    if (arg.startsWith("-X") && arg.length > 2)
      return arg.slice(2).replace(/^=/, "").toUpperCase();
  }
  return null;
}

/** A joined field flag's value (`-fkey=v`, `--field=key=v`); the argument itself for any other. */
function joinedValue(arg: string): string {
  if (arg.startsWith("--")) return arg.slice(arg.indexOf("=") + 1);
  return arg.startsWith("-") ? arg.slice(2) : arg;
}

/** The command line without `--paginate`, `--slurp` and the fields whose `key=value` `drop` names. */
function stripped(
  args: readonly string[],
  drop: (field: string) => boolean,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--paginate" || arg === "--slurp") continue;
    if (FIELDS.has(arg)) {
      const value = args[i + 1] ?? "";
      i += 1;
      if (!drop(value)) out.push(arg, value);
      continue;
    }
    if (isField(arg) && drop(joinedValue(arg))) continue;
    out.push(arg);
  }
  return out;
}

/** The host a command line sends to: its `--hostname`, else `GH_HOST`, else github.com. */
function hostOf(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--hostname") return (args[i + 1] ?? "").toLowerCase();
    if (arg.startsWith("--hostname=")) return arg.slice(11).toLowerCase();
  }
  return (env.GH_HOST ?? "github.com").toLowerCase();
}

/** Whether `url` is an https URL on the API origin of `host` (`api.<host>`, or `<host>` itself for an enterprise server). */
function onApiOrigin(url: string, host: string): boolean {
  try {
    const at = new URL(url);
    return (
      at.protocol === "https:" &&
      at.username === "" &&
      at.password === "" &&
      (at.hostname === host || at.hostname === `api.${host}`)
    );
  } catch (error) {
    swallow(error, "a next link that is not a URL is not followed");
    return false;
  }
}

/**
 * The next page a REST answer's `Link` header names, when it is on the API
 * origin of the host a call in `env` sends to (`GH_HOST`, else github.com).
 */
export function nextPageUrl(
  headers: Headers | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return nextLink(headers, hostOf([], env));
}

/** The URL the `Link` header names as the next page, when it is on `host`'s API origin. */
function nextLink(headers: Headers | null, host: string): string | null {
  const link = headers?.get("link") ?? "";
  const url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
  return url !== null && onApiOrigin(url, host) ? url : null;
}

/** The cursor of the next page: the first `pageInfo` in the answer, in document order, when it says there is one. */
export function endCursorOf(value: unknown): string | null {
  return cursorIn(value)?.cursor ?? null;
}

/** The first `pageInfo` at or below `value` in document order, as its cursor (`null` when it names no next page); `undefined` when there is none. */
function cursorIn(value: unknown): { cursor: string | null } | undefined {
  if (!isRecord(value) && !Array.isArray(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found =
      (key === "pageInfo" ? pageInfoCursor(child) : undefined) ??
      cursorIn(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function pageInfoCursor(info: unknown): { cursor: string | null } | undefined {
  if (!isRecord(info) || typeof info.hasNextPage !== "boolean")
    return undefined;
  const { hasNextPage, endCursor } = info;
  return {
    cursor: hasNextPage && typeof endCursor === "string" ? endCursor : null,
  };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    swallow(error, "a page that is not JSON names no next page");
    return null;
  }
}

/** Every page's output in turn, or one array that marks blank slurped pages as unreadable. */
function inTurn(slurp: boolean) {
  return (pages: readonly string[]): string =>
    slurp
      ? `[${pages.map((p) => p.trim() || "null").join(",")}]`
      : pages.join("");
}

/** The pages' arrays merged into one, as gh merges them; the pages in turn when one is not an array. */
function merged(pages: readonly string[]): string {
  if (pages.length === 1) return pages[0] ?? "";
  const bodies = pages.map((p) => p.trim());
  if (!bodies.every((b) => b.startsWith("[") && b.endsWith("]")))
    return pages.join("");
  const items = bodies
    .map((b) => b.slice(1, -1).trim())
    .filter((b) => b !== "");
  return `[${items.join(",")}]`;
}

/**
 * How the wrapper pages `args`; `null` for a command line that is not a
 * paged `gh api` read, or one left to gh to page (see the module comment).
 */
export function pagePlan(
  args: readonly string[],
  captured: boolean,
  env: Record<string, string | undefined> = process.env,
): PagePlan | null {
  if (args[0] !== "api" || !args.includes("--paginate") || !captured)
    return null;
  if (args.some((a) => LEFT_TO_GH.has(flagOf(a)))) return null;
  const slurp = args.includes("--slurp");
  const templated = args.some((a) => TEMPLATED.has(flagOf(a)));
  if (slurp && templated) return null;
  const at = apiRouteAt(args);
  if (at < 0) return null;
  // `--include` is the page's own, so the wrapper reads its headers; the
  // budget then leaves them on the output for the wrapper to take off.
  if (apiRoute(args) === "graphql")
    return templated ? null : graphqlPlan(args, slurp);
  return restPlan(args, at, { slurp, templated }, env);
}

function graphqlPlan(args: readonly string[], slurp: boolean): PagePlan {
  const page = (cursor: string | null) => [
    ...stripped(args, (f) => cursor !== null && /^endCursor=/.test(f)),
    ...(cursor === null ? [] : ["-f", `endCursor=${cursor}`]),
    "--include",
  ];
  return {
    first: page(null),
    next: (_headers, body) => {
      const cursor = endCursorOf(json(body));
      return cursor === null ? null : page(cursor);
    },
    assemble: inTurn(slurp),
  };
}

function restPlan(
  args: readonly string[],
  at: number,
  mode: { slurp: boolean; templated: boolean },
  env: Record<string, string | undefined>,
): PagePlan | null {
  const method = methodOf(args);
  const fields = args.some(isField);
  if (method === null ? fields : method !== "GET") return null;
  const host = hostOf(args, env);
  // gh asks REST pages 100 at a time unless the caller said otherwise.
  const first = stripped(args, () => false);
  const firstAt = apiRouteAt(first);
  const route = first[firstAt] ?? "";
  if (!fields && firstAt >= 0 && !/[?&]per_page=/.test(route))
    first[firstAt] = `${route}${route.includes("?") ? "&" : "?"}per_page=100`;
  const assemble = mode.slurp
    ? inTurn(true)
    : mode.templated
      ? inTurn(false)
      : merged;
  return {
    first: [...first, "--include"],
    next: (headers) => {
      const url = nextLink(headers, host);
      if (url === null) return null;
      const rest = [...args];
      rest[at] = url;
      return [...stripped(rest, () => true), "--include"];
    },
    assemble,
  };
}

/** What sends one page: its command line and the seconds it may take. */
export type SendPage<T> = (argv: string[], timeoutSec: number) => Promise<T>;

/**
 * Send `plan`'s pages through `send`, each admitted, observed and recorded
 * as a request of its own, within one deadline of `deadlineSec` seconds;
 * `refuse` is the result of a read stopped before a page was sent.
 */
export async function drivePages<T extends GhRun & { stdout?: string }>(
  plan: PagePlan,
  send: SendPage<T>,
  deadlineSec: number,
  refuse: (failure: OutboundFailure) => T,
): Promise<T> {
  const endAt = currentMs() + deadlineSec * 1000;
  const outputs: string[] = [];
  let argv = plan.first;
  let last: T | null = null;
  for (let page = 1; ; page += 1) {
    const leftSec = (endAt - currentMs()) / 1000;
    if (last !== null && leftSec <= 0)
      // Cut off as a run at its deadline is: `too-costly`, sent.
      return {
        ...last,
        code: 124,
        timedOut: true,
        stdout: plan.assemble(outputs),
        stderr: `the paged read reached its deadline after ${page - 1} pages; sent no more\n`,
      };
    const result = await send(argv, page === 1 ? deadlineSec : leftSec);
    const { headers, body } = splitHeaders(
      typeof result.stdout === "string" ? result.stdout : "",
    );
    const answered = { ...result, stdout: body };
    if (result.code !== 0 || result.held !== undefined)
      return failedPage(answered, page, plan, outputs);
    outputs.push(body);
    last = answered;
    const next = plan.next(headers, body);
    if (next === null) return { ...answered, stdout: plan.assemble(outputs) };
    if (page >= PAGE_CAP)
      return {
        ...refuse(
          outboundFailure(
            "too-costly",
            `the paged read has more than ${PAGE_CAP} pages; sent no more after page ${PAGE_CAP}`,
            { sent: true },
          ),
        ),
        stdout: plan.assemble(outputs),
      };
    argv = next;
  }
}

/**
 * A refused page sent nothing, and a failing first page is a single call's
 * failure; a later failure keeps what the pages before it said.
 */
function failedPage<T extends GhRun & { stdout?: string }>(
  answered: T,
  page: number,
  plan: PagePlan,
  outputs: readonly string[],
): T {
  if (page === 1) return answered;
  return { ...answered, stdout: plan.assemble([...outputs]) };
}

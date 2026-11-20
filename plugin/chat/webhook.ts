/**
 * The `webhook` notification channel (`channel.ts`): each due cause posted,
 * one request each, to an incoming webhook whose address the machine file
 * names by the environment variable that holds it. One channel kind reaches
 * three kinds of destination, chosen by its `format`:
 *
 * - `text`: the notice as plain text, with a `Title` header and, where the
 *   notice links a pull request, a `Click` header. ntfy reads those headers
 *   and shows a push notification on a phone; any endpoint that takes a
 *   plain-text body reads the body.
 * - `slack`: a Slack incoming webhook's JSON, `{"text": …}`, links not
 *   unfurled and Slack's control characters escaped.
 * - `discord`: a Discord webhook's JSON, `{"content": …}`, posted with
 *   `wait=true` so a 2xx means it was saved, with every mention turned off,
 *   Markdown escaped and link previews suppressed.
 *
 * The channel only delivers: which causes are due, the repeat cadence, the
 * back-off and the records are the tick's. It renders the structured notice
 * (its first paragraph, the framed decisions with their options, the acts
 * that settle it, its address and its pull request's link), falling back to
 * the notice's text where the notice carries nothing structured, and cut to
 * what the destination accepts. The key line always comes first, so a
 * reader can match the message to the dashboard.
 *
 * Each cause is answered so:
 *
 * - `sent`: a 2xx answer, the receipt. The place it records is the
 *   channel's name and the destination's host, never the address.
 * - `waits`: nothing was sent (the channel is unreachable, the tick's time
 *   is spent, the transport's hold refused it, or it was stopped first), or
 *   the destination asked to wait (a 429). A cause that waits counts no
 *   failure. A 429 holds the destination in the machine's budget record
 *   until its `Retry-After`, so no channel object of any repository, in this
 *   tick or a later one, sends to that address before then.
 * - `lost`: anything else that was sent and refused or not answered (a 4xx,
 *   a 5xx, a redirect, no answer within the deadline). It counts in the
 *   failure ledger and backs off there; one whose answer was lost after it
 *   left may have arrived, and is sent again once the back-off allows, so a
 *   person may see it twice.
 *
 * After an unanswered post, a 5xx or a 429, the causes left in the tick on
 * this channel wait. A webhook cannot be read back, so the channel never
 * answers `already`, nor can it say whether a notice was read: the
 * `notices_read` observation stays the Orca card's
 * (`dispatch/lib/notices-read.ts`).
 *
 * The address is a credential: it never appears in a delivery's detail, its
 * place, a reason or a ledger row. A variable that is unset or empty, or that
 * holds an address the transport refuses, makes the channel unreachable: the
 * tick reports it once a tick as the host's fault, and every due cause waits.
 * Every request goes through the governed transport
 * (`shared/outbound/http.ts`): a deadline, the closed failure classes, the
 * budget record's hold, the outbound ledger and the run's hold.
 */
import { httpAddress, sendHttp } from "../shared/outbound/http.ts";
import type { BudgetGovernor } from "../shared/outbound/budget.ts";
import type { OutboundFailure } from "../shared/outbound/failure.ts";
import type {
  ChannelNotice,
  NoticeDecision,
  Delivery,
  DeliveryTime,
  DueNotice,
  NotificationChannel,
} from "./channel.ts";

/** How a webhook channel renders a notice: plain text (ntfy), Slack's JSON, or Discord's. */
export const WEBHOOK_FORMATS = ["text", "slack", "discord"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** One webhook channel as the machine file names it. */
export interface WebhookSettings {
  /** The channel's name (`channelNameFault`). */
  name: string;
  /** The environment variable holding the webhook's address. */
  urlEnv: string;
  format: WebhookFormat;
}

/** What a channel is built with beside its settings. */
export interface WebhookOptions {
  /** The tick's environment, which holds the address. */
  env?: Record<string, string | undefined>;
  /** The platform's `fetch`, unless a test hands another. */
  fetchImpl?: typeof fetch;
  /** The longest one request may take; `WEBHOOK_TIMEOUT_MS` unless given. */
  timeoutMs?: number;
  /** The budget record a 429's hold is kept in; the machine's unless a test hands another. */
  governor?: BudgetGovernor;
}

/** The longest one post may take, within the time the tick has left. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** The longest message each format sends: ntfy's message limit in bytes, Slack's practical limit for a message's text, Discord's content limit in characters. */
/** The longest pull-request tail kept whole; a longer one is left out. */
const MAX_LINK_TAIL = 500;

const LIMITS: Readonly<Record<WebhookFormat, number>> = {
  text: 4000,
  slack: 3900,
  discord: 2000,
};

/** A request's body and headers. */
export interface Rendered {
  body: string;
  headers: Record<string, string>;
}

/** The address a post goes to: Discord's gets `wait=true`, so a 2xx means the message was saved; other query parameters stay. */
export function postAddress(raw: string, format: WebhookFormat): string {
  if (format !== "discord" || !URL.canParse(raw)) return raw;
  const url = new URL(raw);
  if (url.searchParams.get("wait") === "true") return raw;
  url.searchParams.set("wait", "true");
  return url.toString();
}

/** The first paragraph of a notice's text: its key line and what follows up to the first blank line. */
function headline(text: string): string {
  const end = text.indexOf("\n\n");
  return end < 0 ? text : text.slice(0, end);
}

/** `text` with each of `parts` removed, longest first. */
function without(text: string, parts: string[]): string {
  return [...parts]
    .sort((a, b) => b.length - a.length)
    .reduce((rest, part) => rest.split(part).join(" "), text);
}

/** The paragraphs of the text after the first that the structured fields do not repeat: a paragraph is left out only when nothing but the fields' own words is in it, so a condition or a warning around them stays. */
function context(notice: ChannelNotice): string[] {
  const end = notice.text.indexOf("\n\n");
  if (end < 0) return [];
  const repeated = [
    ...(notice.decisions ?? []).flatMap((d) => [d.key, d.question ?? ""]),
    ...(notice.acts ?? []),
    notice.address ?? "",
    notice.links?.pullRequest ?? "",
  ].filter((v) => v !== "");
  return notice.text
    .slice(end + 2)
    .split("\n\n")
    .map((p) =>
      p
        .split("\n")
        .filter((line) => /[\p{L}\p{N}]/u.test(without(line, repeated)))
        .join("\n")
        .trim(),
    )
    .filter((p) => p !== "")
    .flatMap((p) => ["", p]);
}

/** Whether a notice carries anything beside its key and text. */
function structured(notice: ChannelNotice): boolean {
  return (
    notice.address !== undefined ||
    notice.links?.pullRequest !== undefined ||
    (notice.acts ?? []).length > 0 ||
    (notice.decisions ?? []).length > 0
  );
}

/** One framed decision's lines: its question, the recommendation, the options. */
function decisionLines(d: NoticeDecision): string[] {
  return [
    `- ${d.key}: ${d.question ?? "framed on the pull request"}`,
    ...(d.recommendation === null
      ? []
      : [`  Recommended: ${d.recommendation}`]),
    ...d.options.flatMap((o) => [
      `  Option: ${o.name}${o.recommended ? " (recommended)" : ""}`,
      ...(o.changes === null ? [] : [`    Changes: ${o.changes}`]),
      ...(o.costs === null ? [] : [`    Costs: ${o.costs}`]),
    ]),
  ];
}

/** A titled block of lines after a blank line; nothing when it has none. */
function block(title: string | null, lines: string[]): string[] {
  if (lines.length === 0) return [];
  return title === null ? ["", ...lines] : ["", title, ...lines];
}

/** The notice's message in plain text: the structured fields where it has them, its text where it has none. */
export function noticeMessage(notice: ChannelNotice, withLink = true): string {
  if (!structured(notice)) return notice.text;
  const link = withLink ? notice.links?.pullRequest : undefined;
  return [
    headline(notice.text),
    ...context(notice),
    ...block("Decisions:", (notice.decisions ?? []).flatMap(decisionLines)),
    ...block(
      "To settle it:",
      (notice.acts ?? []).map((a) => `  ${a}`),
    ),
    ...block(null, [
      ...(notice.address === undefined ? [] : [`Address: ${notice.address}`]),
      ...(link === undefined ? [] : [`Pull request: ${link}`]),
    ]),
  ].join("\n");
}

const UTF8 = new TextEncoder();

/** The size of `text` as `format`'s limit counts it: bytes for ntfy, characters for the others. */
function sizeOf(text: string, format: WebhookFormat): number {
  return format === "text" ? UTF8.encode(text).length : text.length;
}

/** `text` cut to `format`'s limit, its first line (the key line) always whole. */
export function fitted(
  text: string,
  format: WebhookFormat,
  reserve = 0,
): string {
  const limit = LIMITS[format] - reserve;
  if (sizeOf(text, format) <= limit) return text;
  const cut =
    "\n… (cut short: the dispatch dashboard and the pull request hold the rest)";
  const first = text.indexOf("\n");
  const head = first < 0 ? text : text.slice(0, first);
  // The key line stays whole when it fits with the note; one that cannot is cut like the rest.
  let low = sizeOf(head + cut, format) <= limit ? head.length : 0;
  let high = text.length;
  // The longest prefix that fits with the note, never shorter than a key line that fits.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeOf(text.slice(0, mid) + cut, format) <= limit) low = mid;
    else high = mid - 1;
  }
  // Never split a character written as two UTF-16 units.
  const code = text.charCodeAt(low - 1);
  if (low > head.length && code >= 0xd800 && code <= 0xdbff) low -= 1;
  return text.slice(0, low) + cut;
}

/** Printable ASCII alone, for a header value, at most `max` characters. */
function headerValue(value: string, max = 200): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/** Slack's control characters escaped; the payload turns mrkdwn off, so no marker needs defusing. */
function slackControls(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Slack's control characters escaped and raw URLs defused, for words that are not Jig's own. */
function slackText(text: string): string {
  return defuseLinks(slackControls(text));
}

/** A raw URL written so neither service links it: the scheme's colon is followed by a zero-width space. */
function defuseLinks(text: string): string {
  return text.replace(/\b(https?):\/\//gi, "$1:\u200b//");
}

/** Discord's Markdown escaped, and raw URLs defused, so a decision's words are never a link or formatting. */
function discordText(text: string): string {
  return defuseLinks(text.replace(/[\\*_~`|>[\]()#-]/g, (c) => `\\${c}`));
}

/** The request that posts `due` in `format`. */
export function render(due: DueNotice, format: WebhookFormat): Rendered {
  const link = due.notice.links?.pullRequest;
  // Jig's own link is kept usable: it is added after the untrusted words are escaped, and the cut leaves room for it.
  const apart =
    format !== "text" && link !== undefined && structured(due.notice);
  const plain = noticeMessage(due.notice, !apart);
  // A link too long to leave room for the words is left out rather than cut, since a cut address leads nowhere.
  const tail =
    apart && `\n\nPull request: ${link}`.length <= MAX_LINK_TAIL
      ? `\n\nPull request: ${link}`
      : "";
  const escaped =
    format === "slack"
      ? slackText(plain)
      : format === "discord"
        ? discordText(plain)
        : plain;
  const trusted = format === "slack" ? slackControls(tail) : tail;
  // Escaping grows the text, so it comes before the cut to the limit.
  const message = fitted(escaped, format, sizeOf(trusted, format)) + trusted;
  if (format === "slack")
    return {
      body: JSON.stringify({
        text: message,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
      headers: { "Content-Type": "application/json" },
    };
  if (format === "discord")
    return {
      body: JSON.stringify({
        content: message,
        flags: 4,
        allowed_mentions: { parse: [] },
      }),
      headers: { "Content-Type": "application/json" },
    };
  return {
    body: message,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: headerValue(
        `jig: ${due.cause}${due.repeat === true ? " (again)" : ""}, ${due.target}`,
      ),
      ...(link !== undefined && httpAddress(link).ok
        ? { Click: headerValue(link, 2000) }
        : {}),
    },
  };
}

/** Where the address in `urlEnv` points, or why the channel cannot be reached: never the address itself. */
function destinationOf(
  settings: WebhookSettings,
  env: Record<string, string | undefined>,
): { url: string; host: string } | { unreachable: string } {
  const raw = env[settings.urlEnv]?.trim() ?? "";
  if (raw === "")
    return {
      unreachable: `the ${settings.name} channel's address variable ${settings.urlEnv} is not set in the tick's environment`,
    };
  const address = httpAddress(raw);
  if (!address.ok)
    return {
      unreachable: `the address in ${settings.urlEnv}, the ${settings.name} channel's, is refused: ${address.failure.reason} (its value is withheld, since it is a credential)`,
    };
  return { url: raw, host: address.value.host };
}

/** A failure after which the channel sends nothing more this tick: the destination did not answer, or asked to wait. */
function stopsTheTick(failure: OutboundFailure): boolean {
  return (
    failure.code === "unreachable" ||
    failure.code === "server-fault" ||
    failure.code === "too-costly" ||
    failure.code === "rate-limited"
  );
}

/** What one post went to, and how. */
interface Post {
  settings: WebhookSettings;
  url: string;
  host: string;
  longest: number;
  fetchImpl: typeof fetch | undefined;
  governor: BudgetGovernor | undefined;
}

function answer(
  due: DueNotice,
  outcome: Delivery["outcome"],
  place: string | null,
  detail: string,
): Delivery {
  return { key: due.notice.key, outcome, place, detail };
}

/** Post one cause, and answer for it; with the reason the channel stops for the tick, when the answer says to. */
async function postOne(
  post: Post,
  c: DueNotice,
  time: DeliveryTime,
): Promise<{ delivery: Delivery; stop: string | null }> {
  const left = time.timeLeftMs();
  if (time.signal.aborted || (left !== null && left <= 0))
    return {
      delivery: answer(
        c,
        "waits",
        null,
        "the tick's time for delivery was spent",
      ),
      stop: null,
    };
  const { settings } = post;
  const request = render(c, settings.format);
  const sent = await sendHttp({
    system: "webhook",
    operation: `WebhookPost ${settings.format}`,
    url: postAddress(post.url, settings.format),
    destination: `the ${settings.name} webhook at ${post.host}`,
    body: request.body,
    headers: request.headers,
    timeoutMs: Math.min(post.longest, left ?? post.longest),
    signal: time.signal,
    ...(post.fetchImpl === undefined ? {} : { fetchImpl: post.fetchImpl }),
    ...(post.governor === undefined ? {} : { governor: post.governor }),
  });
  if (sent.ok)
    return {
      delivery: answer(
        c,
        "sent",
        `${settings.name} (${post.host})`,
        `posted, HTTP ${sent.value.status}`,
      ),
      stop: null,
    };
  const { failure } = sent;
  // Never sent (a hold refused it, or it was stopped first), or asked to wait: it waits, counting no failure.
  const waits = sent.unsent === true || failure.code === "rate-limited";
  return {
    delivery: answer(
      c,
      waits ? "waits" : "lost",
      null,
      `${failure.code}: ${failure.reason}`,
    ),
    stop: stopsTheTick(failure)
      ? `not sent this tick: ${failure.reason}`
      : null,
  };
}

/** A webhook channel, for one repository's tick. */
export function webhookChannel<Due extends DueNotice = DueNotice>(
  settings: WebhookSettings,
  options: WebhookOptions = {},
): NotificationChannel<Due> {
  const target = destinationOf(settings, options.env ?? process.env);
  let stopped: string | null = null;
  return {
    name: settings.name,
    unreachable: () => ("unreachable" in target ? target.unreachable : null),
    async deliver(
      due: readonly Due[],
      time: DeliveryTime,
    ): Promise<Delivery[]> {
      if ("unreachable" in target)
        return due.map((c) => answer(c, "waits", null, target.unreachable));
      const post: Post = {
        settings,
        ...target,
        longest: options.timeoutMs ?? WEBHOOK_TIMEOUT_MS,
        fetchImpl: options.fetchImpl,
        governor: options.governor,
      };
      const out: Delivery[] = [];
      for (const c of due) {
        if (stopped !== null) {
          out.push(answer(c, "waits", null, stopped));
          continue;
        }
        const { delivery, stop } = await postOne(post, c, time);
        out.push(delivery);
        stopped = stop;
      }
      return out;
    },
  };
}

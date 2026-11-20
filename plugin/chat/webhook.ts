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
 * - `discord`: a Discord webhook's JSON, `{"content": …}`, with every mention
 *   turned off, so no notice pings a role or everyone.
 *
 * The channel only delivers: which causes are due, the repeat cadence, the
 * back-off and the records are the tick's. It renders the structured notice
 * (its first paragraph, the framed decisions with their options, the acts
 * that settle it, its address and its pull request's link), falling back to
 * the notice's text where the notice carries nothing structured, and cut to
 * what the destination accepts. The key line always comes first, so a
 * reader can match the message to the dashboard.
 *
 * A 2xx answer is the receipt (`sent`), and the place it records is the
 * channel's name and the destination's host, never the address. A webhook
 * cannot be read back, so the channel never answers `already`; a delivery
 * whose answer was lost after it was sent is `lost` and is sent again once
 * the back-off allows, so a person may see it twice. Nor can a webhook say
 * whether a notice was read: the `notices_read` observation stays the Orca
 * card's (`dispatch/lib/notices-read.ts`).
 *
 * The address is a credential: it never appears in a delivery's detail, its
 * place, a reason or a ledger row. A variable that is unset or empty, or that
 * holds an address the transport refuses, makes the channel unreachable, and
 * every due cause waits. Every request goes through the governed transport
 * (`shared/outbound/http.ts`): a deadline, the closed failure classes, the
 * outbound ledger and the run's hold. After a destination fails to answer,
 * or asks to wait, the causes left in the tick wait rather than being sent.
 */
import { httpAddress, sendHttp } from "../shared/outbound/http.ts";
import type { OutboundFailure } from "../shared/outbound/failure.ts";
import type {
  ChannelNotice,
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
}

/** The longest one post may take, within the time the tick has left. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The longest message each format sends: ntfy's message limit in bytes, Slack's practical limit for a message's text, Discord's content limit in characters. */
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

/** The first paragraph of a notice's text: its key line and what follows up to the first blank line. */
function headline(text: string): string {
  const end = text.indexOf("\n\n");
  return end < 0 ? text : text.slice(0, end);
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

/** The notice's message in plain text: the structured fields where it has them, its text where it has none. */
export function noticeMessage(notice: ChannelNotice): string {
  if (!structured(notice)) return notice.text;
  const lines = [headline(notice.text)];
  const decisions = notice.decisions ?? [];
  if (decisions.length > 0) {
    lines.push("", "Decisions:");
    for (const d of decisions) {
      lines.push(`- ${d.key}: ${d.question ?? "framed on the pull request"}`);
      if (d.recommendation !== null)
        lines.push(`  Recommended: ${d.recommendation}`);
      if (d.options.length > 0)
        lines.push(
          `  Options: ${d.options.map((o) => (o.recommended ? `${o.name} (recommended)` : o.name)).join(", ")}`,
        );
    }
  }
  const acts = notice.acts ?? [];
  if (acts.length > 0)
    lines.push("", "To settle it:", ...acts.map((a) => `  ${a}`));
  const where: string[] = [];
  if (notice.address !== undefined) where.push(`Address: ${notice.address}`);
  if (notice.links?.pullRequest !== undefined)
    where.push(`Pull request: ${notice.links.pullRequest}`);
  if (where.length > 0) lines.push("", ...where);
  return lines.join("\n");
}

const UTF8 = new TextEncoder();

/** The size of `text` as `format`'s limit counts it: bytes for ntfy, characters for the others. */
function sizeOf(text: string, format: WebhookFormat): number {
  return format === "text" ? UTF8.encode(text).length : text.length;
}

/** `text` cut to `format`'s limit, its first line (the key line) always whole. */
export function fitted(text: string, format: WebhookFormat): string {
  const limit = LIMITS[format];
  if (sizeOf(text, format) <= limit) return text;
  const cut =
    "\n… (cut short: the dispatch dashboard and the pull request hold the rest)";
  const first = text.indexOf("\n");
  const head = first < 0 ? text : text.slice(0, first);
  let low = head.length;
  let high = text.length;
  // The longest prefix that fits with the note, never shorter than the key line.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (sizeOf(text.slice(0, mid) + cut, format) <= limit) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + cut;
}

/** Printable ASCII alone, for a header value, at most `max` characters. */
function headerValue(value: string, max = 200): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/** Slack's control characters escaped, so text is never read as a link or a mention. */
function slackText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The request that posts `due` in `format`. */
export function render(due: DueNotice, format: WebhookFormat): Rendered {
  const message = fitted(noticeMessage(due.notice), format);
  if (format === "slack")
    return {
      body: JSON.stringify({
        text: slackText(message),
        unfurl_links: false,
        unfurl_media: false,
      }),
      headers: { "Content-Type": "application/json" },
    };
  if (format === "discord")
    return {
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [] },
      }),
      headers: { "Content-Type": "application/json" },
    };
  const link = due.notice.links?.pullRequest;
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
    failure.code === "rate-limited"
  );
}

/** A webhook channel, for one repository's tick. */
export function webhookChannel<Due extends DueNotice = DueNotice>(
  settings: WebhookSettings,
  options: WebhookOptions = {},
): NotificationChannel<Due> {
  const target = destinationOf(settings, options.env ?? process.env);
  const longest = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  let stopped: string | null = null;
  const answer = (
    due: Due,
    outcome: Delivery["outcome"],
    place: string | null,
    detail: string,
  ): Delivery => ({ key: due.notice.key, outcome, place, detail });
  return {
    name: settings.name,
    unreachable: () => ("unreachable" in target ? target.unreachable : null),
    async deliver(
      due: readonly Due[],
      time: DeliveryTime,
    ): Promise<Delivery[]> {
      if ("unreachable" in target)
        return due.map((c) => answer(c, "waits", null, target.unreachable));
      const place = `${settings.name} (${target.host})`;
      const out: Delivery[] = [];
      for (const c of due) {
        const left = time.timeLeftMs();
        if (stopped !== null) {
          out.push(answer(c, "waits", null, stopped));
          continue;
        }
        if (time.signal.aborted || (left !== null && left <= 0)) {
          out.push(
            answer(c, "waits", null, "the tick's time for delivery was spent"),
          );
          continue;
        }
        const request = render(c, settings.format);
        const sent = await sendHttp({
          system: "webhook",
          operation: `WebhookPost ${settings.format}`,
          url: target.url,
          destination: `the ${settings.name} webhook at ${target.host}`,
          body: request.body,
          headers: request.headers,
          timeoutMs: Math.min(longest, left ?? longest),
          signal: time.signal,
          ...(options.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.fetchImpl }),
        });
        if (sent.ok) {
          out.push(
            answer(c, "sent", place, `posted, HTTP ${sent.value.status}`),
          );
          continue;
        }
        // Stopped before it left: not tried, so it waits rather than counting as lost.
        const tried = sent.failure.sent === true || !time.signal.aborted;
        out.push(
          answer(
            c,
            tried ? "lost" : "waits",
            null,
            `${sent.failure.code}: ${sent.failure.reason}`,
          ),
        );
        if (stopsTheTick(sent.failure))
          stopped = `not sent this tick: ${sent.failure.reason}`;
      }
      return out;
    },
  };
}

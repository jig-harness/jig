/**
 * The machine file's `notify` key: the notification channels
 * (`chat/channel.ts`) the tick sends each cause through, beside the Orca
 * card the session runtime writes on `runtime: orca`. A channel is the
 * host's, never a repository's: its credential belongs to the machine.
 *
 * ```yaml
 * notify:
 *   channels:
 *     - name: phone                     # lowercase letters, digits, hyphens
 *       kind: webhook                   # the one kind
 *       url_env: JIG_NOTIFY_PHONE_URL   # the variable holding the address
 *       format: text                    # text (ntfy), slack or discord
 * ```
 *
 * A webhook's address is a credential, so the file names the environment
 * variable that holds it, never the address; a `url_env` that looks like an
 * address is refused without echoing it. `orca-card` names the Orca card
 * and no other channel. On `runtime: process`, which writes no card, a
 * repository's `notify` stage needs at least one channel here.
 */
import { channelNameFault } from "../../chat/channel.ts";
import {
  WEBHOOK_FORMATS,
  type WebhookFormat,
  webhookChannel,
  type WebhookSettings,
} from "../../chat/webhook.ts";
import type { NotificationChannel } from "../../chat/channel.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import type { Cause } from "./actions/notify.ts";
import {
  type Checked,
  each,
  invalid,
  list,
  only,
  text,
} from "./machine-values.ts";
import { ORCA_CARD } from "./notice-records.ts";

/** A webhook channel the machine file names. */
export interface WebhookChannelConfig extends WebhookSettings {
  kind: "webhook";
}

/** A notification channel the machine file names; `webhook` is the one kind. */
export type NotifyChannelConfig = WebhookChannelConfig;

const NOTIFY_KEYS = ["channels"];
const CHANNEL_KEYS = ["name", "kind", "url_env", "format"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function channel(
  value: unknown,
  i: number,
  taken: string[],
): Checked<NotifyChannelConfig> {
  const where = `notify.channels[${i}]`;
  if (!isMapping(value)) return invalid(`${where} must be a mapping`);
  const known = only(value, CHANNEL_KEYS, where);
  if (!known.ok) return known;
  const name = text(value.name, `${where}.name`);
  if (!name.ok) return name;
  if (name.value === ORCA_CARD)
    return invalid(
      `${where}.name: ${ORCA_CARD} names the Orca card the session runtime writes; choose another name`,
    );
  const fault = channelNameFault(name.value, taken);
  if (fault !== null) return invalid(`${where}.name: ${fault}`);
  if (value.kind !== "webhook")
    return invalid(`${where}.kind must be webhook, the one channel kind`);
  const urlEnv = text(value.url_env, `${where}.url_env`);
  if (!urlEnv.ok) return urlEnv;
  if (!ENV_NAME.test(urlEnv.value))
    return invalid(
      `${where}.url_env must name an environment variable that holds the webhook's address, never the address (its value is withheld, since it may be a credential)`,
    );
  const format = value.format ?? "text";
  if (!(WEBHOOK_FORMATS as readonly unknown[]).includes(format))
    return invalid(
      `${where}.format must be one of ${WEBHOOK_FORMATS.join(", ")}`,
    );
  taken.push(name.value);
  return ok({
    name: name.value,
    kind: "webhook",
    urlEnv: urlEnv.value,
    format: format as WebhookFormat,
  });
}

/** `notify`'s channels; none when the key is absent. */
export function notifyChannels(value: unknown): Checked<NotifyChannelConfig[]> {
  if (value === undefined || value === null) return ok([]);
  if (!isMapping(value)) return invalid("notify must be a mapping");
  const known = only(value, NOTIFY_KEYS, "notify");
  if (!known.ok) return known;
  const raw = list(value.channels, "notify.channels");
  if (!raw.ok) return raw;
  const taken: string[] = [];
  return each(raw.value, (item, i) => channel(item, i, taken));
}

/** Where one repository's tick sends its notices: whether it writes the Orca card, and the channels it sends through beside it. */
export interface NoticeOutlets {
  orcaCard: boolean;
  channels: Array<NotificationChannel<Cause>>;
}

/** The outlets the machine file gives a tick: the Orca card on `runtime: orca` alone, and every channel `notify.channels` names, built over the tick's environment. */
export function noticeOutlets(
  machine: {
    runtime?: "orca" | "process";
    notifyChannels?: readonly NotifyChannelConfig[];
  },
  env: Record<string, string | undefined> = process.env,
): NoticeOutlets {
  return {
    orcaCard: machine.runtime !== "process",
    channels: (machine.notifyChannels ?? []).map((c) =>
      webhookChannel<Cause>(c, { env }),
    ),
  };
}

/**
 * The machine file's `notify` key (`notify-config.ts`): the notification
 * channels a host names beside the Orca card, and the `notify` stage on
 * `runtime: process`, which needs one of them.
 */
import { describe, expect, it } from "bun:test";
import { parseMachineConfigText } from "../lib/machine-config.ts";
import { noticeOutlets } from "../lib/notify-config.ts";

const PATH = JSON.stringify(import.meta.dir);

function read(runtime: "orca" | "process", channels: string[] | null) {
  return parseMachineConfigText(
    [
      `runtime: ${runtime}`,
      "repositories:",
      `  - path: ${PATH}`,
      "    stages: [pickup, notify]",
      ...(channels === null ? [] : ["notify:", "  channels:", ...channels]),
    ].join("\n"),
    "machine",
  );
}

const PHONE = [
  "    - name: phone",
  "      kind: webhook",
  "      url_env: JIG_NOTIFY_PHONE_URL",
];

describe.skipIf(process.platform === "win32")("on runtime: process", () => {
  it("accepts the notify stage with a webhook channel", () => {
    expect(read("process", [...PHONE, "      format: discord"])).toMatchObject({
      ok: true,
      value: {
        runtime: "process",
        notifyChannels: [
          {
            name: "phone",
            kind: "webhook",
            urlEnv: "JIG_NOTIFY_PHONE_URL",
            format: "discord",
          },
        ],
      },
    });
  });

  it("refuses the notify stage with no channel, naming the field", () => {
    for (const channels of [null, []])
      expect(read("process", channels)).toMatchObject({
        ok: false,
        failure: {
          code: "invalid",
          reason: expect.stringContaining("notify.channels"),
        },
      });
  });

  it("builds no Orca card, only the channels", () => {
    const config = read("process", PHONE);
    if (!config.ok) throw new Error(config.failure.reason);
    const outlets = noticeOutlets(config.value, {});
    expect(outlets.orcaCard).toBe(false);
    expect(outlets.channels.map((c) => c.name)).toEqual(["phone"]);
  });
});

describe("on runtime: orca", () => {
  it("keeps the card and names no channel unless the file does", () => {
    const config = read("orca", null);
    if (!config.ok) throw new Error(config.failure.reason);
    expect(config.value).not.toHaveProperty("notifyChannels");
    expect(noticeOutlets(config.value, {})).toEqual({
      orcaCard: true,
      channels: [],
    });
  });

  it("formats as text when the channel names no format", () => {
    expect(read("orca", PHONE)).toMatchObject({
      ok: true,
      value: { notifyChannels: [{ format: "text" }] },
    });
  });
});

describe("a channel the file refuses", () => {
  const SECRET = "https://hooks.example.test/services/T0/B0/s3cr3t";
  for (const [why, channels, says] of [
    [
      "an address in place of its variable, the value withheld",
      ["    - name: phone", "      kind: webhook", `      url_env: ${SECRET}`],
      "never the address",
    ],
    [
      "the Orca card's name",
      ["    - name: orca-card", "      kind: webhook", "      url_env: HOOK"],
      "orca-card names the Orca card",
    ],
    [
      "a name the port refuses",
      ["    - name: Phone", "      kind: webhook", "      url_env: HOOK"],
      "lowercase letters",
    ],
    [
      "a name given twice",
      [...PHONE, ...PHONE],
      "two notification channels are named phone",
    ],
    [
      "an unknown kind",
      ["    - name: phone", "      kind: forge", "      url_env: HOOK"],
      "kind must be webhook",
    ],
    [
      "an unknown format",
      [...PHONE, "      format: teams"],
      "format must be one of text, slack, discord",
    ],
    ["an unknown key", [...PHONE, "      url: x"], "unknown key(s): url"],
  ] as const)
    it(`for ${why}`, () => {
      const outcome = read("orca", [...channels]);
      expect(outcome).toMatchObject({
        ok: false,
        failure: { reason: expect.stringContaining(says) },
      });
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
    });
});

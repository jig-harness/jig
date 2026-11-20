/**
 * The `webhook` notification channel (`chat/webhook.ts`): how it renders a
 * structured notice in each format, how each failure is answered, how it
 * honours the time it is given, and that the address, a credential, never
 * reaches what it answers.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { DeliveryTime, DueNotice } from "../channel.ts";
import {
  type CallRecord,
  withLedgerWriter,
} from "../../shared/outbound/ledger.ts";
import {
  fitted,
  noticeMessage,
  render,
  webhookChannel,
  type WebhookFormat,
} from "../webhook.ts";

const SECRET = "T000/B000/s3cr3t";
const KEY =
  "example-org/example-repo PR #7 parked, ledger generation 3: thread F1";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

interface Hit {
  body: string;
  headers: Headers;
}

/** A webhook that answers each request with `status` (or `answer`'s response), recording what it received. */
function hook(
  answer: (n: number) => Response | Promise<Response> = () =>
    new Response("ok"),
) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      hits.push({ body: await request.text(), headers: request.headers });
      return answer(hits.length);
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}/hooks/${SECRET}`,
    hits,
    host: `127.0.0.1:${server.port}`,
  };
}

function parked(key = KEY): DueNotice {
  return {
    target: "PR #7",
    cause: "parked",
    notice: {
      key,
      text: `[jig dispatch: ${key}]\nPR #7 (Budget) is parked: one decision waits for a person.\n\nWhich budget applies?\n\nAnswer on the pull request.\nhttps://example.test/pull/7`,
      address: "drive@example-org/example-repo#7",
      links: { pullRequest: "https://example.test/pull/7" },
      acts: ["jig send answer drive@example-org/example-repo#7 F1 Keep"],
      decisions: [
        {
          key: "F1",
          question: "Which budget applies?",
          recommendation: "Keep, since nothing else changes",
          options: [
            { name: "Keep", changes: null, costs: null, recommended: true },
            {
              name: "Raise",
              changes: "more",
              costs: "money",
              recommended: false,
            },
          ],
        },
      ],
    },
  };
}

function plain(key: string): DueNotice {
  return {
    target: "host",
    cause: "action-failing",
    notice: {
      key,
      text: `[jig dispatch: ${key}]\nThe tick failed 3 times in a row.`,
    },
  };
}

function time(
  left: number | null = null,
  signal = new AbortController().signal,
): DeliveryTime {
  return { timeLeftMs: () => left, signal };
}

const env = (url: string | undefined) => ({ JIG_TEST_HOOK: url });

function channel(
  url: string | undefined,
  format: WebhookFormat = "text",
  timeoutMs?: number,
) {
  return webhookChannel(
    { name: "phone", urlEnv: "JIG_TEST_HOOK", format },
    { env: env(url), ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
}

async function deliver(
  url: string | undefined,
  due: DueNotice[],
  options: {
    format?: WebhookFormat;
    time?: DeliveryTime;
    timeoutMs?: number;
  } = {},
) {
  const rows: CallRecord[] = [];
  const answers = await withLedgerWriter(
    (row) => rows.push(row),
    () =>
      channel(url, options.format, options.timeoutMs).deliver(
        due,
        options.time ?? time(),
      ),
  );
  // The address is a credential: nothing the channel answers or records holds it.
  expect(JSON.stringify(answers)).not.toContain(SECRET);
  expect(JSON.stringify(rows)).not.toContain(SECRET);
  return { answers, rows };
}

describe("rendering", () => {
  it("leads with the key line, then the decisions, the acts, the address and the link", () => {
    const message = noticeMessage(parked().notice);
    expect(message.split("\n")[0]).toBe(`[jig dispatch: ${KEY}]`);
    expect(message).toContain("PR #7 (Budget) is parked");
    expect(message).toContain("- F1: Which budget applies?");
    expect(message).toContain("Recommended: Keep, since nothing else changes");
    expect(message).toContain("Options: Keep (recommended), Raise");
    expect(message).toContain(
      "jig send answer drive@example-org/example-repo#7 F1 Keep",
    );
    expect(message).toContain("Address: drive@example-org/example-repo#7");
    expect(message).toContain("Pull request: https://example.test/pull/7");
    expect(message).not.toContain("Answer on the pull request.");
  });

  it("falls back to the notice's text when it carries nothing structured", () => {
    const due = plain("host ticks failing");
    expect(noticeMessage(due.notice)).toBe(due.notice.text);
  });

  it("posts plain text with ntfy's title and click headers", () => {
    const { body, headers } = render({ ...parked(), repeat: true }, "text");
    expect(body).toBe(noticeMessage(parked().notice));
    expect(headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      Title: "jig: parked (again), PR #7",
      Click: "https://example.test/pull/7",
    });
  });

  it("posts Slack's JSON with its control characters escaped and links not unfurled", () => {
    const due = plain("a <!channel> & <b>");
    const { body, headers } = render(due, "slack");
    expect(headers["Content-Type"]).toBe("application/json");
    const json = JSON.parse(body);
    expect(json.text).toContain("a &lt;!channel&gt; &amp; &lt;b&gt;");
    expect(json).toMatchObject({ unfurl_links: false, unfurl_media: false });
  });

  it("posts Discord's JSON with every mention turned off", () => {
    const { body } = render(plain("@everyone look"), "discord");
    const json = JSON.parse(body);
    expect(json.content).toContain("@everyone look");
    expect(json.allowed_mentions).toEqual({ parse: [] });
  });

  it("cuts a long notice to the format's limit, the key line whole", () => {
    const key = "k".repeat(300);
    const long = {
      ...plain(key),
      notice: { key, text: `[jig dispatch: ${key}]\n${"é".repeat(5000)}` },
    };
    for (const [format, size] of [
      ["text", (s: string) => new TextEncoder().encode(s).length],
      ["discord", (s: string) => s.length],
    ] as const) {
      const cut = fitted(long.notice.text, format);
      expect(size(cut)).toBeLessThanOrEqual(format === "text" ? 4000 : 2000);
      expect(cut.startsWith(`[jig dispatch: ${key}]\n`)).toBe(true);
      expect(cut).toContain("cut short");
    }
    expect(
      JSON.parse(render(long, "discord").body).content.length,
    ).toBeLessThanOrEqual(2000);
  });
});

describe("delivery", () => {
  it("posts each due cause once and answers sent, the place naming the channel and the host alone", async () => {
    const h = hook();
    const { answers, rows } = await deliver(h.url, [parked(), plain("second")]);
    expect(answers).toEqual([
      {
        key: KEY,
        outcome: "sent",
        place: `phone (${h.host})`,
        detail: "posted, HTTP 200",
      },
      {
        key: "second",
        outcome: "sent",
        place: `phone (${h.host})`,
        detail: "posted, HTTP 200",
      },
    ]);
    expect(h.hits).toHaveLength(2);
    expect(h.hits[0]?.body.startsWith(`[jig dispatch: ${KEY}]`)).toBe(true);
    expect(h.hits[0]?.headers.get("title")).toBe("jig: parked, PR #7");
    expect(rows.map((r) => [r.system, r.operation, r.failure])).toEqual([
      ["webhook", "WebhookPost text", null],
      ["webhook", "WebhookPost text", null],
    ]);
  });

  it("answers a refused post lost and goes on with the next", async () => {
    const h = hook(
      (n) => new Response("invalid_payload", { status: n === 1 ? 400 : 200 }),
    );
    const { answers } = await deliver(h.url, [parked(), plain("second")], {
      format: "slack",
    });
    expect(answers.map((a) => [a.outcome, a.detail])).toEqual([
      ["lost", expect.stringContaining("invalid: the phone webhook")],
      ["sent", "posted, HTTP 200"],
    ]);
    expect(answers[0]?.place).toBeNull();
  });

  for (const [status, code] of [
    [503, "server-fault"],
    [429, "rate-limited"],
  ] as const)
    it(`answers HTTP ${status} lost as ${code}, and the causes after it wait`, async () => {
      const h = hook(() => new Response("", { status }));
      const { answers } = await deliver(h.url, [parked(), plain("second")]);
      expect(answers.map((a) => a.outcome)).toEqual(["lost", "waits"]);
      expect(answers[0]?.detail).toStartWith(`${code}: `);
      expect(answers[1]?.detail).toStartWith("not sent this tick: ");
      expect(h.hits).toHaveLength(1);
    });

  it("never answers already: a webhook cannot be read back", async () => {
    const h = hook();
    const first = await deliver(h.url, [parked()]);
    const again = await deliver(h.url, [parked()]);
    expect([...first.answers, ...again.answers].map((a) => a.outcome)).toEqual([
      "sent",
      "sent",
    ]);
  });
});

describe("an address that is not there", () => {
  it("makes the channel unreachable when its variable is unset or empty, and every cause waits unsent", async () => {
    for (const url of [undefined, "", "  "]) {
      const c = channel(url);
      expect(c.unreachable()).toBe(
        "the phone channel's address variable JIG_TEST_HOOK is not set in the tick's environment",
      );
      const { answers, rows } = await deliver(url, [parked()]);
      expect(answers.map((a) => a.outcome)).toEqual(["waits"]);
      expect(rows).toEqual([]);
    }
  });

  it("makes the channel unreachable when the variable holds an address it refuses, the value withheld", () => {
    const c = channel(`http://hooks.example.test/${SECRET}`);
    expect(c.unreachable()).toContain("its value is withheld");
    expect(c.unreachable()).not.toContain(SECRET);
  });
});

describe("the time it is given", () => {
  it("sends nothing once the tick's time is spent", async () => {
    const h = hook();
    const { answers } = await deliver(h.url, [parked()], { time: time(0) });
    expect(answers).toEqual([
      expect.objectContaining({
        outcome: "waits",
        detail: "the tick's time for delivery was spent",
      }),
    ]);
    expect(h.hits).toHaveLength(0);
  });

  it("sends nothing once its signal has aborted", async () => {
    const h = hook();
    const controller = new AbortController();
    controller.abort();
    const { answers } = await deliver(h.url, [parked(), plain("second")], {
      time: time(null, controller.signal),
    });
    expect(answers.map((a) => a.outcome)).toEqual(["waits", "waits"]);
    expect(h.hits).toHaveLength(0);
  });

  it("bounds a post by its deadline and answers it lost, the causes after it waiting", async () => {
    const h = hook(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response()), 5000),
        ),
    );
    const { answers } = await deliver(h.url, [parked(), plain("second")], {
      timeoutMs: 50,
    });
    expect(answers.map((a) => a.outcome)).toEqual(["lost", "waits"]);
    expect(answers[0]?.detail).toContain("no answer within 50ms");
  });

  it("bounds a post by the time the tick has left", async () => {
    const h = hook(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response()), 5000),
        ),
    );
    const { answers } = await deliver(h.url, [parked()], { time: time(40) });
    expect(answers[0]?.detail).toContain("no answer within 40ms");
  });

  it("stops a post in flight when its signal aborts, and answers it lost", async () => {
    const h = hook(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response()), 5000),
        ),
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const { answers } = await deliver(h.url, [parked(), plain("second")], {
      time: time(null, controller.signal),
    });
    expect(answers.map((a) => a.outcome)).toEqual(["lost", "waits"]);
  });
});

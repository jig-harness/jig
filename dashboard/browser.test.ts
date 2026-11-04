/**
 * The page in a real browser, against the real server over each scenario: what
 * only a rendered page can show. Every scenario at a phone's width and a
 * laptop's, light and dark, for overflow, requests, errors and the strip's fact;
 * then the behaviours one scenario at a time.
 *
 * It drives Chromium through `playwright-core`, from `JIG_CHROMIUM` or the
 * Playwright cache. Where none is found the checks cannot run and are skipped
 * with a warning. Set `JIG_REQUIRE_BROWSER=1` on a machine that must run them:
 * there a missing browser is a failing test, so a suite that never ran cannot
 * read as a pass. Set `DASHBOARD_SHOTS=<dir>` to also write one image per
 * scenario, width and theme.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { type Browser, chromium, type Page } from "playwright-core";
import {
  bottomOf,
  chromiumPath,
  CONNECTION_LOST,
  loseServer,
  open,
  REFUSAL_LOAD,
  type Served,
  settled,
  shoot,
  shortControls,
  shows,
  start,
  staysAway,
  until,
  type Watched,
} from "./browser-page.ts";
import { SCENARIOS, type ScenarioId } from "./fixtures.ts";
import { FIXTURE_TOKEN } from "./serve-fixture.ts";

const TOKEN = FIXTURE_TOKEN;
const TIMEOUT = 60_000;

const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1440, height: 900 };

let browser: Browser | undefined;
let missing = "";
const executablePath = chromiumPath();
if (executablePath === null) missing = "no Chromium in the Playwright cache";
else
  try {
    browser = await chromium.launch({ executablePath, headless: true });
  } catch (error) {
    missing =
      error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
  }

afterAll(async () => {
  await browser?.close();
});

if (!browser && process.env.JIG_REQUIRE_BROWSER === "1")
  it("a browser is available where one is required", () => {
    throw new Error(
      `these checks need Chromium and found none (${missing}); JIG_REQUIRE_BROWSER=1 makes a missing browser fail instead of skip`,
    );
  });
else if (!browser)
  console.warn(
    `dispatch-dashboard browser checks: skipped (${missing}). Set JIG_REQUIRE_BROWSER=1 to make this an error.`,
  );

const browserIt = browser ? it : it.skip;

/** The browser, inside a check that only runs when there is one. */
function requireBrowser(): Browser {
  if (browser === undefined) throw new Error("no browser");
  return browser;
}

const running = new Map<ScenarioId, Promise<Served>>();

function served(scenario: ScenarioId): Promise<Served> {
  const known = running.get(scenario);
  if (known !== undefined) return known;
  const started = start(scenario);
  running.set(scenario, started);
  return started;
}

afterAll(async () => {
  for (const server of running.values()) await (await server).stop();
});

const WRONG_TOKEN = "wrong-token";
/** Longer than any hover delay a popover would open after. */
const HOVER_WATCH_MS = 600;
const LONG_VIEW =
  "window=30d&repo=example-org/web&class=gates+failed&reason=conflict";

/** The address a scenario's checks open: a wrong token is the point of `token`, a narrowed view of `long`. */
function addressOf(server: Served, scenario: ScenarioId): string {
  if (scenario === "token") return server.url.replace(TOKEN, WRONG_TOKEN);
  return scenario === "long" ? `${server.url}&${LONG_VIEW}` : server.url;
}

/** What each scenario's strip must say. */
const TICK_FACT: Record<ScenarioId, RegExp> = {
  quiet: /Tick 16:45, 2 min ago\s*next due 16:50/,
  loud: /Tick 16:45, 2 min ago\s*next due 16:50/,
  hung: /Tick 16:45, 2 min ago\s*next due 16:50/,
  queue: /Tick 16:45, 2 min ago\s*next due 16:50/,
  stopped: /Tick 16:00, 47 min ago\s*next was due 16:05, overdue 42 min/,
  gone: /Tick 16:40, 7 min ago\s*server not answering/,
  token: /Newest tick not known\s*the server refused this request/,
  empty: /No tick yet\s*no receipt on this host/,
  long: /Tick 16:45, 2 min ago\s*next due 16:50/,
};

/** What each scenario's answer must say first. */
const ANSWER: Partial<Record<ScenarioId, RegExp>> = {
  quiet: /Nothing needs a person\./,
  loud: /8 need a person\..*First: PR #456, parked for a person\./s,
  hung: /1 needs a person\..*First: PR #472, nudge-unanswered\./s,
  queue: /1 needs a person\..*First: #231, assigner cannot write\./s,
  stopped: /Nothing needed a person at the 16:00 tick\./,
  gone: /8 needed a person at the 16:40 tick\..*First: PR #456, parked for a person\./s,
  empty: /No tick has run on this host\./,
  long: /Nothing needs a person\./,
};

const WIDTHS = [
  { name: "phone", viewport: PHONE },
  { name: "laptop", viewport: LAPTOP },
] as const;

const THEMES = ["light", "dark"] as const;

type Viewport = { width: number; height: number };
type Theme = (typeof THEMES)[number];

/** The other theme, which the device asks for so a forced one is seen to win. */
const DEVICE_THEME = { light: "dark", dark: "light" } as const;

/** Opens one cell of the matrix: a scenario at a width, with its theme forced. */
async function openCell(
  scenario: ScenarioId,
  viewport: Viewport,
  theme: Theme,
): Promise<{ server: Served; watched: Watched }> {
  // The server gone is a state a page reaches, so this scenario's server is its own to stop.
  const server =
    scenario === "gone" ? await start(scenario) : await served(scenario);
  const address = addressOf(server, scenario);
  // The refusal has no script to read a forced theme, so it follows the device.
  const watched =
    scenario === "token"
      ? await open(requireBrowser(), server.origin, address, viewport, theme, [
          REFUSAL_LOAD,
        ])
      : await open(
          requireBrowser(),
          server.origin,
          `${address}&theme=${theme}`,
          viewport,
          DEVICE_THEME[theme],
          [CONNECTION_LOST],
        );
  return { server, watched };
}

/** Waits until a cell's strip states its tick and the page has settled. */
async function cellSettled(page: Page, scenario: ScenarioId): Promise<void> {
  await shows(page, ".tick b");
  await until("the strip states its fact", async () =>
    TICK_FACT[scenario].test((await page.locator(".tick").innerText()) ?? ""),
  );
  if (ANSWER[scenario] !== undefined) await shows(page, ".answer");
  if (scenario !== "token") await shows(page, "#history h2");
  await settled(page);
}

/** What every cell shows: no overflow, the forced theme, and the strip in view. */
async function expectFrame(
  page: Page,
  viewport: Viewport,
  theme: Theme,
): Promise<void> {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const background = await page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".dd") as Element)
        .backgroundColor,
  );
  expect(background).toBe(
    theme === "dark" ? "rgb(26, 23, 19)" : "rgb(249, 246, 241)",
  );
  expect(await page.locator(".tick").isVisible()).toBe(true);
  expect(await bottomOf(page, ".tick")).toBeLessThan(viewport.height);
}

/** What a phone also shows: every control tall enough, and the answer above the fold. */
async function expectPhone(
  page: Page,
  viewport: Viewport,
  scenario: ScenarioId,
): Promise<void> {
  expect(await shortControls(page)).toEqual([]);
  if (ANSWER[scenario] !== undefined)
    expect(await bottomOf(page, ".answer")).toBeLessThanOrEqual(
      viewport.height,
    );
}

describe("every scenario, at each width and in each theme", () => {
  for (const scenario of SCENARIOS)
    for (const { name, viewport } of WIDTHS)
      for (const theme of THEMES)
        browserIt(
          `${scenario} on a ${name}, ${theme}`,
          async () => {
            const { server, watched } = await openCell(
              scenario,
              viewport,
              theme,
            );
            const { page } = watched;
            try {
              if (scenario === "gone") await loseServer(page, server);
              await cellSettled(page, scenario);
              await shoot(page, `${scenario}-${viewport.width}-${theme}`);
              const answer = ANSWER[scenario];
              if (answer !== undefined)
                expect(await page.locator(".answer").innerText()).toMatch(
                  answer,
                );
              await expectFrame(page, viewport, theme);
              if (name === "phone") await expectPhone(page, viewport, scenario);
              expect(watched.otherOrigins).toEqual([]);
              expect(watched.problems).toEqual([]);
            } finally {
              await watched.context.close();
              if (scenario === "gone") await server.stop();
            }
          },
          TIMEOUT,
        );
});

describe("the desktop fold", () => {
  browserIt(
    "loud at 1440: every panel's first screen ends within 900 px",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pWindow .fbtn");
        await settled(page);
        // What needs you runs past the fold by design: its heading and first rows must stand above it.
        expect(await bottomOf(page, ".pNeeds .need")).toBeLessThanOrEqual(900);
        expect(await page.locator(".pNeeds .need").count()).toBeGreaterThan(5);
        expect(await bottomOf(page, ".pLine")).toBeLessThanOrEqual(900);
        expect(await bottomOf(page, ".pQueue")).toBeLessThanOrEqual(900);
        expect(await bottomOf(page, ".pWindow")).toBeLessThanOrEqual(900);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the reshaped page", () => {
  browserIt(
    "with no needs the answer is a plain line and the line takes the wide column",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pLine");
        expect(await page.locator(".answer.loud").count()).toBe(0);
        expect(await page.locator(".pNeeds").count()).toBe(0);
        const wide = await page
          .locator(".pLine")
          .evaluate((e) => e.getBoundingClientRect().left);
        const narrow = await page
          .locator(".pQueue")
          .evaluate((e) => e.getBoundingClientRect().left);
        expect(wide).toBeLessThan(narrow);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "with needs a filled band appears and What needs you takes the wide column",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pNeeds");
        expect(await page.locator(".answer.loud").count()).toBe(1);
        const needs = await page
          .locator(".pNeeds")
          .evaluate((e) => e.getBoundingClientRect().left);
        const line = await page
          .locator(".pLine")
          .evaluate((e) => e.getBoundingClientRect().left);
        expect(needs).toBeLessThan(line);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the server gone", () => {
  browserIt(
    "keeps what it last returned, says when, and turns the filters off",
    async () => {
      // This scenario's server is stopped here, so it is its own.
      const server = await start("gone");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
        "light",
        [CONNECTION_LOST],
      );
      try {
        await shows(page, ".pNeeds");
        await shows(page, ".selBtn");
        expect(await page.locator(".banner").count()).toBe(0);
        expect(await page.locator(".selBtn").first().isDisabled()).toBe(false);

        await server.stop();
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));

        await shows(page, ".banner");
        const banner = await page.locator(".banner").innerText();
        expect(banner).toContain(
          "The server is not answering. This is what it last returned.",
        );
        expect(banner).toContain("Last read 16:47; retrying every 60 s.");
        expect(banner).toContain("jig dispatch dashboard");

        expect(await page.locator(".pNeeds .need").count()).toBeGreaterThan(5);
        expect(await page.locator(".row").count()).toBeGreaterThan(0);
        expect(await page.locator(".tick").innerText()).toContain(
          "server not answering",
        );
        expect(await page.locator(".answer h1").innerText()).toBe(
          "8 needed a person at the 16:40 tick.",
        );
        expect(await page.locator(".colophon").innerText()).toContain(
          "last read 16:47 host time",
        );

        for (const selector of [".selBtn", ".fields input", ".pWindow .fbtn"]) {
          const controls = page.locator(selector);
          const count = await controls.count();
          expect(count).toBeGreaterThan(0);
          for (let i = 0; i < count; i++)
            expect(await controls.nth(i).isDisabled()).toBe(true);
        }
        expect(problems).toEqual([]);
      } finally {
        await context.close();
        await server.stop();
      }
    },
    TIMEOUT,
  );
});

describe("a wrong token", () => {
  browserIt(
    "gets the refusal, no data, and no script runs",
    async () => {
      const server = await served("token");
      const requests: string[] = [];
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url.replace(TOKEN, WRONG_TOKEN),
        LAPTOP,
        "light",
        [REFUSAL_LOAD],
      );
      page.on("request", (request) => requests.push(request.url()));
      try {
        await shows(page, "#h-ref");
        expect(await page.locator("#h-ref").innerText()).toBe(
          "The server refused this request: the token does not match.",
        );
        expect(
          await page.evaluate(() => document.querySelectorAll("script").length),
        ).toBe(0);
        const text = await page.locator("body").innerText();
        expect(text).toContain("Nothing was read, so nothing is shown.");
        expect(text).not.toContain("example-org");
        expect(text).not.toContain("work-a");
        expect(await page.locator("#root").count()).toBe(0);
        expect(requests).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a token the server stops taking while the page is open shows only the refusal",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
        "light",
        [REFUSAL_LOAD],
      );
      try {
        await shows(page, ".pLine");
        await page.route("**/state*", (route) =>
          route.fulfill({
            status: 403,
            json: {
              ok: false,
              failure: {
                code: "token-refused",
                reason: "this dashboard needs the token its command printed",
              },
            },
          }),
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await shows(page, "#h-ref");
        expect(await page.locator(".pLine").count()).toBe(0);
        expect(await page.locator("body").innerText()).not.toContain(
          "example-org",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("a long history", () => {
  browserIt(
    "says how much it shows, and keeps the document small even showing all",
    async () => {
      const server = await served("long");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&${LONG_VIEW}`,
        LAPTOP,
      );
      try {
        await shows(page, ".row");
        expect(await page.locator(".meta").innerText()).toContain(
          "newest 5000 of 6210 rows: narrow the window or a filter to see the rest",
        );
        expect(await page.locator(".row").count()).toBeLessThanOrEqual(25);

        await page.getByRole("button", { name: "Show 25 more" }).click();
        await page.getByRole("button", { name: "Show all 5000" }).click();
        await until("the list has grown", async () => {
          const height = await page
            .locator(".rows")
            .evaluate((e) => e.getBoundingClientRect().height);
          return height > 100_000;
        });
        expect(await page.locator(".row").count()).toBeLessThan(100);

        await page.evaluate(() => window.scrollTo(0, 100_000));
        await until("rows far down the list are in the document", async () => {
          const text = await page.locator(".rows").innerText();
          return !text.includes("16:40") && text.includes("PR #");
        });
        expect(await page.locator(".row").count()).toBeLessThan(100);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the filters", () => {
  browserIt(
    "write the query string, and a reload restores them",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pWindow .fbtn");
        await page.getByRole("button", { name: "7 days" }).click();
        await until("the window is in the address", async () =>
          page.url().includes("window=7d"),
        );

        await page.locator(".pWindow .fbtn", { hasText: "stalled" }).click();
        await until("the class is in the address", async () =>
          page.url().includes("class=stalled"),
        );

        await page.locator(".selBtn").first().click();
        await page.getByRole("option", { name: "example-org/web" }).click();
        await until("the repository is in the address", async () =>
          page.url().includes("repo=example-org/web"),
        );

        await page.locator('input[type="search"]').fill("exit");
        expect(page.url()).not.toContain("reason=exit");
        await until(
          "the reason is in the address once typing pauses",
          async () => page.url().includes("reason=exit"),
        );
        expect(page.url()).toContain(`token=${TOKEN}`);
        await until("the rows have narrowed", async () => {
          const meta = await page.locator(".meta").innerText();
          return meta.startsWith("5 rows");
        });

        await page.reload();
        await shows(page, ".row");
        expect(
          await page
            .getByRole("button", { name: "7 days" })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(
          await page
            .locator(".pWindow .fbtn", { hasText: "stalled" })
            .getAttribute("aria-pressed"),
        ).toBe("true");
        expect(await page.locator(".selBtn").first().innerText()).toContain(
          "example-org/web",
        );
        expect(await page.locator('input[type="search"]').inputValue()).toBe(
          "exit",
        );
        expect(await page.locator(".meta").innerText()).toStartWith("5 rows");
        expect(await page.locator(".active").innerText()).toContain(
          "repository example-org/web",
        );

        await page.getByRole("button", { name: "Clear all" }).click();
        await until("the address has dropped the filters", async () => {
          const address = page.url();
          return !address.includes("repo=") && !address.includes("class=");
        });
        expect(page.url()).toContain("window=7d");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a typed range goes in the address and shows back in the host's time",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".row");
        const from = page.locator('input[type="datetime-local"]').first();
        expect(await from.inputValue()).toBe("2026-11-03T00:00");
        await from.fill("2026-11-03T04:00");
        await until("the range is in the address", async () =>
          page.url().includes("from=2026-11-03T04:00"),
        );
        await until("the rows have narrowed", async () =>
          (await page.locator(".meta").innerText()).includes("04:00 to 16:47"),
        );
        expect(
          await page.locator(".pWindow .fbtn[aria-pressed='true']").count(),
        ).toBe(0);
        expect(await from.inputValue()).toBe("2026-11-03T04:00");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("a host in another time zone", () => {
  browserIt(
    "reads a typed range on the host's clock, sends the instant, and shows it back",
    async () => {
      const server = await served("loud");
      const context = await requireBrowser().newContext({ viewport: LAPTOP });
      const page = await context.newPage();
      const asked: string[] = [];
      page.on("request", (request) => asked.push(request.url()));
      await page.route("**/state*", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.value.timeZone = "Asia/Tokyo";
        await route.fulfill({ response, json: body });
      });
      try {
        await page.goto(server.url);
        await shows(page, ".row");
        expect(await page.locator(".tick").innerText()).toContain("Tick 01:45");
        const from = page.locator('input[type="datetime-local"]').first();
        await from.fill("2026-11-04T01:00");
        await until("the page asks for the instant", async () =>
          asked.some((url) => url.includes("from=2026-11-03T16:00:00.000Z")),
        );
        expect(page.url()).toContain("from=2026-11-04T01:00");
        await until(
          "the answer's window shows back on the host's clock",
          async () =>
            (await page.locator(".meta").innerText()).includes(
              "01:00 to 01:47",
            ),
        );
        expect(await from.inputValue()).toBe("2026-11-04T01:00");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the disclosures", () => {
  browserIt(
    "a fold opens by keyboard and shows its evidence",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".slot");
        const fold = page.locator(".slot .foldBtn").first();
        await fold.focus();
        expect(await page.locator(".slot .kv").count()).toBe(0);
        await page.keyboard.press("Enter");
        await shows(page, ".slot .kv");
        expect(await fold.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(".slot .kv").innerText()).toContain(
          "Retry the webhook on a 5xx",
        );
        await page.keyboard.press("Space");
        await until(
          "the fold has closed",
          async () => (await page.locator(".slot .kv").count()) === 0,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a log row opens by keyboard to its whole reason",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".rowSum");
        const row = page.locator(".rowSum").first();
        await row.focus();
        await page.keyboard.press("Enter");
        await shows(page, ".rowBody");
        expect(await row.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(".rowBody").innerText()).toContain(
          "exit 0 (converged)",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a term opens by tap or focus, and hover alone reveals nothing",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".termBtn");
        const term = page.locator(".termBtn", { hasText: "wall" });
        await term.hover();
        expect(await staysAway(page, ".pop", HOVER_WATCH_MS)).toBe(true);

        await term.click();
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain("usage limit");
        await page.keyboard.press("Escape");
        await until(
          "the term has closed",
          async () => (await page.locator(".pop").count()) === 0,
        );

        await page.locator(".pLine h2").click();
        await page.keyboard.press("Tab");
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain(
          "concurrent-session",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the whole decision renders its Markdown",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        PHONE,
      );
      try {
        await shows(page, ".need");
        await page
          .locator(".need .foldBtn", { hasText: "The whole decision" })
          .first()
          .click();
        await shows(page, ".quote.md");
        expect(await page.locator(".quote.md h2").first().innerText()).toBe(
          "Question",
        );
        expect(await page.locator(".quote.md li").count()).toBe(2);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "on plain http, where the browser has no clipboard API, Copy still takes the answer line",
    async () => {
      const server = await served("loud");
      // A name that is not loopback makes this a real insecure context.
      const plain = await chromium.launch({
        executablePath: executablePath ?? "",
        headless: true,
        args: ["--host-resolver-rules=MAP dispatch.invalid 127.0.0.1"],
      });
      try {
        const address = server.url.replace("127.0.0.1", "dispatch.invalid");
        const { page } = await open(
          plain,
          new URL(address).origin,
          address,
          PHONE,
        );
        await shows(page, ".need");
        expect(
          await page.evaluate(() => [
            window.isSecureContext,
            "clipboard" in navigator,
          ]),
        ).toEqual([false, false]);
        const copy = page.getByRole("button", {
          name: "Copy the answer line for PR #456",
        });
        await copy.click();
        await until(
          "the button says it copied",
          async () => (await copy.innerText()) === "Copied",
        );
        expect(await page.locator(".clip").inputValue()).toBe(
          "answer PRRT_x1: ",
        );
        expect(await page.locator(".say").innerText()).toBe("Copied");
        await until(
          "the button is back to its word",
          async () => (await copy.innerText()) === "Copy answer line",
        );
      } finally {
        await plain.close();
      }
    },
    TIMEOUT,
  );
});

describe("a phone with everything open", () => {
  browserIt(
    "evidence, long values and the filter's options still fit and stay tall enough",
    async () => {
      const server = await served("hung");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        PHONE,
      );
      try {
        await shows(page, ".slot");
        await page
          .getByRole("button", { name: /^Show all/ })
          .first()
          .click();
        const folds = page.locator(".foldBtn[aria-expanded='false']");
        for (let left = await folds.count(); left > 0; left--)
          await folds.first().click();
        await page.locator(".rowSum").first().click();
        await shows(page, ".rowBody");
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
        expect(await shortControls(page)).toEqual([]);

        await page.locator(".selBtn").first().click();
        await shows(page, '[role="option"]');
        const heights = await page.evaluate(() =>
          [...document.querySelectorAll('[role="option"]')].map(
            (option) => option.getBoundingClientRect().height,
          ),
        );
        expect(heights.length).toBeGreaterThan(1);
        for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("what fails", () => {
  browserIt(
    "a coded failure says its reason and keeps the last data",
    async () => {
      const server = await served("quiet");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
        "light",
        [/status of 503/],
      );
      try {
        await shows(page, ".row");
        const rows = await page.locator(".row").count();
        await page.route("**/rows*", (route) =>
          route.fulfill({
            status: 503,
            json: {
              ok: false,
              failure: {
                code: "log-unreadable",
                reason: "the outcome log cannot be read",
              },
            },
          }),
        );
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await shows(page, ".banner");
        const banner = await page.locator(".banner").innerText();
        expect(banner).toContain("the outcome log cannot be read");
        expect(banner).toContain("log-unreadable");
        expect(await page.locator(".row").count()).toBe(rows);
        expect(await page.locator(".pLine").count()).toBe(1);

        // A new question that fails keeps the last answer too.
        await page.getByRole("button", { name: "7 days" }).click();
        await until("the failed read has settled", async () =>
          page.url().includes("window=7d"),
        );
        await settled(page);
        expect(await page.locator(".banner").innerText()).toContain(
          "log-unreadable",
        );
        expect(await page.locator(".row").count()).toBe(rows);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a bug in one panel stays in that panel, as a plain line with a copy button",
    async () => {
      const server = await served("quiet");
      const context = await requireBrowser().newContext({ viewport: LAPTOP });
      const page = await context.newPage();
      await page.route("**/state*", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.value.line.sessions[0].samples = null;
        await route.fulfill({ response, json: body });
      });
      try {
        await page.goto(server.url);
        await shows(page, ".defect");
        const panels = await page.locator(".defect").count();
        expect(panels).toBe(1);
        expect(await page.locator(".defect").innerText()).toContain(
          "The line hit a bug and stopped here",
        );
        expect(await page.locator(".defect .copy").count()).toBe(1);
        expect(await page.locator(".defect").innerText()).not.toContain(" at ");
        expect(await page.locator(".pQueue").count()).toBe(1);
        await shows(page, ".row");
        await shows(page, ".answer");

        await page.unroute("**/state*");
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await shows(page, ".slot");
        expect(await page.locator(".defect").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

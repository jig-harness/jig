/**
 * The page in a real browser, against the real server over each scenario: what
 * only a rendered page can show. Every scenario at a phone's width and a
 * laptop's, light and dark, in each of its views, for overflow, one
 * column of cards, requests, errors and the strip's fact; then the layout, the
 * reads and the filters one scenario at a time. What a person opens and copies
 * is `browser-interactions.test.ts`; the keys are `browser-keys.test.ts`.
 *
 * It drives Chromium through `playwright-core`, from `JIG_CHROMIUM`, `JIG_TEST_CHROMIUM` or the
 * Playwright cache. Where none is found the checks cannot run and are skipped
 * with a warning. Set `JIG_REQUIRE_BROWSER=1` on a machine that must run them:
 * there a missing browser is a failing test, so a suite that never ran cannot
 * read as a pass. Set `DASHBOARD_SHOTS=<dir>` to also write one image per
 * scenario, width and theme.
 */
import { describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import {
  bottomOf,
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
  until,
  type Watched,
} from "./browser-page.ts";
import {
  browserSuite,
  LAPTOP,
  openView,
  PHONE,
  TIMEOUT,
  TOKEN,
} from "./browser-suite.ts";
import { SCENARIOS, type ScenarioId } from "./fixtures.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const WRONG_TOKEN = "wrong-token";
const LONG_VIEW =
  "window=30d&repo=example-org/web&class=gates+failed&reason=conflict";

/** The address a scenario's checks open: a wrong token is the point of `token`, a narrowed view of `long`. */
function addressOf(server: Served, scenario: ScenarioId): string {
  if (scenario === "token") return server.url.replace(TOKEN, WRONG_TOKEN);
  return scenario === "long" ? `${server.url}&${LONG_VIEW}` : server.url;
}

/** How fresh each scenario's strip must say the page is. */
const TICK_FACT: Record<ScenarioId, RegExp> = {
  quiet: /^Updated 2 min ago$/,
  loud: /^Updated 2 min ago$/,
  merge: /^Updated 2 min ago$/,
  hung: /^Updated 2 min ago$/,
  queue: /^Updated 2 min ago$/,
  stopped: /^Updated 47 min ago · overdue$/,
  gone: /^Updated 7 min ago · offline$/,
  token: /^Not read: the server refused$/,
  empty: /^No tick yet$/,
  long: /^Updated 2 min ago$/,
};

/** What each scenario's answer must say first. */
const ANSWER: Partial<Record<ScenarioId, RegExp>> = {
  quiet: /Nothing needs a person\./,
  loud: /8 need a person\..*First: PR #456, parked for a person\./s,
  merge: /8 need a person\..*First: PR #456, parked for a person\./s,
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

/** Waits until a cell's strip says how fresh it is and the page has settled. */
async function cellSettled(page: Page, scenario: ScenarioId): Promise<void> {
  await shows(page, ".tick .fresh");
  await until("the strip states its fact", async () =>
    TICK_FACT[scenario].test(
      ((await page.locator(".tick").innerText()) ?? "").trim(),
    ),
  );
  if (scenario !== "token") await shows(page, "main :is(h1, h2)");
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

/** No two cards side by side: every card the view shows starts at one left edge, each below the one before. */
async function expectOneColumn(page: Page): Promise<void> {
  const boxes = await page.locator("[data-card]:visible").evaluateAll((cards) =>
    cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: Math.round(r.left), top: r.top, bottom: r.bottom };
    }),
  );
  for (const [i, box] of boxes.entries()) {
    const before = boxes[i - 1];
    if (before === undefined) continue;
    expect(box.left).toBe(boxes[0]?.left ?? box.left);
    expect(box.top).toBeGreaterThanOrEqual(before.bottom - 1);
  }
}

/** The views every cell visits, by their tabs' labels, after the one the page opens on. */
const CARD_VIEWS = [
  "Merge",
  "Needs you",
  "Running",
  "Queue",
  "History",
] as const;

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
              if (scenario !== "token")
                for (const label of CARD_VIEWS) {
                  await openView(page, label);
                  await shows(page, "main :is(h1, h2)");
                  await settled(page);
                  await shoot(
                    page,
                    `${scenario}-${viewport.width}-${theme}-${label.split(" ")[0]?.toLowerCase()}`,
                  );
                  await expectFrame(page, viewport, theme);
                  await expectOneColumn(page);
                  if (label === "Needs you") {
                    const answer = ANSWER[scenario];
                    if (answer !== undefined)
                      expect(await page.locator(".answer").innerText()).toMatch(
                        answer,
                      );
                    if (name === "phone")
                      await expectPhone(page, viewport, scenario);
                  } else if (name === "phone")
                    expect(await shortControls(page)).toEqual([]);
                }
              else {
                await shoot(page, `${scenario}-${viewport.width}-${theme}`);
                await expectFrame(page, viewport, theme);
              }
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

/** The label of the tab the page is on, without its count. */
async function currentTab(page: Page): Promise<string> {
  const tab = page.locator('.viewTab[aria-current="page"]');
  return (await tab.evaluate((a) => a.firstChild?.textContent ?? "")).trim();
}

describe("the view a page opens on", () => {
  browserIt(
    "loud at 1440 opens on Needs you, its first cards above the fold, with no flash",
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
        await settled(page);
        expect(await currentTab(page)).toBe("Needs you");
        // What needs you runs past the fold by design: its heading and first rows must stand above it.
        expect(await bottomOf(page, ".pNeeds .need")).toBeLessThanOrEqual(900);
        expect(await page.locator(".pNeeds .need").count()).toBeGreaterThan(5);
        expect(await page.locator(".answer.loud").count()).toBe(1);
        expect(await page.locator(".flash").count()).toBe(0);
        expect(await page.locator(".pLine, .pQueue, .pMerge").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "quiet opens on Needs you, its answer a plain line and no list",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".answer");
        expect(await currentTab(page)).toBe("Needs you");
        expect(await page.locator(".answer.loud").count()).toBe(0);
        expect(await page.locator(".pNeeds").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "with merge now holding pull requests it opens on Merge, merge now first",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pMerge .mCard");
        expect(await currentTab(page)).toBe("Merge");
        expect(
          await page.locator(".pMerge .groupHead").allInnerTexts(),
        ).toEqual(["Merge now · 2", "Approve first · 1", "Update next · 1"]);
        expect(
          await page
            .locator(".pMerge .mCard")
            .first()
            .getAttribute("data-command"),
        ).toContain("--match-head-commit 3f2a91c");
        expect(await page.locator(".flash").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "an address that names a view opens on it, and the old Now opens Needs you",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await shows(page, ".pQueue");
        expect(await currentTab(page)).toBe("Queue");
        await page.goto(`${server.url}&view=now`);
        await shows(page, ".pNeeds");
        expect(await currentTab(page)).toBe("Needs you");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the tabs' counts", () => {
  browserIt(
    "every tab but Help carries its count",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pMerge");
        await until("the log's count is read", async () =>
          (await page.locator(".viewTab").allInnerTexts()).some((t) =>
            /^History\s*\d/.test(t),
          ),
        );
        const tabs = await page
          .locator(".viewTab")
          .evaluateAll((all) =>
            all.map((a) => a.textContent?.replace(/\s+/g, " ").trim()),
          );
        expect(tabs).toEqual([
          "Merge4, 4 ready to merge",
          "Needs you8, 8 need you",
          "Running4, 4 sessions",
          "Queue4, 4 coming",
          "History8, 8 rows in the window",
          "Help",
        ]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the merge flash", () => {
  browserIt(
    "shows on every view but Merge while merge now holds a pull request, and never otherwise",
    async () => {
      for (const [scenario, flashes] of [
        ["merge", true],
        ["loud", false],
        ["quiet", false],
      ] as const) {
        const server = await served(scenario);
        const { page, context } = await open(
          requireBrowser(),
          server.origin,
          server.url,
          LAPTOP,
        );
        try {
          await shows(page, "main :is(h1, h2)");
          for (const label of [...CARD_VIEWS, "Help"]) {
            await openView(page, label);
            await shows(page, "main :is(h1, h2)");
            expect({
              scenario,
              label,
              flash: await page.locator(".flash").count(),
            }).toEqual({
              scenario,
              label,
              flash: flashes && label !== "Merge" ? 1 : 0,
            });
          }
          if (flashes)
            expect(await page.locator(".flash").textContent()).toContain(
              "2 pull requests are safe to merge: #461, #1199",
            );
        } finally {
          await context.close();
        }
      }
    },
    TIMEOUT,
  );

  browserIt(
    "dismissed, it stays hidden until a pull request reaches merge now at a new head",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".flash");
        await page.locator(".flashOff").click();
        await until(
          "the flash is gone",
          async () => (await page.locator(".flash").count()) === 0,
        );
        await page.reload();
        await shows(page, ".pNeeds");
        expect(await page.locator(".flash").count()).toBe(0);

        await page.route("**/state*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.value.line.ready[1].head =
            "0123456789abcdef0123456789abcdef01234567";
          await route.fulfill({ response, json: body });
        });
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await shows(page, ".flash");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "its link goes to Merge",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=running`,
        LAPTOP,
      );
      try {
        await shows(page, ".flash");
        await page.locator(".flashGo").click();
        await shows(page, ".pMerge");
        expect(await currentTab(page)).toBe("Merge");
        expect(page.url()).toContain("view=merge");
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
        `${server.url}&view=history`,
        LAPTOP,
        "light",
        [CONNECTION_LOST],
      );
      try {
        await shows(page, ".selBtn");
        await settled(page);
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

        expect(await page.locator(".row").count()).toBeGreaterThan(0);
        expect((await page.locator(".tick").innerText()).trim()).toBe(
          "Updated 7 min ago · offline",
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

        await openView(page, "Needs you");
        await shows(page, ".pNeeds");
        expect(await page.locator(".pNeeds .need").count()).toBeGreaterThan(5);
        expect(await page.locator(".answer h1").innerText()).toBe(
          "8 needed a person at the 16:40 tick.",
        );
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
      const { page, context, requests } = await open(
        requireBrowser(),
        server.origin,
        server.url.replace(TOKEN, WRONG_TOKEN),
        LAPTOP,
        "light",
        [REFUSAL_LOAD],
      );
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
        // Only the page itself was fetched, from before it navigated: no read.
        expect(
          requests.filter((url) =>
            /^\/(state|rows|receipt)$/.test(new URL(url).pathname),
          ),
        ).toEqual([]);
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
        await shows(page, ".answer");
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
        expect(await page.locator(".answer").count()).toBe(0);
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
        `${server.url}&view=history&${LONG_VIEW}`,
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
        `${server.url}&view=history`,
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
        expect(page.url()).toContain("view=history");
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
        `${server.url}&view=history`,
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
        await page.goto(`${server.url}&view=history`);
        await shows(page, ".row");
        await page.locator(".fresh").click();
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain(
          "the 01:45 tick",
        );
        await page.keyboard.press("Escape");
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

describe("what fails", () => {
  browserIt(
    "a coded failure says its reason and keeps the last data",
    async () => {
      const server = await served("quiet");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=history`,
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
        expect(await page.locator(".pWindow").count()).toBe(1);

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
        await page.goto(`${server.url}&view=running`);
        await shows(page, ".defect");
        const panels = await page.locator(".defect").count();
        expect(panels).toBe(1);
        expect(await page.locator(".defect").innerText()).toContain(
          "What is running hit a bug and stopped here",
        );
        expect(await page.locator(".defect .copy").count()).toBe(1);
        expect(await page.locator(".defect").innerText()).not.toContain(" at ");
        await openView(page, "Queue");
        await shows(page, ".pQueue");
        expect(await page.locator(".defect").count()).toBe(0);
        await openView(page, "Running");

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

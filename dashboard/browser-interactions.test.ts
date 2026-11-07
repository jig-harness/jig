import { queued, drive } from "./fixture-line.ts";
/**
 * What a person opens and copies on the page, in a real browser against the
 * real server: folds and log rows by keyboard, hints on hover, tap and focus,
 * long lists closing from either end, the whole decision's Markdown, Copy on
 * plain http with a drafted reply, and a phone with everything open. How the
 * browser is found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import { chromium } from "playwright-core";
import { open, shortControls, shows, until } from "./browser-page.ts";
import {
  browserSuite,
  LAPTOP,
  openView,
  PHONE,
  TIMEOUT,
} from "./browser-suite.ts";

const { browserIt, requireBrowser, served, executablePath } =
  await browserSuite();

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
        `${server.url}&view=history`,
        LAPTOP,
      );
      try {
        await shows(page, ".rowExpand");
        const row = page.locator(".rowExpand").first();
        await row.focus();
        await page.keyboard.press("Enter");
        await shows(page, ".rowBody");
        expect(await row.getAttribute("aria-expanded")).toBe("true");
        expect(await page.locator(".rowBody").innerText()).toContain(
          "exit 0 (converged)",
        );
        const stage = page.locator(".rowBody .chipBtn");
        await stage.focus();
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain("drive");
        await page.keyboard.press("Escape");
        await stage.click();
        await shows(page, ".pop");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a term opens by hover, tap or focus",
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
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain("usage limit");
        await page.mouse.move(0, 0);
        await until(
          "the term has closed once the pointer left",
          async () => (await page.locator(".pop").count()) === 0,
        );

        await term.click();
        await shows(page, ".pop");
        expect(await page.locator(".pop").innerText()).toContain("usage limit");
        await page.keyboard.press("Escape");
        await until(
          "the term has closed",
          async () => (await page.locator(".pop").count()) === 0,
        );

        await page.mouse.move(0, 0);
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
    "a stage chip, a source chip and the freshness say what they mean on hover",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".pLine .chipBtn");
        const hovered = async (selector: string, says: string) => {
          await page.locator(selector).first().hover();
          await shows(page, ".pop");
          expect(await page.locator(".pop").innerText()).toContain(says);
          await page.mouse.move(0, 0);
          await until(
            "the hint has closed",
            async () => (await page.locator(".pop").count()) === 0,
          );
        };
        await hovered(".pLine .chipBtn", "Restarting a stopped drive");
        await hovered(".pQueue .chipBtn", "may restart by itself");
        await hovered(".fresh", "The next tick is due 16:50.");
        await hovered(".pNeeds .helpBtn", "only a person can settle");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a long list closes from its panel's head as well as its foot",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        PHONE,
      );
      try {
        await shows(page, ".pQueue .headMore");
        const items = page.locator(".pQueue .qItem:visible");
        const closed = await items.count();
        await page.locator(".pQueue .moreBtn:not(.headMore)").click();
        await until(
          "the list has opened",
          async () => (await items.count()) > closed,
        );
        expect(await page.locator(".pQueue .headMore").innerText()).toBe(
          "Show fewer",
        );
        await page.locator(".pQueue .headMore").click();
        await until(
          "the list has closed",
          async () => (await items.count()) === closed,
        );
        await page.locator(".pQueue .moreBtn:not(.headMore)").click();
        await until(
          "the list has opened again",
          async () => (await items.count()) > closed,
        );
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.locator(".pQueue .moreBtn:not(.headMore)").click();
        await until(
          "the foot button has closed the list",
          async () => (await items.count()) === closed,
        );
        await until(
          "the panel's head is back in view",
          async () =>
            await page
              .locator(".pQueue .headMore")
              .evaluate((el) => el.getBoundingClientRect().top >= 0),
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
          .getByRole("button", { name: "The whole decision" })
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
    "on plain http, where the browser has no clipboard API, Copy still takes the answer line and a drafted reply",
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
          async () => (await copy.getAttribute("title")) === "Copied",
        );
        expect(await page.locator(".clip").inputValue()).toBe(
          "answer PRRT_x1: ",
        );
        expect(await page.locator(".say").innerText()).toBe("Copied");
        await until(
          "the copy icon is ready again",
          async () =>
            (await copy.getAttribute("title")) ===
            "Copy the answer line for PR #456",
        );

        const need = page.locator(".need").first();
        await need.getByRole("button", { name: "Write reply" }).click();
        await need.locator("textarea").fill("A, keep it small");
        const answer = page.getByRole("button", {
          name: "Copy the answer for PR #456",
        });
        await answer.click();
        await until(
          "the button says it copied",
          async () => (await answer.getAttribute("title")) === "Copied",
        );
        expect(await page.locator(".clip").inputValue()).toBe(
          "answer PRRT_x1: A, keep it small",
        );

        // The draft is kept in this browser, so a reload loses none of it.
        await page.reload();
        await shows(page, ".need textarea");
        expect(
          await page.locator(".need").first().locator("textarea").inputValue(),
        ).toBe("A, keep it small");
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
        const overflowOf = () =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          );
        expect(await overflowOf()).toBeLessThanOrEqual(0);
        expect(await shortControls(page)).toEqual([]);

        await openView(page, "History");
        await page.locator(".rowExpand").first().click();
        await shows(page, ".rowBody");
        expect(await overflowOf()).toBeLessThanOrEqual(0);
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

browserIt(
  "PR links, live merged state, hover context and ID-only icon copy",
  async () => {
    const server = await served("quiet");
    const { page, context } = await open(
      requireBrowser(),
      server.origin,
      server.url,
      LAPTOP,
    );
    try {
      await page.route("**/pr?*", async (route) => {
        const params = new URL(route.request().url()).searchParams;
        await route.fulfill({
          json: {
            state: "MERGED",
            title: "A merged change",
            isDraft: false,
            url: `https://github.com/${params.get("repo")}/pull/${params.get("pr")}`,
            checkedAt: "2026-11-06T21:00:00.000Z",
          },
        });
      });
      await page.reload();
      await shows(page, ".pr-merged");
      const pr = page.locator(".pr-merged").first();
      const link = pr.locator("a.tgt");
      expect(await link.getAttribute("href")).toMatch(/\/pull\/\d+$/);
      const copy = pr.locator(".copy");
      expect(await copy.locator("svg").count()).toBe(1);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await copy.click();
      await until(
        "the ID is copied",
        async () => (await copy.getAttribute("title")) === "Copied",
      );
      const id = (await link.textContent())?.replace("PR #", "") ?? "";
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        id,
      );
      await pr.locator(".prState").hover();
      await shows(page, ".pop");
      expect(await page.locator(".pop").textContent()).toContain(
        "A merged change",
      );
      expect(await page.locator(".pop a").first().getAttribute("href")).toMatch(
        /^https:\/\/github.com\/[^/]+\/[^/]+$/,
      );
    } finally {
      await context.close();
    }
  },
  TIMEOUT,
);

browserIt(
  "merged PRs show awaiting and running follow-ups in the summary and their cards",
  async () => {
    const server = await served("quiet");
    const { page, context } = await open(
      requireBrowser(),
      server.origin,
      server.url,
      LAPTOP,
    );
    try {
      await page.route("**/state?*", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const line = body.value.line;
        line.needs = [];
        line.queue = [
          queued({
            source: "merged",
            group: "starts",
            repo: "example-org/web",
            pr: 7,
            title: "Queued change",
            why: "Merge observed",
          }),
        ];
        line.sessions = [
          drive({
            stage: "followup",
            account: line.accounts[0].name,
            repo: "example-org/web",
            pr: 8,
            title: "Running change",
            created: 900,
          }),
        ];
        await route.fulfill({ json: body });
      });
      await page.reload();
      await shows(page, ".followupSummary");
      const summary = page.getByLabel("Post-merge follow-ups");
      await until(
        "the follow-up counts are visible",
        async () =>
          (await summary.textContent())?.includes("1 awaiting follow-up") ===
          true,
      );
      expect(await summary.textContent()).toContain("1 follow-up running");
      expect(await page.locator(".qItem .followupBadge").textContent()).toBe(
        "Merged · Awaiting follow-up",
      );
      expect(await page.locator(".slot .followupBadge").textContent()).toBe(
        "Merged · Follow-up running",
      );
    } finally {
      await context.close();
    }
  },
  TIMEOUT,
);

for (const outcome of ["success", "http-error", "null"] as const)
  browserIt(
    `merged drive decisions stay removed during and after a ${outcome} refresh`,
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      let hold = false;
      let refreshing = false;
      let release: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await page.clock.install();
        await page.route("**/pr?*", async (route) => {
          const params = new URL(route.request().url()).searchParams;
          if (hold) {
            refreshing = true;
            await pending;
            if (outcome !== "success") {
              await route.fulfill({
                status: outcome === "http-error" ? 503 : 200,
                json: null,
              });
              return;
            }
          }
          await route.fulfill({
            json: {
              state: "MERGED",
              title: "Merged change",
              isDraft: false,
              url: `https://github.com/${params.get("repo")}/pull/${params.get("pr")}`,
              checkedAt: "2026-11-06T21:00:00.000Z",
            },
          });
        });
        await page.reload();
        const decision = page
          .locator(".need .tgt")
          .filter({ hasText: "PR #456" });
        await shows(page, ".pr-merged");
        await until(
          "the merged decision is removed",
          async () => (await decision.count()) === 0,
        );
        hold = true;
        await page.clock.fastForward(60_000);
        await until("PR state is being refreshed", async () => refreshing);
        await page.clock.runFor(50);
        expect(await decision.count()).toBe(0);
        const answered = page.waitForResponse((response) =>
          response.url().includes("/pr?"),
        );
        release?.();
        await answered;
        await page.clock.runFor(500);
        expect(await decision.count()).toBe(0);
        expect(await page.locator(".pr-unknown").count()).toBe(0);
      } finally {
        release?.();
        await context.close();
      }
    },
    TIMEOUT,
  );

browserIt(
  "a stalled PR response expires and a later refresh can recover",
  async () => {
    const server = await served("loud");
    const { page, context } = await open(
      requireBrowser(),
      server.origin,
      server.url,
      LAPTOP,
    );
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let stalled = true;
    try {
      await page.route("**/pr?*", async (route) => {
        if (stalled) await pending;
        await route.fulfill({
          json: {
            state: "MERGED",
            title: "Recovered",
            isDraft: false,
            url: "https://github.com/example-org/web/pull/456",
            checkedAt: "2026-11-06T21:00:00.000Z",
          },
        });
      });
      const expired = page.waitForEvent("requestfailed", {
        predicate: (request) => request.url().includes("/pr?"),
        timeout: 20_000,
      });
      await page.reload();
      await expired;
      stalled = false;
      release?.();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await shows(page, ".pr-merged");
    } finally {
      release?.();
      await context.close();
    }
  },
  TIMEOUT,
);

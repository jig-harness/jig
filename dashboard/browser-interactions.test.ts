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

        const need = page.locator(".need").first();
        await need.getByRole("button", { name: "Write reply" }).click();
        await need.locator("textarea").fill("A, keep it small");
        const answer = page.getByRole("button", {
          name: "Copy the answer for PR #456",
        });
        await answer.click();
        await until(
          "the button says it copied",
          async () => (await answer.innerText()) === "Copied",
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
        await page.locator(".rowSum").first().click();
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

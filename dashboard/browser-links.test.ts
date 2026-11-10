/**
 * Tracker items and a part of the line kept from an older tick, in a real
 * browser against the real server: every card and log row links its key and
 * shows its title, a row that kept no link of its own links the item through
 * another item link of its repository's tracker, and the page names the busy
 * repository and how old its part is. How the browser is found and when its
 * absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Locator } from "playwright-core";
import { open, shows } from "./browser-page.ts";
import { browserSuite, LAPTOP, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

/** The key's link and the title shown under or beside it. */
async function keyAndTitle(card: Locator) {
  const key = card.locator("a.tgt").first();
  return {
    key: await key.textContent(),
    href: await key.getAttribute("href"),
    title: await card.locator(".itemTitle").first().textContent(),
  };
}

describe("tracker items", () => {
  browserIt(
    "link their key and show their title on a stalled need, an unplaced queued item and a log row",
    async () => {
      const server = await served("partial");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".pNeeds .need");
        expect(
          await keyAndTitle(
            page.locator(".pNeeds .need", { hasText: "#240" }).first(),
          ),
        ).toEqual({
          key: "#240",
          href: "https://forge.example/example-org/api/issues/240",
          title: "Retry the webhook delivery",
        });
        await page.goto(`${server.url}&view=queue`);
        await shows(page, ".pQueue .qItem");
        const queued = page.locator(".pQueue .qItem", { hasText: "API-80" });
        expect(await queued.locator("a.tgt").getAttribute("href")).toBe(
          "https://tracker.example/acme/issue/API-80/backfill-the-ledger",
        );
        expect(await queued.innerText()).toContain("Backfill the ledger");
        await page.goto(`${server.url}&view=history`);
        await shows(page, ".cell-tgt");
        expect(
          await keyAndTitle(
            page.locator(".cell-tgt", { hasText: "API-77" }).first(),
          ),
        ).toEqual({
          key: "API-77",
          href: "https://tracker.example/acme/issue/API-77/add-the-audit-export",
          title: "Add the audit export",
        });
        expect(await page.locator("body").innerText()).not.toContain(
          "tracker base",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "link a log row that kept no link through another item link of its repository's tracker",
    async () => {
      const server = await served("partial");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=history`,
        LAPTOP,
      );
      try {
        await shows(page, ".cell-tgt");
        const cell = page.locator(".cell-tgt", { hasText: "API-91" }).first();
        expect(await cell.locator("a.tgt").getAttribute("href")).toBe(
          "https://tracker.example/acme/issue/API-91",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("a repository another tick held busy", () => {
  browserIt(
    "is named with the age of its part while the rest of the line is current",
    async () => {
      const server = await served("partial");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await shows(page, ".banner");
        const banner = await page.locator(".banner").innerText();
        expect(banner).toContain(
          "example-org/mobile has not been read since 16:05, 42 min ago.",
        );
        expect(banner).toContain("Another tick held it busy");
        expect(banner).not.toContain("The timer has not ticked");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

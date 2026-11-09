/**
 * Needs you in a real browser against the real server: each card opens with
 * its act, the ask, the recommended option with what it changes and costs,
 * and who it waits on; the steps for a person are a checklist in the fold;
 * and the person filter leaves only that person's needs. How the browser is
 * found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import { open, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

describe("Needs you", () => {
  browserIt(
    "opens each card with its act, the ask, the recommended option and who it waits on",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".pNeeds .need");
        expect(
          await page.locator(".pNeeds .groupHead").allTextContents(),
        ).toEqual(["Decide", "Authorize", "Investigate"]);
        const card = page.locator(".pNeeds .need").first();
        expect(await card.locator(".act").textContent()).toBe("Decide");
        expect(await card.locator(".q").textContent()).toBe(
          "Should the retry cover 4xx responses too?",
        );
        expect(await card.locator(".rec strong").textContent()).toBe(
          "A: retry 5xx only",
        );
        expect(await card.locator(".rec").textContent()).toContain(
          "changes: the retry helper; costs: leaves 429 unhandled",
        );
        expect(await card.locator(".waitsOn").textContent()).toBe(
          "Waits on maintainer-a",
        );
        await card.getByRole("button", { name: "The whole decision" }).click();
        await shows(page, ".pNeeds .need .options");
        expect(await card.locator(".options li").textContent()).toContain(
          "B: retry 5xx and 429",
        );
        expect(await card.locator(".steps input[type=checkbox]").count()).toBe(
          1,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "filtering to one person leaves only the needs that wait on them",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".pNeeds .personFilter select");
        await page
          .locator(".pNeeds .personFilter select")
          .selectOption("maintainer-b");
        await until(
          "only maintainer-b's need is listed",
          async () => (await page.locator(".pNeeds .need").count()) === 1,
        );
        const card = page.locator(".pNeeds .need").first();
        expect(await card.locator(".act").textContent()).toBe("Authorize");
        expect(await card.locator(".waitsOn").textContent()).toBe(
          "Waits on maintainer-b",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

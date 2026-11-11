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
    "renders a park's recommendation Markdown before opening the decision",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const decision = body.value.line.needs[0].decisions[0];
          decision.options = [];
          decision.recommendation =
            "**Drop the exemption**, use `gates` and [read the policy](https://example.com/policy).";
          await route.fulfill({ json: body });
        });
        await page.reload();
        await shows(page, ".pNeeds .need");
        const card = page.locator(".pNeeds .need").first();
        await until(
          "the Markdown recommendation arrives",
          async () =>
            (await card.textContent())?.includes("Drop the exemption") === true,
        );
        expect(await card.textContent()).not.toContain("**");
        expect(await card.locator("strong").textContent()).toBe(
          "Drop the exemption",
        );
        expect(await card.locator("code").textContent()).toBe("gates");
        const link = card.getByRole("link", { name: "read the policy" });
        expect(await link.getAttribute("href")).toBe(
          "https://example.com/policy",
        );
        expect(await link.getAttribute("rel")).toBe("noreferrer noopener");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

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
        // The other options fold under the decision's row.
        await card.getByRole("button", { name: "1 other option" }).click();
        await shows(page, ".pNeeds .need .options");
        expect(await card.locator(".options li").textContent()).toContain(
          "B: retry 5xx and 429",
        );
        await card.getByRole("button", { name: "The whole decision" }).click();
        await shows(page, ".pNeeds .need .steps");
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

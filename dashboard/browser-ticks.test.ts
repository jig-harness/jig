/** The tick strip in History: the newest ticks' lengths and slowest phases, and a low-budget tick marked. */
import { describe, expect } from "bun:test";
import {
  open,
  settled,
  shoot,
  shortControls,
  shows,
  until,
} from "./browser-page.ts";
import {
  browserSuite,
  LAPTOP,
  openView,
  PHONE,
  TIMEOUT,
} from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

describe("the tick strip", () => {
  browserIt(
    "lists the newest ticks with their length and slowest phase, and marks the one that skipped reads for a low budget",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await shows(page, ".need");
        await openView(page, "History");
        await shows(page, ".pTicks .tkRow");
        const rows = page.locator(".pTicks .tkRow");
        const first = rows.first();
        expect(await first.locator(".tkAt").textContent()).toBe("16:45");
        expect(await first.locator(".tkTook").textContent()).toBe("1 min 3 s");
        expect(await first.locator(".tkSlow").textContent()).toMatch(
          /^slowest forge in example-org\/web, \d+ s$/,
        );
        const visible = await rows.evaluateAll(
          (all) =>
            all.filter((row) => row.getBoundingClientRect().height > 0).length,
        );
        expect(visible).toBe(8);
        const low = page.locator(".pTicks .tkRow", { hasText: "low budget" });
        expect(await low.count()).toBe(1);
        expect(await low.first().isVisible()).toBe(true);
        expect(
          await low.locator(".tkMarks").evaluate((marks) => {
            const next = marks.nextElementSibling;
            if (next === null) return false;
            const budget = next.getBoundingClientRect();
            return [...marks.children].every(
              (chip) => chip.getBoundingClientRect().right <= budget.left,
            );
          }),
        ).toBe(true);
        await low
          .first()
          .locator(".chipBtn", { hasText: "low budget" })
          .click();
        await until("the low budget's meaning opens", async () =>
          ((await page.locator(".pop").textContent()) ?? "").includes(
            "thread samples",
          ),
        );
        await page.keyboard.press("Escape");
        await page
          .locator(".pTicks")
          .getByRole("button", { name: /^Show all \d+$/ })
          .click();
        await until(
          "every tick shows",
          async () =>
            (await rows.evaluateAll(
              (all) =>
                all.filter((row) => row.getBoundingClientRect().height > 0)
                  .length,
            )) === (await rows.count()),
        );
        await settled(page);
        await shoot(page, "ticks-laptop");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "fits a phone, with every control tall enough, its rows opened",
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
        await openView(page, "History");
        await shows(page, ".pTicks .tkRow");
        await page
          .locator(".pTicks .foldBtn", { hasText: "Details" })
          .first()
          .click();
        await shows(page, ".pTicks .tkKv");
        expect(
          await page.locator(".pTicks .tkKv").first().textContent(),
        ).toContain("example-org/web");
        await page
          .locator(".pTicks .tkKv dt.m")
          .first()
          .evaluate((label) => {
            label.textContent = `${"owner".repeat(7)}/${"repository".repeat(10)}`;
          });
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
        expect(await shortControls(page)).toEqual([]);
        await shoot(page, "ticks-phone");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

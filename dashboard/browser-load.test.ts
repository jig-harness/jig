/** The host's load at the top of Running: the load factor, the gauge that binds, what it would have held, and each gauge folded. */
import { describe, expect } from "bun:test";
import { open, settled, shoot, shows, until } from "./browser-page.ts";
import {
  browserSuite,
  LAPTOP,
  openView,
  PHONE,
  TIMEOUT,
} from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

describe("the load gauge", () => {
  for (const [name, viewport] of [
    ["laptop", LAPTOP],
    ["phone", PHONE],
  ] as const)
    browserIt(
      `leads Running with the load factor and what binds, on a ${name}`,
      async () => {
        const server = await served("loud");
        const { page, context } = await open(
          requireBrowser(),
          server.origin,
          server.url,
          viewport,
        );
        try {
          await shows(page, ".need");
          await openView(page, "Running");
          await shows(page, ".pLine .load");
          const head = page.locator(".pLine .loadHead");
          expect(await head.locator("b").textContent()).toBe("Load 82%");
          expect(await head.textContent()).toContain("memory binds");
          expect(await page.locator(".pLine .load").textContent()).toContain(
            "Reporting only: 1 launch would have been held this tick.",
          );
          // It sits above the accounts.
          const [load, account] = await Promise.all([
            page.locator(".pLine .load").boundingBox(),
            page.locator(".pLine .acct").first().boundingBox(),
          ]);
          expect((load?.y ?? 0) < (account?.y ?? 0)).toBe(true);
          await page
            .locator(".pLine .load")
            .getByRole("button", {
              name: "Each gauge, the reservations and the holds",
            })
            .click();
          await until("the gauges open", async () =>
            (
              (await page.locator(".pLine .load .foldPanel").textContent()) ??
              ""
            ).includes("2 holding, 1 waiting"),
          );
          expect(
            await page.locator(".pLine .load .foldPanel").textContent(),
          ).toContain("would hold the pickup: memory binds");
          await settled(page);
          await shoot(page, `load-${name}`);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
});

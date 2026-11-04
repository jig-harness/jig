/** Browser state survives view changes, and shared links carry the rendered theme. */
import { describe, expect } from "bun:test";
import { open, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, openView, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

describe("retained page choices", () => {
  browserIt(
    "a restored theme reaches view links and the copied link",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await page.evaluate(() =>
          localStorage.setItem("jig-dispatch-dashboard:theme", "dark"),
        );
        await page.reload();
        await shows(page, ".fresh");
        expect(
          await page.locator(".viewTab").first().getAttribute("href"),
        ).toContain("theme=dark");
        await until("the freshness label has loaded", async () =>
          (
            (await page.locator(".fresh").getAttribute("aria-label")) ?? ""
          ).includes("Updated"),
        );
        await openView(page, "History");
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page
          .getByRole("button", { name: "Copy the link to this view" })
          .click();
        expect(
          await page.evaluate(() => navigator.clipboard.readText()),
        ).toContain("theme=dark");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  for (const failure of ["denied", "full"] as const) {
    browserIt(
      `drafts survive tabs when storage is ${failure}, with a warning`,
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
          await page.evaluate((kind) => {
            const store = window.localStorage;
            if (kind === "denied")
              Object.defineProperty(window, "localStorage", {
                get() {
                  throw new DOMException("Denied", "SecurityError");
                },
              });
            else {
              store.setItem(
                "jig-dispatch-dashboard:reply:example-org/web PRRT_x1",
                JSON.stringify({ text: "older", at: Date.now() }),
              );
              Storage.prototype.setItem = () => {
                throw new DOMException("Full", "QuotaExceededError");
              };
            }
          }, failure);
          const need = page.locator(".need").first();
          await need.getByRole("button", { name: "Write reply" }).click();
          await need.locator("textarea").fill("A, keep it small");
          await until("the storage warning is visible", async () =>
            (await need.innerText()).includes("Not saved"),
          );
          await openView(page, "History");
          await openView(page, "Help");
          await openView(page, "Now");
          await shows(page, ".need textarea");
          expect(await need.locator("textarea").inputValue()).toBe(
            "A, keep it small",
          );
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
  }

  browserIt(
    "open and remounted drafts expire without a reload",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        await page.clock.install();
        await page.reload();
        await shows(page, ".need");
        const need = page.locator(".need").first();
        await need.getByRole("button", { name: "Write reply" }).click();
        await need.locator("textarea").fill("A");
        await page.clock.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
        await page.clock.runFor(20_001);
        await until(
          "the open draft expires",
          async () => (await need.locator("textarea").inputValue()) === "",
        );
        await openView(page, "Help");
        await openView(page, "Now");
        expect(
          await need
            .getByRole("button", { name: "Copy the answer line for PR #456" })
            .count(),
        ).toBe(1);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

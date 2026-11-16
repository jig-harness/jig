/**
 * The closing report on the page, in a real browser against the real server:
 * each run's line says what it concluded and the next step it suggests, or
 * that it ended without a report; a row opens to all runs of its work, where
 * the suggested next step and the tick's own differ side by side; and a
 * need's card says what its run concluded beside its question. How the
 * browser is found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import { open, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, PHONE, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

describe("the closing report", () => {
  browserIt(
    "a run's line says what it concluded, or that it ended without a report",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=history`,
        LAPTOP,
      );
      try {
        await shows(page, ".cell-run");
        const lines = await page.locator(".cell-run").allTextContents();
        expect(lines).toContainEqual(
          expect.stringContaining(
            "Converged at round 4: every review thread is resolved",
          ),
        );
        expect(lines).toContain("Ended without a report");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a row opens to all runs of its work, with both next steps where they differ",
    async () => {
      const server = await served("quiet");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=history`,
        PHONE,
      );
      try {
        await shows(page, ".rowExpand");
        await page
          .locator(".row", { hasText: "PR #92" })
          .locator(".rowExpand")
          .click();
        await page.getByRole("button", { name: "All runs of PR #92" }).click();
        await shows(page, ".workRuns");
        const runs = page.locator(".workRuns");
        expect(await runs.locator("h3").textContent()).toBe(
          "Runs of PR #92 in example-org/infra, newest first",
        );
        const text = await runs.textContent();
        expect(text).toContain(
          "Re-arm the drive once the limit resets. (line)",
        );
        expect(text).toContain(
          "none: no handoff was recorded: exit 16 (quota-parked)",
        );
        expect(text).toContain("usage-limit");
        expect(page.url()).toContain("target=PR+%2392");
        await until("the log holds that work's rows alone", async () =>
          (await page.locator(".row").allTextContents()).every((row) =>
            row.includes("PR #92"),
          ),
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a need's card says what its run concluded beside its question",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".need");
        const card = page.locator(".need", { hasText: "PR #461" });
        await card.locator(".concluded").waitFor();
        expect(await card.locator(".concluded").textContent()).toBe(
          "The run concluded: Tagged the release and updated the website; the bundle budget check fails at 184 KiB, which only a person may raise.",
        );
        expect(await card.textContent()).toContain(
          "Should the bundle budget rise to 180 KiB",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

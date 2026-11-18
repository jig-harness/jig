/**
 * What is coming in a real browser, with a queue the size a working host
 * reaches: most targets will not start, and the few that start next stay in
 * sight. How the browser is found and when its absence fails is
 * `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import type { LineQueued } from "../plugin/dispatch/lib/dashboard-contract.ts";
import { queued } from "./fixture-line.ts";
import { open, shortControls, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const REPOS = [
  "example-org/web",
  "example-org/api",
  "example-org/infra",
  "example-org/mobile",
];

const repoAt = (i: number): string => REPOS[i % REPOS.length] ?? "";

/** Eighty targets, in the order the dispatcher wrote them. */
function longQueue(): LineQueued[] {
  const starts = Array.from({ length: 4 }, (_, i) =>
    queued({
      source: i % 2 === 0 ? "re-armable" : "label drive",
      group: "starts",
      repo: repoAt(i),
      pr: 100 + i,
      title: `Starting change ${i}`,
      why: "its wall has lifted",
    }),
  );
  const held = Array.from({ length: 3 }, (_, i) =>
    queued({
      source: "held",
      group: "held",
      repo: repoAt(i),
      pr: 200 + i,
      title: `Held change ${i}`,
      why: "a person held it",
    }),
  );
  const reported = Array.from({ length: 3 }, (_, i) =>
    queued({
      source: "assigned",
      group: "reported",
      repo: repoAt(i),
      item: `REP-${i}`,
      title: `Reported item ${i}`,
      why: "assigned by maintainer-a",
    }),
  );
  const never = Array.from({ length: 70 }, (_, i) =>
    queued({
      source: "assigned",
      group: "never",
      repo: repoAt(i),
      item: `NEV-${i}`,
      title: `Refused item ${i}`,
      why:
        i < 68
          ? `assigned to factory by contractor-${i}, who cannot write to ENG; only a person with write access starts a pickup`
          : "who assigned it cannot be read again: timed out",
    }),
  );
  return [...starts, ...held, ...reported, ...never];
}

/** Answers the page's reads with the queue `queue` gives at that moment. */
async function withQueue(page: Page, queue: () => LineQueued[]): Promise<void> {
  await page.route("**/state?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.value.line.queue = queue();
    await route.fulfill({ json: body });
  });
}

const withLongQueue = (page: Page) => withQueue(page, longQueue);

/** Some refused items, each its own target. */
function refusedItems(count: number): LineQueued[] {
  return Array.from({ length: count }, (_, i) =>
    queued({
      source: "assigned",
      group: "never",
      repo: repoAt(i),
      item: `NEV-${i}`,
      title: `Refused item ${i}`,
      why: "assigned by contractor-c, who cannot write",
    }),
  );
}

/** Jumps to a card from the palette and waits for it to take focus. */
async function jumpTo(page: Page, target: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await page.locator(".paletteField").fill(target);
  await page.keyboard.press("Enter");
  await until(
    `${target} has focus`,
    async () =>
      (await page.locator(":focus").getAttribute("aria-label")) === target,
  );
}

/** Every card's key, in the page's order, folded ones included. */
function cardOrder(page: Page): Promise<string[]> {
  return page
    .locator(".pQueue .qItem")
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("aria-label") ?? ""),
    );
}

function sideways(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

function groupBy(page: Page, word: string) {
  return page
    .getByRole("group", { name: "Group by" })
    .getByRole("button", { name: word, exact: true });
}

describe("What is coming", () => {
  browserIt(
    "keeps the filters and the first card that starts above the fold, with a long refused group folded",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await withLongQueue(page);
        await page.reload();
        await page.getByRole("heading", { name: /^Starts next/ }).waitFor();
        await until(
          "all eighty cards are counted",
          async () => (await page.locator(".pQueue .qItem").count()) === 80,
        );
        const first = await page
          .locator(".pQueue .qItem:visible")
          .first()
          .boundingBox();
        const controls = await page.locator(".facetControls").boundingBox();
        expect(controls).not.toBeNull();
        expect(first).not.toBeNull();
        expect((controls?.y ?? 0) + (controls?.height ?? 0)).toBeLessThan(
          LAPTOP.height,
        );
        expect((first?.y ?? 0) + (first?.height ?? 0)).toBeLessThan(
          LAPTOP.height,
        );
        expect(await sideways(page)).toBeLessThanOrEqual(0);

        // "Starts next" leads and has nothing to fold it.
        expect(
          await page.locator(".pQueue h3").first().textContent(),
        ).toContain("Starts next");
        expect(
          await page.getByRole("button", { name: "Starts next group" }).count(),
        ).toBe(0);
        const never = page.getByRole("button", {
          name: "Will not start group",
        });
        expect(await never.getAttribute("aria-expanded")).toBe("false");
        const heading = page.getByRole("heading", { name: /^Will not start/ });
        expect(await heading.textContent()).toContain(
          "68 assigned by someone who cannot write",
        );
        expect(await heading.locator("[data-group-count]").textContent()).toBe(
          "70",
        );
        expect(await page.locator(".pQueue .qItem:visible").count()).toBe(10);

        const card = page.locator(".pQueue .qItem").first();
        expect(await card.textContent()).toContain("example-org/web");
        expect(await card.locator(".srcChip").textContent()).toBe("re-armable");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "filters by repository, source, kind and group, with counts, and says why in what remains",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await withLongQueue(page);
        await page.reload();
        await page.locator('[data-facet="happens"]').waitFor();
        for (const facet of ["repo", "source", "kind", "happens"])
          expect(await page.locator(`[data-facet="${facet}"]`).count()).toBe(1);
        const words = await page
          .locator('[data-facet="happens"] .facetChip')
          .allTextContents();
        expect(words).toEqual(["starts 4", "held 3", "reported 3", "never 70"]);
        await page
          .locator('[data-facet="kind"]')
          .getByRole("button", { name: /^pull request/ })
          .click();
        expect(new URL(page.url()).searchParams.get("facet-kind")).toBe(
          "pull request",
        );
        await until(
          "only pull requests remain",
          async () =>
            (await page.locator(".pQueue .qItem:visible").count()) === 7,
        );
        expect(
          await page.getByRole("heading", { name: /^Will not start/ }).count(),
        ).toBe(0);
        await page.getByRole("button", { name: "Clear", exact: true }).click();
        await page
          .locator('[data-facet="repo"]')
          .getByRole("combobox")
          .or(
            page
              .locator('[data-facet="repo"]')
              .getByRole("button", { name: /example-org\/api/ }),
          )
          .first()
          .waitFor();
        await page
          .locator('[data-facet="repo"]')
          .getByRole("button", { name: /example-org\/api/ })
          .click();
        const heading = page.getByRole("heading", { name: /^Will not start/ });
        await until(
          "the refused group counts what the filter left",
          async () =>
            (await heading.locator("[data-group-count]").textContent()) ===
            "18",
        );
        expect(await heading.textContent()).toContain(
          "17 assigned by someone who cannot write",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "grouping by repository and back restores the dispatcher's order exactly",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await withLongQueue(page);
        await page.reload();
        await until(
          "all eighty cards are drawn",
          async () => (await page.locator(".pQueue .qItem").count()) === 80,
        );
        const order = await cardOrder(page);
        expect(
          await groupBy(page, "what happens").getAttribute("aria-pressed"),
        ).toBe("true");

        await groupBy(page, "repository").click();
        await page
          .getByRole("heading", { name: /^example-org\/api/ })
          .waitFor();
        expect(new URL(page.url()).searchParams.get("group-by")).toBe("repo");
        expect(await cardOrder(page)).not.toEqual(order);
        expect((await cardOrder(page)).toSorted()).toEqual(order.toSorted());
        // Under another grouping a card still says what will happen to it.
        expect(
          await page.locator(".pQueue .qItem .qHappens").first().textContent(),
        ).toBe("Starts next");
        await page.reload();
        await page
          .getByRole("heading", { name: /^example-org\/api/ })
          .waitFor();
        expect(
          await groupBy(page, "repository").getAttribute("aria-pressed"),
        ).toBe("true");

        await groupBy(page, "none").click();
        await until(
          "the list has no headings",
          async () => (await page.locator(".pQueue h3").count()) === 0,
        );
        expect(await cardOrder(page)).toEqual(order);

        await groupBy(page, "source").click();
        await page.getByRole("heading", { name: /^assigned/ }).waitFor();

        await groupBy(page, "what happens").click();
        await page.getByRole("heading", { name: /^Starts next/ }).waitFor();
        expect(new URL(page.url()).searchParams.has("group-by")).toBe(false);
        expect(await cardOrder(page)).toEqual(order);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a palette jump reaches a card in a folded group, under a filter or after Show all",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        await withLongQueue(page);
        await page.reload();
        await page
          .locator('[data-facet="repo"]')
          .getByRole("button", { name: /example-org\/api/ })
          .click();
        await until(
          "the filter has narrowed the cards",
          async () =>
            (await page.locator(".pQueue .qItem:visible").count()) < 80,
        );
        await jumpTo(page, "NEV-69");
        expect(new URL(page.url()).searchParams.has("facet-repo")).toBe(false);
        const never = page.getByRole("button", {
          name: "Will not start group",
        });
        expect(await never.getAttribute("aria-expanded")).toBe("true");

        await jumpTo(page, "PR #202");
        const held = page.getByRole("button", {
          name: "Held behind a serialized leader group",
        });
        await held.click();
        expect(await held.getAttribute("aria-expanded")).toBe("false");
        await jumpTo(page, "PR #202");
        expect(await held.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the text filter finds the same cards under every grouping",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue&q=starts+next`,
        LAPTOP,
      );
      try {
        await withLongQueue(page);
        await page.reload();
        const shown = page.locator(".pQueue .qItem:visible");
        await until(
          "the filter applies",
          async () => (await shown.count()) > 0,
        );
        expect(await shown.count()).toBe(4);
        await groupBy(page, "repository").click();
        await page
          .getByRole("heading", { name: /^example-org\/api/ })
          .waitFor();
        expect(await shown.count()).toBe(4);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a refresh that lengthens the refused group leaves it as the person has it",
    async () => {
      const server = await served("queue");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=queue`,
        LAPTOP,
      );
      try {
        let count = 5;
        await withQueue(page, () => refusedItems(count));
        await page.clock.install();
        await page.reload();
        const never = page.getByRole("button", {
          name: "Will not start group",
        });
        await never.waitFor();
        expect(await never.getAttribute("aria-expanded")).toBe("true");
        count = 6;
        await page.clock.fastForward(60_000);
        await until(
          "the sixth card has arrived",
          async () => (await page.locator(".pQueue .qItem").count()) === 6,
        );
        expect(await never.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a phone offers Show all only where it would show more, and an opened refused group shows all of it",
    async () => {
      const server = await served("queue");
      const context = await requireBrowser().newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await withQueue(page, () => [
          ...longQueue().slice(0, 2),
          ...refusedItems(8),
        ]);
        await page.goto(`${server.url}&view=queue`);
        const never = page.getByRole("button", {
          name: "Will not start group",
        });
        await never.waitFor();
        expect(
          await page.getByRole("button", { name: /^Show all/ }).count(),
        ).toBe(0);
        await never.tap();
        await until(
          "the opened group shows its cards",
          async () =>
            (await page.locator(".pQueue .qItem:visible").count()) === 10,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "on a phone a refresh changes neither how a group opens nor what it holds back",
    async () => {
      const server = await served("queue");
      const context = await requireBrowser().newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        const lead = longQueue().slice(0, 1);
        let refused = 5;
        await withQueue(page, () => [...lead, ...refusedItems(refused)]);
        await page.clock.install();
        await page.goto(`${server.url}&view=queue`);
        const cards = page.locator(".pQueue .qItem");
        const shown = page.locator(".pQueue .qItem:visible");
        await until(
          "the cards arrive",
          async () => (await cards.count()) === 6,
        );
        expect(await shown.count()).toBe(3);
        refused = 6;
        await page.clock.fastForward(60_000);
        await until(
          "the card arrives",
          async () => (await cards.count()) === 7,
        );
        expect(await shown.count()).toBe(3);
        expect(
          await page.getByRole("button", { name: "Show all 6" }).count(),
        ).toBeGreaterThan(0);

        refused = 8;
        await page.reload();
        const never = page.getByRole("button", {
          name: "Will not start group",
        });
        await never.waitFor();
        expect(await never.getAttribute("aria-expanded")).toBe("false");
        refused = 4;
        await page.clock.fastForward(60_000);
        await until(
          "the group shrinks",
          async () => (await cards.count()) === 5,
        );
        await never.tap();
        await until(
          "the opened group shows every card",
          async () => (await shown.count()) === 5,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a phone offers no Show all while a filter already shows every match",
    async () => {
      const server = await served("queue");
      const context = await requireBrowser().newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      try {
        await withQueue(page, () =>
          Array.from({ length: 8 }, (_, i) =>
            queued({
              source: "re-armable",
              group: "starts",
              repo: repoAt(i % 2),
              pr: 300 + i,
              title: `Starting change ${i}`,
              why: "its wall has lifted",
            }),
          ),
        );
        await page.goto(`${server.url}&view=queue`);
        const all = page.getByRole("button", { name: /^Show all/ });
        await all.first().waitFor();
        await page.locator(".phoneRepo select").selectOption("example-org/api");
        await until(
          "every match shows",
          async () =>
            (await page.locator(".pQueue .qItem:visible").count()) === 4,
        );
        expect(await all.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  for (const width of [390, 320]) {
    browserIt(
      `folds by touch at ${width}px, with repository the only filter and the default grouping`,
      async () => {
        const server = await served("queue");
        const context = await requireBrowser().newContext({
          viewport: { width, height: 844 },
          hasTouch: true,
          isMobile: true,
        });
        const page = await context.newPage();
        try {
          await withLongQueue(page);
          // A link made on a laptop keeps its grouping there, not here.
          await page.goto(`${server.url}&view=queue&group-by=repo`);
          await page.getByRole("heading", { name: /^Starts next/ }).waitFor();
          expect(
            await page.evaluate(() => matchMedia("(hover: none)").matches),
          ).toBe(true);
          expect(
            await page.getByRole("group", { name: "Group by" }).count(),
          ).toBe(0);
          expect(
            await page
              .locator(".facetRow:visible")
              .evaluateAll((rows) =>
                rows.map((row) => row.getAttribute("data-facet")),
              ),
          ).toEqual(["repo"]);
          expect(await page.locator(".phoneRepo select").isVisible()).toBe(
            true,
          );
          const never = page.getByRole("button", {
            name: "Will not start group",
          });
          expect(await never.getAttribute("aria-expanded")).toBe("false");
          const held = page.getByRole("button", {
            name: "Held behind a serialized leader group",
          });
          expect(await held.getAttribute("aria-expanded")).toBe("true");
          // Every open group shows its first cards before Show all.
          const heldCards = page.locator(
            "[data-facet-group]:has(h3:has-text('Held')) .qItem:visible",
          );
          expect(await heldCards.count()).toBe(2);
          await held.tap();
          expect(await held.getAttribute("aria-expanded")).toBe("false");
          expect(await heldCards.count()).toBe(0);
          await never.tap();
          expect(await never.getAttribute("aria-expanded")).toBe("true");
          await shows(page, "[data-facet-group] .qItem");
          expect(await shortControls(page)).toEqual([]);
          expect(await sideways(page)).toBeLessThanOrEqual(0);

          await page
            .locator(".phoneRepo select")
            .selectOption("example-org/api");
          await until(
            "the repository filter narrows the cards",
            async () =>
              (await page
                .locator(".pQueue .qItem:visible")
                .evaluateAll((cards) =>
                  cards.every((card) =>
                    card.textContent?.includes("example-org/api"),
                  ),
                )) === true,
          );
          expect(await sideways(page)).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
  }
});

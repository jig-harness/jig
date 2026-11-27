/**
 * Needs you in a real browser against the real server: each card opens with
 * its act, the ask, the recommended option with what it changes and costs,
 * and who it waits on; the steps for a person are a checklist in the fold;
 * and the person filter leaves only that person's needs. How the browser is
 * found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import { open, settled, shows, until } from "./browser-page.ts";
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
        const headings = await page
          .locator(".pNeeds .needGroupTitle")
          .allTextContents();
        const groups = page.locator(".pNeeds .needGroup");
        const counted = await groups.evaluateAll((els) =>
          els.map((el) => ({
            shown: el.querySelector("[data-group-count]")?.textContent,
            cards: el.querySelectorAll(".need").length,
          })),
        );
        expect(headings.map((h) => h.replace(/\s+/g, " ").trim())).toEqual([
          expect.stringMatching(/^Decide · [1-9]\d*/),
          expect.stringMatching(/^Authorize · 1(?!\d)/),
          expect.stringMatching(/^Investigate · 4(?!\d)/),
        ]);
        // Each heading's count is the number of cards its group holds.
        expect(counted.map((g) => g.shown)).toEqual(
          counted.map((g) => String(g.cards)),
        );
        expect(await page.locator(".pNeeds .needGroupTitle .act").count()).toBe(
          0,
        );
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
        await card.locator("[data-card-toggle]").click();
        await shows(page, ".pNeeds .need .opts .decExpanded");
        expect(
          await card.locator(".opts li.decExpanded").textContent(),
        ).toContain("B: retry 5xx and 429");

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
    "folds the answered holds into one line that opens and closes, at every width",
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
        // With no answered hold there is no line.
        expect(await page.locator(".pNeeds .heldToggle").count()).toBe(0);
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.value.line.answeredHolds = [1, 2, 3, 4, 5, 6].map((n) => ({
            repo: "example-org/web",
            target: `#${n}`,
            why: `a person chose hold for #${n}; it returns when its facts change`,
          }));
          await route.fulfill({ json: body });
        });
        await page.reload();
        await shows(page, ".pNeeds .heldToggle");
        const toggle = page.locator(".pNeeds .heldToggle");
        const notes = page.locator(".pNeeds .answeredHold");
        expect(await toggle.count()).toBe(1);
        expect(await toggle.textContent()).toBe(
          "6 cards hidden by answers · show",
        );
        expect(await toggle.getAttribute("aria-expanded")).toBe("false");
        expect(await notes.filter({ visible: true }).count()).toBe(0);
        await toggle.click();
        await until(
          "the six notes show",
          async () => (await notes.filter({ visible: true }).count()) === 6,
        );
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        expect(await notes.first().textContent()).toBe(
          "example-org/web #1: a person chose hold for #1; it returns when its facts change",
        );
        await toggle.focus();
        await page.keyboard.press("Enter");
        await until(
          "the notes hide again",
          async () => (await notes.filter({ visible: true }).count()) === 0,
        );
        // Open, so the notes' own lines are measured too.
        await toggle.click();
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await settled(page);
          expect({
            width,
            overflow: await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
            tall: ((await toggle.boundingBox())?.height ?? 0) >= 44,
          }).toEqual({ width, overflow: 0, tall: true });
        }
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
        await page.getByRole("button", { name: /maintainer-b/ }).click();
        await until(
          "only maintainer-b's need is listed",
          async () =>
            (await page.locator(".pNeeds .need:visible").count()) === 1,
        );
        const card = page.locator(".pNeeds .need:visible").first();
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

  browserIt(
    "act chips update counts and restore the filtered view from its address",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        server.url,
        LAPTOP,
      );
      try {
        expect(new URL(page.url()).searchParams.has("view")).toBe(false);
        const chip = page
          .locator('[data-facet="act"]')
          .getByRole("button", { name: /^Decide/ });
        const count = Number((await chip.textContent())?.match(/\d+$/)?.[0]);
        expect(count).toBeGreaterThan(0);
        const total = await page.locator(".need").count();
        expect(total).toBeGreaterThan(count);
        await chip.click();
        expect(await chip.getAttribute("aria-pressed")).toBe("true");
        expect(new URL(page.url()).searchParams.get("view")).toBe("needs");
        expect(new URL(page.url()).searchParams.get("facet-act")).toBe(
          "Decide",
        );
        await shows(page, ".need:visible");
        const shown = page.locator(".need:visible");
        expect(await shown.locator(".act").allTextContents()).toEqual(
          Array.from({ length: count }, () => "Decide"),
        );
        expect(
          await page.getByText(`Showing ${count} of ${total}`).isVisible(),
        ).toBe(true);
        expect(
          await page
            .locator(".needGroup:visible [data-group-count]")
            .allTextContents(),
        ).toEqual([String(count)]);
        await page.reload();
        await until(
          "the act filter is restored",
          async () => (await chip.getAttribute("aria-pressed")) === "true",
        );
        await page.getByRole("button", { name: "Clear", exact: true }).click();
        expect(new URL(page.url()).searchParams.has("facet-act")).toBe(false);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a heading folds by click, Enter and o on desktop",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        const decide = page.getByRole("button", { name: "Decide group" });
        const investigate = page.getByRole("button", {
          name: "Investigate group",
        });
        expect(await investigate.getAttribute("aria-expanded")).toBe("false");
        await decide.click();
        expect(await decide.getAttribute("aria-expanded")).toBe("false");
        await decide.press("Enter");
        expect(await decide.getAttribute("aria-expanded")).toBe("true");
        await decide.press("o");
        expect(await decide.getAttribute("aria-expanded")).toBe("false");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a long group opens on ten cards and can show the rest",
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
          const first = body.value.line.needs[0];
          // Each asks its own question: needs identical but for their target would be one question group's card.
          body.value.line.needs = Array.from({ length: 12 }, (_, index) => ({
            ...first,
            pr: 1800 + index,
            target: `PR #${1800 + index}`,
            decisions: first.decisions.map(
              (d: { question: string | null }) => ({
                ...d,
                question: `${d.question ?? "Which one?"} (${index + 1})`,
              }),
            ),
          }));
          await route.fulfill({ json: body });
        });
        await page.reload();
        const group = page.locator("[data-facet-group]").filter({
          has: page.getByRole("heading", { name: /^Decide/ }),
        });
        const show = group.getByRole("button", { name: "Show all 12" });
        await show.waitFor();
        const cards = group.locator(".need:visible");
        expect(await cards.count()).toBe(10);
        await show.click();
        expect(await cards.count()).toBe(12);
        await group.getByRole("button", { name: "Decide group" }).click();
        await page.keyboard.press("Control+k");
        await page.locator(".paletteField").fill("#1811");
        await page.keyboard.press("Enter");
        await until(
          "the last card has focus",
          async () =>
            (await page.locator(":focus").getAttribute("aria-label")) ===
            "PR #1811",
        );
        expect(await cards.count()).toBe(12);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "surfaces a converged PR placed in needs-you by the board read under its mapped act with Ready conditions",
    async () => {
      const server = await served("quiet");
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
          body.value.line.needs = [];
          body.value.line.ready = [
            {
              repo: "example-org/web",
              pr: 509,
              url: "https://forge.example/example-org/web/pull/509",
              title: "Tighten the branch rule",
              head: "a".repeat(40),
              place: "needs-you",
              lane: null,
              says: "the forge blocks the merge (BLOCKED) on a rule the board cannot tell, such as signed commits or a deployment: open the pull request",
              act: "open-pr",
              waitingFor: null,
              command: null,
              withheld: null,
              requested: [],
              failing: [],
              failingOmitted: 0,
              conditions: [
                {
                  name: "converged",
                  met: true,
                  fact: "its drive stopped converged",
                },
                {
                  name: "protection lets it merge",
                  met: false,
                  fact: "merge state BLOCKED",
                },
              ],
              unblocks: [],
              since: "2026-11-03T15:00:00.000Z",
            },
          ];
          await route.fulfill({ json: body });
        });
        await page.reload();
        await shows(page, ".pNeeds .need");
        expect(
          await page.locator('[data-view="merge"] .badge').textContent(),
        ).toBe("0");
        expect(
          await page.locator('[data-view="needs"] .badge').textContent(),
        ).toBe("1");
        const heading = await page
          .locator(".pNeeds .needGroupTitle")
          .first()
          .textContent();
        expect(heading?.replace(/\s+/g, " ").trim()).toMatch(/^Do · 1(?!\d)/);
        const card = page.locator(".pNeeds .need").first();
        expect(await card.locator(".act").textContent()).toBe("Do");
        expect(await card.textContent()).toContain("PR #509");
        expect(await card.textContent()).toContain("open the pull request");
        expect(await card.textContent()).toContain("BLOCKED");
        await card.locator("[data-card-toggle]").click();
        await shows(page, ".pNeeds .need .mConds");
        expect(await card.locator(".mConds").textContent()).toContain(
          "protection lets it merge (not met): merge state BLOCKED",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the count still names a repository the tick could not read",
    async () => {
      const server = await served("loud");
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
          const repo = body.value.line.repos[0];
          repo.unobserved = true;
          repo.refused = "the forge could not be read";
          delete repo.readAt;
          await route.fulfill({ json: body });
        });
        await page.reload();
        await shows(page, ".need");
        expect(await page.locator(".answer").textContent()).toMatch(
          /need a person.*1 repository not read: .*never read/s,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  for (const width of [390, 320]) {
    browserIt(
      `filter links and group headings work by touch at ${width}px`,
      async () => {
        const server = await served("loud");
        const context = await requireBrowser().newContext({
          viewport: { width, height: 844 },
          hasTouch: true,
          isMobile: true,
        });
        const page = await context.newPage();
        try {
          await page.goto(`${server.url}&view=queue&facet-source=assigned`);
          const clear = page.getByRole("button", {
            name: "Clear",
            exact: true,
          });
          await clear.waitFor();
          expect(
            await page.evaluate(() => matchMedia("(hover: none)").matches),
          ).toBe(true);
          const named = page.locator(".phoneFilters");
          expect(await named.isVisible()).toBe(true);
          expect(await named.textContent()).toMatch(/source.*assigned/i);
          const sources = await page
            .locator(".qItem:visible")
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute("data-facet-source")),
            );
          expect(sources.length).toBeGreaterThan(0);
          expect(new Set(sources)).toEqual(new Set(['["assigned"]']));
          expect(
            await page.locator('[data-facet="source"] button:visible').count(),
          ).toBe(0);
          expect(await page.locator("[data-view-filter]:visible").count()).toBe(
            0,
          );
          expect((await clear.boundingBox())?.height).toBeGreaterThanOrEqual(
            44,
          );
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
          await clear.tap();
          expect(new URL(page.url()).searchParams.has("facet-source")).toBe(
            false,
          );
          await page.goto(`${server.url}&view=needs`);
          const decide = page.getByRole("button", { name: "Decide group" });
          await decide.waitFor();
          expect((await decide.boundingBox())?.height).toBeGreaterThanOrEqual(
            44,
          );
          await decide.tap();
          expect(await decide.getAttribute("aria-expanded")).toBe("false");
          expect(
            await page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth,
            ),
          ).toBeLessThanOrEqual(0);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
  }
});

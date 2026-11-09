/**
 * The page's keys in a real browser, on every view: j and k move one focus
 * between the cards, Enter and o open and close the card, p and i open its
 * pull request or issue, c copies its command, g and a letter go to a view,
 * / filters, ? lists the keys and ⌘K or Ctrl-K opens the palette; and none of
 * them fires while a person types in a field. Over the `merge` scenario, where
 * every view has cards and merge now holds two pull requests. How the browser
 * is found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Page } from "playwright-core";
import { open, settled, shows, until, type Watched } from "./browser-page.ts";
import { browserSuite, LAPTOP, openView, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

/** The card views by their tabs' labels, the letter after g that goes to each, and what a `?view=` names. */
const VIEWS = [
  { label: "Merge", key: "m", id: "merge" },
  { label: "Needs you", key: "n", id: "needs" },
  { label: "Running", key: "r", id: "running" },
  { label: "Queue", key: "q", id: "queue" },
  { label: "History", key: "h", id: "history" },
] as const;

/** Opens the scenario on a view, with `window.open` recording rather than opening. */
async function openOn(view: string): Promise<Watched> {
  const server = await served("merge");
  const watched = await open(
    requireBrowser(),
    server.origin,
    `${server.url}&view=${view}`,
    LAPTOP,
  );
  const { page } = watched;
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.assign(window, { opened });
    window.open = (url?: string | URL) => {
      opened.push(String(url));
      return null;
    };
  });
  await page.reload();
  await shows(page, "main :is(h1, h2)");
  await settled(page);
  return watched;
}

async function currentTab(page: Page): Promise<string> {
  const tab = page.locator('.viewTab[aria-current="page"]');
  return (await tab.evaluate((a) => a.firstChild?.textContent ?? "")).trim();
}

/** The card focus is on, by its key; `null` when focus is on none. */
function focusedCard(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("data-card") ?? null,
  );
}

function cardKeys(page: Page): Promise<string[]> {
  return page
    .locator("main [data-card]:visible")
    .evaluateAll((cards) =>
      cards.map((c) => c.getAttribute("data-card") ?? ""),
    );
}

function opened(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { opened: string[] }).opened.slice(),
  );
}

/** What the page last said about a key, out loud and in sight. */
function said(page: Page): Promise<string> {
  return page
    .locator(".say")
    .textContent()
    .then((t) => t ?? "");
}

/** Presses j until focus rests on the first card that carries `attribute`; its value, or `null` when no card does. */
async function jTo(page: Page, attribute: string): Promise<string | null> {
  const keys = await page
    .locator("main [data-card]:visible")
    .evaluateAll(
      (cards, name) => cards.map((c) => c.getAttribute(name)),
      attribute,
    );
  const at = keys.findIndex((v) => v !== null);
  if (at === -1) return null;
  await page.keyboard.press("j");
  for (let i = 0; i < at; i++) await page.keyboard.press("j");
  return keys[at] ?? null;
}

describe("the keys on every view", () => {
  for (const view of VIEWS) {
    browserIt(
      `${view.label}: j and k move one focus between the cards, and Tab still leaves it`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          const keys = await cardKeys(page);
          expect(keys.length).toBeGreaterThan(1);
          await page.keyboard.press("j");
          expect(await focusedCard(page)).toBe(keys[0] ?? "");
          await page.keyboard.press("j");
          expect(await focusedCard(page)).toBe(keys[1] ?? "");
          await page.keyboard.press("k");
          expect(await focusedCard(page)).toBe(keys[0] ?? "");
          await page.keyboard.press("k");
          expect(await focusedCard(page)).toBe(keys[0] ?? "");
          // Roving focus: one card takes Tab, so Tab moves into its controls rather than to the next card.
          expect(
            await page.locator('main [data-card][tabindex="0"]').count(),
          ).toBe(1);
          await page.keyboard.press("Tab");
          expect(await focusedCard(page)).toBeNull();
          expect(
            await page.evaluate(
              () =>
                document.activeElement
                  ?.closest("[data-card]")
                  ?.getAttribute("data-card") ?? null,
            ),
          ).toBe(keys[0] ?? "");
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: Enter and o expand and collapse the card`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          await page.keyboard.press("j");
          const card = page.locator("main [data-card]:visible").first();
          const toggle = card
            .locator("[data-card-toggle], .foldBtn.disclosure")
            .first();
          expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          await page.keyboard.press("Enter");
          await until(
            "Enter expanded the card",
            async () => (await toggle.getAttribute("aria-expanded")) === "true",
          );
          expect(await focusedCard(page)).not.toBeNull();
          await page.keyboard.press("o");
          await until(
            "o collapsed the card",
            async () =>
              (await toggle.getAttribute("aria-expanded")) === "false",
          );
          await page.keyboard.press("o");
          await until(
            "o expanded it again",
            async () => (await toggle.getAttribute("aria-expanded")) === "true",
          );
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: p and i open the card's pull request or issue, or say it has none`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          const pr = await jTo(page, "data-pr");
          expect(pr).not.toBeNull();
          await page.keyboard.press("p");
          await until("p opened the pull request", async () =>
            (await opened(page)).includes(pr ?? ""),
          );
          await page.keyboard.press("i");
          await until("i said the card has no issue", async () =>
            (await said(page)).includes("This card has no issue"),
          );
          await page.keyboard.press("Escape");
          await page.reload();
          await shows(page, "main :is(h1, h2)");
          const issue = await jTo(page, "data-issue");
          // Needs you and Queue hold tracker items in this scenario; the other views hold only pull requests.
          expect(issue !== null).toBe(
            view.id === "needs" || view.id === "queue",
          );
          if (issue === null) return;
          await page.keyboard.press("i");
          await until("i opened the issue", async () =>
            (await opened(page)).includes(issue),
          );
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: c copies the card's command`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          const command = await jTo(page, "data-command");
          expect(command).not.toBeNull();
          await page.keyboard.press("c");
          await until("c copied the command", async () =>
            (await said(page)).startsWith("Copied"),
          );
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toBe(command ?? "");
          await shows(page, ".keyToast");
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: g and a letter go to each view, ? lists the keys, / filters`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          for (const to of VIEWS) {
            await page.keyboard.press("g");
            await page.keyboard.press(to.key);
            await until(
              `g ${to.key} went to ${to.label}`,
              async () => (await currentTab(page)) === to.label,
            );
            expect(page.url()).toContain(`view=${to.id}`);
          }
          await openView(page, view.label);
          await page.keyboard.press("?");
          await until(
            "? went to the keys",
            async () => (await currentTab(page)) === "Help",
          );
          expect(
            await page.evaluate(() => document.activeElement?.id ?? ""),
          ).toBe("h-keys");
          expect(await page.locator(".keyList dt").count()).toBeGreaterThan(8);
          await openView(page, view.label);
          await page.keyboard.press("/");
          const field = page.locator(
            view.id === "history"
              ? '.fields input[type="search"]'
              : "[data-view-filter]",
          );
          await until("/ focused the view's filter", async () =>
            field.first().evaluate((f) => f === document.activeElement),
          );
          if (view.id !== "history") {
            const before = (await cardKeys(page)).length;
            const target = await page
              .locator("main [data-card]:visible .tgt")
              .first()
              .textContent();
            await page.keyboard.type(target ?? "");
            await until("the filter narrowed the cards", async () => {
              const now = (await cardKeys(page)).length;
              return now > 0 && now < before;
            });
            await page.keyboard.press("Escape");
            await until(
              "Escape cleared the filter",
              async () => (await cardKeys(page)).length === before,
            );
          }
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: ⌘K and Ctrl-K open the palette, a dialog with an active descendant`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          for (const chord of ["Meta+k", "Control+k"]) {
            await page.keyboard.press(chord);
            await shows(page, '[role="dialog"] [role="combobox"]');
            const field = page.locator(".paletteField");
            expect(
              await field.evaluate((f) => f === document.activeElement),
            ).toBe(true);
            const active = await field.getAttribute("aria-activedescendant");
            expect(
              await page
                .locator(`#${CSS_ESCAPE(active ?? "")}`)
                .getAttribute("aria-selected"),
            ).toBe("true");
            await page.keyboard.press("ArrowDown");
            expect(await field.getAttribute("aria-activedescendant")).not.toBe(
              active,
            );
            await page.keyboard.press("Escape");
            await until(
              "Escape closed the palette",
              async () => (await page.locator('[role="dialog"]').count()) === 0,
            );
          }
          // Jump to a pull request by its number, from any view.
          await page.keyboard.press("Control+k");
          await page.keyboard.type("#1199");
          await page.keyboard.press("Enter");
          await until(
            "the palette went to the card on Merge",
            async () => (await currentTab(page)) === "Merge",
          );
          await until("the card has focus", async () =>
            ((await focusedCard(page)) ?? "").includes(" 1199 "),
          );
          // Go to a view.
          await page.keyboard.press("Control+k");
          await page.keyboard.type("go to queue");
          await page.keyboard.press("Enter");
          await until(
            "the palette went to Queue",
            async () => (await currentTab(page)) === "Queue",
          );
          // Run a card's command.
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          await page.keyboard.press("Control+k");
          await page.keyboard.type("merge command #461");
          await page.keyboard.press("Enter");
          await until("the palette copied the merge command", async () =>
            (await said(page)).startsWith("Copied"),
          );
          expect(
            await page.evaluate(() => navigator.clipboard.readText()),
          ).toContain("gh pr merge 461");
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

    browserIt(
      `${view.label}: no key fires inside a text field`,
      async () => {
        const { page, context } = await openOn(view.id);
        try {
          const field = page
            .locator(
              view.id === "history"
                ? '.fields input[type="search"]'
                : "[data-view-filter]",
            )
            .first();
          await field.focus();
          const typed = "jkopicg/?";
          await page.keyboard.type(typed);
          await page.keyboard.press("Enter");
          await page.keyboard.press("g");
          await page.keyboard.press("m");
          await page.keyboard.press("Meta+k");
          await page.keyboard.press("Control+k");
          expect(await page.locator('[role="dialog"]').count()).toBe(0);
          expect(await currentTab(page)).toBe(view.label);
          expect(await opened(page)).toEqual([]);
          expect(await focusedCard(page)).toBeNull();
          expect(
            await field.evaluate((f) => f === document.activeElement),
          ).toBe(true);
          expect(await field.inputValue()).toBe(`${typed}gm`);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
  }

  browserIt(
    "Help: the g keys, ? and the palette work, and j says there is no card",
    async () => {
      const { page, context } = await openOn("help");
      try {
        await shows(page, "#h-keys");
        await page.keyboard.press("j");
        await until("j said there is no card", async () =>
          (await said(page)).includes("No cards in this view"),
        );
        await page.keyboard.press("Control+k");
        await shows(page, ".paletteField");
        await page.keyboard.press("Escape");
        await page.keyboard.press("g");
        await page.keyboard.press("n");
        await until(
          "g n went to Needs you",
          async () => (await currentTab(page)) === "Needs you",
        );
        await page.keyboard.press("?");
        await until(
          "? came back to Help",
          async () => (await currentTab(page)) === "Help",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a card's own keys wait until a card is chosen, and the palette copies with nothing focused",
    async () => {
      const { page, context } = await openOn("merge");
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.keyboard.press("p");
        await until("p asked for a card first", async () =>
          (await said(page)).includes("press j first"),
        );
        expect(await opened(page)).toEqual([]);
        await page.keyboard.press("Control+k");
        await page.keyboard.type("merge command #1199");
        await page.keyboard.press("Enter");
        await until("the palette copied the merge command", async () =>
          (await said(page)).startsWith("Copied"),
        );
        expect(
          await page.evaluate(() => navigator.clipboard.readText()),
        ).toContain("gh pr merge 1199");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "dismissing the flash or following it keeps focus on the page",
    async () => {
      const { page, context } = await openOn("running");
      try {
        await page.locator(".flashGo").focus();
        await page.keyboard.press("Enter");
        await until(
          "the flash went to Merge",
          async () => (await currentTab(page)) === "Merge",
        );
        await until("focus is on Merge's first card", async () =>
          ((await focusedCard(page)) ?? "").startsWith("merge "),
        );
        await openView(page, "Queue");
        await page.locator(".flashOff").click();
        await until(
          "the flash is gone",
          async () => (await page.locator(".flash").count()) === 0,
        );
        expect(
          await page.evaluate(() => document.activeElement?.tagName),
        ).not.toBe("BODY");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a filter finds the cards a phone keeps behind Show all",
    async () => {
      const server = await served("merge");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        { width: 390, height: 844 },
      );
      try {
        await shows(page, ".need");
        const hidden = await page
          .locator(".need.rest .tgt")
          .first()
          .textContent();
        expect(hidden).not.toBeNull();
        await page.locator("[data-view-filter]").fill(hidden ?? "");
        await until(
          "the hidden card shows",
          async () => (await cardKeys(page)).length > 0,
        );
        expect(
          await page
            .locator("main [data-card]:visible .tgt")
            .first()
            .textContent(),
        ).toBe(hidden);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a reply being written takes every key as text",
    async () => {
      const { page, context } = await openOn("needs");
      try {
        const need = page.locator(".need").first();
        await need.getByRole("button", { name: "Write reply" }).click();
        const box = need.locator("textarea");
        await box.focus();
        await page.keyboard.type("jk gm c?");
        expect(await box.inputValue()).toBe("jk gm c?");
        expect(await currentTab(page)).toBe("Needs you");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

/** An element id as a CSS selector: React's ids carry colons. */
function CSS_ESCAPE(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

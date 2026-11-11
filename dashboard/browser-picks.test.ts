/**
 * Picking answers on a card in a real browser, over the `picks` scenario: a
 * card of one decision, a card of two, and a card whose decision asks for
 * authorization. A digit picks an option of the current decision (1 is the
 * recommended one) and moves on, h and l move between decisions, u undoes,
 * r writes a note or an answer in the person's own words, and c copies the
 * card's answers as one comment with their digests; a guarded pick copies
 * only on the second step, from the key, the button and the palette; a
 * decision framed again drops its pick and says so; and on a phone every
 * pick is a tap. How the browser is found and when its absence fails is
 * `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { BrowserContext, Page } from "playwright-core";
import { PICK_DIGESTS } from "./fixture-picks.ts";
import { open, settled, shortControls, shows, until } from "./browser-page.ts";
import { browserSuite, LAPTOP, PHONE, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const BEFORE = "the clipboard before";

async function openPicks(): Promise<{ page: Page; context: BrowserContext }> {
  const server = await served("picks");
  const { page, context } = await open(
    requireBrowser(),
    server.origin,
    `${server.url}&view=needs`,
    LAPTOP,
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await shows(page, ".pNeeds .need");
  await settled(page);
  return { page, context };
}

function card(page: Page, target: string) {
  return page.locator(".pNeeds .need", { hasText: target });
}

function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function resetClipboard(page: Page): Promise<void> {
  await page.evaluate((text) => navigator.clipboard.writeText(text), BEFORE);
}

function said(page: Page): Promise<string> {
  return page
    .locator(".say")
    .textContent()
    .then((t) => t ?? "");
}

/** Presses j until focus is on the card for `target`. */
async function jTo(page: Page, target: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("j");
    const on = await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    );
    if (on === target) return;
  }
  throw new Error(`j never reached ${target}`);
}

/** Whether each option button of a card is pressed, by its name. */
function pressed(page: Page, target: string, name: string) {
  return card(page, target)
    .locator(".opt", { hasText: name })
    .getAttribute("aria-pressed");
}

/** Waits until the card's current decision is `key`. */
async function currentIs(
  cardOf: ReturnType<typeof card>,
  key: string,
): Promise<void> {
  await until(
    `the current decision is ${key}`,
    async () =>
      (await cardOf.locator(".dec.cur").getAttribute("data-decision")) === key,
  );
}

describe("picking answers on a card", () => {
  browserIt(
    "j, 1, c on a card of one decision copies its recommended option with the digest",
    async () => {
      const { page, context } = await openPicks();
      try {
        await resetClipboard(page);
        await page.keyboard.press("j");
        await page.keyboard.press("1");
        await until(
          "1 picked the recommended option",
          async () => (await pressed(page, "PR #501", "Keep it")) === "true",
        );
        expect(await said(page)).toContain("Picked Keep it for PR #501");
        expect(
          await card(page, "PR #501").locator(".opt").first().textContent(),
        ).toContain("(recommended)");
        await page.keyboard.press("c");
        await until("c copied", async () => (await clipboard(page)) !== BEFORE);
        expect(await clipboard(page)).toBe(
          `answer PRRT_one: approve [${PICK_DIGESTS.one}]`,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a card of two decisions copies one comment that answers both, with h, l, u, r and a held digit",
    async () => {
      const { page, context } = await openPicks();
      try {
        const two = card(page, "PR #502");
        expect(await two.locator(".decCount").textContent()).toBe(
          "2 decisions · 0 picked",
        );
        // The interplay shows beside both decisions it names.
        expect(await two.locator(".interplay").count()).toBe(2);
        await jTo(page, "PR #502");
        // A held digit picks once: the repeat does not pick in the next decision.
        await page.keyboard.down("2");
        await page.keyboard.down("2");
        await page.keyboard.up("2");
        await until(
          "2 picked Remove",
          async () => (await pressed(page, "PR #502", "Remove")) === "true",
        );
        await currentIs(two, "PRRT_table");
        expect(await two.locator('.opt[aria-pressed="true"]').count()).toBe(1);
        await page.keyboard.press("1");
        await until(
          "1 picked Later",
          async () => (await pressed(page, "PR #502", "Later")) === "true",
        );
        expect(await two.locator(".decCount").textContent()).toBe(
          "2 decisions · 2 picked",
        );
        // u clears the last pick and returns to it; h and l move between the decisions.
        await page.keyboard.press("u");
        await until(
          "u cleared Later",
          async () => (await pressed(page, "PR #502", "Later")) === "false",
        );
        await currentIs(two, "PRRT_table");
        await page.keyboard.press("h");
        await currentIs(two, "PRRT_flag");
        await page.keyboard.press("l");
        await page.keyboard.press("1");
        // r beside a pick writes a note; Escape leaves the field and the keys work again.
        await page.keyboard.press("h");
        await page.keyboard.press("r");
        await until("the note field has focus", async () =>
          page
            .evaluate(
              () => document.activeElement?.getAttribute("data-field") ?? "",
            )
            .then((f) => f === "PRRT_flag note"),
        );
        await page.keyboard.type("for one release only");
        await page.keyboard.press("Escape");
        expect(
          await page.evaluate(
            () => document.activeElement?.getAttribute("aria-label") ?? "",
          ),
        ).toBe("PR #502");
        await resetClipboard(page);
        await page.keyboard.press("c");
        await until("c copied", async () => (await clipboard(page)) !== BEFORE);
        expect(await clipboard(page)).toBe(
          [
            `answer PRRT_flag: choose Remove [${PICK_DIGESTS.flag}]`,
            "note PRRT_flag: for one release only",
            "",
            `answer PRRT_table: approve [${PICK_DIGESTS.table}]`,
          ].join("\n"),
        );
        // Picks are kept in this browser: a reload loses none of them.
        await page.reload();
        await shows(page, ".pNeeds .need");
        await until(
          "the picks came back",
          async () => (await pressed(page, "PR #502", "Remove")) === "true",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a decision framed again drops its pick and says so",
    async () => {
      const { page, context } = await openPicks();
      try {
        await jTo(page, "PR #501");
        await page.keyboard.press("2");
        await until(
          "2 picked Remove it",
          async () => (await pressed(page, "PR #501", "Remove it")) === "true",
        );
        const reframed = "0f0f0f0f0f0f";
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const one = body.value.line.needs.find(
            (n: { pr: number }) => n.pr === 501,
          );
          one.decisions[0].digest = reframed;
          await route.fulfill({ json: body });
        });
        await page.reload();
        await shows(page, ".pNeeds .need");
        const row = card(page, "PR #501").locator(".dec");
        await until("the row says the pick was dropped", async () =>
          ((await row.textContent()) ?? "").includes(
            "your pick of Remove it was dropped",
          ),
        );
        expect(
          await card(page, "PR #501")
            .locator('.opt[aria-pressed="true"]')
            .count(),
        ).toBe(0);
        await resetClipboard(page);
        await jTo(page, "PR #501");
        await page.keyboard.press("c");
        await until("c copied", async () => (await clipboard(page)) !== BEFORE);
        // Nothing of the earlier framing is sent with the new digest, and no approval of a framing the person never answered.
        expect(await clipboard(page)).toBe("answer PRRT_one: ");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a guarded pick copies only on the second step, from the key, the button and the palette",
    async () => {
      const { page, context } = await openPicks();
      const guarded = card(page, "PR #1300");
      const expected = `answer PRRT_drop: approve [${PICK_DIGESTS.drop}]`;
      try {
        await jTo(page, "PR #1300");
        // With nothing picked, a guarded recommendation copies only the starting line.
        await resetClipboard(page);
        await page.keyboard.press("c");
        await until("c copied", async () => (await clipboard(page)) !== BEFORE);
        expect(await clipboard(page)).toBe("answer PRRT_drop: ");
        await page.keyboard.press("1");

        // The key: the first c shows what it approves, the second copies.
        await resetClipboard(page);
        await page.keyboard.press("c");
        await shows(page, ".pNeeds .guard");
        expect(await guarded.locator(".guard").textContent()).toContain(
          "Do not drop — changes: the table stays until the next release; costs: its storage for one more release",
        );
        // The first step said what comes first instead of copying.
        expect(await said(page)).toContain("Check first");
        expect(await clipboard(page)).toBe(BEFORE);
        // The first step ends when the card loses focus.
        await page.keyboard.press("k");
        await until(
          "the step ended",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        await jTo(page, "PR #1300");
        await page.keyboard.press("c");
        await shows(page, ".pNeeds .guard");
        // ... and when a pick changes.
        await page.keyboard.press("2");
        await until(
          "the pick change ended the step",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        await page.keyboard.press("1");
        await page.keyboard.press("c");
        await shows(page, ".pNeeds .guard");
        await page.keyboard.press("c");
        await until("c copied", async () => (await clipboard(page)) !== BEFORE);
        expect(await clipboard(page)).toBe(expected);

        // The button.
        await resetClipboard(page);
        const copy = guarded.getByRole("button", {
          name: "Copy the answers for PR #1300",
        });
        await copy.click();
        await shows(page, ".pNeeds .guard");
        // The first step said what comes first instead of copying.
        expect(await said(page)).toContain("Check first");
        expect(await clipboard(page)).toBe(BEFORE);
        await guarded
          .getByRole("button", {
            name: "Confirm and copy the answers for PR #1300",
          })
          .click();
        await until(
          "Confirm copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(expected);

        // The palette.
        await resetClipboard(page);
        for (const step of ["first", "second"]) {
          await page.keyboard.press("Control+k");
          await page.keyboard.type("answers #1300");
          await page.keyboard.press("Enter");
          if (step === "first") {
            await shows(page, ".pNeeds .guard");
            // The first step said what comes first instead of copying.
            expect(await said(page)).toContain("Check first");
            expect(await clipboard(page)).toBe(BEFORE);
          }
        }
        await until(
          "the palette copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(expected);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "every pick can be made by pointer alone, on a phone",
    async () => {
      const server = await served("picks");
      const context = await requireBrowser().newContext({
        viewport: PHONE,
        hasTouch: true,
        isMobile: true,
      });
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        const page = await context.newPage();
        await page.goto(`${server.url}&view=needs`);
        await shows(page, ".pNeeds .need");
        await settled(page);
        await resetClipboard(page);
        const two = card(page, "PR #502");
        // No number is shown on a phone: an option is a row to tap.
        expect(await two.locator(".optNum").first().isVisible()).toBe(false);
        await two.getByRole("button", { name: "1 other option" }).first().tap();
        await two.locator(".opt", { hasText: "Remove" }).tap();
        await until(
          "the tap picked Remove",
          async () => (await pressed(page, "PR #502", "Remove")) === "true",
        );
        expect(await said(page)).toContain("Picked Remove for decision 1 of 2");
        await two.locator(".opt", { hasText: "Later" }).tap();
        await two.getByRole("button", { name: "Undo last pick" }).tap();
        await until(
          "Undo cleared Later",
          async () => (await pressed(page, "PR #502", "Later")) === "false",
        );
        await two.locator(".opt", { hasText: "Later" }).tap();
        await two
          .locator('.dec[data-decision="PRRT_flag"]')
          .getByRole("button", { name: "Add a note" })
          .tap();
        await page.keyboard.type("for one release only");
        expect(await shortControls(page)).toEqual([]);
        await two
          .getByRole("button", { name: "Copy the answers for PR #502" })
          .tap();
        await until(
          "the tap copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(
          [
            `answer PRRT_flag: choose Remove [${PICK_DIGESTS.flag}]`,
            "note PRRT_flag: for one release only",
            "",
            `answer PRRT_table: approve [${PICK_DIGESTS.table}]`,
          ].join("\n"),
        );

        // A guarded pick, confirmed by a tap.
        await page
          .getByRole("button", { name: /Show all/ })
          .first()
          .tap();
        const guarded = card(page, "PR #1300");
        await guarded.getByRole("button", { name: "1 other option" }).tap();
        await guarded
          .locator(".opt", { hasText: "the table and its rows are deleted" })
          .tap();
        await resetClipboard(page);
        await guarded
          .getByRole("button", { name: "Copy the answers for PR #1300" })
          .tap();
        await shows(page, ".pNeeds .guard");
        expect(await guarded.locator(".guard").textContent()).toContain(
          "no rollback once deployed",
        );
        // The first step said what comes first instead of copying.
        expect(await said(page)).toContain("Check first");
        expect(await clipboard(page)).toBe(BEFORE);
        expect(await shortControls(page)).toEqual([]);
        await guarded
          .getByRole("button", {
            name: "Confirm and copy the answers for PR #1300",
          })
          .tap();
        await until(
          "Confirm copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(
          `answer PRRT_drop: choose Drop [${PICK_DIGESTS.drop}]`,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a held c takes only the first step of a guarded copy",
    async () => {
      const { page, context } = await openPicks();
      const guarded = card(page, "PR #1300");
      try {
        await jTo(page, "PR #1300");
        await page.keyboard.press("1");
        await resetClipboard(page);
        await page.keyboard.down("c");
        await shows(page, ".pNeeds .guard");
        // The key repeats while it is held: the repeats are not a second press.
        await page.keyboard.down("c");
        await page.keyboard.down("c");
        await page.keyboard.up("c");
        expect(await guarded.locator(".guard").count()).toBe(1);
        expect(await said(page)).toContain("Check first");
        expect(await clipboard(page)).toBe(BEFORE);
        await page.keyboard.press("c");
        await until(
          "the second press copied",
          async () => (await clipboard(page)) !== BEFORE,
        );
        expect(await clipboard(page)).toBe(
          `answer PRRT_drop: approve [${PICK_DIGESTS.drop}]`,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the palette ends a card's first step when it runs nothing on that card",
    async () => {
      const { page, context } = await openPicks();
      const guarded = card(page, "PR #1300");
      try {
        await jTo(page, "PR #1300");
        await page.keyboard.press("1");
        await page.keyboard.press("c");
        await shows(page, ".pNeeds .guard");
        // Another card's command, copied from the palette, leaves focus on this card.
        await page.keyboard.press("Control+k");
        await page.keyboard.type("answer line #502");
        await page.keyboard.press("Enter");
        await until(
          "the step ended",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
        expect(
          await page.evaluate(
            () =>
              document.activeElement
                ?.closest("[data-card]")
                ?.getAttribute("aria-label") ?? "",
          ),
        ).toBe("PR #1300");
        // So one c is a first step again, not a copy.
        await resetClipboard(page);
        await page.keyboard.press("c");
        await shows(page, ".pNeeds .guard");
        expect(await clipboard(page)).toBe(BEFORE);
        // A palette closed with nothing run ends it too.
        await page.keyboard.press("Control+k");
        await page.keyboard.press("Escape");
        await until(
          "the step ended on Escape",
          async () => (await guarded.locator(".guard").count()) === 0,
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a palette copy whose card is gone by the time its view is drawn says nothing was copied",
    async () => {
      const { page, context } = await openPicks();
      try {
        await jTo(page, "PR #1300");
        await page.keyboard.press("1");
        await page.keyboard.press("g");
        await page.keyboard.press("q");
        await shows(page, ".pQueue");
        await resetClipboard(page);
        // The palette lists the card; the next read no longer holds it.
        await page.keyboard.press("Control+k");
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.value.line.needs = body.value.line.needs.filter(
            (n: { pr: number }) => n.pr !== 1300,
          );
          await route.fulfill({ json: body });
        });
        const read = page.waitForResponse((r) => r.url().includes("/state?"));
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await read;
        await page.keyboard.type("answers #1300");
        await page.keyboard.press("Enter");
        await until("the page said nothing was copied", async () =>
          (await said(page)).startsWith("Not copied: PR #1300"),
        );
        expect(await clipboard(page)).toBe(BEFORE);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

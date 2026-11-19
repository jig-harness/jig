/**
 * The host's load at the top of Running, in a real browser against the real
 * server: the factor and the gauge that binds, every gauge against its own
 * line with nothing to open, a gauge past its line and one not read, and the
 * holds and reservations in one fold titled with its count. All of it holds
 * at 1440, 390 and 320 pixels, the phones with touch and no hover. How the
 * browser is found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Browser, Page } from "playwright-core";
import {
  open,
  type Served,
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

const SMALL_PHONE = { width: 320, height: 568 };

const SIZES = [
  ["1440", LAPTOP, false],
  ["390", PHONE, true],
  ["320", SMALL_PHONE, true],
] as const;

/** Running at a size: a phone has touch and no hover. */
async function runningAt(
  browser: Browser,
  server: Served,
  viewport: { width: number; height: number },
  touch: boolean,
  forcedColors: "active" | "none" = "none",
) {
  const context = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch,
    forcedColors,
  });
  const page = await context.newPage();
  // The forge is not read here: a pull request's identity stands on the line alone.
  await page.route("**/pr?*", (route) => route.fulfill({ status: 503 }));
  await page.goto(`${server.url}&view=running`);
  await shows(page, ".pLine .load .gRow");
  await settled(page);
  return { page, context };
}

/** Each gauge row as drawn: its name, classes, text and the boxes of its bar's parts. */
function rowsOf(page: Page) {
  return page.locator(".pLine .load .gRow").evaluateAll((rows) =>
    rows.map((row) => {
      const box = (selector: string) => {
        const found = row.querySelector(selector);
        if (found === null) return null;
        const r = found.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const name = row.querySelector(".gName .bareWord");
      return {
        name: name?.textContent ?? "",
        weight: Number(name === null ? 0 : getComputedStyle(name).fontWeight),
        classes: row.className,
        text: row.textContent ?? "",
        pct: row.querySelector(".gPct")?.textContent ?? "",
        label: row.querySelector(".gBar")?.getAttribute("aria-label") ?? "",
        track: box(".gTrack"),
        trackBorder: getComputedStyle(row.querySelector(".gTrack") ?? row)
          .borderTopStyle,
        fill: box(".gFill"),
        past: box(".gPast"),
        line: box(".gLine"),
        lineBorder: getComputedStyle(row.querySelector(".gLine") ?? row)
          .borderLeftWidth,
        reads: box(".gReads"),
        bar: box(".gBar"),
      };
    }),
  );
}

function sideScroll(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

describe("the load", () => {
  for (const [name, viewport] of [
    ["laptop", LAPTOP],
    ["phone", PHONE],
  ] as const)
    browserIt(
      `leads Running with the load factor and what binds, every gauge open, on a ${name}`,
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
          expect(await head.locator(".loadTitle").textContent()).toBe(
            "Load 82%, memory binds",
          );
          const load = page.locator(".pLine .load");
          expect(await load.textContent()).toContain(
            "The fullest gauge against its own line, not a sum.",
          );
          expect(
            await page.locator(".pLine .load .gRow .gName").allTextContents(),
          ).toEqual([
            "Memory binds",
            "Processors",
            "Test lock",
            "Disk",
            "Forge budget",
            "Accounts",
          ]);
          // It sits above the accounts.
          const [box, account] = await Promise.all([
            load.boundingBox(),
            page.locator(".pLine .acct").first().boundingBox(),
          ]);
          expect((box?.y ?? 0) < (account?.y ?? 0)).toBe(true);
          await load
            .getByRole("button", {
              name: "Would have held 1 launch · reservations",
            })
            .click();
          await until("the holds and reservations open", async () =>
            (
              (await page.locator(".pLine .load .gpanel").textContent()) ?? ""
            ).includes("would hold the pickup: memory binds"),
          );
          expect(
            await page.locator(".pLine .load .gpanel").textContent(),
          ).toContain("2.6 GiB, measured over 12 samples");
          await settled(page);
          await shoot(page, `load-${name}`);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

  for (const [name, viewport, touch] of SIZES)
    browserIt(
      `shows every gauge against its line, the one past it binding and the one not read, at ${name}`,
      async () => {
        const server = await served("overload");
        const { page, context } = await runningAt(
          requireBrowser(),
          server,
          viewport,
          touch,
        );
        try {
          expect(
            await page.evaluate(() => matchMedia("(hover: hover)").matches),
          ).toBe(!touch);
          expect(
            await page.locator(".pLine .loadHead .loadTitle").textContent(),
          ).toBe("Load 150%, processors binds");
          const rows = await rowsOf(page);
          expect(rows.map((r) => r.pct)).toEqual([
            "96%",
            "150%",
            "50%",
            "not read",
            "31%",
            "40%",
          ]);
          // Every read gauge's fill shows with nothing opened, each bar with its line marked.
          for (const row of rows) {
            expect({ name: row.name, line: row.line !== null }).toEqual({
              name: row.name,
              line: true,
            });
            expect(row.lineBorder).toBe("2px");
            if (!row.classes.includes("unread"))
              expect({
                name: row.name,
                filled: (row.fill?.right ?? 0) - (row.fill?.left ?? 0) > 4,
              }).toEqual({ name: row.name, filled: true });
          }
          if (!touch)
            // The whole breakdown is in the first screen of a laptop.
            expect(
              Math.max(...rows.map((r) => r.bar?.bottom ?? Infinity)),
            ).toBeLessThanOrEqual(viewport.height);
          // The lines sit two thirds along their bars.
          for (const row of rows) {
            const track = row.track ?? { left: 0, right: 0 };
            const at =
              ((row.line?.left ?? 0) + 1 - track.left) /
              (track.right - track.left);
            expect(at).toBeCloseTo(2 / 3, 1);
          }
          // Processors binds, past its line: bold, tagged, its fill running on past the line.
          const processors = rows[1];
          expect(processors?.classes).toContain("binds");
          expect(processors?.classes).toContain("over");
          expect(processors?.text).toContain("binds");
          expect(processors?.text).toContain("over its line");
          expect(processors?.weight).toBeGreaterThanOrEqual(700);
          expect(processors?.label).toBe(
            "Processors at 150% of its line, over it",
          );
          expect(
            Math.abs(
              (processors?.past?.left ?? 0) - (processors?.fill?.right ?? 0),
            ),
          ).toBeLessThanOrEqual(1);
          expect(
            (processors?.past?.right ?? 0) - (processors?.past?.left ?? 0),
          ).toBeGreaterThan(4);
          // Memory is near its line but under it: neither binding nor over.
          expect(rows[0]?.classes).not.toContain("binds");
          expect(rows[0]?.past).toBeNull();
          expect(rows[0]?.text).not.toContain("over its line");
          // The disk read nothing: an empty dashed bar and its reason in place of a figure.
          const disk = rows[3];
          expect(disk?.classes).toContain("unread");
          expect(disk?.text).toContain(
            "free space not read (df did not answer within 2 s)",
          );
          expect(disk?.label).toBe("Disk not read");
          expect((disk?.fill?.right ?? 0) - (disk?.fill?.left ?? 1)).toBe(0);
          expect(disk?.past).toBeNull();
          expect(disk?.trackBorder).toBe("dashed");
          // Each row still says its line.
          expect(rows[1]?.text).toContain("line: 0.9 per core");
          // On a phone what it read moves under the bar; on a laptop it sits beside it.
          for (const row of rows)
            if (touch)
              expect(row.reads?.top ?? 0).toBeGreaterThanOrEqual(
                (row.bar?.bottom ?? 0) - 1,
              );
            else expect(row.reads?.top ?? 0).toBeLessThan(row.bar?.bottom ?? 0);
          expect(await sideScroll(page)).toBeLessThanOrEqual(0);

          // The holds and reservations open from one fold titled with its count, by a tap on a phone.
          const fold = page.getByRole("button", {
            name: "Would have held 2 launches · reservations",
          });
          expect(await fold.getAttribute("aria-expanded")).toBe("false");
          if (touch) await page.locator(".load .ghead").tap();
          else await fold.click();
          await until(
            "the fold opens",
            async () => (await fold.getAttribute("aria-expanded")) === "true",
          );
          const panel = page.locator(".pLine .load .gpanel");
          expect(await panel.textContent()).toContain(
            "would hold the drive: processors binds: load 21.6 on 16 cores, at its line of 0.9 per core",
          );
          expect(await panel.textContent()).toContain("Reserves · pickup");
          // Each hold's words run across the fold, not down a sliver beside its target.
          const narrowest = Math.min(
            ...(await panel
              .locator("dd")
              .evaluateAll((all) =>
                all.map((dd) => dd.getBoundingClientRect().width),
              )),
          );
          expect(narrowest).toBeGreaterThan(160);
          expect(await sideScroll(page)).toBeLessThanOrEqual(0);
          if (touch) {
            const disc = await fold.boundingBox();
            expect(Math.min(disc?.width ?? 0, disc?.height ?? 0)).toBe(44);
            expect(await shortControls(page)).toEqual([]);
          }
          await settled(page);
          await shoot(page, `load-over-${name}`);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );

  browserIt(
    "keeps every bar's line and the unread gauge's dashed edge under forced colours",
    async () => {
      const server = await served("overload");
      const { page, context } = await runningAt(
        requireBrowser(),
        server,
        PHONE,
        true,
        "active",
      );
      try {
        expect(
          await page.evaluate(
            () => matchMedia("(forced-colors: active)").matches,
          ),
        ).toBe(true);
        const rows = await rowsOf(page);
        expect(rows.map((r) => r.lineBorder)).toEqual(rows.map(() => "2px"));
        expect(rows[3]?.trackBorder).toBe("dashed");
        const fills = await page
          .locator(".pLine .load .gRow:not(.unread) .gFill")
          .evaluateAll((all) =>
            all.map((fill) => getComputedStyle(fill).backgroundColor),
          );
        expect(fills.length).toBe(5);
        for (const fill of fills) expect(fill).not.toBe("rgba(0, 0, 0, 0)");
        expect(rows[1]?.text).toContain("over its line");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

browserIt(
  "folding accounts preserves the Running repository filter and its counts",
  async () => {
    const server = await served("loud");
    const { page, context } = await open(
      requireBrowser(),
      server.origin,
      `${server.url}&view=running`,
      LAPTOP,
    );
    try {
      const chips = page.locator('[data-facet="repo"] .facetChip');
      await chips.first().waitFor();
      expect(await chips.count()).toBeGreaterThan(1);
      await chips.first().click();
      const status = page.locator(".facetShowing");
      const before = await status.textContent();
      expect(before).toMatch(/Showing [1-9]\d* of [1-9]\d*/);
      await page
        .getByRole("button", { name: "Accounts and their slots" })
        .click();
      expect(await chips.first().getAttribute("aria-pressed")).toBe("true");
      expect(await status.textContent()).toBe(before);
    } finally {
      await context.close();
    }
  },
  TIMEOUT,
);

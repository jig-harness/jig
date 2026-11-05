/**
 * What each browser test file sets up once, at its top level: Chromium launched
 * or the reason it was not, the fixture servers its checks start, and both
 * closed after the file's checks.
 */
import { afterAll, expect, it } from "bun:test";
import { type Browser, chromium, type Page } from "playwright-core";
import { Defect } from "../plugin/shared/errors.ts";
import { chromiumPath, type Served, start, until } from "./browser-page.ts";
import type { ScenarioId } from "./fixtures.ts";
import { FIXTURE_TOKEN } from "./serve-fixture.ts";

export const TOKEN = FIXTURE_TOKEN;
export const TIMEOUT = 60_000;

export const PHONE = { width: 390, height: 844 };
export const LAPTOP = { width: 1440, height: 900 };

export async function browserSuite() {
  let browser: Browser | undefined;
  let missing = "";
  const executablePath = chromiumPath();
  if (executablePath === null) missing = "no Chromium in the Playwright cache";
  else
    try {
      browser = await chromium.launch({ executablePath, headless: true });
    } catch (error) {
      missing =
        error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
    }

  afterAll(async () => {
    await browser?.close();
  });

  if (!browser && process.env.JIG_REQUIRE_BROWSER === "1")
    it("a browser is available where one is required", () => {
      // JIG_REQUIRE_BROWSER=1 makes a missing browser fail instead of skip; the
      // failure names why none was found.
      expect({ chromium: missing }).toEqual({ chromium: "found" });
    });
  else if (!browser)
    console.warn(
      `dispatch-dashboard browser checks: skipped (${missing}). Set JIG_REQUIRE_BROWSER=1 to make this an error.`,
    );

  /** The browser, inside a check that only runs when there is one; called elsewhere, a bug. */
  const requireBrowser = (): Browser => {
    if (browser === undefined) throw new Defect("no browser");
    return browser;
  };

  const running = new Map<ScenarioId, Promise<Served>>();
  const served = (scenario: ScenarioId): Promise<Served> => {
    const known = running.get(scenario);
    if (known !== undefined) return known;
    const started = start(scenario);
    running.set(scenario, started);
    return started;
  };

  afterAll(async () => {
    for (const server of running.values()) await (await server).stop();
  });

  return {
    browserIt: browser ? it : it.skip,
    requireBrowser,
    served,
    executablePath,
  };
}

/** Opens a view by its tab, as a person does. */
export async function openView(page: Page, label: string): Promise<void> {
  const tab = page.locator(".viewTab", { hasText: label });
  await tab.click();
  await until(
    `the ${label} tab is current`,
    async () => (await tab.getAttribute("aria-current")) === "page",
  );
}

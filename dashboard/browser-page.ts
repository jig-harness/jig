/**
 * What the browser checks share: finding Chromium, a fixture server in a
 * subprocess, a watched page, waiting by polling with a deadline, and the
 * images `DASHBOARD_SHOTS` asks for.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { expectSpawnExited } from "../lib/test-helpers/expect-spawn-exit.ts";
import type { ScenarioId } from "./fixtures.ts";

/** A fixture server that did not come up, or a wait that ran out. */
class BrowserCheckError extends Error {
  override name = "BrowserCheckError";
}

const SERVE = join(import.meta.dir, "serve-fixture.ts");
const DEADLINE_MS = 15_000;

export function chromiumPath(): string | null {
  // JIG_CHROMIUM is this suite's own override; JIG_TEST_CHROMIUM is the one CI
  // already supplies for the browser checks it runs.
  for (const name of ["JIG_CHROMIUM", "JIG_TEST_CHROMIUM"]) {
    const named = process.env[name];
    if (named !== undefined && named !== "") return named;
  }
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).sort().reverse()) {
    const path = join(cache, dir, "chrome-linux64/chrome");
    if (dir.startsWith("chromium-") && existsSync(path)) return path;
  }
  return null;
}

// ---------- the server ----------

export interface Served {
  url: string;
  origin: string;
  /** Stops it, once, and asserts it exited cleanly. */
  stop(): Promise<void>;
}

export async function start(scenario: ScenarioId): Promise<Served> {
  const child = Bun.spawn(["bun", SERVE, "--scenario", scenario], {
    env: { ...process.env, TZ: "UTC" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let printed = "";
  const deadline = Date.now() + DEADLINE_MS;
  while (!printed.includes("\n") && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({
        value: undefined,
        done: true,
      })),
    ]);
    if (done) break;
    printed += decoder.decode(value);
  }
  const url = printed.trim();
  if (!url.startsWith("http")) {
    // The child may still be running, so end it before reading what it said:
    // its stderr closes only when it exits.
    child.kill("SIGKILL");
    await child.exited;
    const said = await Promise.race([
      new Response(child.stderr).text(),
      Bun.sleep(2000).then(() => ""),
    ]);
    throw new BrowserCheckError(
      `the fixture server for ${scenario} printed no address: ${printed} ${said}`,
    );
  }
  reader.releaseLock();
  let stopped = false;
  return {
    url,
    origin: new URL(url).origin,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      await expectSpawnExited(child, 0, `the ${scenario} fixture server`);
    },
  };
}

// ---------- one page, and what it did ----------

export interface Watched {
  page: Page;
  context: BrowserContext;
  otherOrigins: string[];
  /** Every request the page made, from before it navigated. */
  requests: string[];
  problems: string[];
}

export async function open(
  browser: Browser,
  origin: string,
  url: string,
  viewport: { width: number; height: number },
  scheme: "light" | "dark" = "light",
  expected: RegExp[] = [],
): Promise<Watched> {
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  const watched: Watched = {
    page,
    context,
    otherOrigins: [],
    requests: [],
    problems: [],
  };
  page.on("request", (request) => {
    const requested = request.url();
    watched.requests.push(requested);
    if (!requested.startsWith(origin) && !requested.startsWith("data:"))
      watched.otherOrigins.push(requested);
  });
  page.on("pageerror", (error) => watched.problems.push(`thrown: ${error}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (!expected.some((pattern) => pattern.test(text)))
      watched.problems.push(`console: ${text}`);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `content security policy: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  await page.goto(url);
  return watched;
}

export const REFUSAL_LOAD = /status of 403/;
export const CONNECTION_LOST = /ERR_CONNECTION_REFUSED/;

/** Waits by polling, up to a deadline, until a selector shows. */
export async function shows(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .waitFor({ state: "visible", timeout: DEADLINE_MS });
}

/** Waits by polling, up to a deadline, until a check holds; fails with what it last read. */
export async function until(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new BrowserCheckError(`timed out waiting until ${what}`);
}

/** Waits until the page has its answers and has laid out the rows it holds. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

/** The controls a phone's thumb reaches that are shorter than 44 px. */
export function shortControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'a, button, input, select, textarea, summary, [role="combobox"]',
      ),
    ]
      .filter((element) => {
        if (element.closest("[aria-hidden='true']") !== null) return false;
        if (element.classList.contains("clip")) return false;
        if (element.getAttribute("aria-hidden") === "true") return false;
        const box = element.getBoundingClientRect();
        return box.width > 1 && box.height > 1 && box.height < 44;
      })
      .map(
        (element) =>
          `${element.tagName} ${element.className}: ${element.textContent?.slice(0, 30)} ${element.getBoundingClientRect().height}`,
      ),
  );
}

export function bottomOf(page: Page, selector: string): Promise<number> {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => element.getBoundingClientRect().bottom);
}

/** Stops the server under an open page, and waits for the page to say so. */
export async function loseServer(page: Page, server: Served): Promise<void> {
  await shows(page, ".pNeeds");
  // Both reads answered first, so what the page keeps includes the log.
  await settled(page);
  await server.stop();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await shows(page, ".banner");
}

/** Writes the page's image when `DASHBOARD_SHOTS` names a directory. */
export async function shoot(page: Page, name: string): Promise<void> {
  const shots = process.env.DASHBOARD_SHOTS;
  if (shots === undefined) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

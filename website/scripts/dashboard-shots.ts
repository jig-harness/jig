/**
 * Draws the dispatch dashboard's screenshots (public/shots/dashboard-*.webp):
 * the real page on its Needs you view, served by the real server over the
 * dashboard's `loud` fixture with its clock held still, so the shots show
 * what the plugin serves and never a person's own data.
 *
 *   bun scripts/dashboard-shots.ts
 *
 * Needs Chrome (through playwright-core, as the browser tests do) and `cwebp`
 * on the path, as the plates do. Each shot is taken at twice the pixel
 * density, on a desk and on a phone, in both themes, so the site shows the
 * one that matches the reader's theme. Run it again after a change to the
 * dashboard page or its `loud` fixture.
 *
 * The fixture server runs as a child, `bun dashboard/serve-fixture.ts`, rather
 * than through an import: nothing outside website/ joins the site's build by
 * this script, which the build never runs.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("../public/shots/", import.meta.url));
const DEADLINE_MS = 15_000;

/** A fixture server that printed no address, or a shot that was not written. */
class ShotError extends Error {
  override name = "ShotError";
}

// The viewport each shot is taken at, and the width its file is written at:
// the shot's largest rendered size, at twice the pixel density.
const VIEWS = [
  { name: "desk", viewport: { width: 1440, height: 960 }, width: 1800 },
  { name: "phone", viewport: { width: 390, height: 844 }, width: 600 },
] as const;
const SCHEMES = ["light", "dark"] as const;

/** The fixture server's address, from the first line it prints. */
async function address(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + DEADLINE_MS;
  let printed = "";
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
  reader.releaseLock();
  const url = printed.trim();
  if (!url.startsWith("http"))
    throw new ShotError(
      `the dashboard's fixture server printed no address: ${printed}`,
    );
  return url;
}

// The server serves the built page, not dashboard/src: a stale bundle would
// redraw every shot from the previous UI and report success.
const built = spawnSync("bun", ["dashboard/build.ts", "--check"], {
  cwd: repo,
  stdio: "inherit",
});
if (built.status !== 0)
  throw new ShotError(
    "the dashboard's built page is stale: run `bun dashboard/build.ts` from the repository root, then run this again",
  );

const work = mkdtempSync(join(tmpdir(), "dashboard-shots-"));
const server = Bun.spawn(
  ["bun", "dashboard/serve-fixture.ts", "--scenario", "loud"],
  {
    cwd: repo,
    env: { ...process.env, TZ: "UTC" },
    stdout: "pipe",
    stderr: "inherit",
  },
);
try {
  const url = await address(server.stdout);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    mkdirSync(out, { recursive: true });
    for (const view of VIEWS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({
          viewport: view.viewport,
          deviceScaleFactor: 2,
          colorScheme: scheme,
        });
        const page = await context.newPage();
        await page.goto(`${url}&view=needs`, { waitUntil: "networkidle" });
        await page
          .locator(".pNeeds")
          .waitFor({ state: "visible", timeout: DEADLINE_MS });
        const png = join(work, `${view.name}-${scheme}.png`);
        await page.screenshot({ path: png });
        await context.close();
        const target = join(out, `dashboard-${view.name}-${scheme}.webp`);
        const webp = spawnSync(
          "cwebp",
          [
            "-quiet",
            "-q",
            "80",
            "-resize",
            String(view.width),
            "0",
            png,
            "-o",
            target,
          ],
          { stdio: "inherit" },
        );
        if (webp.status !== 0)
          throw new ShotError(`cwebp failed for ${target}`);
        console.log(`wrote ${target}`);
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await server.exited;
  rmSync(work, { recursive: true, force: true });
}

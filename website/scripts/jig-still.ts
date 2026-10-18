/**
 * Draws the still that stands in for the home page's jig model
 * (public/plates/jig-still.webp): the model's own first frame, captured
 * from a running site, so the still and the model's first frame are one
 * picture and the model takes over unseen.
 *
 *   bun scripts/jig-still.ts [url]      (default http://127.0.0.1:4321/)
 *
 * Needs Chrome (through playwright-core, as the browser tests do), ImageMagick's `magick` and
 * `cwebp` on the path, as the plates do. The page is opened wide, light,
 * with white paper and black ink, at twice the pixel density; the canvas
 * is captured once the model has drawn, and converted to a plate mask the
 * way design/website.md § Drawing a plate describes.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:4321/";
const out = fileURLToPath(
  new URL("../public/plates/jig-still.webp", import.meta.url),
);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const host = page.locator("[data-jig-model][data-ready]");
  await host.waitFor({ state: "attached", timeout: 30_000 });
  await page.addStyleTag({
    content: `:root { --bg: #fff !important; --ink: #000 !important; }
      html, body { background: #fff !important; }
      .strip, header, .hero > :not(.hero-plate) { visibility: hidden !important; }`,
  });
  // The model re-reads its colors when the theme attribute changes.
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(400);
  const canvas = host.locator("canvas");
  const dir = mkdtempSync(join(tmpdir(), "jig-still-"));
  try {
    const png = join(dir, "still.png");
    await canvas.screenshot({ path: png, omitBackground: false });
    // Black ink on white to a mask: the darkness becomes the alpha.
    const mask = join(dir, "mask.png");
    const steps = [
      [
        "magick",
        png,
        "-colorspace",
        "Gray",
        "(",
        "+clone",
        "-negate",
        ")",
        "-alpha",
        "off",
        "-compose",
        "CopyOpacity",
        "-composite",
        "-fill",
        "black",
        "-colorize",
        "100",
        "-background",
        "none",
        `png32:${mask}`,
      ],
      [
        "cwebp",
        "-quiet",
        "-q",
        "70",
        "-alpha_q",
        "80",
        "-exact",
        mask,
        "-o",
        out,
      ],
    ];
    const failed = steps.find(([cmd, ...args]) => {
      const r = spawnSync(cmd, args, { stdio: "inherit" });
      if (r.status === 0) return false;
      console.error(`${cmd} exited with ${r.status}`);
      return true;
    });
    if (failed) {
      process.exitCode = 1;
    } else {
      const box = await canvas.boundingBox();
      console.log(`wrote ${out} from a ${box?.width}x${box?.height} canvas`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}

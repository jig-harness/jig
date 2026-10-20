import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { chrome, onePixel, required } from "./support.ts";

// CI without Chromium still runs the static and merge tests in handback.test.ts.
test.skipIf(!chrome && !required)(
  "installed-copy landing CLI rejects raw delivery and renders a clean delivery",
  () => {
    expect(chrome).toBeTruthy();
    const scratch = mkdtempSync(join(tmpdir(), "jig-browser-integration-"));
    const consumer = join(scratch, "consumer");
    const cache = join(scratch, "plugin-cache");
    mkdirSync(consumer);
    cpSync(resolve(import.meta.dir, "../../.."), cache, {
      recursive: true,
      filter: (path) =>
        !path.endsWith("node_modules") && !path.endsWith("__tests__"),
    });
    const script = join(
      cache,
      "skills/design-brief-builder/scripts/handback.ts",
    );
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("JIG_")),
      ),
      JIG_CONSUMER_ROOT: consumer,
      JIG_USER_LAYER: "off",
    };
    const run = (args: string[], expected = 0) => {
      const result = Bun.spawnSync(args, {
        cwd: consumer,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      });
      expectSpawnExit(result, expected);
      return result.stdout.toString().trim();
    };
    const write = (path: string, text: string | Buffer) => {
      const target = join(consumer, path);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, text);
    };
    const png = onePixel([255, 255, 255]);
    try {
      expect(existsSync(join(cache, "node_modules"))).toBe(false);
      run(["git", "init"]);
      run(["git", "config", "user.email", "test@example.test"]);
      run(["git", "config", "user.name", "Test"]);
      write(
        ".config/jig.yaml",
        JSON.stringify({
          design_brief: {
            handback: {
              widths: [390, 1280],
              rubric: "rubric.md",
              scorecard: "scorecard.md",
              browser_executable: chrome,
              forbidden_terms: ["retired phrase"],
            },
          },
        }),
      );
      write("rubric.md", "Review the desktop and mobile scenarios.\n");
      write("scorecard.md", "Bar outcome: pass\n");
      write("bundle/README.md", "Bar outcome: pass\n");
      write(
        "bundle/design-handback.json",
        JSON.stringify({
          version: 1,
          scenarios: [
            {
              name: "home",
              url: "index.html",
              ready: "body",
              screenshot: "screenshots/home.png",
            },
          ],
        }),
      );
      write(
        "bundle/index.html",
        "<!doctype html><html><body>Previous export</body></html>",
      );
      write("bundle/screenshots/home.png", png);
      write("bundle/screenshots/home-1280.png", png);
      run(["git", "add", "."]);
      run(["git", "commit", "-m", "Previous export"]);
      const ours = run(["git", "rev-parse", "HEAD"]);
      write(
        "bundle/index.html",
        '<!doctype html><html><body><div style="width:1800px">retired&#32;phrase</div><img src="https://example.invalid/external.png"><script>console.error("raw delivery error")</script></body></html>',
      );
      write("bundle/uploads/uploads/brief.md", "nested upload");
      write("bundle/uploads/brief-a1b2c3d4.md", "duplicate upload");
      run(["git", "add", "."]);
      run(["git", "commit", "-m", "Raw returned export"]);
      const raw = run(["git", "rev-parse", "HEAD"]);
      write("bundle/README.md", `Bar outcome: pass\nExport base: ${raw}\n`);
      write(
        "bundle/handback-report.json",
        JSON.stringify({
          version: 1,
          ours,
          exportBase: raw,
          previousExportBase: ours,
          provenance: "raw export",
          conflicts: [],
          regressions: [],
        }),
      );
      for (const input of ["index.html", "design-handback.json"])
        utimesSync(join(consumer, "bundle", input), 20, 20);
      for (const name of ["home.png", "home-1280.png"])
        utimesSync(join(consumer, "bundle/screenshots", name), 10, 10);
      const failed = JSON.parse(
        run([process.execPath, script, "check", "bundle"], 1),
      ) as { failures: string[] };
      for (const diagnostic of [
        "forbidden",
        "nested",
        "duplicate",
        "newer",
        "previous",
        "external request",
        "console error",
        "overflow",
      ])
        expect(
          failed.failures.some((failure) => failure.includes(diagnostic)),
        ).toBe(true);
      expect(
        readFileSync(join(consumer, "bundle/screenshots/home.png")),
      ).toEqual(png);

      write(
        "bundle/index.html",
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>Accepted design</body></html>',
      );
      rmSync(join(consumer, "bundle/uploads"), { recursive: true });
      write(
        "scorecard.md",
        `Bar outcome: pass\nReviewed export base: ${raw}\n`,
      );
      const delivered = onePixel([20, 40, 60]);
      for (const name of ["home.png", "home-1280.png"]) {
        write(`bundle/screenshots/${name}`, delivered);
        utimesSync(join(consumer, "bundle/screenshots", name), 30, 30);
      }
      for (const input of ["index.html", "design-handback.json"])
        utimesSync(join(consumer, "bundle", input), 20, 20);
      const passed = JSON.parse(
        run([process.execPath, script, "check", "bundle"]),
      ) as { failures: string[] };
      expect(passed.failures).toEqual([]);
      expect(
        readFileSync(join(consumer, "bundle/screenshots/home.png")),
      ).toEqual(delivered);
      for (const width of [390, 1280]) {
        const capture = readFileSync(
          join(consumer, `bundle/.handback-render/home-${width}.png`),
        );
        expect(capture.subarray(0, 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect(capture.length).toBeGreaterThan(png.length);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  60_000,
);

/**
 * The page the plugin carries is a fresh build of its source and the pinned
 * packages; `bun dashboard/build.ts` rebuilds it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIcons, buildPage, PAGE_DIR } from "./build.ts";

const root = resolve(import.meta.dir, "..");

test("the built page is a fresh build of its source and the pinned packages", async () => {
  for (const [name, content] of Object.entries(await buildPage()))
    expect({
      name,
      current: readFileSync(join(root, PAGE_DIR, name), "utf8") === content,
    }).toEqual({ name, current: true });
  for (const [name, content] of Object.entries(buildIcons()))
    expect({
      name,
      current: Buffer.from(readFileSync(join(root, PAGE_DIR, name))).equals(
        Buffer.from(content),
      ),
    }).toEqual({ name, current: true });
}, 60_000);

test("an inline script cannot end early, and its licences come from what the bundler read", async () => {
  const files = await buildPage();
  const page = files["index.html"] ?? "";
  // One closing tag for the one script: nothing in the bundle ends it early.
  expect(page.match(/<\/script/gi)?.length).toBe(1);
  expect(page).not.toContain("<!--");
  const licences = files["bundle.LICENSE"] ?? "";
  for (const name of ["react ", "react-dom ", "@tanstack/react-query "])
    expect(licences).toContain(`\n${name}`.trimStart());
  expect(licences).toContain("MIT License");
}, 60_000);

test("both pages name Jig's mark as their icon, inline, so the browser asks the server for none", async () => {
  const mark = readFileSync(
    join(root, "website/public/brand/jig-mark-adaptive.svg"),
    "utf8",
  ).trim();
  const files = await buildPage();
  for (const name of ["index.html", "refused.html"]) {
    const href = /<link rel="icon" href="([^"]*)"/.exec(files[name] ?? "")?.[1];
    expect({ name, icon: href && decodeURIComponent(href) }).toEqual({
      name,
      icon: `data:image/svg+xml,${mark}`,
    });
  }
}, 60_000);

test("the page, and only the page, offers itself as an app, with an icon of every size its manifest declares", async () => {
  const files = await buildPage();
  expect(files["index.html"]).toContain(
    '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">',
  );
  expect(files["index.html"]).toMatch(
    /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/,
  );
  // The page a refused request gets has nothing to install.
  expect(files["refused.html"]).not.toContain('rel="manifest"');

  const manifest = JSON.parse(files["manifest.webmanifest"] ?? "") as {
    start_url: string;
    icons: { src: string; sizes: string }[];
  };
  expect(manifest.start_url).toBe("/");
  const icons = buildIcons();
  for (const icon of manifest.icons) {
    const bytes = icons[icon.src.slice(1)];
    expect({ src: icon.src, present: bytes !== undefined }).toEqual({
      src: icon.src,
      present: true,
    });
    const view = new DataView(
      (bytes ?? new Uint8Array(24)).buffer,
      (bytes ?? new Uint8Array(24)).byteOffset,
    );
    expect({
      src: icon.src,
      size: `${view.getUint32(16)}x${view.getUint32(20)}`,
    }).toEqual({ src: icon.src, size: icon.sizes });
  }
}, 60_000);

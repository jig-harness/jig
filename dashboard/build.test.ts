/**
 * The page the plugin carries is a fresh build of its source and the pinned
 * packages; `bun dashboard/build.ts` rebuilds it.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPage, PAGE_DIR } from "./build.ts";

const root = resolve(import.meta.dir, "..");

test("the built page is a fresh build of its source and the pinned packages", async () => {
  for (const [name, content] of Object.entries(await buildPage()))
    expect({
      name,
      current: readFileSync(join(root, PAGE_DIR, name), "utf8") === content,
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

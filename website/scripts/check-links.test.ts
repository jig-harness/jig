import { expect, test } from "bun:test";
import { parsePage, problemWith, srcsetUrls } from "./check-links.ts";

const pages = new Map([
  ["/", { ids: new Set(["top"]) }],
  ["/factory/", { ids: new Set(["learning"]) }],
  ["/examples/audit/sheet.html", { ids: new Set(["m1"]) }],
  ["/favicon.svg", { ids: new Set<string>() }],
  ["/sprite.svg", { ids: new Set(["icon"]) }],
]);
const isAsset = (path: string) =>
  path === "/_astro/site.css" || path === "/logo.png";
const check = (href: string, route = "/factory/") =>
  problemWith(href, route, pages, isAsset);

test("an anchor alone is checked against the page it is on", () => {
  expect(check("#learning")).toBeNull();
  expect(check("#the-learning-loop-wraps-both")).toBe("no such anchor");
});

test("a relative link resolves against its page", () => {
  expect(check("../#top")).toBeNull();
  expect(check("missing/")).toBe("no such page");
});

test("an HTML file is a page, so its anchors are checked", () => {
  expect(check("/examples/audit/sheet.html#m1")).toBeNull();
  expect(check("/examples/audit/sheet.html#missing")).toBe("no such anchor");
  expect(check("/favicon.svg")).toBeNull();
});

test("links off the site are not checked", () => {
  for (const href of ["https://bun.sh/x#y", "mailto:a@b.c", "//cdn.test/x"])
    expect(check(href), href).toBeNull();
});

test("only elements count: comments and scripts are neither ids nor links", async () => {
  const page = await parsePage(
    `<!-- <p id="ghost"> --><a href="/real/" id="here">x</a>` +
      `<script>const s = '<a href="/fake/">';</script><link rel="icon" href="/favicon.svg">`,
  );
  expect([...page.ids]).toEqual(["here"]);
  expect(page.hrefs).toEqual(["/real/", "/favicon.svg"]);
});

test("a link to the site's own address is checked like a relative one", () => {
  expect(check("https://jig-harness.dev/factory/#learning")).toBeNull();
  expect(check("https://jig-harness.dev/missing/#missing")).toBe(
    "no such page",
  );
  expect(check("https://jig-harness.dev/#gone")).toBe("no such anchor");
});

test("a built stylesheet or script must exist like any other file", () => {
  expect(check("/_astro/site.css")).toBeNull();
  expect(check("/_astro/missing.css")).toBe("no such page");
});

test("a script, image or media source is collected like a link", async () => {
  const page = await parsePage(
    `<script src="/_astro/missing.js"></script><img src="/logo.png">` +
      `<video><source src="/clip.mp4"></video><script>inline()</script>`,
  );
  expect(page.hrefs).toEqual(["/_astro/missing.js", "/logo.png", "/clip.mp4"]);
  expect(check("/_astro/missing.js")).toBe("no such page");
});

test("every attribute a browser loads a URL from is collected", async () => {
  const page = await parsePage(
    `<iframe src="/missing.html"></iframe><video src="/a.mp4" poster="/p.png"></video>` +
      `<audio src="/b.mp3"></audio><track src="/c.vtt"><embed src="/d.svg">` +
      `<object data="/e.svg"></object><input type="image" src="/f.png">` +
      `<img srcset="/g.png 1x, /h.png 2x"><picture><source srcset="/i.webp 480w,/j.webp 960w"></picture>`,
  );
  expect(page.hrefs.sort()).toEqual(
    [
      "/missing.html",
      "/a.mp4",
      "/p.png",
      "/b.mp3",
      "/c.vtt",
      "/d.svg",
      "/e.svg",
      "/f.png",
      "/g.png",
      "/h.png",
      "/i.webp",
      "/j.webp",
    ].sort(),
  );
});

test("a URL attribute is collected whatever element carries it", async () => {
  const page = await parsePage(
    `<svg><image href="/missing.png" width="1" height="1"/>` +
      `<use xlink:href="/sprite.svg#gone"/><use href="#icon"/></svg>` +
      `<link rel="preload" as="image" imagesrcset="/k.png 1x, /l.png 2x">` +
      `<form action="/send/"><button formaction="/other/">x</button></form>`,
  );
  expect(page.hrefs.sort()).toEqual(
    [
      "/missing.png",
      "/sprite.svg#gone",
      "#icon",
      "/k.png",
      "/l.png",
      "/send/",
      "/other/",
    ].sort(),
  );
  expect(check("/missing.png")).toBe("no such page");
  expect(check("/k.png")).toBe("no such page");
  expect(check("#icon")).toBe("no such anchor");
});

test("data is a URL on an object only", async () => {
  const page = await parsePage(`<object data="/e.svg"></object><p data="x">`);
  expect(page.hrefs).toEqual(["/e.svg"]);
});

test("a srcset candidate is its address without the descriptor", () => {
  expect(srcsetUrls("/a.png")).toEqual(["/a.png"]);
  expect(srcsetUrls("/a.png 1x, /b.png 2x")).toEqual(["/a.png", "/b.png"]);
  expect(srcsetUrls("/a,b.png 1x, /c.png 2x")).toEqual(["/a,b.png", "/c.png"]);
});

test("an anchor on an SVG is checked against the SVG's ids", async () => {
  const page = await parsePage(
    `<svg><symbol id="icon"><path d="M0 0"/></symbol>` +
      `<use href="#icon"/><use href="#gone"/></svg>`,
  );
  expect([...page.ids]).toEqual(["icon"]);
  expect(check("/sprite.svg#icon")).toBeNull();
  expect(check("/sprite.svg#gone")).toBe("no such anchor");
  expect(check("/favicon.svg#missing")).toBe("no such anchor");
  expect(check("#gone", "/sprite.svg")).toBe("no such anchor");
});

test("a file with no ids has no anchors", () => {
  expect(check("/logo.png")).toBeNull();
  expect(check("/logo.png#top")).toBe("no such anchor");
  expect(check("/_astro/site.css#x")).toBe("no such anchor");
});

test("a file that sets its own base URL is marked, not resolved", async () => {
  const svg = await parsePage(
    `<svg xmlns="http://www.w3.org/2000/svg" xml:base="/missing/"><image href="logo.png"/></svg>`,
  );
  expect(svg.rebased).toBe(true);
  const html = await parsePage(
    `<head><base href="/docs/"></head><a href="x/">x</a>`,
  );
  expect(html.rebased).toBe(true);
  const plain = await parsePage(`<a href="/base/" data-base="x">x</a>`);
  expect(plain.rebased).toBe(false);
});

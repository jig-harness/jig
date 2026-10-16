import { expect, test } from "bun:test";
import worker from "./index.ts";

/** Static assets as Cloudflare serves them: a HEAD has no body, and a matching `If-None-Match` gets 304. */
const ASSETS = {
  fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/nothing/index.md")
      return new Response("missing", { status: 404 });
    if (request.headers.get("If-None-Match") === '"v1"')
      return new Response(null, { status: 304 });
    return new Response(request.method === "HEAD" ? null : `asset ${path}`, {
      headers: { "Content-Type": "text/plain", ETag: '"v1"' },
    });
  },
};
const KEY = "a-long-random-key";

const get = (
  path: string,
  init: RequestInit = {},
  key: string | undefined = KEY,
) =>
  worker.fetch(new Request(`https://jig-harness.dev${path}`, init), {
    ASSETS,
    SITE_KEY: key,
  });

async function cookieFromLink(): Promise<string> {
  const response = await get(`/factory/?key=${KEY}`);
  return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
}

test("without the key or its cookie, no page is served", async () => {
  const response = await get("/factory/");
  expect(response.status).toBe(403);
  expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
});

test("the link sets the cookie and drops the key from the address", async () => {
  const response = await get(`/factory/?key=${KEY}&tab=ci`);
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(
    "https://jig-harness.dev/factory/?tab=ci",
  );
  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).not.toContain(KEY);
});

test("the link redirects only to this site", async () => {
  const response = await get(`//other.example/?key=${KEY}`);
  expect(response.status).toBe(303);
  const location = response.headers.get("Location") ?? "";
  expect(new URL(location, "https://jig-harness.dev/").host).toBe(
    "jig-harness.dev",
  );
});

test("the cookie lets the reader in on every page", async () => {
  const response = await get("/modules/", {
    headers: { Cookie: `theme=dark; ${await cookieFromLink()}` },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("asset /modules/");
});

test("a wrong key or a forged cookie is refused", async () => {
  expect((await get("/?key=guess")).status).toBe(403);
  expect(
    (await get("/", { headers: { Cookie: "jig_site=0000" } })).status,
  ).toBe(403);
});

test("a changed key ends the visits the old one started", async () => {
  const cookie = await cookieFromLink();
  const response = await get("/", { headers: { Cookie: cookie } }, "new-key");
  expect(response.status).toBe(403);
});

test("with no key set, nothing is served", async () => {
  const link = new Request(`https://jig-harness.dev/?key=${KEY}`);
  expect((await worker.fetch(link, { ASSETS })).status).toBe(403);
  expect((await get(`/?key=${KEY}`, {}, "")).status).toBe(403);
});

test("robots.txt is served to everyone", async () => {
  const response = await get("/robots.txt");
  expect(response.status).toBe(200);
});

const MD = "text/markdown, text/html;q=0.5";

/** A request from a reader holding the key's cookie. */
async function authed(path: string, accept?: string) {
  const headers: Record<string, string> = { Cookie: await cookieFromLink() };
  if (accept) headers.Accept = accept;
  return get(path, { headers });
}

test("a reader that prefers Markdown gets the page's twin, with its headers", async () => {
  const response = await authed("/modules/M2/", MD);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(
    "text/markdown; charset=utf-8",
  );
  expect(response.headers.get("Content-Signal")).toBe(
    "ai-train=yes, search=yes, ai-input=yes",
  );
  expect(response.headers.get("Vary")).toContain("Accept");
  expect(response.headers.get("X-Markdown-Tokens")).toBe(
    String(Math.ceil("asset /modules/M2/index.md".length / 4)),
  );
  expect(await response.text()).toBe("asset /modules/M2/index.md");
});

test("the twin of the home page and of an address without its slash", async () => {
  expect(await (await authed("/", MD)).text()).toBe("asset /index.md");
  expect(await (await authed("/factory", MD)).text()).toBe(
    "asset /factory/index.md",
  );
});

test("a reader that prefers HTML gets the page, which says it depends on Accept", async () => {
  for (const accept of [
    "text/html,*/*;q=0.8",
    "*/*",
    "text/html, text/markdown",
  ]) {
    const response = await authed("/modules/", accept);
    expect(await response.text()).toBe("asset /modules/");
    expect(response.headers.get("Vary")).toContain("Accept");
  }
  expect(await (await authed("/modules/")).text()).toBe("asset /modules/");
});

test("a page with no twin is served as HTML even to a reader that asks for Markdown", async () => {
  expect(await (await authed("/nothing/", MD)).text()).toBe("asset /nothing/");
});

test("a file is served as it is, a twin asked for by address as Markdown", async () => {
  const image = await authed("/brand/jig-mark.svg", MD);
  expect(await image.text()).toBe("asset /brand/jig-mark.svg");
  expect(image.headers.get("Vary")).toBeNull();
  const twin = await authed("/modules/M2/index.md");
  expect(twin.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  expect(twin.headers.get("Content-Signal")).toBe(
    "ai-train=yes, search=yes, ai-input=yes",
  );
  expect(twin.headers.get("X-Markdown-Tokens")).toBe(
    String(Math.ceil("asset /modules/M2/index.md".length / 4)),
  );
  expect((await authed("/nothing/index.md")).status).toBe(404);
});

test("a HEAD or a conditional request for Markdown is answered as a GET would be", async () => {
  const tokens = String(Math.ceil("asset /modules/M2/index.md".length / 4));
  const cookie = await cookieFromLink();
  const head = await get("/modules/M2/", {
    method: "HEAD",
    headers: { Accept: MD, Cookie: cookie },
  });
  expect(head.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  expect(head.headers.get("X-Markdown-Tokens")).toBe(tokens);
  expect(await head.text()).toBe("");
  const conditional = await get("/modules/M2/", {
    headers: { Accept: MD, Cookie: cookie, "If-None-Match": '"v1"' },
  });
  expect(conditional.headers.get("Content-Type")).toBe(
    "text/markdown; charset=utf-8",
  );
  expect(await conditional.text()).toBe("asset /modules/M2/index.md");
});

test("Markdown is served only behind the key", async () => {
  expect(
    (await get("/modules/M2/", { headers: { Accept: MD } }, "")).status,
  ).toBe(403);
  expect(
    (
      await worker.fetch(
        new Request("https://jig-harness.dev/modules/M2/", {
          headers: { Accept: MD },
        }),
        { ASSETS, SITE_KEY: KEY },
      )
    ).status,
  ).toBe(403);
});

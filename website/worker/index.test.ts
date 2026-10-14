import { expect, test } from "bun:test";
import worker from "./index.ts";

const ASSETS = {
  fetch: async (request: Request) =>
    new Response(`asset ${new URL(request.url).pathname}`),
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

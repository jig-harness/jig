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
const get = (path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://jig-harness.dev${path}`, init), {
    ASSETS,
  });

test("every page is served to any reader", async () => {
  const response = await get("/modules/");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("asset /modules/");
});

test("robots.txt is served", async () => {
  const response = await get("/robots.txt");
  expect(response.status).toBe(200);
});

const MD = "text/markdown, text/html;q=0.5";

/** A request with the given `Accept` header, if any. */
function read(path: string, accept?: string) {
  return get(path, accept ? { headers: { Accept: accept } } : {});
}

test("a reader that prefers Markdown gets the page's twin, with its headers", async () => {
  const response = await read("/modules/M2/", MD);
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
  expect(await (await read("/", MD)).text()).toBe("asset /index.md");
  expect(await (await read("/factory", MD)).text()).toBe(
    "asset /factory/index.md",
  );
});

test("a reader that prefers HTML gets the page, which says it depends on Accept", async () => {
  for (const accept of [
    "text/html,*/*;q=0.8",
    "*/*",
    "text/html, text/markdown",
  ]) {
    const response = await read("/modules/", accept);
    expect(await response.text()).toBe("asset /modules/");
    expect(response.headers.get("Vary")).toContain("Accept");
  }
  expect(await (await read("/modules/")).text()).toBe("asset /modules/");
});

test("a page with no twin is served as HTML even to a reader that asks for Markdown", async () => {
  expect(await (await read("/nothing/", MD)).text()).toBe("asset /nothing/");
});

test("a file is served as it is, a twin asked for by address as Markdown", async () => {
  const image = await read("/brand/jig-mark.svg", MD);
  expect(await image.text()).toBe("asset /brand/jig-mark.svg");
  expect(image.headers.get("Vary")).toBeNull();
  const twin = await read("/modules/M2/index.md");
  expect(twin.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  expect(twin.headers.get("Content-Signal")).toBe(
    "ai-train=yes, search=yes, ai-input=yes",
  );
  expect(twin.headers.get("X-Markdown-Tokens")).toBe(
    String(Math.ceil("asset /modules/M2/index.md".length / 4)),
  );
  expect((await read("/nothing/index.md")).status).toBe(404);
});

test("a HEAD or a conditional request for Markdown is answered as a GET would be", async () => {
  const tokens = String(Math.ceil("asset /modules/M2/index.md".length / 4));
  const head = await get("/modules/M2/", {
    method: "HEAD",
    headers: { Accept: MD },
  });
  expect(head.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  expect(head.headers.get("X-Markdown-Tokens")).toBe(tokens);
  expect(await head.text()).toBe("");
  const conditional = await get("/modules/M2/", {
    headers: { Accept: MD, "If-None-Match": '"v1"' },
  });
  expect(conditional.headers.get("Content-Type")).toBe(
    "text/markdown; charset=utf-8",
  );
  expect(await conditional.text()).toBe("asset /modules/M2/index.md");
});

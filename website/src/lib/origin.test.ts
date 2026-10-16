import { expect, test } from "bun:test";
import {
  encodedRoute,
  percentDecoded,
  routeAddress,
  routePath,
} from "./origin.ts";

test("decodes valid escapes and keeps a % that starts no escape", () => {
  expect(percentDecoded("caf%C3%A9100%")).toBe("café100%");
  expect(percentDecoded("100%")).toBe("100%");
  expect(percentDecoded("%zz%41")).toBe("%zzA");
  expect(percentDecoded("a%2")).toBe("a%2");
  expect(percentDecoded("%FF")).toBe("�");
  expect(percentDecoded("%EF%BB%BFtitle")).toBe("\uFEFFtitle");
});

test("agrees with the built-in decoders wherever they succeed", () => {
  for (const part of ["café", "caf%C3%A9", "a%20b%2Fc%23d", "%F0%9F%94%A7x"]) {
    expect(percentDecoded(part)).toBe(decodeURIComponent(part));
    expect(percentDecoded(part, ";/?:@&=+$,#")).toBe(decodeURI(part));
  }
});

test("a route path decodes every escape but a slash, and round-trips segment encoding", () => {
  expect(routePath("/notes/a%26b%40c%2Bd%3B%3D%24%2C%3A%3F%23/")).toBe(
    "/notes/a&b@c+d;=$,:?#/",
  );
  expect(routePath("/a%2Fb/")).toBe("/a%2Fb/");
  for (const route of [
    "/notes/a&b/",
    "/notes/x@y+z;=$,:/",
    "/notes/café 100%/",
    "/notes/a?b#c/",
  ]) {
    expect(routePath(encodedRoute(route))).toBe(route);
  }
});

test("a route's address keeps a ? or # in its path", () => {
  const url = new URL(routeAddress("/notes/a?b#c/"));
  expect(url.pathname).toBe("/notes/a%3Fb%23c/");
  expect(url.search).toBe("");
  expect(url.hash).toBe("");
  expect(routeAddress("/x/", "https://site.invalid")).toBe(
    "https://site.invalid/x/",
  );
});

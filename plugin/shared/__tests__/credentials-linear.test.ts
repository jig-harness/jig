import { expect, test } from "bun:test";
import { maskCredentials } from "../credentials";

test("a long quoted word of credential-like fragments is masked in linear time", () => {
  const word = `"${"token".repeat(8192)}"`;
  const started = performance.now();
  const out = maskCredentials(word, "<redacted>");
  expect(performance.now() - started).toBeLessThan(1000);
  expect(out).toBe(word);
});

test("a quoted credential field is still masked", () => {
  expect(maskCredentials('{"api_key": "abc123"}', "<redacted>")).toBe(
    '{"api_key": "<redacted>"}',
  );
});

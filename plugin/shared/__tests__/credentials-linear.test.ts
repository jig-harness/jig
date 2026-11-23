import { expect, test } from "bun:test";
import { maskCredentials } from "../credentials";

const MARK = "<redacted>";

// A pattern that rescans each word boundary needs minutes on this input; one
// pass needs milliseconds, so the bound holds across slow runners.
test.each([
  ["a quoted word of credential-like fragments", `"${"token".repeat(80000)}"`],
  ["a hyphenated run with no assignment", `"${"token-".repeat(70000)}"`],
  ["a dotted run with no assignment", `${"secret.".repeat(60000)}`],
])("%s is read in one pass and left alone", (_, text) => {
  const started = performance.now();
  const out = maskCredentials(text, MARK);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(out).toBe(text);
});

test("a quoted credential field is still masked", () => {
  expect(maskCredentials('{"api_key": "abc123"}', MARK)).toBe(
    '{"api_key": "<redacted>"}',
  );
});

test.each([
  ["before", `${"a".repeat(300)}token`],
  ["after", `token${"a".repeat(300)}`],
])(
  "a name with 300 letters %s the fragment still masks its value",
  (_, name) => {
    expect(maskCredentials(`{"${name}": "opaque"}`, MARK)).toBe(
      `{"${name}": "${MARK}"}`,
    );
    expect(maskCredentials(`${name}=opaque`, MARK)).toBe(`${name}=${MARK}`);
    expect(maskCredentials(`${name}="opaque value"`, MARK)).toBe(
      `${name}=${MARK}`,
    );
  },
);

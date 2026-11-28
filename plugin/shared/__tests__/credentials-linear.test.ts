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

test("a bare value never swallows the next assignment's key", () => {
  expect(maskCredentials('token= password="example value"', MARK)).toBe(
    `token= password=${MARK}`,
  );
  expect(maskCredentials('token=\npassword="example value"', MARK)).toBe(
    `token=\npassword=${MARK}`,
  );
});

test("segments glued to a quoted value are masked with it", () => {
  expect(maskCredentials('password="quoted part"unquoted-fixture', MARK)).toBe(
    `password=${MARK}`,
  );
});

test("an unquoted value is masked through quoted and bare segments and stops at separators after a quote", () => {
  const cases: [string, string][] = [
    ["password=token'=opaque-fixture", `password=${MARK}`],
    ['token= "password":"example value"', `token= "password": "${MARK}"`],
    ["password=token:opaque-fixture", `password=${MARK}`],
    ["password=\"alpha\"'beta gamma'", `password=${MARK}`],
    ['password=pre"alpha beta"', `password=${MARK}`],
    ['password="example",status=ready', `password=${MARK},status=ready`],
    ['password="example"; status=ready', `password=${MARK}; status=ready`],
  ];
  for (const [input, want] of cases)
    expect(maskCredentials(input, MARK)).toBe(want);
});

test("a quoted value spans lines to its close, takes its first line when unclosed, and a suffix without a field boundary stays masked", () => {
  const cases: [string, string][] = [
    ['password="alpha\nbeta"\nnext', `password=${MARK}\nnext`],
    ['password="alpha\r\nbeta" next', `password=${MARK} next`],
    ['password="alpha\\\nstatus line', `password=${MARK}\nstatus line`],
    ["password=abc\\\nstatus line", `password=${MARK}\nstatus line`],
    ['password="example",suffix', `password=${MARK}`],
    ['password="example"}tail', `password=${MARK}`],
    ['password="example"}\n', `password=${MARK}}\n`],
    ['password="example";status=ready', `password=${MARK};status=ready`],
  ];
  for (const [input, want] of cases)
    expect(maskCredentials(input, MARK)).toBe(want);
});

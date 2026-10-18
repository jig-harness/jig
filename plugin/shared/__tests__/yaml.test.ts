import { expect, test } from "bun:test";
import { dump as pinnedDump } from "js-yaml";
import { dump, load } from "../yaml.ts";

const value = {
  "web-app": [
    "packages/core-lib/**",
    "apps/web-app/**",
    ".github/workflows/**",
  ],
  docs: ["docs/**"],
  quoted: ["*.md", "a: b", "{x,y}/**", "long ".repeat(40).trim()],
};

test("dump writes what the pinned js-yaml's dump writes", () => {
  for (const options of [{}, { sortKeys: true, lineWidth: -1 }])
    expect(dump(value, options)).toBe(pinnedDump(value, options));
});

test("dump with sorted keys and no folding reads back as the same value", () => {
  const text = dump(value, { sortKeys: true, lineWidth: -1 });
  expect(text.startsWith("docs:\n  - docs/**\n")).toBe(true);
  expect(text).not.toContain(">-");
  expect(load(text)).toEqual(value);
});

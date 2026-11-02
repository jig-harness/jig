/**
 * The libraries the plugin vendors are the pinned packages. The plugin cache
 * has no node_modules, so `plugin/shared/vendor/` carries each library with
 * its licence; CONTRIBUTING.md § Derived files says how to refresh them when
 * a dependency is updated.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { vendoredOptique } from "./vendor-optique.ts";

const root = resolve(import.meta.dirname, "../..");
const vendor = join(root, "plugin", "shared", "vendor");

test("the vendored YAML parser is the pinned js-yaml build", () => {
  // js-yaml ships its own ESM build, vendored as it is.
  const pinned = join(root, "node_modules/js-yaml");
  expect(readFileSync(join(vendor, "js-yaml.mjs"), "utf8")).toBe(
    readFileSync(join(pinned, "dist/js-yaml.mjs"), "utf8"),
  );
  expect(readFileSync(join(vendor, "js-yaml.LICENSE"), "utf8")).toBe(
    readFileSync(join(pinned, "LICENSE"), "utf8"),
  );
});

test("the vendored command-line parser is a fresh build of the pinned Optique", () => {
  // Optique ships no single-file build, so the plugin carries Bun's bundle of
  // the parts the jig command imports, its declarations and its licence;
  // `bun tools/plugin/vendor-optique.ts` rebuilds all three.
  for (const [name, content] of Object.entries(vendoredOptique()))
    expect({
      name,
      current: readFileSync(join(vendor, name), "utf8") === content,
    }).toEqual({ name, current: true });
});

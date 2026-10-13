/**
 * A session keeps the plugin version it started with. The audit says so when
 * a newer version is installed beside it, so a team does not audit with
 * criteria the update has already changed.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newerInstalledVersion } from "../scripts/lib/repo.ts";

const cache = mkdtempSync(join(tmpdir(), "jig-plugin-cache-"));
afterAll(() => rmSync(cache, { recursive: true, force: true }));
/** A version folder as an install leaves it: its manifest names the version. */
function install(v: string, manifest = `{ "version": "${v}" }`) {
  mkdirSync(join(cache, "jig", v, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(cache, "jig", v, ".claude-plugin", "plugin.json"),
    manifest,
  );
}
for (const v of ["0.9.0", "0.15.0", "0.16.1", "0.16.0"]) install(v);
mkdirSync(join(cache, "jig", "notes"));

test("names the newest version installed beside an older running one", () => {
  expect(newerInstalledVersion(join(cache, "jig", "0.15.0"), "0.15.0")).toBe(
    "0.16.1",
  );
});

test("is silent when the running version is the newest, or in a checkout", () => {
  expect(newerInstalledVersion(join(cache, "jig", "0.16.1"), "0.16.1")).toBe(
    null,
  );
  const checkout = mkdtempSync(join(tmpdir(), "jig-checkout-"));
  mkdirSync(join(checkout, "plugin"));
  mkdirSync(join(checkout, "scripts"));
  expect(newerInstalledVersion(join(checkout, "plugin"), "0.16.1")).toBe(null);
  rmSync(checkout, { recursive: true, force: true });
});

test("passes over what a restart could not load: an empty folder, a stray file, a manifest naming another version", () => {
  mkdirSync(join(cache, "jig", "0.99.0"));
  writeFileSync(join(cache, "jig", "0.98.0"), "");
  install("0.97.0", '{ "version": "0.16.1" }');
  expect(newerInstalledVersion(join(cache, "jig", "0.15.0"), "0.15.0")).toBe(
    "0.16.1",
  );
});

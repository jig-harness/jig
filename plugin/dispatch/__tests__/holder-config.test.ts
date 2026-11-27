/**
 * holder-config.ts: the machine file's `detach_idle_holders` and
 * `rescue_unpushed`, both off unless the file turns them on, and a rescue
 * without the detach refused.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachineConfig } from "../lib/machine-config.ts";

const dir = mkdtempSync(join(tmpdir(), "holder-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function read(body: string) {
  const file = join(dir, "dispatch.yaml");
  writeFileSync(file, body);
  const machine = readMachineConfig(file);
  return machine.ok ? machine.value?.holders : machine.failure;
}

describe("the machine file's holder keys", () => {
  it("are off unless the file turns them on", () => {
    expect(read("repositories: []\n")).toEqual({
      detachIdle: false,
      rescueUnpushed: false,
    });
    expect(read("detach_idle_holders: true\n")).toEqual({
      detachIdle: true,
      rescueUnpushed: false,
    });
    expect(read("detach_idle_holders: true\nrescue_unpushed: true\n")).toEqual({
      detachIdle: true,
      rescueUnpushed: true,
    });
  });

  it("refuses a rescue without the detach, and anything but true or false", () => {
    expect(read("rescue_unpushed: true\n")).toEqual({
      code: "invalid",
      reason: expect.stringContaining(
        "rescue_unpushed: true needs detach_idle_holders: true",
      ),
    });
    expect(read("detach_idle_holders: sometimes\n")).toEqual({
      code: "invalid",
      reason: expect.stringContaining(
        "detach_idle_holders must be true or false",
      ),
    });
  });
});

/**
 * drive-pr: the drive's state label write is best effort, a boundary no
 * throw crosses. Reading the stop's facts from the drive's state (a person's
 * stop record that does not read, a state that does not parse) happens inside
 * it, so a throw there is reported as a defect with its stack and never
 * reaches the drive's exit.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { labelDrive } from "../scripts/lib/driver/state-labels.ts";
import { ok } from "../../../shared/outcome.ts";

const restore: Array<() => void> = [];
afterEach(() => {
  for (const r of restore.splice(0)) r();
});

describe("labelDrive's boundary", () => {
  it("reports a throw while reading the stop's facts as a defect, and returns", async () => {
    const said: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((line: unknown) => {
      said.push(String(line));
    });
    restore.push(() => spy.mockRestore());
    const read: string[] = [];
    await labelDrive(
      "999",
      async () => {
        throw new Error("the person's stop record does not read");
      },
      {
        settings: async () => {
          read.push("settings");
          return ok({
            slug: "example/project",
            config: { enabled: true, prefix: "jig:", onlyLabeled: false },
          });
        },
        forge: () => {
          throw new Error("no forge call is made");
        },
      },
    );
    expect(read).toEqual([]);
    expect(said.join("\n")).toContain(
      "labels: PR #999's state label was not written: a defect (the person's stop record does not read)",
    );
  });
});

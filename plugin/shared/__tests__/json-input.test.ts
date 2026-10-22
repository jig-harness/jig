import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INVALID_JSON_INPUT, readJsonInput } from "../json-input.ts";

test("JSON file input is literal and does not consume stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-json-input-"));
  try {
    const path = join(dir, "body é.json");
    const value = { body: "`code` $(echo lost) $HOME\nEOF" };
    writeFileSync(path, JSON.stringify(value));
    let stdinRead = false;
    expect(
      await readJsonInput(path, async () => {
        stdinRead = true;
        return "null";
      }),
    ).toEqual(value);
    expect(stdinRead).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid JSON null differs from malformed input or a failed read", async () => {
  const errors: string[] = [];
  const print = spyOn(console, "error").mockImplementation((message) =>
    errors.push(String(message)),
  );
  try {
    expect(await readJsonInput(undefined, async () => "null")).toBeNull();
    expect(await readJsonInput(undefined, async () => "not JSON")).toBe(
      INVALID_JSON_INPUT,
    );
    expect(
      await readJsonInput(undefined, async () =>
        Promise.reject("unreadable stream"),
      ),
    ).toBe(INVALID_JSON_INPUT);
    expect(errors[0]).toContain("stdin is not valid JSON");
    expect(errors[1]).toBe("failed to read stdin: unreadable stream");
  } finally {
    print.mockRestore();
  }
});

test("a failure reading an input file names the file, not stdin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-json-input-"));
  const errors: string[] = [];
  const print = spyOn(console, "error").mockImplementation((message) =>
    errors.push(String(message)),
  );
  try {
    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "not JSON");
    const missing = join(dir, "missing.json");
    const unused = async () => "null";
    expect(await readJsonInput(malformed, unused)).toBe(INVALID_JSON_INPUT);
    expect(await readJsonInput(missing, unused)).toBe(INVALID_JSON_INPUT);
    expect(errors[0]).toStartWith(`${malformed} is not valid JSON: `);
    expect(errors[1]).toStartWith(`failed to read ${missing}: `);
  } finally {
    print.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

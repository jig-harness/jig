import { describe, expect, test } from "bun:test";
import {
  expectSpawnExit,
  expectSpawnExitNot,
  expectSpawnKilled,
} from "./expect-spawn-exit.ts";

// The helpers' only interesting behavior is the mismatch branch, which never
// runs in a green suite: a dropped label, a swapped stream or an inverted
// condition would ship silently green without a probe of the helper itself.

describe("expectSpawnExit", () => {
  test("a match does not throw", () => {
    expect(() =>
      expectSpawnExit({ exitCode: 0, stdout: "", stderr: "" }, 0),
    ).not.toThrow();
  });

  test("a mismatch reports expected and actual code, stdout and stderr", () => {
    expect(() =>
      expectSpawnExit(
        { exitCode: 1, stdout: "stdout-marker", stderr: "stderr-marker" },
        0,
      ),
    ).toThrow(/expected exit 0, got 1[\s\S]*stdout-marker[\s\S]*stderr-marker/);
  });

  test("stdout and stderr stay on their own streams", () => {
    expect(() =>
      expectSpawnExit({ exitCode: 1, stdout: "OUT", stderr: "ERR" }, 0),
    ).toThrow(/--- stdout ---\nOUT\n--- stderr ---\nERR/);
  });

  test("Buffer and Uint8Array output is stringified", () => {
    expect(() =>
      expectSpawnExit(
        {
          exitCode: 1,
          stdout: Buffer.from("buffer-stdout-marker"),
          stderr: Buffer.from("buffer-stderr-marker"),
        },
        0,
      ),
    ).toThrow(/buffer-stdout-marker[\s\S]*buffer-stderr-marker/);
  });

  test("a plain Uint8Array is decoded as text, not joined byte values", () => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(() =>
      expectSpawnExit(
        { exitCode: 1, stdout: bytes("OUT"), stderr: bytes("ERR") },
        0,
      ),
    ).toThrow(/--- stdout ---\nOUT\n--- stderr ---\nERR/);
  });

  test("the label prefixes the message when provided", () => {
    expect(() =>
      expectSpawnExit({ exitCode: 1, stdout: "", stderr: "" }, 0, "my label"),
    ).toThrow(/^my label: expected exit 0, got 1/);
  });

  test("no label means no prefix", () => {
    expect(() =>
      expectSpawnExit({ exitCode: 1, stdout: "", stderr: "" }, 0),
    ).toThrow(/^expected exit 0, got 1/);
  });

  test("a null exit code mismatches any number", () => {
    expect(() =>
      expectSpawnExit({ exitCode: null, stdout: "", stderr: "" }, 0),
    ).toThrow(/expected exit 0, got null/);
  });

  test("null output does not raise a secondary error", () => {
    expect(() =>
      expectSpawnExit({ exitCode: 1, stdout: null, stderr: null }, 0),
    ).toThrow(/expected exit 0, got 1[\s\S]*--- stdout ---\n\n--- stderr ---/);
  });
});

describe("expectSpawnExitNot", () => {
  test("a non-forbidden code does not throw", () => {
    expect(() =>
      expectSpawnExitNot({ exitCode: 1, stdout: "", stderr: "" }, 0),
    ).not.toThrow();
  });

  test("a null exit code is not any forbidden number", () => {
    expect(() =>
      expectSpawnExitNot({ exitCode: null, stdout: "", stderr: "" }, 0),
    ).not.toThrow();
  });

  test("the forbidden code reports itself, stdout and stderr", () => {
    expect(() =>
      expectSpawnExitNot(
        { exitCode: 0, stdout: "stdout-marker", stderr: "stderr-marker" },
        0,
      ),
    ).toThrow(
      /expected exit code other than 0, got 0[\s\S]*stdout-marker[\s\S]*stderr-marker/,
    );
  });

  test("the label prefixes the message when provided", () => {
    expect(() =>
      expectSpawnExitNot(
        { exitCode: 0, stdout: "", stderr: "" },
        0,
        "my label",
      ),
    ).toThrow(/^my label: expected exit code other than 0, got 0/);
  });
});

describe("expectSpawnKilled", () => {
  test("a null exit code does not throw", () => {
    expect(() =>
      expectSpawnKilled({ exitCode: null, stdout: "", stderr: "" }),
    ).not.toThrow();
  });

  test("a numeric code reports itself, stdout and stderr", () => {
    expect(() =>
      expectSpawnKilled(
        { exitCode: 0, stdout: "stdout-marker", stderr: "stderr-marker" },
        "cancel",
      ),
    ).toThrow(
      /^cancel: expected a signal-killed run \(null exit code\), got 0[\s\S]*stdout-marker[\s\S]*stderr-marker/,
    );
  });
});

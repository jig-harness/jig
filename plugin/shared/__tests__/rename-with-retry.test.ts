import { expect, test } from "bun:test";
import { mkdirWithRetry, renameWithRetry } from "../rename-with-retry.ts";

function error(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`rename retries Windows ${code} without changing either path`, () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    renameWithRetry("source", "destination", {
      platform: "win32",
      rename: (...paths) => {
        calls.push(paths);
        if (calls.length < 3) throw error(code);
      },
      sleep: (ms) => delays.push(ms),
    });
    expect(calls).toEqual(Array(3).fill(["source", "destination"]));
    expect(delays).toEqual([10, 20]);
  });
}

test("persistent sharing errors stop at the bound and preserve the original error", () => {
  const failure = error("EBUSY");
  let attempts = 0;
  const delays: number[] = [];
  expect(() =>
    renameWithRetry("source", "destination", {
      platform: "win32",
      rename: () => {
        attempts++;
        throw failure;
      },
      sleep: (ms) => delays.push(ms),
    }),
  ).toThrow(failure);
  expect(attempts).toBe(5);
  expect(delays).toEqual([10, 20, 40, 80]);
});

for (const [platform, code] of [
  ["linux", "EPERM"],
  ["darwin", "EBUSY"],
  ["win32", "ENOENT"],
  ["win32", "EEXIST"],
] as const) {
  test(`${platform} ${code} fails immediately`, () => {
    let attempts = 0;
    const delays: number[] = [];
    const failure = error(code);
    expect(() =>
      renameWithRetry("source", "destination", {
        platform,
        rename: () => {
          attempts++;
          throw failure;
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow(failure);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });
}

test("mkdir waits for a Windows pending deletion before acquiring the directory", () => {
  let attempts = 0;
  const paths: string[] = [];
  mkdirWithRetry("lock", {
    platform: "win32",
    mkdir: (path) => {
      paths.push(path);
      if (++attempts < 3) throw error("EACCES");
    },
    sleep: () => {
      /* Delay is injected to keep this test deterministic. */
    },
  });
  expect(paths).toEqual(["lock", "lock", "lock"]);
});

test("mkdir treats EEXIST as an occupied lock without retrying", () => {
  let attempts = 0;
  expect(() =>
    mkdirWithRetry("lock", {
      platform: "win32",
      lstat: () => ({}),
      mkdir: () => {
        attempts++;
        throw error("EEXIST");
      },
      sleep: () => {
        throw new Error("unexpected wait");
      },
    }),
  ).toThrow("EEXIST");
  expect(attempts).toBe(1);
});

test("mkdir retries Windows EEXIST only when the directory entry is already absent", () => {
  let attempts = 0;
  const inspected: string[] = [];
  const delays: number[] = [];
  mkdirWithRetry("lock", {
    platform: "win32",
    mkdir: () => {
      if (++attempts < 3) throw error("EEXIST");
    },
    lstat: (path) => {
      inspected.push(path);
      throw error("ENOENT");
    },
    sleep: (ms) => delays.push(ms),
  });
  expect(attempts).toBe(3);
  expect(inspected).toEqual(["lock", "lock"]);
  expect(delays).toEqual([10, 20]);
});

for (const code of ["EACCES", "EIO"]) {
  test(`mkdir preserves occupied-lock failure when lstat reports ${code}`, () => {
    let attempts = 0;
    let inspections = 0;
    const occupied = error("EEXIST");
    expect(() =>
      mkdirWithRetry("lock", {
        platform: "win32",
        mkdir: () => {
          attempts++;
          throw occupied;
        },
        lstat: () => {
          inspections++;
          throw error(code);
        },
        sleep: () => {
          throw new Error("unexpected wait");
        },
      }),
    ).toThrow(occupied);
    expect(attempts).toBe(1);
    expect(inspections).toBe(1);
  });
}

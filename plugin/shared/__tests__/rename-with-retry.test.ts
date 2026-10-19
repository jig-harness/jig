import { expect, test } from "bun:test";
import { mkdirWithRetry, renameWithRetry } from "../rename-with-retry.ts";

function error(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function retryClock(delays: number[] = []) {
  let elapsed = 0;
  return {
    random: () => 0,
    now: () => elapsed,
    sleep: (ms: number) => {
      delays.push(ms);
      elapsed += ms;
    },
  };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`rename retries Windows ${code} without changing either path`, () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    renameWithRetry("source", "destination", {
      ...retryClock(delays),
      platform: "win32",
      rename: (...paths) => {
        calls.push(paths);
        if (calls.length < 3) throw error(code);
      },
    });
    expect(calls).toEqual(Array(3).fill(["source", "destination"]));
    expect(delays).toEqual([5, 5]);
  });
}

test("persistent sharing errors stop at the bound and preserve the original error", () => {
  const failure = error("EBUSY");
  let attempts = 0;
  const delays: number[] = [];
  expect(() =>
    renameWithRetry("source", "destination", {
      ...retryClock(delays),
      platform: "win32",
      rename: () => {
        attempts++;
        throw failure;
      },
    }),
  ).toThrow(failure);
  expect(attempts).toBe(401);
  expect(delays).toHaveLength(400);
  expect(delays.reduce((sum, ms) => sum + ms, 0)).toBe(2000);
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
      ...retryClock(),
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
    ...retryClock(delays),
  });
  expect(attempts).toBe(3);
  expect(inspected).toEqual(["lock", "lock"]);
  expect(delays).toEqual([5, 5]);
});

for (const code of ["EACCES", "EIO"]) {
  test(`mkdir preserves occupied-lock failure when lstat reports ${code}`, () => {
    let attempts = 0;
    let inspections = 0;
    const occupied = error("EEXIST");
    expect(() =>
      mkdirWithRetry("lock", {
        ...retryClock(),
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

test("rename can catch a reader closing its handle after 350ms", () => {
  let elapsed = 0;
  let attempts = 0;
  renameWithRetry("source", "destination", {
    platform: "win32",
    now: () => elapsed,
    random: () => 0,
    sleep: (ms) => {
      elapsed += ms;
    },
    rename: () => {
      attempts++;
      if (elapsed < 350) throw error("EPERM");
    },
  });
  expect(elapsed).toBe(350);
  expect(attempts).toBeGreaterThan(5);
});

test("a positively identified nonempty directory destination is occupied immediately", () => {
  let attempts = 0;
  const failure = error("EPERM");
  expect(() =>
    renameWithRetry("source", "destination", {
      platform: "win32",
      rename: () => {
        attempts++;
        throw failure;
      },
      lstat: () => ({ isDirectory: () => true }),
      readdir: () => ["owner.live"],
      sleep: () => {
        throw new Error("occupied directory must not wait");
      },
    }),
  ).toThrow(failure);
  expect(attempts).toBe(1);
});

test("an unreadable destination retains bounded sharing retries", () => {
  let elapsed = 0;
  renameWithRetry("source", "destination", {
    platform: "win32",
    now: () => elapsed,
    random: () => 0,
    sleep: (ms) => {
      elapsed += ms;
    },
    rename: () => {
      if (elapsed < 350) throw error("EBUSY");
    },
    lstat: () => {
      throw error("EACCES");
    },
  });
  expect(elapsed).toBe(350);
});

test("mkdir retries an ambiguous sharing failure while the removed name is unreadable", () => {
  let attempts = 0;
  const delays: number[] = [];
  mkdirWithRetry("lock", {
    ...retryClock(delays),
    platform: "win32",
    mkdir: () => {
      if (++attempts < 3) throw error("EACCES");
    },
    lstat: () => {
      throw error("EACCES");
    },
  });
  expect(attempts).toBe(3);
  expect(delays).toEqual([5, 5]);
});

for (const budget of [0, 12]) {
  test(`caller deadline caps sharing retries at ${budget}ms while retaining the initial attempt`, () => {
    for (const operation of ["rename", "mkdir"]) {
      let elapsed = 100;
      let attempts = 0;
      const failure = error("EACCES");
      const fail = () => {
        attempts++;
        throw failure;
      };
      const options = {
        platform: "win32" as const,
        deadlineMs: 100 + budget,
        now: () => elapsed,
        random: () => 0,
        sleep: (ms: number) => {
          elapsed += ms;
        },
        rename: fail,
        mkdir: fail,
        lstat: () => {
          throw error("ENOENT");
        },
      };
      expect(() => {
        if (operation === "rename")
          renameWithRetry("source", "destination", options);
        else mkdirWithRetry("lock", options);
      }).toThrow(failure);
      expect(elapsed).toBe(100 + budget);
      expect(attempts).toBe(budget === 0 ? 1 : 4);
    }
  });
}

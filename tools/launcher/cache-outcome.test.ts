import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachePath, fallbackCache } from "./cache.ts";
import { launch } from "./launch.ts";
import type { OpenRequest, Provider } from "./provider.ts";
import type { Tracker } from "./tracker.ts";

const fallback = { prompt: "Body", branch: "" };

const tracker: Tracker = {
  name: "linear",
  launchEnvironment: fallback,
  read: async () => ({
    cache: fallbackCache("ENG-1", fallback, 1_700_000_000),
    repoLabel: null,
    warnings: [],
    assignToOpener: async () => ({ assigned: true }),
  }),
};

test("a cache write that fails is passed to the provider, after a warning", async () => {
  const home = mkdtempSync(join(tmpdir(), "launcher-cache-"));
  const opened: OpenRequest[] = [];
  const warnings: string[] = [];
  const provider: Provider = {
    name: "conductor",
    validateRepo() {
      // any settings are valid
    },
    async open(request) {
      opened.push(request);
    },
  };
  const deps = {
    home,
    env: {},
    tracker,
    provider,
    warn: (m: string) => warnings.push(m),
  };
  try {
    await launch("ENG-1", "", deps);
    expect(opened[0]?.cacheWriteFailed).toBe(false);
    // A directory where the cache file goes fails the write, even for root.
    const path = cachePath(home, "ENG-1");
    rmSync(path);
    mkdirSync(join(path, "x"), { recursive: true });
    await launch("ENG-1", "", deps);
    expect(opened[1]?.cacheWriteFailed).toBe(true);
    expect(warnings.join("\n")).toContain("Could not write the context cache");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { ghRepoEnv, ghRepoEnvFor } from "../gh-repo-env.ts";

test("ghRepoEnv drops an inherited GH_REPO", () => {
  const before = process.env.GH_REPO;
  process.env.GH_REPO = "someone/else";
  try {
    expect(ghRepoEnv().GH_REPO).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = before;
  }
});

test("ghRepoEnvFor names the repository, or none", () => {
  expect(ghRepoEnvFor("owner/name").GH_REPO).toBe("owner/name");
  expect(ghRepoEnvFor(null).GH_REPO).toBeUndefined();
});

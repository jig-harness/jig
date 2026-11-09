import { expect, test } from "bun:test";
import { repoOfUrl } from "../scripts/lib/repo-url.ts";

test("only a supported scheme on the forge host names a repository", async () => {
  expect(
    await repoOfUrl("https://github.com/example-org/example-repo.git"),
  ).toBe("example-org/example-repo");
  for (const url of [
    "https://elsewhere.invalid/example-org/example-repo.git",
    "/tmp/example-org/example-repo",
    "file:///tmp/example-org/example-repo",
    "git://github.com/example-org/example-repo.git",
    "https://github.com/a/b/c",
  ]) {
    expect(await repoOfUrl(url)).toBe("");
  }
});

test("SSH aliases must resolve to the forge under a deadline", async () => {
  const resolve = async (args: string[], options: { timeoutSec: number }) => {
    expect(args).toEqual(["ssh", "-G", "--", "git@github-work"]);
    expect(options.timeoutSec).toBeGreaterThan(0);
    return { code: 0, stdout: "hostname github.com\n" };
  };
  expect(
    await repoOfUrl(
      "git@github-work:example-org/example-repo.git",
      {},
      resolve,
    ),
  ).toBe("example-org/example-repo");
  expect(
    await repoOfUrl(
      "git@github-work:example-org/example-repo.git",
      {},
      async () => ({ code: 0, stdout: "hostname elsewhere.invalid\n" }),
    ),
  ).toBe("");
  await expect(
    repoOfUrl("git@github-work:example-org/example-repo.git", {}, async () => ({
      code: 124,
      stdout: "",
      stderr: "deadline",
    })),
  ).rejects.toThrow("ssh -G exited 124: deadline");
});

test("SSH transport overrides are refused rather than verified with another command", async () => {
  await expect(
    repoOfUrl("git@github-work:example-org/example-repo.git", {
      GIT_SSH_COMMAND: "ssh -F alternate-config",
    }),
  ).rejects.toThrow("overrides Git's SSH transport");
});

test("enterprise forge selection comes from gh's host settings", async () => {
  const remote = "https://forge.example.invalid/example-org/example-repo.git";
  expect(await repoOfUrl(remote, { GH_HOST: "forge.example.invalid" })).toBe(
    "example-org/example-repo",
  );
  expect(
    await repoOfUrl(remote, {
      GH_REPO: "forge.example.invalid/example-org/example-repo",
    }),
  ).toBe("example-org/example-repo");
  expect(await repoOfUrl(remote, {})).toBe("");
});

test("authoritative forge metadata supports an inferred enterprise host", async () => {
  expect(
    await repoOfUrl(
      "https://forge.example.invalid/example-org/example-repo.git",
      {},
      undefined,
      "https://forge.example.invalid/example-org/example-repo/pull/1",
    ),
  ).toBe("example-org/example-repo");
});

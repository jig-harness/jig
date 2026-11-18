import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  processWorktreeRoot,
  decodeWorktreeOwner,
} from "../process-worktree-owner.ts";

test("separate clones with the same directory name have separate runs roots", () => {
  expect(processWorktreeRoot(resolve("/one/app"), resolve("/jig"))).not.toBe(
    processWorktreeRoot(resolve("/two/app"), resolve("/jig")),
  );
  expect(processWorktreeRoot(resolve("/one/app"), resolve("/jig"))).toStartWith(
    join(resolve("/jig"), "worktrees", "app-"),
  );
});

test("an owner must name its repository, branch and at least one launch", () => {
  const owner = {
    version: 1 as const,
    runtime: "process" as const,
    repository: resolve("/repo"),
    branch: "topic",
    launches: ["20261114T234948Z-470fe362"],
    processes: [],
  };
  expect(decodeWorktreeOwner(JSON.stringify(owner))).toEqual(owner);
  for (const changed of [
    { launches: [] },
    { processes: [{}] },
    { runtime: "orca" },
    { repository: "relative" },
  ]) {
    expect(
      decodeWorktreeOwner(JSON.stringify({ ...owner, ...changed })),
    ).toBeNull();
  }
});

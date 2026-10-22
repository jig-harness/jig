/**
 * drive-repository.test.ts — the repository label a drive listing prints is
 * `owner/name` or nothing: no remote URL form may carry a credential into it.
 */

import { describe, expect, it } from "bun:test";
import { repositoryLabel } from "../scripts/lib/drive-repository.ts";

describe("repositoryLabel", () => {
  it.each([
    ["https://example.invalid/sample/repo.git", "sample/repo"],
    ["https://user:secret@example.invalid/sample/repo.git", "sample/repo"],
    ["git@example.invalid:sample/repo.git", "sample/repo"],
    ["ssh://git@example.invalid:2222/sample/repo", "sample/repo"],
    [
      "https://example.invalid/sample/repo.git?access_token=secret",
      "sample/repo",
    ],
    ["https://example.invalid/sample/repo.git#secret", "sample/repo"],
    ["https://example.invalid/sample/repo?x=1#secret", "sample/repo"],
  ])("labels %s as %s", (url, label) => {
    expect(repositoryLabel(url)).toBe(label);
  });

  it.each([
    "https://example.invalid/token:secret/repo.git",
    "https://example.invalid/sample/re po.git",
    "https://example.invalid/sample/repo;secret",
    "https://example.invalid/sample/..",
    "repo",
    "",
  ])("refuses %s", (url) => {
    expect(repositoryLabel(url)).toBe("");
  });
});

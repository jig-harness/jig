import { describe, expect, test } from "bun:test";
import type { GhApi } from "../../../../plugin/skills/changelog/scripts/github-rules.ts";
import { githubIssues } from "./github-issues.ts";

const BOT = "github-actions[bot]";
const issue = (number: number, login = BOT) => ({
  number,
  title: "Precondition failed",
  body: "details",
  user: { login },
});
function apiFixture(values: unknown[]) {
  const calls: string[][] = [];
  const api: GhApi = (args) => {
    calls.push(args);
    const value = values.shift();
    return value instanceof Error
      ? { ok: false, stdout: "", stderr: value.message }
      : { ok: true, stdout: JSON.stringify(value), stderr: "" };
  };
  return { api, calls };
}

describe("GitHub external preconditions tracker adapter", () => {
  test("reads every page and excludes pull requests", async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const { api, calls } = apiFixture([
      page,
      [{ ...issue(101), pull_request: {} }, issue(102)],
    ]);
    const found = await githubIssues("team/project", BOT, api).listOpen();
    expect(found).toHaveLength(101);
    expect(found.at(-1)?.id).toBe("102");
    expect(calls.map((call) => call[0])).toEqual([
      "repos/team/project/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=1",
      "repos/team/project/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=2",
    ]);
  });
  test("a failed later page cannot produce a partial listing", async () => {
    const { api } = apiFixture([
      Array.from({ length: 100 }, (_, i) => issue(i + 1)),
      new Error("denied"),
    ]);
    await expect(
      githubIssues("team/project", BOT, api).listOpen(),
    ).rejects.toThrow("denied");
  });
  test.each([
    {},
    [null],
    [{ ...issue(1), number: "1" }],
    [{ ...issue(1), body: 4 }],
  ])("rejects malformed listing %j", async (value) => {
    const { api } = apiFixture([value]);
    await expect(
      githubIssues("team/project", BOT, api).listOpen(),
    ).rejects.toThrow();
  });
  test("a repeated page cannot masquerade as a complete listing", async () => {
    const page = Array.from({ length: 100 }, (_, i) => issue(i + 1));
    const { api } = apiFixture([page, page]);
    await expect(
      githubIssues("team/project", BOT, api).listOpen(),
    ).rejects.toThrow("repeated");
  });
  test("an issue by another creator is never adopted", async () => {
    const { api } = apiFixture([[issue(1, "outsider")]]);
    await expect(
      githubIssues("team/project", BOT, api).listOpen(),
    ).rejects.toThrow("another creator");
  });
  test("invalid JSON cannot masquerade as an empty listing", async () => {
    const api: GhApi = () => ({ ok: true, stdout: "not JSON", stderr: "" });
    await expect(
      githubIssues("team/project", BOT, api).listOpen(),
    ).rejects.toThrow("valid JSON");
  });
  test("null issue bodies are empty", async () => {
    const { api } = apiFixture([[{ ...issue(1), body: null }]]);
    expect(
      (await githubIssues("team/project", BOT, api).listOpen())[0]?.body,
    ).toBe("");
  });
  test("writes use argument arrays and returns the issue", async () => {
    const { api, calls } = apiFixture([issue(4), issue(4), issue(4)]);
    const port = githubIssues("team/project", BOT, api);
    const content = { title: "A title", body: "A body\nwith `$(shell)`" };
    expect((await port.create(content)).id).toBe("4");
    await port.update("4", content);
    await port.close("4");
    expect(calls[0]).toEqual([
      "repos/team/project/issues",
      "--method",
      "POST",
      "-f",
      `title=${content.title}`,
      "-f",
      `body=${content.body}`,
    ]);
    expect(calls[1]?.slice(0, 3)).toEqual([
      "repos/team/project/issues/4",
      "--method",
      "PATCH",
    ]);
    expect(calls[2]).toEqual([
      "repos/team/project/issues/4",
      "--method",
      "PATCH",
      "-f",
      "state=closed",
    ]);
  });
  test("invalid repository and issue identities never reach the API", async () => {
    const { api, calls } = apiFixture([]);
    expect(() => githubIssues("../bad", BOT, api)).toThrow("repository");
    expect(() => githubIssues("team/project", "a&b", api)).toThrow("creator");
    await expect(
      githubIssues("team/project", BOT, api).close("../1"),
    ).rejects.toThrow("issue");
    expect(calls).toEqual([]);
  });
  test("write failures propagate", async () => {
    const { api } = apiFixture([new Error("write denied")]);
    await expect(
      githubIssues("team/project", BOT, api).close("4"),
    ).rejects.toThrow("write denied");
  });
});

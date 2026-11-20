import { expect, test } from "bun:test";
import { recordGhAttempt } from "../outbound/gh-ledger.ts";
import { type CallRecord, withLedgerWriter } from "../outbound/ledger.ts";

/** The repository the ledger records for one run of `gh` with `args`. */
async function recorded(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<string | null | undefined> {
  const records: CallRecord[] = [];
  await withLedgerWriter(
    (record) => records.push(record),
    () =>
      recordGhAttempt(
        args,
        { env: { GH_TOKEN: "repository-test" }, ...opts },
        async () => ({ code: 0, stdout: "{}", stderr: "", timedOut: false }),
      ),
  );
  return records[0]?.repository;
}

test.each([
  [["pr", "view", "7", "-R", "Owner/Repo"], "owner/repo"],
  [["pr", "view", "7", "--repo=github.com/owner/repo"], "owner/repo"],
  [["api", "repos/owner/repo/pulls/7"], "owner/repo"],
  [
    ["api", "https://api.github.com/repos/owner/repo/issues?page=2"],
    "owner/repo",
  ],
  [
    [
      "api",
      "graphql",
      "-f",
      "query=query { x }",
      "-F",
      "owner=owner",
      "-F",
      "name=repo",
    ],
    "owner/repo",
  ],
  [["api", "repos/{owner}/{repo}/pulls/7"], null],
  [["api", "user"], null],
] as const)("gh %p records repository %p", async (args, repository) => {
  expect(await recorded([...args])).toBe(repository);
});

test("a GraphQL request body's owner and name variables name the repository", async () => {
  expect(
    await recorded(["api", "graphql", "--input", "-"], {
      stdin: JSON.stringify({
        query: "query Q($owner: String!, $name: String!) { x }",
        variables: { owner: "Owner", name: "Repo" },
      }),
    }),
  ).toBe("owner/repo");
});

test("a run that names no repository records the one GH_REPO names", async () => {
  expect(
    await recorded(["pr", "list"], {
      env: { GH_TOKEN: "repository-test", GH_REPO: "owner/repo" },
    }),
  ).toBe("owner/repo");
});

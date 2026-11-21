/**
 * Trusted automation (`pull_requests.trusted_automation`): the list as the
 * configuration gives it, each rule that keeps a listed bot's pull request
 * the repository's own, the update type a manifest diff shows, and the
 * compare answer the rules are read from.
 */
import { describe, expect, it } from "bun:test";
import {
  type AutomationFacts,
  type AutomationFile,
  authorLogin,
  DEFAULT_TRUSTED_PATHS,
  parseCompare,
  type TrustedAuthor,
  trustedAutomationOf,
  trustedEntryFor,
  trustVerdict,
  updateTypeOf,
} from "../scripts/lib/trusted-automation.ts";
import { ok, failed } from "../../../shared/outcome.ts";

const HEAD = "a".repeat(40);
const EARLIER = "c".repeat(40);

const values = (list: unknown, adopt?: unknown): Record<string, unknown> => ({
  pull_requests: { trusted_automation: list },
  ...(adopt === undefined ? {} : { dispatch: { adopt: { authors: adopt } } }),
});

function entry(over: Partial<TrustedAuthor> = {}): TrustedAuthor {
  return {
    login: "renovate[bot]",
    paths: DEFAULT_TRUSTED_PATHS,
    defaultPaths: true,
    updateTypes: null,
    signed: true,
    committers: ["host-person"],
    ...over,
  };
}

const manifest = (patch: string): AutomationFile => ({
  path: "package.json",
  previous: null,
  patch,
});
const lockfile: AutomationFile = {
  path: "pnpm-lock.yaml",
  previous: null,
  patch: null,
};
const bump = (before: string, after: string, key = "left-pad") =>
  manifest(
    `@@ -9,7 +9,7 @@\n   "dependencies": {\n-    "${key}": "${before}",\n+    "${key}": "${after}",\n   },`,
  );

function automation(over: Partial<AutomationFacts> = {}): AutomationFacts {
  return {
    head: HEAD,
    commits: [{ sha: HEAD, login: "renovate[bot]", verified: true }],
    files: [bump("^1.2.3", "^1.2.4"), lockfile],
    ...over,
  };
}

const verdict = (
  over: {
    crossRepository?: boolean | null;
    automation?: Partial<AutomationFacts> | null;
    unread?: string;
  } = {},
  e: TrustedAuthor = entry(),
) =>
  trustVerdict(
    {
      head: HEAD,
      author: "renovate[bot]",
      crossRepository:
        over.crossRepository === undefined ? false : over.crossRepository,
      ...(over.unread !== undefined
        ? { automation: failed("unreadable", over.unread) }
        : over.automation === null
          ? {}
          : { automation: ok(automation(over.automation ?? {})) }),
    },
    e,
  );

describe("the list on the default branch", () => {
  it("reads an absent setting as nobody trusted", () => {
    expect(trustedAutomationOf({})).toEqual(ok([]));
    expect(trustedAutomationOf({ pull_requests: {} })).toEqual(ok([]));
  });

  it("reads a login alone with the default paths, signed commits and the people adoption names as committers", () => {
    const list = trustedAutomationOf(
      values(["Renovate[bot]"], ["host-person", "dependabot[bot]"]),
    );
    expect(list).toEqual(
      ok([
        {
          login: "renovate[bot]",
          paths: DEFAULT_TRUSTED_PATHS,
          defaultPaths: true,
          updateTypes: null,
          signed: true,
          committers: ["host-person"],
        },
      ]),
    );
  });

  it("reads a GitHub App's app/<name> as <name>[bot] and keeps an entry's own fields", () => {
    const list = trustedAutomationOf(
      values([
        {
          login: "app/dependabot",
          paths: ["**/package.json"],
          update_types: ["patch", "minor"],
          signed: false,
          committers: ["Someone"],
        },
      ]),
    );
    expect(list.ok && list.value[0]).toEqual({
      login: "dependabot[bot]",
      paths: ["**/package.json"],
      defaultPaths: false,
      updateTypes: ["patch", "minor"],
      signed: false,
      committers: ["someone"],
    });
  });

  it.each([
    ["a mapping", { login: "renovate[bot]" }, "must be a list"],
    ["a person's login", ["someone"], "must be a bot's login"],
    [
      "an unknown key",
      [{ login: "renovate[bot]", merge: true }],
      "unknown keys: merge",
    ],
    [
      "an unknown update type",
      [{ login: "renovate[bot]", update_types: ["huge"] }],
      "huge is not one of",
    ],
    [
      "an empty path list",
      [{ login: "renovate[bot]", paths: [] }],
      "paths must be a nonempty list",
    ],
    ["a bot listed twice", ["renovate[bot]", "app/renovate"], "a second time"],
    [
      "signed that is not a boolean",
      [{ login: "renovate[bot]", signed: "yes" }],
      "signed must be true or false",
    ],
  ])("refuses %s, naming the setting", (_what, list, why) => {
    const read = trustedAutomationOf(values(list));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.reason).toContain("pull_requests.trusted_automation");
      expect(read.failure.reason).toContain(why);
    }
  });

  it("finds a pull request's author in the list, a bot's login as the board reads it", () => {
    const list = [entry()];
    expect(trustedEntryFor(authorLogin("Bot", "renovate"), list)).toEqual(
      entry(),
    );
    expect(trustedEntryFor(authorLogin("User", "renovate"), list)).toBeNull();
    expect(trustedEntryFor("", list)).toBeNull();
  });
});

describe("a listed bot's pull request is the repository's own only when every rule holds", () => {
  it("meets the rule with one signed commit by the bot within its paths", () => {
    expect(verdict()).toEqual({
      met: true,
      fact: "trusted automation renovate[bot]: same repository, 1 commit allowed, 2 files within its paths",
    });
  });

  it.each([
    ["a fork", { crossRepository: true }, "its head is in a fork"],
    [
      "an unread fork flag",
      { crossRepository: null },
      "whether its head is in a fork did not read",
    ],
    [
      "commits and files not read",
      { automation: null },
      "its commits and files were not read",
    ],
    [
      "commits and files that did not read",
      { unread: "more files than one read holds" },
      "did not read: more files than one read holds",
    ],
    [
      "a read of another head",
      { automation: { head: EARLIER } },
      "were read at ccccccc, not at aaaaaaa",
    ],
    ["no commits", { automation: { commits: [] } }, "it has no commits"],
    [
      "a commit by someone else",
      {
        automation: {
          commits: [{ sha: HEAD, login: "outsider", verified: true }],
        },
      },
      "commit aaaaaaa is by outsider",
    ],
    [
      "a commit with no linked author",
      { automation: { commits: [{ sha: HEAD, login: "", verified: true }] } },
      "commit aaaaaaa has no linked author",
    ],
    [
      "an unsigned commit by the bot",
      {
        automation: {
          commits: [{ sha: HEAD, login: "renovate[bot]", verified: false }],
        },
      },
      "carries no valid signature",
    ],
    [
      "a path outside its paths",
      {
        automation: {
          files: [
            lockfile,
            { path: "src/index.ts", previous: null, patch: null },
          ],
        },
      },
      "src/index.ts is outside its paths",
    ],
    [
      "a rename from outside its paths",
      {
        automation: {
          files: [
            {
              path: "package.json",
              previous: "src/package.json.tmpl",
              patch: null,
            },
          ],
        },
      },
      "src/package.json.tmpl is outside its paths",
    ],
  ])("refuses %s", (_what, over, why) => {
    const v = verdict(over);
    expect(v.met).toBe(false);
    expect(v.fact).toStartWith("renovate[bot] is trusted automation, but ");
    expect(v.fact).toContain(why);
  });

  it("allows a commit by a listed committer, such as a drive's repair, and an unsigned bot commit where signed is off", () => {
    const commits = [
      { sha: EARLIER, login: "renovate[bot]", verified: false },
      { sha: HEAD, login: "Host-Person", verified: false },
    ];
    expect(
      verdict({ automation: { commits } }, entry({ signed: false })).met,
    ).toBe(true);
    expect(verdict({ automation: { commits } }).met).toBe(false);
  });

  it("checks the update type only where the entry sets update types", () => {
    const major = { files: [bump("^1.2.3", "^2.0.0"), lockfile] };
    expect(verdict({ automation: major }).met).toBe(true);
    const typed = entry({ updateTypes: ["patch", "minor"] });
    const refused = verdict({ automation: major }, typed);
    expect(refused.met).toBe(false);
    expect(refused.fact).toContain(
      "its update type is major, outside patch, minor",
    );
    const minor = verdict(
      { automation: { files: [bump("^1.2.3", "^1.3.0")] } },
      typed,
    );
    expect(minor).toEqual({
      met: true,
      fact: "trusted automation renovate[bot]: same repository, 1 commit allowed, 1 file within its paths, a minor update",
    });
    const unread = verdict(
      { automation: { files: [manifest('+    "left-pad": "^1.0.0",')] } },
      typed,
    );
    expect(unread.fact).toContain(
      "its update type does not read: package.json: left-pad is added or removed",
    );
  });
});

describe("the update type a manifest diff shows", () => {
  it.each([
    [[bump("^1.2.3", "^1.2.4")], "patch"],
    [[bump("~1.2.3", "~1.4.0")], "minor"],
    [[bump("1.2.3", "2.0.0")], "major"],
    [[bump("^1.2.3", "1.2.3")], "pin"],
    [[lockfile], "lockfile"],
    [[bump("^1.2.3", "^1.2.4"), bump("^4.0.0", "^5.0.0", "other")], "major"],
  ] as const)("reads %j as %s", (files, type) => {
    expect(updateTypeOf(files)).toEqual(ok(type));
  });

  it.each([
    [
      "another manifest",
      [{ path: "go.mod", previous: null, patch: "" }],
      "go.mod is not a manifest",
    ],
    [
      "a manifest with no diff",
      [{ path: "package.json", previous: null, patch: null }],
      "gives no diff",
    ],
    [
      "a dependency added",
      [manifest('+    "left-pad": "^1.0.0",')],
      "added or removed",
    ],
    [
      "a range that is not a version",
      [bump("npm:x@1.0.0", "npm:x@1.0.1")],
      "not a version update",
    ],
    [
      "a line that is not a key and its version",
      [manifest('-  "scripts": {')],
      "not a key and its version",
    ],
    [
      "a manifest that changes no version",
      [manifest(' "a": "b"')],
      "changes no dependency's version",
    ],
  ])("does not read %s", (_what, files, why) => {
    const read = updateTypeOf(files as AutomationFile[]);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.reason).toContain(why);
  });
});

describe("the compare answer", () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    total_commits: 1,
    commits: [
      {
        sha: HEAD,
        author: { login: "renovate[bot]", type: "Bot" },
        commit: { verification: { verified: true } },
      },
    ],
    files: [
      { filename: "package.json", patch: "@@ x", previous_filename: null },
      { filename: "pnpm-lock.yaml", patch: "@@ lock" },
    ],
    ...over,
  });

  it("reads each commit's linked author and signature, and keeps a manifest's diff only", () => {
    expect(parseCompare(answer(), HEAD)).toEqual(
      ok({
        head: HEAD,
        commits: [{ sha: HEAD, login: "renovate[bot]", verified: true }],
        files: [
          { path: "package.json", previous: null, patch: "@@ x" },
          { path: "pnpm-lock.yaml", previous: null, patch: null },
        ],
      }),
    );
  });

  it.each([
    ["more commits than it lists", { total_commits: 2 }, "more commits"],
    [
      "a last commit that is not the head",
      { commits: [{ sha: EARLIER, author: null, commit: {} }] },
      "does not end at the head",
    ],
    [
      "as many files as one answer can hold",
      { files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) },
      "more files",
    ],
    ["no files", { files: null }, "holds no files"],
  ])("does not read %s", (_what, over, why) => {
    const read = parseCompare(answer(over), HEAD);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.reason).toContain(why);
  });

  it("reads a commit with no linked author as an empty login", () => {
    const read = parseCompare(
      answer({ commits: [{ sha: HEAD, author: null, commit: {} }] }),
      HEAD,
    );
    expect(read.ok && read.value.commits).toEqual([
      { sha: HEAD, login: "", verified: false },
    ]);
  });
});

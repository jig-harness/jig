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
  LISTING_PAGE,
  parseListings,
  type TrustedAuthor,
  trustedAutomationOf,
  trustedEntryFor,
  trustVerdict,
  updateTypeOf,
} from "../scripts/lib/trusted-automation.ts";
import { ok, failed } from "../../../shared/outcome.ts";
import {
  authorSatisfied,
  type ForgeFacts,
  type ReadyRules,
} from "../scripts/lib/merge-ready.ts";
import {
  AUTOMATION_CACHE_PREFIX,
  type AutomationCache,
  automationFor,
} from "../scripts/lib/trusted-automation-read.ts";

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
    commits: [
      {
        sha: HEAD,
        login: "renovate[bot]",
        committer: "renovate[bot]",
        verified: true,
      },
    ],
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
          commits: [
            {
              sha: HEAD,
              login: "outsider",
              committer: "outsider",
              verified: true,
            },
          ],
        },
      },
      "commit aaaaaaa is by outsider",
    ],
    [
      "a commit with no linked author",
      {
        automation: {
          commits: [{ sha: HEAD, login: "", committer: "", verified: true }],
        },
      },
      "commit aaaaaaa has no linked author",
    ],
    [
      "an unsigned commit by the bot",
      {
        automation: {
          commits: [
            {
              sha: HEAD,
              login: "renovate[bot]",
              committer: "renovate[bot]",
              verified: false,
            },
          ],
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
      {
        sha: EARLIER,
        login: "renovate[bot]",
        committer: "renovate[bot]",
        verified: false,
      },
      {
        sha: HEAD,
        login: "Host-Person",
        committer: "host-person",
        verified: false,
      },
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
      "it holds a major update, outside patch, minor",
    );
    const minor = verdict(
      { automation: { files: [bump("^1.2.3", "^1.3.0")] } },
      typed,
    );
    expect(minor).toEqual({
      met: true,
      fact: "trusted automation renovate[bot]: same repository, 1 commit allowed, 1 file within its paths, minor update",
    });
    const unread = verdict(
      {
        automation: {
          files: [
            manifest(
              `${'@@ -9,7 +9,7 @@\n   "dependencies": {\n'}+    "left-pad": "^1.0.0",`,
            ),
          ],
        },
      },
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
      [
        manifest(
          `${'@@ -9,7 +9,7 @@\n   "dependencies": {\n'}+    "left-pad": "^1.0.0",`,
        ),
      ],
      "added or removed",
    ],
    [
      "a range that is not a version",
      [bump("npm:x@1.0.0", "npm:x@1.0.1")],
      "not a version update",
    ],
    [
      "a hunk that does not show its section",
      [manifest('-    "left-pad": "^1.0.0",\n+    "left-pad": "^1.0.1",')],
      "does not show its section",
    ],
    ["a prerelease", [bump("^1.2.3-rc.1", "^1.2.3")], "not a version update"],
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

describe("the pull request's listings", () => {
  const commit = (over: Record<string, unknown> = {}) => ({
    sha: HEAD,
    author: { login: "renovate[bot]", type: "Bot" },
    committer: { login: "renovate[bot]" },
    commit: { verification: { verified: true } },
    ...over,
  });
  const fileList = () => [
    {
      filename: "package.json",
      status: "modified",
      patch: '@@ x\n+  "a": "1",',
      additions: 1,
      deletions: 0,
      previous_filename: null,
    },
    { filename: "pnpm-lock.yaml", status: "modified", patch: "@@ lock" },
  ];

  it("reads each commit's linked author, committer and signature, and keeps a manifest's changed lines only", () => {
    expect(parseListings([commit()], fileList(), HEAD)).toEqual(
      ok({
        head: HEAD,
        commits: [
          {
            sha: HEAD,
            login: "renovate[bot]",
            committer: "renovate[bot]",
            verified: true,
          },
        ],
        files: [
          {
            path: "package.json",
            previous: null,
            patch: '@@ x\n+  "a": "1",',
          },
          { path: "pnpm-lock.yaml", previous: null, patch: null },
        ],
      }),
    );
  });

  it.each([
    [
      "a last commit that is not the head",
      [commit({ sha: EARLIER })],
      fileList(),
      "does not end at the head",
    ],
    [
      "a full page of files",
      [commit()],
      Array.from({ length: 100 }, (_, i) => ({
        filename: `f${i}`,
        status: "added",
      })),
      "more files",
    ],
    ["no files", [commit()], [], "lists no changed file"],
    ["no file listing", [commit()], null, "holds no files"],
    [
      "a rename with no previous name",
      [commit()],
      [{ filename: "package.json", status: "renamed" }],
      "no previous name",
    ],
  ])("does not read %s", (_what, commits, files, why) => {
    const read = parseListings(commits, files, HEAD);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.reason).toContain(why);
  });

  it("reads a commit with no linked author as an empty login", () => {
    const read = parseListings(
      [{ sha: HEAD, author: null, commit: {} }],
      fileList(),
      HEAD,
    );
    expect(read.ok && read.value.commits).toEqual([
      { sha: HEAD, login: "", committer: "", verified: false },
    ]);
  });
});

describe("the rules a review found open", () => {
  it("refuses a signed commit whose committer is another account", () => {
    const commits = [
      {
        sha: HEAD,
        login: "renovate[bot]",
        committer: "someone",
        verified: true,
      },
    ];
    const v = verdict({ automation: { commits } });
    expect(v.met).toBe(false);
    expect(v.fact).toContain("signed for another committer");
  });

  it("refuses an unsigned repair commit by a listed committer unless signed is off", () => {
    const commits = [
      {
        sha: HEAD,
        login: "host-person",
        committer: "host-person",
        verified: false,
      },
    ];
    expect(verdict({ automation: { commits } }).met).toBe(false);
  });

  it("refuses present null list values", () => {
    for (const field of ["paths", "committers", "update_types"]) {
      const list = trustedAutomationOf(
        values([{ login: "renovate[bot]", [field]: null }]),
      );
      expect(list.ok).toBe(false);
    }
  });

  it("does not read the package's own version as a dependency", () => {
    const own = manifest(
      '@@ -1,5 +1,5 @@\n-  "version": "1.2.3",\n+  "version": "1.2.4",',
    );
    expect(updateTypeOf([own]).ok).toBe(false);
  });

  it("does not read a change outside the dependency sections", () => {
    const engines = manifest(
      '@@ -1,5 +1,5 @@\n   "engines": {\n-    "node": ">=18.1.0",\n+    "node": ">=18.1.1",',
    );
    expect(updateTypeOf([engines]).ok).toBe(false);
  });

  it("does not read a package changed in two sections without their headings", () => {
    const twice = manifest(
      '@@ -9,3 +9,3 @@\n-    "x": "1.0.0",\n+    "x": "1.0.1",\n@@ -20,3 +20,3 @@\n-    "x": "1.0.0",\n+    "x": "2.0.0",',
    );
    const read = updateTypeOf([twice]);
    expect(read.ok).toBe(false);
  });

  it("classifies ranges the policy can read and refuses the rest", () => {
    expect(updateTypeOf([bump("^1.0.0", "1")]).ok).toBe(false);
    expect(updateTypeOf([bump("^1.2.3", "~1.2.4")]).ok).toBe(false);
    expect(updateTypeOf([bump("1.2.4", "1.2.3")]).ok).toBe(false);
  });

  it("enforces update types per change, not by the largest", () => {
    const mixed = {
      files: [bump("^1.2.3", "^1.3.0"), bump("^2.0.0", "^2.0.1", "other")],
    };
    const minorOnly = entry({ updateTypes: ["minor"] });
    const v = verdict({ automation: mixed }, minorOnly);
    expect(v.met).toBe(false);
    expect(v.fact).toContain("patch update, outside minor");
    expect(
      verdict({ automation: mixed }, entry({ updateTypes: ["minor", "patch"] }))
        .met,
    ).toBe(true);
  });

  it("accepts a listing below the page and refuses one that fills it", () => {
    const commits = (n: number) => [
      ...Array.from({ length: n - 1 }, () => ({ sha: EARLIER })),
      { sha: HEAD },
    ];
    const files = (n: number) =>
      Array.from({ length: n }, () => ({
        filename: "pnpm-lock.yaml",
        status: "modified",
      }));
    expect(parseListings(commits(LISTING_PAGE - 1), files(1), HEAD).ok).toBe(
      true,
    );
    expect(parseListings(commits(LISTING_PAGE), files(1), HEAD).ok).toBe(false);
    expect(parseListings(commits(1), files(LISTING_PAGE - 1), HEAD).ok).toBe(
      true,
    );
    expect(parseListings(commits(1), files(LISTING_PAGE), HEAD).ok).toBe(false);
  });

  it("refuses a file with an empty name or a status it does not know", () => {
    const read = (file: Record<string, unknown>) =>
      parseListings([{ sha: HEAD }], [file], HEAD).ok;
    expect(read({ filename: "", status: "modified" })).toBe(false);
    expect(read({ filename: "a", status: "mystery" })).toBe(false);
    expect(read({ filename: "pnpm-lock.yaml", status: "modified" })).toBe(true);
  });
});

describe("the kept read", () => {
  const BASE = "b".repeat(40);
  const BAD_HEAD = "z".repeat(40);
  const forgeFacts = (baseOid: string, over: Record<string, unknown> = {}) =>
    ({
      number: 7,
      head: BAD_HEAD,
      author: "renovate[bot]",
      authorAssociation: "NONE",
      crossRepository: false,
      reviews: [],
      baseOid,
      ...over,
    }) as unknown as ForgeFacts;
  const rules = {
    reviewerApp: "reviewer",
    trustedAutomation: ok([entry()]),
  } as unknown as ReadyRules;
  const kept = {
    head: BAD_HEAD,
    baseOid: BASE,
    facts: { ...automation(), head: BAD_HEAD },
  };
  const cache = (): AutomationCache => {
    const rows = new Map<string, unknown>([
      [`${AUTOMATION_CACHE_PREFIX}o/r:7`, kept],
    ]);
    return {
      get: <T>(key: string) => (rows.get(key) ?? null) as T | null,
      set: (key, value) => void rows.set(key, value),
    };
  };

  it("reuses a read for the same head and base commit", async () => {
    const read = await automationFor(
      "o/r",
      forgeFacts(BASE),
      rules,
      5,
      cache(),
    );
    expect(read).toEqual(ok(kept.facts));
  });

  it("does not reuse it once the base commit moved", async () => {
    const read = await automationFor(
      "o/r",
      forgeFacts("c".repeat(40)),
      rules,
      5,
      cache(),
    );
    expect(read?.ok).toBe(false);
  });

  it("does not read at all where an own association already satisfies condition 8", async () => {
    const own = forgeFacts(BASE, { authorAssociation: "MEMBER" });
    expect(await automationFor("o/r", own, rules, 5, cache())).toBeUndefined();
  });

  it("does not read at all where a qualifying approval already satisfies condition 8", async () => {
    const approved = forgeFacts(BASE, {
      reviews: [
        {
          author: "someone",
          person: true,
          association: "MEMBER",
          state: "APPROVED",
          commit: BAD_HEAD,
        },
      ],
    });
    expect(authorSatisfied(approved)).toBe(true);
    expect(
      await automationFor("o/r", approved, rules, 5, cache()),
    ).toBeUndefined();
  });

  it("does not read where no reviewer app is named", async () => {
    const none = { ...rules, reviewerApp: null } as unknown as ReadyRules;
    expect(
      await automationFor("o/r", forgeFacts(BASE), none, 5, cache()),
    ).toBeUndefined();
  });
});

describe("structure, ranges, moves and counts", () => {
  const read = (files: AutomationFile[]) => updateTypeOf(files);
  it("does not read an edit after the dependency section closed", () => {
    const patch =
      '@@ -9,7 +9,7 @@\n   "dependencies": {\n     "a": "^1.0.0"\n   },\n-  "version": "1.0.0",\n+  "version": "1.0.1",';
    expect(read([manifest(patch)]).ok).toBe(false);
    const closed =
      '@@ -9,7 +9,7 @@\n   "dependencies": {\n     "a": "^1.0.0"\n   },\n-    "x": "1.0.0",\n+    "x": "1.0.1",';
    expect(read([manifest(closed)]).ok).toBe(false);
  });
  it("does not read a nested object named like a dependency section", () => {
    const patch =
      '@@ -9,7 +9,7 @@\n   "config": {\n     "dependencies": {\n-      "a": "^1.0.0",\n+      "a": "^1.0.1",';
    expect(read([manifest(patch)]).ok).toBe(false);
  });
  it("tells a bare partial range from an exact version", () => {
    expect(read([bump("1.2", "1.3")])).toEqual(ok("minor"));
    expect(read([bump("1.2.3", "1.3")]).ok).toBe(false);
    expect(read([bump("1.2", "1.2.0")])).toEqual(ok("pin"));
  });
  it("does not read a file moved to a lockfile name from another name", () => {
    expect(
      read([{ path: "pnpm-lock.yaml", previous: "notes.txt", patch: null }]).ok,
    ).toBe(false);
  });
  it("withholds a manifest patch whose line counts differ from the file's", () => {
    const listed = parseListings(
      [
        {
          sha: HEAD,
          author: { login: "renovate[bot]" },
          committer: { login: "renovate[bot]" },
          commit: { verification: { verified: true } },
        },
      ],
      [
        {
          filename: "package.json",
          status: "modified",
          patch: '@@ x\n+  "a": "1",',
          additions: 2,
          deletions: 0,
        },
      ],
      HEAD,
    );
    expect(listed.ok && listed.value.files[0]?.patch).toBeNull();
  });
});

import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { withoutLeakyGitEnv } from "../../../shared/guarded-git-spawn.ts";
import {
  body,
  CHANNELS,
  draft,
  fallbackUrl,
  fileArgs,
  formUrl,
  JIG_REPOSITORY,
  redact,
  remoteOwnerName,
  replacementsFor,
  searchArgs,
  searchUrl,
  splitFacetLabels,
} from "../scripts/report-bug.ts";

const script = join(import.meta.dir, "..", "scripts", "report-bug.ts");
const form = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    ".github",
    "ISSUE_TEMPLATE",
    "bug.yml",
  ),
  "utf8",
);

/** The bug form's fields, in order: each `- type:` entry's id and label. */
function formFields(): { id: string; label: string }[] {
  return form
    .split(/\n {2}- type: /)
    .slice(1)
    .map((entry) => ({
      id: /\n {4}id: (\S+)/.exec(entry)?.[1] ?? "",
      label: /\n {6}label: (.+)/.exec(entry)?.[1]?.trim() ?? "",
    }));
}

test("the body's headings are the bug form's labels, in its order", () => {
  const headings = [
    ...body({
      version: "1.2.3",
      channel: "stable",
      what: "w",
      expected: "e",
      tools: "t",
    }).matchAll(/^### (.+)$/gm),
  ].map((m) => m[1]);
  expect(headings).toEqual(formFields().map((f) => f.label));
});

test("the form address fills only fields the form has, and the channels are its options", () => {
  const ids = new Set(formFields().map((f) => f.id));
  const { url } = formUrl("x: y", {
    version: "1",
    "last-working": "0.9.0",
    what: "w",
    expected: "e",
    tools: "t",
    channel: "stable",
  });
  const query = new URL(url).searchParams;
  expect(query.get("channel")).toBe("stable");
  for (const key of query.keys())
    if (key !== "template" && key !== "title") expect(ids).toContain(key);
  const options = /id: channel[\s\S]*?options:\n((?:\s+- .+\n)+)/
    .exec(form)?.[1]
    ?.split("\n")
    .map((line) => line.replace(/^\s+- /, "").trim())
    .filter(Boolean);
  expect(Object.values(CHANNELS)).toEqual(options ?? []);
});

test("a long account leaves what happened out of the address", () => {
  const long = "x".repeat(9000);
  const result = formUrl("x: y", { version: "1", what: long });
  expect(result.complete).toBe(false);
  expect(new URL(result.url).searchParams.has("what")).toBe(false);
});

test("an oversized field is left out, in a fixed order, until the address fits", () => {
  const result = formUrl("x: y", {
    version: "1",
    what: "w".repeat(9000),
    expected: "x".repeat(9000),
  });
  expect(result.url.length).toBeLessThanOrEqual(8000);
  expect(result.omitted).toEqual(["What happened", "What you expected"]);
  const huge = formUrl("t".repeat(9000), { version: "1" });
  expect(huge.url.length).toBeLessThanOrEqual(8000);
  expect(huge.omitted).toEqual(["the title"]);
});

test("the fallback address targets the bug form with the edited title and body", () => {
  const { url, omitted } = fallbackUrl({ title: "a: b", body: "edited body" });
  const parsed = new URL(url);
  expect(parsed.searchParams.get("template")).toBe("bug.yml");
  expect(parsed.searchParams.get("what")).toBe("edited body");
  expect(parsed.searchParams.get("title")).toBe("a: b");
  expect(omitted).toEqual([]);
});

test("the fallback address names what it leaves out when too long", () => {
  const long = fallbackUrl({ title: "t", body: "x".repeat(9000) });
  expect(long.url.length).toBeLessThanOrEqual(8000);
  expect(long.omitted).toEqual(["What happened"]);
  const title = fallbackUrl({ title: "t".repeat(9000), body: "b" });
  expect(title.url.length).toBeLessThanOrEqual(8000);
  expect(title.omitted).toContain("the title");
});

test("a filesystem remote yields its owner and name", () => {
  expect(remoteOwnerName("/srv/acme-co/storefront.git")).toEqual({
    owner: "acme-co",
    name: "storefront",
  });
  expect(remoteOwnerName("../acme-co/storefront")).toEqual({
    owner: "acme-co",
    name: "storefront",
  });
});

test("a file URL and a bare relative path read like the filesystem path", () => {
  const want = { owner: "acme-co", name: "storefront" };
  expect(remoteOwnerName("file:///srv/acme-co/storefront.git")).toEqual(want);
  expect(remoteOwnerName("acme-co/storefront.git")).toEqual(want);
});

test("the fallback address fills each form field from a draft body", () => {
  const fields = {
    version: "1.2.3",
    channel: "marketplace",
    lastWorking: undefined,
    what: "it parked",
    expected: "it converges",
    tools: "Claude Code on Linux",
  };
  const parsed = new URL(fallbackUrl({ title: "t", body: body(fields) }).url);
  expect(fallbackUrl({ title: "t", body: body(fields) }).split).toBe(true);
  expect(parsed.searchParams.get("version")).toBe("1.2.3");
  expect(parsed.searchParams.get("channel")).toBe("marketplace");
  expect(parsed.searchParams.get("what")).toBe("it parked");
  expect(parsed.searchParams.get("expected")).toBe("it converges");
  expect(parsed.searchParams.has("last-working")).toBe(false);
  expect(fallbackUrl({ title: "t", body: "edited" }).split).toBe(false);
});

test("a body edited to drop a blank line before a heading loses no text", () => {
  const edited = body({
    version: "1.2.3",
    channel: "marketplace",
    what: "it parked",
    expected: "it converges",
    tools: "Claude Code on Linux",
  }).replace(
    "it parked\n\n### What you expected",
    "it parked\n### What you expected",
  );
  const r = fallbackUrl({ title: "t", body: edited });
  expect(r.split).toBe(true);
  expect(new URL(r.url).searchParams.get("what")).toBe("it parked");
});

test("an answer that starts with an indented code block keeps its indentation", () => {
  const edited = body({
    version: "1.2.3",
    channel: "marketplace",
    what: "it parked",
    expected: "it converges",
    tools: "Claude Code on Linux",
  }).replace("\nit parked\n", "\n    bun run gates\n    exit 1\n");
  const r = fallbackUrl({ title: "t", body: edited });
  expect(r.split).toBe(true);
  expect(new URL(r.url).searchParams.get("what")).toBe(
    "    bun run gates\n    exit 1",
  );
});

test("a body quoting a form heading is kept whole, not split at the quote", () => {
  const fields = {
    version: "1.2.3",
    channel: "marketplace",
    what: "```md\n### What you expected\n\nsample\n```",
    expected: "it converges",
    tools: "Claude Code on Linux",
  };
  const r = fallbackUrl({ title: "t", body: body(fields) });
  expect(r.split).toBe(false);
  expect(new URL(r.url).searchParams.has("expected")).toBe(false);
});

test("an oversized version is omitted so the address fits", () => {
  const fields = {
    version: "9".repeat(9000),
    channel: "marketplace",
    what: "w",
    expected: "e",
    tools: "t",
  };
  const r = fallbackUrl({ title: "t", body: body(fields) });
  expect(r.url.length).toBeLessThanOrEqual(8000);
  expect(r.omitted).toContain("Plugin version");
});

test("a nested remote namespace is redacted whole", () => {
  expect(
    remoteOwnerName("git@gitlab.example:private-org/team/service.git"),
  ).toEqual({
    owner: "private-org/team",
    name: "service",
  });
  const r = replacementsFor({
    root: "/r",
    home: "/h",
    remoteAddress: "https://gitlab.example/private-org/team/service.git",
  });
  expect(redact("private-org/team/service", r).text).not.toMatch(/private-org/);
});

test("a placeholder is never redacted again by a later replacement", () => {
  const r = replacementsFor({
    root: "/src/repository",
    home: "/h",
    remoteAddress: "git@example.com:owner/repository.git",
  });
  expect(redact("/src/repository/app", r).text).toBe("<repository>/app");
  expect(redact("owner/repository", r).text).toBe("<owner>/<repository-name>");
});

test("a channel inherited from Object.prototype is not a channel", () => {
  const run = Bun.spawnSync(
    [
      "bun",
      script,
      "draft",
      "--skill",
      "x",
      "--symptom",
      "s",
      "--what",
      script,
      "--expected",
      "e",
      "--channel",
      "constructor",
    ],
    { env: withoutLeakyGitEnv() },
  );
  expectSpawnExit(run, 2, "draft --channel constructor");
});

test("the owner and name are read from SSH and HTTPS addresses", () => {
  expect(remoteOwnerName("git@github.com:acme-co/storefront.git")).toEqual({
    owner: "acme-co",
    name: "storefront",
  });
  expect(
    remoteOwnerName("https://git.example.com/acme-co/storefront/"),
  ).toEqual({
    owner: "acme-co",
    name: "storefront",
  });
});

test("the repository's names, paths and issue keys become placeholders", () => {
  const replacements = replacementsFor({
    root: "/home/dev/src/storefront",
    home: "/home/dev",
    remoteAddress: "git@github.com:acme-co/storefront.git",
    trackerTeam: "SHOP",
  });
  const { text, matched } = redact(
    "In /home/dev/src/storefront/app, acme-co/storefront's SHOP-142 broke; Acme-Co config in /home/dev/.jig",
    replacements,
  );
  expect(text).toBe(
    "In <repository>/app, <owner>/<repository-name>'s <issue> broke; <owner> config in ~/.jig",
  );
  expect(text).not.toMatch(/storefront|acme|SHOP-/i);
  expect(matched.size).toBe(5);
});

test("Jig's own repository keeps its names", () => {
  const replacements = replacementsFor({
    root: "/src/jig",
    home: "/home/dev",
    remoteAddress: `https://github.com/${JIG_REPOSITORY}.git`,
  });
  expect(redact("jig-harness/jig drive-pr", replacements).text).toBe(
    "jig-harness/jig drive-pr",
  );
});

test("the draft is titled by skill and symptom, with the form's channel answer", () => {
  const result = draft(
    {
      skill: "drive-pr",
      symptom: "parks in storefront",
      what: "output",
      expected: "converges",
      channel: "tag",
      tool: "Codex 0.160",
    },
    {
      version: "1.2.3",
      os: "Linux 6",
      replacements: replacementsFor({
        root: "/r",
        home: "/home/dev",
        remoteAddress: "git@github.com:acme-co/storefront.git",
      }),
    },
  );
  expect(result.title).toBe("drive-pr: parks in <repository-name>");
  expect(result.body).toContain(
    "### Where you installed it from\n\na pinned tag\n",
  );
  expect(result.body).toContain(
    "### Agent tool and operating system\n\nCodex 0.160 on Linux 6\n",
  );
  expect(result.body).toContain(
    "### Last version it worked in\n\n_No response_\n",
  );
  expect(result.labels).toEqual(["jig"]);
  expect(fileArgs(result)).toEqual([
    "issue",
    "create",
    "--repo",
    "jig-harness/jig",
    "--title",
    "drive-pr: parks in <repository-name>",
    "--label",
    "jig",
    "--type",
    "Bug",
    "--body-file",
    "-",
  ]);
});

test("a draft's type, priority and size labels are dropped, whatever their case", () => {
  const labels = [
    "bug",
    "jig",
    "small",
    "priority: high",
    "Priority:Urgent",
    "type:feature",
    "XL",
    "area:plugin",
  ];
  expect(splitFacetLabels(labels)).toEqual({
    kept: ["jig", "area:plugin"],
    dropped: [
      "bug",
      "small",
      "priority: high",
      "Priority:Urgent",
      "type:feature",
      "XL",
    ],
  });
  const args = fileArgs({ title: "t", labels });
  expect(args.filter((_, i) => args[i - 1] === "--label")).toEqual([
    "jig",
    "area:plugin",
  ]);
  expect(fileArgs({ title: "t", labels }, false)).not.toContain("--type");
});

test("the search covers closed issues, and has an address to search by hand", () => {
  const args = searchArgs("drive-pr parks");
  expect(args.slice(0, 8)).toEqual([
    "issue",
    "list",
    "--repo",
    "jig-harness/jig",
    "--state",
    "all",
    "--search",
    "drive-pr parks",
  ]);
  expect(new URL(searchUrl("drive-pr parks")).searchParams.get("q")).toBe(
    "is:issue drive-pr parks",
  );
});

test("run in a consumer repository, the draft carries none of its names", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "jig-report-bug-")));
  // The root preloads point JIG_OVERLAY at a fixture; the child reads the
  // repository's own file.
  const env = withoutLeakyGitEnv({
    ...process.env,
    CLAUDECODE: "",
    JIG_OVERLAY: undefined,
    JIG_CONSUMER_ROOT: undefined,
  });
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", repo, ...args], { env });
    expectSpawnExit(run, 0, `git ${args.join(" ")}`);
  };
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:acme-co/storefront.git");
  mkdirSync(join(repo, ".config"));
  writeFileSync(
    join(repo, ".config", "jig.yaml"),
    "issue_tracker:\n  team: SHOP\n",
  );
  const what = join(repo, "what.txt");
  writeFileSync(
    what,
    `ran in ${repo} on acme-co/storefront for SHOP-7\nexit 3\n`,
  );
  const out = join(repo, "draft.json");
  const run = Bun.spawnSync(
    [
      process.execPath,
      script,
      "draft",
      "--skill",
      "drive-pr",
      "--symptom",
      "storefront drive parks",
      "--what",
      what,
      "--expected",
      "it converges",
      "--channel",
      "stable",
      "--out",
      out,
    ],
    { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(run, 0);
  const parsed = JSON.parse(readFileSync(out, "utf8")) as {
    body: string;
    title: string;
    url: string;
  };
  // What is published: the title, the body and the form's address.
  for (const published of [
    parsed.title,
    parsed.body,
    decodeURIComponent(parsed.url),
  ]) {
    expect(published).not.toMatch(/storefront|acme-co|SHOP-7/i);
    expect(published).not.toContain(repo);
  }
  expect(run.stdout.toString()).toContain(parsed.body);
  expect(parsed.title).toBe("drive-pr: <repository-name> drive parks");
});

test("a missing field, an unknown channel or no command is a usage error", () => {
  const missing = Bun.spawnSync(
    [process.execPath, script, "draft", "--skill", "drive-pr"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expectSpawnExit(missing, 2);
  expect(missing.stderr.toString()).toContain("is required");
  const what = join(mkdtempSync(join(tmpdir(), "jig-report-bug-")), "what.txt");
  writeFileSync(what, "x\n");
  const channel = Bun.spawnSync(
    [
      process.execPath,
      script,
      "draft",
      "--skill",
      "drive-pr",
      "--symptom",
      "s",
      "--what",
      what,
      "--expected",
      "e",
      "--channel",
      "nightly",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(channel, 2);
  expect(channel.stderr.toString()).toContain("--channel must be one of");
  const none = Bun.spawnSync([process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(none, 2);
  expect(none.stderr.toString()).toContain("report-bug.ts search");
});

test("with no gh, file prints the form address and does not search", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  const draft = join(dir, "draft.json");
  writeFileSync(
    draft,
    JSON.stringify({ title: "t", body: "b", labels: ["bug"], url: "u" }),
  );
  const run = Bun.spawnSync([process.execPath, script, "file", draft], {
    env: { ...process.env, PATH: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(run, 1);
  const err = run.stderr.toString();
  expect(err).toContain("Open the form instead: https://github.com/");
  expect(err).toContain("template=bug.yml");
  expect(err).not.toContain("unknown");
});

test("with gh not logged in, file prints the form address and does not search", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  const draft = join(dir, "draft.json");
  writeFileSync(
    draft,
    JSON.stringify({ title: "t", body: "b", labels: ["bug"], url: "u" }),
  );
  writeFakeProgram(join(dir, "gh"), "#!/bin/sh\nexit 4\n");
  const run = Bun.spawnSync([process.execPath, script, "file", draft], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(run, 1);
  const err = run.stderr.toString();
  expect(err).toContain("Open the form instead: https://github.com/");
  expect(err).not.toContain("unknown");
});

/**
 * A `gh` that logs every call's arguments to `calls.log`, answers an issue
 * search with no issue, and answers a create with `create` (a shell fragment
 * run with the arguments in `$*`) as #900 when it does not say otherwise.
 */
function filingGh(
  dir: string,
  create = "echo https://github.com/jig-harness/jig/issues/900",
  list = "echo '[]'",
  view = `echo '{"issueType":{"name":"Bug"}}'`,
): void {
  writeFakeProgram(
    join(dir, "gh"),
    [
      "#!/bin/sh",
      `echo "$*" >> "${join(dir, "calls.log").replaceAll("\\", "/")}"`,
      `if [ "$1 $2" = "issue list" ]; then ${list}; exit $?; fi`,
      `if [ "$1 $2" = "issue view" ]; then ${view}; exit $?; fi`,
      `if [ "$1 $2" = "issue create" ]; then cat >/dev/null; ${create}; exit $?; fi`,
      "exit 7",
    ].join("\n"),
  );
}

function fileDraft(dir: string, labels = ["bug"]) {
  const draft = join(dir, "draft.json");
  writeFileSync(
    draft,
    JSON.stringify({ title: "t", body: "b", labels, url: "u" }),
  );
  return Bun.spawnSync([process.execPath, script, "file", draft], {
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function calls(dir: string): string[] {
  return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
}

test("file creates the issue with the issue type Bug and no facet label", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir);
  const run = fileDraft(dir, ["bug", "jig", "small", "priority: high"]);
  expectSpawnExit(run, 0);
  expect(run.stdout.toString()).toContain(
    "https://github.com/jig-harness/jig/issues/900",
  );
  expect(calls(dir)).toEqual([
    "issue create --repo jig-harness/jig --title t --label jig --type Bug --body-file -",
    "issue view https://github.com/jig-harness/jig/issues/900 --json issueType",
  ]);
  const err = run.stderr.toString();
  expect(err).toContain("dropped the labels bug, small, priority: high");
  expect(err).not.toContain("without the issue type");
});

test("a draft with no facet label drops nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir);
  const run = fileDraft(dir, ["jig"]);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toBe("");
});

test("an account that may not set issue types still files, and is told so", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(
    dir,
    `case "$*" in *"--type Bug"*) echo 'GraphQL: the viewer may not set the issue type' >&2; exit 1;; *) echo https://github.com/jig-harness/jig/issues/900;; esac`,
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stdout.toString()).toContain(
    "https://github.com/jig-harness/jig/issues/900",
  );
  expect(run.stderr.toString()).toContain(
    "filed without the issue type Bug (GraphQL: the viewer may not set the issue type)",
  );
  const filed = calls(dir).filter((c) => c.startsWith("issue create"));
  expect(filed).toHaveLength(2);
  expect(filed[1]).not.toContain("--type");
});

test("a failure that does not name the type is not filed again without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir, "echo 'HTTP 502: bad gateway' >&2; exit 1");
  const run = fileDraft(dir);
  expectSpawnExit(run, 1);
  expect(calls(dir).filter((c) => c.startsWith("issue create"))).toHaveLength(
    1,
  );
});

test("an account whose create drops the type without an error is told so", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir, undefined, undefined, `echo '{"issueType":null}'`);
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toContain("filed without the issue type Bug");
});

test.each([
  ["a boolean", `{"issueType":false}`],
  ["an empty object", `{"issueType":{}}`],
  ["another type", `{"issueType":{"name":"Task"}}`],
])("an issue type that is %s is not read as Bug", (_name, view) => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir, undefined, undefined, `echo '${view}'`);
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toContain(
    "could not verify the issue type Bug",
  );
});

test("an older gh with no --type files without it", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(
    dir,
    `case "$*" in *"--type Bug"*) echo 'unknown flag: --type' >&2; exit 1;; *) echo https://github.com/jig-harness/jig/issues/900;; esac`,
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toContain(
    "filed without the issue type Bug (unknown flag: --type)",
  );
});

test("a type failure after the issue was created does not file it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(
    dir,
    "echo 'GraphQL: issue type not readable' >&2; exit 1",
    `echo '[{"number":900,"title":"t","state":"OPEN","url":"https://github.com/jig-harness/jig/issues/900"}]'`,
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 1);
  expect(run.stderr.toString()).toContain(
    "The issue exists already, so do not file it again: https://github.com/jig-harness/jig/issues/900",
  );
  expect(calls(dir).filter((c) => c.startsWith("issue create"))).toHaveLength(
    1,
  );
});

test("a type failure with no way to look for the issue does not file it again", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(
    dir,
    "echo 'GraphQL: issue type not readable' >&2; exit 1",
    "exit 1",
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 1);
  expect(run.stderr.toString()).toContain(
    "Whether the issue was created is unknown",
  );
  expect(calls(dir).filter((c) => c.startsWith("issue create"))).toHaveLength(
    1,
  );
});

test("labels joined by commas are split before the facet ones are dropped", () => {
  expect(splitFacetLabels(["jig,bug,small", "priority: high, extra"])).toEqual({
    kept: ["jig", "extra"],
    dropped: ["bug", "small", "priority: high"],
  });
  expect(
    fileArgs({ title: "t", labels: ["small,jig,bug"] }).filter(
      (a) => a === "--label",
    ),
  ).toHaveLength(1);
});

test.each([
  ["an object", "{}"],
  ["an entry with no number", `[{"title":"t"}]`],
])(
  "a type failure whose listing is %s is not filed again",
  (_name, listing) => {
    const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
    filingGh(
      dir,
      "echo 'GraphQL: issue type not readable' >&2; exit 1",
      `echo '${listing}'`,
    );
    const run = fileDraft(dir);
    expectSpawnExit(run, 1);
    expect(run.stderr.toString()).toContain(
      "Whether the issue was created is unknown",
    );
    expect(calls(dir).filter((c) => c.startsWith("issue create"))).toHaveLength(
      1,
    );
  },
);

test("a type failure with a full window of newer issues is not filed again", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  const newer = Array.from({ length: 30 }, (_v, i) => ({
    number: i + 1,
    title: `other ${i}`,
    state: "OPEN",
    url: `https://github.com/jig-harness/jig/issues/${i + 1}`,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  filingGh(
    dir,
    "echo 'GraphQL: issue type not readable' >&2; exit 1",
    `echo '${JSON.stringify(newer)}'`,
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 1);
  expect(run.stderr.toString()).toContain(
    "Whether the issue was created is unknown",
  );
});

test("a full window reaching back before the attempt still files without the type", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  const older = Array.from({ length: 30 }, (_v, i) => ({
    number: i + 1,
    title: `other ${i}`,
    state: "OPEN",
    url: `https://github.com/jig-harness/jig/issues/${i + 1}`,
    createdAt: "2020-01-01T00:00:00Z",
  }));
  filingGh(
    dir,
    `case "$*" in *"--type Bug"*) echo 'GraphQL: the viewer may not set the issue type' >&2; exit 1;; *) echo https://github.com/jig-harness/jig/issues/900;; esac`,
    `echo '${JSON.stringify(older)}'`,
  );
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toContain("filed without the issue type Bug");
});

test.each([
  ["a failed read-back", "exit 1"],
  ["a malformed read-back", "echo '[]'"],
  ["a read-back with no type field", "echo '{}'"],
])("%s warns that the type could not be verified", (_name, view) => {
  const dir = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
  filingGh(dir, undefined, undefined, view);
  const run = fileDraft(dir);
  expectSpawnExit(run, 0);
  expect(run.stderr.toString()).toContain(
    "could not verify the issue type Bug",
  );
});

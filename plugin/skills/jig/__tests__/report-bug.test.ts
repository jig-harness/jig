import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { withoutLeakyGitEnv } from "../../../shared/guarded-git-spawn.ts";
import {
  body,
  CHANNELS,
  draft,
  fileArgs,
  formUrl,
  JIG_REPOSITORY,
  redact,
  remoteOwnerName,
  replacementsFor,
  searchArgs,
  searchUrl,
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
  });
  const query = new URL(url).searchParams;
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
  expect(fileArgs(result)).toEqual([
    "issue",
    "create",
    "--repo",
    "jig-harness/jig",
    "--title",
    "drive-pr: parks in <repository-name>",
    "--label",
    "bug",
    "--body-file",
    "-",
  ]);
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
  const repo = mkdtempSync(join(tmpdir(), "jig-report-bug-"));
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

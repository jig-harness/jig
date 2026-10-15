import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../lib/guarded-git-spawn.ts";
import type { Catalog } from "./change-areas.ts";
import {
  NotAncestor,
  NotOnMain,
  RECORD,
  advance,
  formatPlan,
  kindOf,
  parseLog,
  plan,
  readRecord,
} from "./website-sync.ts";

const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);
const temp = mkdtempSync(join(tmpdir(), "jig-website-sync-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function area(paths: string[], category: string, impliedBy: string[] = []) {
  return {
    title: "An area",
    category,
    paths,
    workspace: [],
    impliedBy,
    deployTier: "none",
  };
}

const catalog: Catalog = {
  website: area(["site/**"], "docs", ["docs", "skills", "toolchain"]),
  docs: area(["*.md", "changes/**"], "docs"),
  skills: area(["skills/**"], "skill", ["notes"]),
  notes: area(["notes/**"], "docs"),
  toolchain: area(["package.json", "bun.lock", ".config/**"], "infra", [
    "shared",
  ]),
  shared: area(["lib/**"], "tooling"),
  gates: area(["scripts/**"], "tooling"),
};

const CATALOG_YAML = `areas:
${Object.entries(catalog)
  .map(
    ([id, a]) => `  ${id}:
    title: "${a.title}"
    category: ${a.category}
    paths: ${JSON.stringify(a.paths)}
    workspace: []
    impliedBy: ${JSON.stringify(a.impliedBy)}
    deployTier: none`,
  )
  .join("\n")}
`;

function scratch(name: string) {
  const root = join(temp, name);
  mkdirSync(root);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { env: safeEnv });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "-q", "-b", "main");
  const commit = (subject: string, files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    git("add", "-A");
    git(
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      subject,
    );
    // origin/main follows the local main, as a fetch would.
    git("update-ref", "refs/remotes/origin/main", "refs/heads/main");
    return git("rev-parse", "HEAD");
  };
  const base = commit("start", {
    ".config/change-areas.yaml": CATALOG_YAML,
    "README.md": "one\n",
  });
  // The record stays out of the scratch commits, so each counts only its own files.
  writeFileSync(join(root, ".git/info/exclude"), `${RECORD}\n`);
  mkdirSync(dirname(join(root, RECORD)), { recursive: true });
  writeFileSync(join(root, RECORD), `commit: ${base}\ndate: "2026-01-01"\n`);
  return { root, git, commit, base };
}

test("a commit's kind follows the areas the site is implied by", () => {
  expect(kindOf(["docs"], catalog)).toBe("content");
  expect(kindOf(["skills", "gates"], catalog)).toBe("content");
  // A content area outranks the site's own files in the same commit.
  expect(kindOf(["website", "docs"], catalog)).toBe("content");
  expect(kindOf(["toolchain"], catalog)).toBe("build");
  expect(kindOf(["website"], catalog)).toBe("site");
  expect(kindOf(["gates"], catalog)).toBe("outside");
  expect(kindOf([], catalog)).toBe("outside");
});

test("an area that reaches the site through another area counts, as resolveAreas follows it", () => {
  expect(kindOf(["shared"], catalog)).toBe("build");
  expect(kindOf(["notes"], catalog)).toBe("content");
});

const A = "a".repeat(40);
const B = "b".repeat(40);

test("lockfiles, fixtures, vendored and binary files are listed but not counted", () => {
  // git log -z: NUL after every field, one newline before the first stat.
  const log = [
    A,
    "2026-01-02",
    "docs: one\tsubject with a tab",
    "\n3\t1\tREADME.md",
    "900\t0\tbun.lock",
    "50\t0\tscripts/fixtures/big.json",
    "70\t0\tlib/vendor/x.mjs",
    "-\t-\tlogo.png",
    B,
    "2026-01-03",
    "chore: empty",
    "",
  ].join("\0");
  expect(parseLog(log)).toEqual([
    {
      sha: A,
      date: "2026-01-02",
      subject: "docs: one\tsubject with a tab",
      lines: 4,
      paths: [
        "README.md",
        "bun.lock",
        "scripts/fixtures/big.json",
        "lib/vendor/x.mjs",
        "logo.png",
      ],
    },
    {
      sha: B,
      date: "2026-01-03",
      subject: "chore: empty",
      lines: 0,
      paths: [],
    },
  ]);
});

test("a subject shaped like a stat and paths with tabs, newlines and quotes come through as written", () => {
  const log = [
    A,
    "2026-01-02",
    "1\t2\tnot-a-path",
    "\n1\t0\ta\tb.md",
    "2\t0\tline\nbreak.md",
    '1\t1\tq"uote\\.md',
    "",
  ].join("\0");
  const [commit] = parseLog(log);
  expect(commit?.subject).toBe("1\t2\tnot-a-path");
  expect(commit?.paths).toEqual(["a\tb.md", "line\nbreak.md", 'q"uote\\.md']);
  expect(commit?.lines).toBe(5);
});

test("malformed log output is an error, never a short list", () => {
  expect(() => parseLog(`${A}\0not-a-date\0s\0`)).toThrow("commit header");
  expect(() => parseLog(`${A}\x002026-01-02\0`)).toThrow("commit header");
  expect(() => parseLog(`${A}\x002026-01-02\0s\0\njunk\0`)).toThrow("stat");
});

test("the plan lists the commits after the record, oldest first, with kind and size", () => {
  const { root, commit } = scratch("plan");
  commit("docs: a new paragraph (#1)", { "README.md": "one\ntwo\n" });
  commit("chore: a gate", { "scripts/gate.ts": "x\n".repeat(30) });
  commit("feat(website): a page", { "site/page.astro": "p\n" });
  const tip = commit("chore: bump a dependency", { "package.json": "{}\n" });
  const p = plan(root, "main", 20);
  expect(p.toCommit).toBe(tip);
  expect(p.baseDate).toBe("2026-01-01");
  expect(
    p.commits.map((c) => [c.subject, c.kind, c.lines, c.oversized, c.areas]),
  ).toEqual([
    ["docs: a new paragraph (#1)", "content", 1, false, ["docs"]],
    ["chore: a gate", "outside", 30, true, ["gates"]],
    ["feat(website): a page", "site", 1, false, ["website"]],
    ["chore: bump a dependency", "build", 1, false, ["toolchain"]],
  ]);
  const text = formatPlan(p);
  expect(text).toContain("4 commit(s) after");
  expect(text).toContain("(checked 2026-01-01)");
  expect(text).toContain("[OVERSIZED]");
  expect(text).toContain("1 commit(s) over 20 counted lines");
});

test("a path with a tab keeps its area in a real repository", () => {
  const { root, commit } = scratch("odd-paths");
  commit("docs: odd names", { "a\tb.md": "x\n", 'q"uote.md': "y\n" });
  const [c] = plan(root, "main").commits;
  expect(c?.areas).toEqual(["docs"]);
  expect(c?.kind).toBe("content");
  expect(c?.lines).toBe(2);
});

test("nothing new is an empty plan", () => {
  const { root } = scratch("empty");
  expect(plan(root, "main").commits).toEqual([]);
});

test("advance records a descendant and refuses anything else", () => {
  const { root, git, commit, base } = scratch("advance");
  const next = commit("docs: more (#2)", { "README.md": "three\n" });
  expect(advance(root, "main", "2026-02-02")).toBe(next);
  expect(readRecord(root)).toEqual({ commit: next, date: "2026-02-02" });
  expect(readFileSync(join(root, RECORD), "utf8")).toStartWith("# ");
  expect(plan(root, "main").commits).toEqual([]);
  // Back to a commit before the record: not a descendant.
  expect(() => advance(root, base, "2026-02-03")).toThrow(NotAncestor);
  // A commit of main before the record: not a descendant.
  expect(() => plan(root, base)).toThrow(NotAncestor);
  // A branch descending from the record is not main: neither planned nor recorded.
  git("checkout", "-q", "-b", "side", next);
  const side = commit("docs: elsewhere", { "README.md": "side\n" });
  expect(() => plan(root, "side")).toThrow(NotOnMain);
  expect(() => advance(root, side, "2026-02-03")).toThrow(NotOnMain);
  expect(readRecord(root).commit).toBe(next);
});

test("a record naming a commit off main is refused", () => {
  const { root, git, commit, base } = scratch("off-main");
  git("checkout", "-q", "-b", "side", base);
  const side = commit("docs: elsewhere", { "README.md": "side\n" });
  git("checkout", "-q", "main");
  commit("docs: on main", { "README.md": "main\n" });
  writeFileSync(join(root, RECORD), `commit: ${side}\n`);
  expect(() => plan(root, "main")).toThrow(NotOnMain);
});

test("a record merged into main as a second parent is refused when advancing too", () => {
  const { root, git, commit, base } = scratch("second-parent");
  git("checkout", "-q", "-b", "side", base);
  const side = commit("docs: elsewhere", { "SIDE.md": "side\n" });
  git("checkout", "-q", "main");
  commit("docs: on main", { "README.md": "main\n" });
  git(
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "merge",
    "-q",
    "--no-ff",
    "--no-edit",
    "side",
  );
  git("update-ref", "refs/remotes/origin/main", "refs/heads/main");
  writeFileSync(join(root, RECORD), `commit: ${side}\n`);
  expect(() => advance(root, "main", "2026-02-02")).toThrow(NotOnMain);
  expect(readRecord(root).commit).toBe(side);
});

test("a commit that changed the record and the site is an earlier update", () => {
  const { root, git, commit } = scratch("update");
  writeFileSync(join(root, ".git/info/exclude"), "");
  const record = readFileSync(join(root, RECORD), "utf8");
  commit("chore(website): site checked", {
    [RECORD]: record,
    "site/page.astro": "p\n",
    "changes/website-update.md": "### Changed\n\n- a page\n",
  });
  git("update-ref", "refs/remotes/origin/main", "refs/heads/main");
  expect(plan(root, "main").commits.map((c) => c.kind)).toEqual(["update"]);
});

test("a record change bundled with content stays content", () => {
  const { root, git, commit } = scratch("update-mixed");
  writeFileSync(join(root, ".git/info/exclude"), "");
  const record = readFileSync(join(root, RECORD), "utf8");
  commit("chore(website): record and a module", {
    [RECORD]: record,
    "README.md": "a changed fact\n",
  });
  git("update-ref", "refs/remotes/origin/main", "refs/heads/main");
  expect(plan(root, "main").commits.map((c) => c.kind)).toEqual(["content"]);
});

test("a catalog without the site area is an error, never an empty review", () => {
  const { root, commit } = scratch("no-site-area");
  commit("chore: drop the site area", {
    ".config/change-areas.yaml": CATALOG_YAML.replace(
      /^ {2}website:[\s\S]*?(?=^ {2}docs:)/m,
      "",
    ),
  });
  expect(() => plan(root, "main")).toThrow("no `website` area");
});

test("a missing or malformed record is an error, never an empty plan", () => {
  const { root } = scratch("malformed");
  writeFileSync(join(root, RECORD), 'date: "2026-01-01"\n');
  expect(() => plan(root, "main")).toThrow("no `commit`");
  writeFileSync(join(root, RECORD), "commit: abc123\n");
  expect(() => plan(root, "main")).toThrow("not a full commit hash");
  rmSync(join(root, RECORD));
  expect(() => plan(root, "main")).toThrow();
});

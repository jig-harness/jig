import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  diffSites,
  lineDiff,
  MAX_EDITS,
  pageText,
  parseArgs,
  processTree,
  routeOf,
  run,
  worktreePaths,
} from "./site-diff.ts";

const page = (main: string) =>
  `<html><head><style>.a{}</style></head><body><header>Plugin v1.0.0</header><main id="main">${main}</main><footer>v1.0.0</footer><script>var x = 1;</script></body></html>`;

describe("pageText", () => {
  test("reads only the main content, a line per block", () => {
    expect(
      pageText(page("<h1>Title</h1><p>One  <a href='/x'>link</a>\n here.</p>")),
    ).toEqual(["# Title", "One link (/x) here."]);
  });

  test("a heading's level, a link's target and an image are part of the text", () => {
    expect(pageText(page("<h2>Title</h2>"))).not.toEqual(
      pageText(page("<p>Title</p>")),
    );
    expect(pageText(page("<p><a href='/correct'>Read</a></p>"))).not.toEqual(
      pageText(page("<p><a href='/wrong'>Read</a></p>")),
    );
    expect(pageText(page("<p><img src='/a.png' alt='Map'></p>"))).toEqual([
      "[image: Map (/a.png)]",
    ]);
  });

  test("leaves scripts and styles inside main out", () => {
    expect(
      pageText(
        page("<p>Kept</p><script>dropped()</script><style>.b{}</style>"),
      ),
    ).toEqual(["Kept"]);
  });

  test("a heading inside a template is left out, with its level", () => {
    expect(
      pageText(page("<p>Kept</p><template><h2>Hidden</h2></template>")),
    ).toEqual(
      pageText(page("<p>Kept</p><template><h3>Hidden</h3></template>")),
    );
    expect(
      pageText(page("<p>Kept</p><template><h2>Hidden</h2></template>")),
    ).toEqual(["Kept"]);
  });

  test("separates a label from its value", () => {
    expect(pageText(page("<p><b>Level</b><i>Lite</i></p>"))).toEqual([
      "Level Lite",
    ]);
  });

  test("a page without main has no text", () => {
    expect(pageText("<html><body><p>x</p></body></html>")).toEqual([]);
  });
});

describe("routeOf", () => {
  test("maps built files to the routes a reader opens", () => {
    expect(routeOf("index.html")).toBe("/");
    expect(routeOf(join("modules", "M2", "index.html"))).toBe("/modules/M2/");
    expect(routeOf("404.html")).toBe("/404.html");
  });
});

describe("diffSites", () => {
  test("lists added, removed and changed pages with their changed lines", () => {
    const before = new Map([
      ["/", ["Same"]],
      ["/a/", ["Old line", "Kept"]],
      ["/gone/", ["x"]],
    ]);
    const after = new Map([
      ["/", ["Same"]],
      ["/a/", ["Kept", "New line"]],
      ["/new/", ["y"]],
    ]);
    expect(diffSites(before, after)).toEqual({
      added: ["/new/"],
      removed: ["/gone/"],
      changed: [{ route: "/a/", removed: ["Old line"], added: ["New line"] }],
    });
  });

  test("counts a repeated line", () => {
    const diff = diffSites(
      new Map([["/", ["x", "x"]]]),
      new Map([["/", ["x"]]]),
    );
    expect(diff.changed).toEqual([{ route: "/", removed: ["x"], added: [] }]);
  });

  test("a reordered page is a change", () => {
    expect(
      diffSites(new Map([["/", ["a", "b"]]]), new Map([["/", ["b", "a"]]]))
        .changed,
    ).toEqual([{ route: "/", removed: ["a"], added: ["a"] }]);
  });
});

describe("lineDiff", () => {
  test("keeps the order of what changed", () => {
    expect(
      lineDiff(["1", "2", "3", "4", "5"], ["1", "9", "3", "5", "6"]),
    ).toEqual({ removed: ["2", "4"], added: ["9", "6"] });
  });

  test("an empty side is all added or all removed", () => {
    expect(lineDiff([], ["a"])).toEqual({ removed: [], added: ["a"] });
    expect(lineDiff(["a"], [])).toEqual({ removed: ["a"], added: [] });
    expect(lineDiff(["a"], ["a"])).toEqual({ removed: [], added: [] });
  });

  test("finds the shortest script on a page of many edits", () => {
    const before = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i % 3 ? l : `new ${i}`));
    const { removed, added } = lineDiff(before, after);
    expect(removed).toEqual(before.filter((_, i) => i % 3 === 0));
    expect(added).toEqual(after.filter((_, i) => i % 3 === 0));
  });

  test("past the edit limit, everything between the shared ends is rewritten", () => {
    const n = MAX_EDITS;
    const before = [
      "top",
      ...Array.from({ length: n }, (_, i) => `a${i}`),
      "end",
    ];
    const after = [
      "top",
      ...Array.from({ length: n }, (_, i) => `b${i}`),
      "end",
    ];
    expect(lineDiff(before, after)).toEqual({
      removed: before.slice(1, -1),
      added: after.slice(1, -1),
    });
  });
});

describe("parseArgs", () => {
  test("reads two refs and the options", () => {
    expect(parseArgs(["a", "b", "--lines", "3", "--keep"])).toEqual({
      base: "a",
      head: "b",
      lines: 3,
      json: false,
      keep: true,
    });
  });

  test("refuses a misspelt option, a negative line limit or a third ref", () => {
    expect(parseArgs(["a", "b", "--keeep"])).toBeNull();
    expect(parseArgs(["a", "b", "--lines", "-1"])).toBeNull();
    expect(parseArgs(["a", "b", "c"])).toBeNull();
  });
});

describe("worktreePaths", () => {
  test("reads the registered paths of a porcelain listing", () => {
    const listing =
      "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/s/base\nHEAD def\ndetached\n";
    expect([...worktreePaths(listing)]).toEqual(["/repo", "/tmp/s/base"]);
  });
});

describe("run", () => {
  const bun = process.execPath;

  test("returns the output only when asked, and drains it otherwise", async () => {
    const script = "process.stdout.write('x'.repeat(3_000_000))";
    expect(await run([bun, "-e", script], ".")).toBe("");
    expect(
      await run([bun, "-e", "console.log('hi')"], ".", { output: true }),
    ).toBe("hi\n");
    await expect(
      run([bun, "-e", script], ".", { output: true }),
    ).rejects.toThrow("printed more than");
  });

  test("keeps only the end of the error output", async () => {
    const script =
      "process.stderr.write('e'.repeat(100_000) + 'LAST'); process.exit(3)";
    const error = await run([bun, "-e", script], ".").catch((e: Error) => e);
    expect(String(error)).toContain("LAST");
    expect(String(error).length).toBeLessThan(3000);
  });

  test("a step past its deadline is stopped and fails", async () => {
    const started = Date.now();
    await expect(
      run([bun, "-e", "setTimeout(() => {}, 60_000)"], ".", { timeoutMs: 200 }),
    ).rejects.toThrow("stopped after");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a step whose output outlives its deadline fails though it exited 0", async () => {
    // The step exits 0 at once; a process it left behind holds its output
    // past the deadline, out of reach of the stop, then lets it close.
    const script = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "inherit", detached: true }).unref()`;
    await expect(
      run([bun, "-e", script], ".", { timeoutMs: 300 }),
    ).rejects.toThrow("stopped after");
  });
});

describe("processTree", () => {
  test("finds every descendant of a step, and nothing else", () => {
    const listing =
      "  1     0\n 10     1\n 11    10\n 12    11\n 13    10\n 20     1\n";
    expect(processTree(10, listing).sort()).toEqual([10, 11, 12, 13]);
  });
});

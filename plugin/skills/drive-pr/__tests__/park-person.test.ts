import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { parseCatalog } from "../scripts/lib/change-areas-catalog.ts";
import { personForPark } from "../scripts/lib/state/park-person.ts";

const catalog = parseCatalog({
  areas: {
    api: { paths: ["api/**"], owner: "api-owner" },
    web: { paths: ["web/**"], owner: "web-owner" },
  },
});

describe("a parked question's person", () => {
  it("treats null as absent at every recipient fallback", () => {
    expect(personForPark("api/route.ts", catalog, null, "author")).toBe(
      "api-owner",
    );
    expect(personForPark(null, catalog, null, "author")).toBe("author");
  });
  it("recognizes overlapping owners by case-insensitive forge identity", () => {
    const shared = parseCatalog({
      areas: {
        first: { paths: ["**"], owner: "Maintainer" },
        second: { paths: ["api/**"], owner: "maintainer" },
      },
    });
    expect(personForPark("api/route.ts", shared, "fallback", "author")).toBe(
      "Maintainer",
    );
  });
  it("routes by its own anchor, then dispatch.person, then the PR author", () => {
    expect(personForPark("api/route.ts", catalog, "maintainer", "author")).toBe(
      "api-owner",
    );
    expect(personForPark("web/view.ts", catalog, "maintainer", "author")).toBe(
      "web-owner",
    );
    expect(personForPark(null, catalog, "maintainer", "author")).toBe(
      "maintainer",
    );
    expect(personForPark("other.ts", catalog, undefined, "author")).toBe(
      "author",
    );
  });
  it("does not choose an arbitrary owner where ownership overlaps", () => {
    const overlapping = parseCatalog({
      areas: {
        first: { paths: ["**"], owner: "first" },
        second: { paths: ["api/**"], owner: "second" },
      },
    });
    expect(
      personForPark("api/route.ts", overlapping, "maintainer", "author"),
    ).toBe("maintainer");
  });
  it("uses the fallback for catalog ownership that is not a person", () => {
    for (const owner of [
      { team: "api" },
      "team/api",
      ["first", "second"],
      null,
    ]) {
      const catalog = parseCatalog({
        areas: { api: { paths: ["api/**"], owner } },
      });
      expect(
        personForPark("api/route.ts", catalog, "maintainer", "author"),
      ).toBe("maintainer");
      expect(personForPark("api/route.ts", catalog, undefined, "author")).toBe(
        "author",
      );
    }
  });
  it("rejects malformed configured logins instead of mentioning arbitrary text", () => {
    expect(() =>
      personForPark(null, catalog, "a\n@everyone", "author"),
    ).toThrow("dispatch.person");
    expect(() => personForPark(null, catalog, undefined, "")).toThrow("author");
  });
});

describe("the pull request author fallback", () => {
  it("reads the author in the consumer repository, ignoring an inherited GH_REPO", () => {
    const dir = mkdtempSync(join(tmpdir(), "park-person-"));
    try {
      const consumer = join(dir, "consumer");
      const bin = join(dir, "bin");
      mkdirSync(consumer);
      mkdirSync(bin);
      writeFakeProgram(
        join(bin, "gh"),
        `#!/usr/bin/env bun
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ cwd: process.cwd(), ghRepo: process.env.GH_REPO ?? null }));
process.stdout.write(JSON.stringify({ author: { login: "pr-author" } }));
`,
      );
      const script = join(dir, "run.ts");
      writeFileSync(
        script,
        `import { resolveParkPerson } from ${JSON.stringify(join(import.meta.dir, "../scripts/lib/state/park-person.ts"))};
process.stdout.write(await resolveParkPerson("7", "PRRT_x", "finding", "docs/a.md"));
`,
      );
      const proc = Bun.spawnSync([process.execPath, script], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          GH_REPO: "other-org/other-repo",
          JIG_CONSUMER_ROOT: consumer,
        },
      });
      expectSpawnExit(proc, 0);
      expect(proc.stdout.toString()).toBe("pr-author");
      const seen = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
      expect(seen.ghRepo).toBeNull();
      expect(realpathSync(seen.cwd)).toBe(realpathSync(consumer));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

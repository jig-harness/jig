import { test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { fixture } from "../../../dashboard/fixtures.ts";
import { writeLine } from "../lib/line-store.ts";
import { closeStateDb } from "../lib/state.ts";

test("current PR state is shared, cached and restricted to configured repositories", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-pr-"));
  try {
    const line = fixture("quiet").line;
    if (line === null) throw new FixtureError("No fixture line");
    line.repos = [
      {
        slug: "example-org/web",
        path: root,
        stages: [],
        refused: null,
        failedReads: [],
        notes: [],
      },
    ];
    writeLine(line, "{}", root);
    closeStateDb(root);
    writeFakeProgram(
      join(root, "gh"),
      `#!/usr/bin/env bun
import {appendFileSync} from "node:fs";
appendFileSync(process.env.CALLS, "call\\n");
if (process.argv[2] !== "api") process.exit(2);
if (process.argv[3].endsWith("/8")) { console.error("authentication expired"); process.exit(1); }
if (process.argv[3].endsWith("/9")) { console.log("invalid JSON"); process.exit(0); }
console.log(JSON.stringify({state:"closed",merged:true,title:"A merged change",draft:false,html_url:"https://github.com/example-org/web/pull/7"}));
`,
    );
    const script = join(root, "check.ts");
    writeFileSync(
      script,
      `import {expect} from "bun:test";
import {readFileSync} from "node:fs";
import {prReader} from ${JSON.stringify(join(import.meta.dir, "../lib/dashboard-pr.ts"))};
const read = prReader(${JSON.stringify(root)});
const [first,second] = await Promise.all([read("example-org/web","7"),read("example-org/web","7")]);
expect(first?.state).toBe("MERGED");
expect(second).toEqual(first);
expect(await read("example-org/web","7")).toEqual(first);
expect(await read("unconfigured/repo","7")).toBe(null);
expect(await read("example-org/web","--help")).toBe(null);
expect(readFileSync(process.env.CALLS,"utf8")).toBe("call\\n");
const reports = [];
const original = console.error;
console.error = (...parts) => reports.push(parts.join(" "));
expect(await read("example-org/web","8")).toBe(null);
console.error = original;
expect(reports.join(" ")).toContain("authentication expired");
expect(reports.join(" ")).toContain("example-org/web PR #8");
await expect(read("example-org/web","9")).rejects.toThrow();
`,
    );
    const child = Bun.spawn([process.execPath, script], {
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH}`,
        CALLS: join(root, "calls"),
        GH_HOST: "github.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await expectSpawnExited(child, 0, "PR state cache");
  } finally {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

class FixtureError extends Error {}

import { test, expect } from "bun:test";
import { join } from "node:path";
const cases: [number, string, string[]][] = [
  [
    0,
    "valid architecture + adr docs pass",
    ["$fix/good/caching.md", "$fix/good/adr.md"],
  ],
  [1, "bad enums/date/tags fail", ["$fix/bad/broken.md"]],
  [1, "adr missing decision_date fails", ["$fix/bad/adr-missing.md"]],
  [1, "missing frontmatter fails", ["$fix/bad/nofm.md"]],
  [0, "no-description doc passes when not new", ["$fix/good/nodesc.md"]],
  [
    1,
    "no-description doc fails when NEW",
    ["--new", "$fix/good/nodesc.md", "$fix/good/nodesc.md"],
  ],
];
for (const [want, label, params] of cases) {
  test(label, () => {
    let args = params.map((value) =>
      value.replace("$fix", join(import.meta.dir, "fixtures")),
    );
    const env = {
      ...process.env,
      SCHEMA: join(import.meta.dir, "fixtures/schema.yaml"),
      NEW_DOCS: "",
      STRICT: "0",
      ADR_DIR: "",
    };
    if (args[0] === "--new") {
      env.NEW_DOCS = args[1] ?? "";
      args = args.slice(2);
    }
    if (args[0] === "--strict") {
      env.STRICT = "1";
      args = args.slice(1);
    }

    const result = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "frontmatter-check.ts"),
        ...args,
      ],
      { env },
    );
    expect(result.exitCode).toBe(want);
  });
}

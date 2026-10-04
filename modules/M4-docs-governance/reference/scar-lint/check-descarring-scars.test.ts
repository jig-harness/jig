import { test, expect } from "bun:test";
import { join } from "node:path";
const cases: [number, string, string[]][] = [
  [0, "clean approved doc passes", ["$fix/clean.md"]],
  [1, "scarred approved doc fails", ["$fix/scarred.md"]],
  [0, "draft with scars is exempt", ["$fix/draft.md"]],
  [
    0,
    "doc documenting scar syntax (masked) passes",
    ["$fix/documents-syntax.md"],
  ],
  [0, "descar_allow doc passes", ["$fix/allowed.md"]],
];
for (const [want, label, params] of cases) {
  test(label, () => {
    let args = params.map((value) =>
      value.replace("$fix", join(import.meta.dir, "fixtures")),
    );
    const env = { ...process.env, NEW_DOCS: "", STRICT: "0", ADR_DIR: "" };
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
        join(import.meta.dir, "check-descarring-scars.ts"),
        ...args,
      ],
      { env },
    );
    expect(result.exitCode).toBe(want);
  });
}

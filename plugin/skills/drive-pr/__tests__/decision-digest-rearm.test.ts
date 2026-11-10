import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { ledgerFromState, parseLedger } from "../scripts/lib/state/ledger.ts";
import {
  fakeForge,
  forgeComment,
  ledgerBody,
  SCRIPTS,
} from "./ledger-forge-fixtures.ts";

test("ledger redaction publishes the stored digest unchanged", () => {
  const s = freshState(12);
  s.parked = [
    {
      key: "K",
      kind: "finding",
      reason: "Notify alice@example.test?",
      round: 1,
      digest: "123456abcdef",
      at: "2026-11-10T10:00:00Z",
    },
  ];
  const ledger = ledgerFromState(s, {
    generation: 1,
    claims: [],
    narrative: [],
    driver: {
      state: "stopped",
      exit: 8,
      actor: "a",
      clone: "c",
      heartbeat: "2026-11-10T10:00:00Z",
    },
  });
  expect(ledger.parked[0]?.reason).toBe("Notify <redacted>?");
  const parsed = parseLedger(ledgerBody(ledger));
  expect(parsed?.kind).toBe("ledger");
  if (parsed?.kind !== "ledger") throw new Error("fixture ledger unreadable");
  expect(parsed.ledger.parked[0]?.digest).toBe(s.parked[0]?.digest);
});

test("rearm refuses both sides of a lagging publication and accepts matching bound answers", async () => {
  for (const [local, published, answer, lag] of [
    ["123456abcdef", "aaaaaaaaaaaa", "123456abcdef", true],
    ["123456abcdef", "aaaaaaaaaaaa", "aaaaaaaaaaaa", true],
    ["123456abcdef", "123456abcdef", "123456abcdef", false],
  ] as const) {
    const s = freshState(12);
    s.parked = [
      {
        key: "K",
        kind: "finding",
        reason: "Keep it?",
        round: 1,
        digest: local,
        at: "2026-11-10T10:00:00Z",
      },
    ];
    const parked = s.parked[0];
    if (parked === undefined) throw new Error("fixture park missing");
    const ledger = ledgerFromState(
      { ...s, parked: [{ ...parked, digest: published }] },
      {
        generation: 1,
        claims: [],
        narrative: [],
        driver: {
          state: "stopped",
          exit: 8,
          actor: "a",
          clone: "c",
          heartbeat: "2026-11-10T10:00:00Z",
        },
      },
    );
    const forge = fakeForge([
      forgeComment(1, ledgerBody(ledger), "drive-bot"),
      {
        ...forgeComment(2, `answer K: approve [${answer}]`, "alice"),
        created_at: "2026-11-10T11:00:00Z",
        updated_at: "2026-11-10T11:00:00Z",
        html_url: "https://example.test/answer",
      },
    ]);
    const module = join(SCRIPTS, "lib", "driver", "rearm.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { admitAnsweredParks } = await import(${JSON.stringify(module)}); await admitAnsweredParks(${JSON.stringify(s)}, true);`,
      ],
      { cwd: forge.repo, env: forge.env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    if (lag) {
      expect(stderr).toContain("the ledger has not yet caught up");
      expect(stderr).not.toContain("would unpark");
    } else expect(stderr).toContain("would unpark 1 answered item");
  }
});

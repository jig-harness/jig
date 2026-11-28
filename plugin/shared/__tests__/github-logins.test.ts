/**
 * GitHub logins: every reader that checks one directly takes an Enterprise
 * Managed User's login (`<handle>_<shortcode>`, such as `mona_acme`), keeps
 * an App's `[bot]` suffix where it took one, and refuses what no login is.
 * The two readers that ask the forge client run in a subprocess whose `gh`
 * answers with the login under test.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { runWithFakeGh } from "../../../lib/test-helpers/run-with-fake-gh.ts";
import {
  GITHUB_LOGIN_SOURCE,
  isGithubLogin,
  REVIEWER,
  uniqueLogins,
} from "../forge-logins.ts";
import { servedPeople } from "../../dispatch/lib/serve-config.ts";
import { userOf } from "../outbound/github-owner.ts";
import { activeUserIn } from "../outbound/github-credential.ts";
import { isPerson } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import { loadSchema } from "../../skills/audit/scripts/lib/schema.ts";

const EMU = ["mona_acme", "Mona_ACME", "mona-lisa_acme", "a_bcd"];
const BOTS = ["example-bot[bot]", "mona_acme[bot]"];
/** Never a login, wherever a bare one is read. */
const NOT_LOGINS = [
  "",
  " mona_acme",
  "mona_acme ",
  "mona acme",
  "@mona_acme",
  "mona/acme",
  "../mona",
  "mona\nacme",
  "mona\u0000acme",
  "_mona",
  "-mona",
  "mona.acme",
  "a".repeat(40),
  `${"a".repeat(39)}_acme`,
  `${"a".repeat(34)}_acme1`,
  "mona-",
  "mona-_acme",
  "mona--lisa",
  "mona--lisa_acme",
  "mona[bot]x",
  "mona__acme",
  "mona_",
  "mona_ab",
  "mona_acme_inc",
  "mona_acmeacme1",
  "a_b",
];

describe("isGithubLogin", () => {
  test("takes logins, Enterprise Managed Users' included", () => {
    for (const login of [
      "mona",
      "A1",
      "a".repeat(39),
      `${"a".repeat(34)}_acme`,
      "mona-lisa-x",
      ...EMU,
    ])
      expect(isGithubLogin(login)).toBe(true);
  });

  test("takes the [bot] suffix only where asked", () => {
    for (const login of BOTS) {
      expect(isGithubLogin(login)).toBe(false);
      expect(isGithubLogin(login, { bot: true })).toBe(true);
    }
  });

  test("refuses what no login is, and what is not text", () => {
    for (const value of [...NOT_LOGINS, undefined, null, 7])
      expect(isGithubLogin(value, { bot: true })).toBe(false);
  });

  test("compares without case", () => {
    expect(uniqueLogins(["mona_acme", "MONA_ACME", "other"])).toEqual([
      "mona_acme",
      "other",
    ]);
  });
});

test("REVIEWER takes a login with or without @, and org/team", () => {
  for (const r of [
    "mona_acme",
    "@mona_acme",
    "@example-org/team-name",
    "example-org/team_name",
  ])
    expect(REVIEWER.test(r)).toBe(true);
  for (const r of [
    "",
    "@",
    "mona acme",
    "@@mona",
    "a/b/c",
    "_mona",
    "mona_acme/team-name",
    "example-org-/team",
    "mona__acme",
    "a".repeat(40),
    `@${"a".repeat(39)}_acme`,
    "mona-",
    "mona--lisa_acme",
  ])
    expect(REVIEWER.test(r)).toBe(false);
});

test("serve[].forge takes an Enterprise Managed User and refuses a bot or a non-login", () => {
  const serve = (forge: string[]) =>
    servedPeople([{ name: "mona", forge, tracker: { github: "mona" } }]);
  const got = serve(["mona_acme"]);
  expect(got.ok && got.value[0]?.forge).toEqual(["mona_acme"]);
  for (const bad of ["example-bot[bot]", "@mona_acme", "mona/acme", "_mona"])
    expect(serve([bad]).ok).toBe(false);
  expect(serve(["mona_acme", "MONA_ACME"]).ok).toBe(false);
});

test("userOf reads an Enterprise Managed User and a bot from GET /user", () => {
  for (const login of [...EMU, ...BOTS])
    expect(userOf(JSON.stringify({ id: 1, login }))).toEqual({ id: 1, login });
  for (const login of NOT_LOGINS)
    expect(userOf(JSON.stringify({ id: 1, login }))).toBeNull();
});

test("activeUserIn reads an Enterprise Managed User from hosts.yml", () => {
  const hosts = (user: string) =>
    `github.com:\n    git_protocol: https\n    user: ${user}\n`;
  expect(activeUserIn(hosts("mona_acme"), "github.com")).toBe("mona_acme");
  expect(activeUserIn(hosts('"mona_acme"'), "github.com")).toBe("mona_acme");
  for (const user of ["_mona", "mona/acme", "example-bot[bot]", "@mona"])
    expect(activeUserIn(hosts(user), "github.com")).toBeNull();
});

test("isPerson takes an Enterprise Managed User and a bot as a parked person", () => {
  for (const login of [...EMU, ...BOTS]) expect(isPerson(login)).toBe(true);
  for (const value of NOT_LOGINS) expect(isPerson(value)).toBe(false);
});

test("the audit schema's dispatch.person spells out the shared login pattern", () => {
  const pattern = loadSchema().fields.find(
    (f) => f.path === "dispatch.person",
  )?.pattern;
  expect(pattern).toBe(String.raw`^${GITHUB_LOGIN_SOURCE}(?:\[bot\])?$`);
  const login = new RegExp(pattern ?? "$^");
  for (const value of [...EMU, ...BOTS]) expect(login.test(value)).toBe(true);
  for (const value of NOT_LOGINS) expect(login.test(value)).toBe(false);
});

describe("readers that ask the forge client", () => {
  const LEDGER_FORGE = join(
    import.meta.dir,
    "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts",
  );
  const ASK_FORGE = join(import.meta.dir, "../../ask/lib/forge.ts");
  const ASK_READING = join(import.meta.dir, "../../ask/lib/reading.ts");

  /** What `gh api user` answers, `-i` (headers first) or `--jq .login`. */
  const gh = (login: string) => `#!/usr/bin/env bun
const login = ${JSON.stringify(login)};
const args = process.argv.slice(2);
if (args.includes("--jq")) console.log(login);
else process.stdout.write("HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n" + JSON.stringify({ login, id: 1 }));
`;

  async function read(login: string): Promise<unknown> {
    const dir = mkdtempSync(join(tmpdir(), "jig-github-login-"));
    try {
      const result = await runWithFakeGh({
        dir,
        unset: ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_REPO"],
        gh: gh(login),
        code: `process.env.JIG_GH_CACHE = "off";
process.env.JIG_FORGE_BUDGET = "off";
const ledger = await import(${JSON.stringify(LEDGER_FORGE)});
const ask = await import(${JSON.stringify(ASK_FORGE)});
const { reading } = await import(${JSON.stringify(ASK_READING)});
const asked = await ask.readLogin(reading());
console.log(JSON.stringify({ resolved: await ledger.resolveLogin(), asked: asked.ok ? asked.value : asked.failure.code }));`,
      });
      expectSpawnExit(result, 0);
      return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("resolveLogin and readLogin take an Enterprise Managed User and a bot", async () => {
    for (const login of ["mona_acme", "example-bot[bot]"])
      expect(await read(login)).toEqual({ resolved: login, asked: login });
  });

  test("resolveLogin and readLogin refuse a login that is malformed", async () => {
    for (const login of ["_mona", "mona/acme"])
      expect(await read(login)).toEqual({
        resolved: null,
        asked: "unreadable",
      });
  });
});

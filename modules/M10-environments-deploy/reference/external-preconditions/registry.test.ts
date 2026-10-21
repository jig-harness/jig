import { describe, expect, setSystemTime, test } from "bun:test";
import { parseRegistry, runRegistry, PreconditionError } from "./registry.ts";
const raw = `version: 1
preconditions:
  - id: protection
    kind: fixture
    owner: maintainers
    target: {}
    expected: {}
    remediation: Ask an administrator to configure it
    state: active
`;
const run = (text = raw, status: "pass" | "fail" | "unknown" = "pass") =>
  runRegistry(parseRegistry(text), {
    checks: { fixture: () => ({ status, reasons: ["fixture observation"] }) },
    now: Date.parse("2026-10-20T00:00:00Z"),
  });
describe("registry", () => {
  test("unknown kinds fail closed", async () =>
    expect(
      (await run(raw.replace("kind: fixture", "kind: other"))).status,
    ).toBe("fail"));
  test("pending never turns green", async () =>
    expect(
      (await run(raw.replace("state: active", "state: pending"))).status,
    ).toBe("fail"));
  test("unexpired explicit waiver covers failure, not unknown", async () => {
    const waived = `${raw}    waiver: {reason: Temporary migration, approved_by: release-owner, expires: '2026-10-21'}\n`;
    expect((await run(waived, "fail")).entries[0]?.outcome).toBe("waived");
    expect((await run(waived, "unknown")).status).toBe("fail");
    expect(
      (await run(waived.replace("state: active", "state: pending"), "fail"))
        .status,
    ).toBe("fail");
  });
  test("expiry at UTC midnight fails even a passing check", async () => {
    expect(
      (
        await run(
          `${raw}    waiver: {reason: Migration, approved_by: owner, expires: '2026-10-20'}\n`,
        )
      ).status,
    ).toBe("fail");
  });
  test("a live run that crosses a waiver's expiry does not honour it", async () => {
    setSystemTime(new Date("2026-10-20T23:59:59.000Z"));
    try {
      const result = await runRegistry(
        parseRegistry(
          `${raw}    waiver: {reason: Migration, approved_by: owner, expires: '2026-10-21'}\n`,
        ),
        {
          checks: {
            fixture: () => {
              setSystemTime(new Date("2026-10-21T00:00:01.000Z"));
              return { status: "fail", reasons: ["fixture observation"] };
            },
          },
        },
      );
      expect(result.status).toBe("fail");
      expect(result.entries[0]?.reasons.join()).toContain("waiver expired");
    } finally {
      setSystemTime();
    }
  });
  test("an invalid declaration throws before any check runs", async () => {
    let ran = false;
    const check = Object.assign(
      () => {
        ran = true;
        return { status: "pass" as const, reasons: [] };
      },
      {
        validate: () => {
          throw new PreconditionError("bad expected");
        },
      },
    );
    await expect(
      runRegistry(parseRegistry(raw), { checks: { fixture: check } }),
    ).rejects.toThrow("bad expected");
    expect(ran).toBe(false);
  });
  test("malformed and incomplete waivers reject", () => {
    for (const expires of [
      "2026-02-30",
      "2026-13-01",
      "tomorrow",
      "2026-10-20T12:00:00Z",
    ])
      expect(() =>
        parseRegistry(
          `${raw}    waiver: {reason: Migration, approved_by: owner, expires: '${expires}'}\n`,
        ),
      ).toThrow();
    expect(() =>
      parseRegistry(`${raw}    waiver: {expires: '2026-10-21'}\n`),
    ).toThrow();
  });
  test("empty, duplicate and unknown fields reject", () => {
    expect(() => parseRegistry("version: 1\npreconditions: []")).toThrow();
    expect(() => parseRegistry(`${raw}    typo: true\n`)).toThrow();
    expect(() =>
      parseRegistry(`${raw}${raw.split("preconditions:\n")[1]}`),
    ).toThrow();
  });
  test("missing fixture never falls back to live", async () => {
    const result = await runRegistry(parseRegistry(raw), {
      checks: {
        fixture: () => {
          throw new PreconditionError("should not run");
        },
      },
      input: {},
    });
    expect(result.entries[0]?.reasons.join()).toContain("missing fixture");
  });
});

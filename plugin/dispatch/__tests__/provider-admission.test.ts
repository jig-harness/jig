/** Admission of provider accounts while their hold stands, and of every account under a repository's provider allow list. */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitHostDriverTakeover,
  admitRearm,
  admitTakeover,
  type LaunchKind,
  notAdmitted,
  replaySlotBlock,
  slotTable,
} from "../lib/accounts.ts";
import { weightReport } from "../lib/account-report.ts";
import { admission } from "../lib/actions/admission.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { MachineAccount } from "../lib/machine-config.ts";
import {
  PROVIDER_ADMISSION_HOLD,
  providerIdentity,
} from "../lib/provider-account.ts";
import { type AllowList, providerRefusal } from "../lib/provider-allow.ts";
import { dispatchSection } from "../lib/section.ts";
import type { Action } from "../lib/types.ts";

const ON = { on: true } as const;

function subscription(name: string, vendor = "claude"): MachineAccount {
  return {
    name,
    vendor,
    configDir: `/accounts/${name}`,
    identity: `${name}@example.com`,
    maxPerAccount: 2,
  };
}

function provider(name: string, providerName: string): MachineAccount {
  const credential = `op://Jig/${name}/credential`;
  return {
    name,
    vendor: "claude",
    configDir: `/accounts/${name}`,
    identity: providerIdentity(providerName, credential, null),
    maxPerAccount: 2,
    provider: {
      harness: "claude-code",
      provider: providerName,
      baseUrl: null,
      credential,
      billing: "pay-per-token",
      spendCap: { daily: "20.00", perRun: null, timezone: "UTC" },
      models: null,
    },
  };
}

function table(accounts: MachineAccount[]) {
  const root = mkdtempSync(join(tmpdir(), "provider-admission-"));
  return slotTable(accounts, [], Date.now(), root);
}

function pass(allowed?: AllowList): LaunchKind {
  return {
    kind: "pass",
    deadlineSec: 5400,
    codex: ON,
    stage: "rearm",
    ...(allowed === undefined ? {} : { allowed }),
  };
}

function admittedName(result: ReturnType<typeof admitRearm>): string | null {
  return "admitted" in result ? result.admitted.account.name : null;
}

function record(account: MachineAccount, id: string): ReadRecord {
  return {
    state: { kind: "pending" },
    result: null,
    record: {
      version: 1,
      id,
      token: "t",
      action: "rearm",
      repo: "example-org/alpha",
      repoPath: "/repos/alpha",
      pr: 7,
      account: account.name,
      vendor: account.vendor as "claude",
      configDir: account.configDir,
      wallBackoffMs: 1000,
      replaces: null,
      facts: "f",
      createdAt: "2026-11-01T00:00:00.000Z",
      workspace: null,
      attempts: [],
      item: null,
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
    },
  };
}

describe("a provider account while its hold stands", () => {
  const router = provider("router", "openrouter");
  const allowAll: AllowList = {
    repo: "example-org/alpha",
    providers: ["openrouter", "anthropic", "openai"],
  };

  it("is never admitted, by any admission path, even where the repository allows its provider", () => {
    expect(PROVIDER_ADMISSION_HOLD).not.toBeNull();
    const slots = table([router]);
    for (const launch of [pass(), pass(allowAll)])
      expect(admitRearm(slots, null, launch)).toEqual({
        waits: expect.stringContaining("configured, not admitted"),
      });
    const replaced = record(router, "replaced");
    expect(admitTakeover(slots, replaced, 5400, ON, allowAll)).toEqual({
      waits: expect.stringContaining("configured, not admitted"),
    });
    expect(
      admitHostDriverTakeover(slots, "router", 5400, ON, "rearm", allowAll),
    ).toEqual({ waits: expect.stringContaining("configured, not admitted") });
    const [routerSlots] = slots;
    if (routerSlots === undefined) throw new Error("no slots");
    expect(
      replaySlotBlock(routerSlots, replaced.record, ON, allowAll),
    ).toContain("configured, not admitted");
    for (const stage of ["pickup", "rearm", "followup", "steward"] as const)
      expect(
        admission(
          {
            table: slots,
            last: null,
            records: [replaced],
            codexOptIn: ON,
            passDeadlineSec: 5400,
          },
          { stage, target: "PR #7" } as Action,
          new Set(),
          3600,
          null,
          allowAll,
        ),
      ).toEqual({ waits: expect.stringContaining("configured, not admitted") });
  });

  it("is admitted past: a subscription account beside it takes the launch", () => {
    const slots = table([router, subscription("work")]);
    expect(admittedName(admitRearm(slots, null, pass(allowAll)))).toBe("work");
  });

  it("is reported as configured and not admitted", () => {
    const refused = notAdmitted([router, subscription("work")], 5400, ON);
    expect(refused).toEqual([
      {
        account: "router",
        vendor: "claude",
        reason: `configured, not admitted: ${PROVIDER_ADMISSION_HOLD}`,
      },
    ]);
    const [routerSlots] = table([router]);
    if (routerSlots === undefined) throw new Error("no slots");
    expect(weightReport(routerSlots, refused[0]?.reason ?? null)).toMatchObject(
      {
        account: "router",
        effective: 0,
        reason: expect.stringContaining("configured, not admitted"),
      },
    );
  });
});

describe("a repository's provider allow list", () => {
  const work = subscription("work");
  const codex = subscription("codex-work", "codex");

  it("refuses an account its list lacks for one repository and admits it for another whose list names its provider", () => {
    const slots = table([work]);
    const alpha: AllowList = {
      repo: "example-org/alpha",
      providers: ["openrouter"],
    };
    const beta: AllowList = {
      repo: "example-org/beta",
      providers: ["anthropic"],
    };
    const refused = admitRearm(slots, null, pass(alpha));
    expect(refused).toEqual({ waits: expect.any(String) });
    const why = "waits" in refused ? refused.waits : "";
    expect(why).toStartWith("provider-not-allowed: example-org/alpha");
    expect(why).toContain("the provider anthropic of the account work");
    expect(admittedName(admitRearm(slots, null, pass(beta)))).toBe("work");
  });

  it("passes over an account the list refuses for the next one it allows", () => {
    const slots = table([work, codex]);
    const openaiOnly: AllowList = {
      repo: "example-org/alpha",
      providers: ["openai"],
    };
    expect(admittedName(admitRearm(slots, null, pass(openaiOnly)))).toBe(
      "codex-work",
    );
    const replaced = record(work, "replaced");
    const takeover = admitTakeover(slots, replaced, 5400, ON, openaiOnly);
    expect(takeover).toEqual({
      waits: expect.stringContaining("provider-not-allowed: example-org/alpha"),
    });
  });

  it("with no list, admits the Claude and OpenAI subscription accounts only and refuses every provider account", () => {
    const none: AllowList = { repo: "example-org/alpha", providers: null };
    expect(admittedName(admitRearm(table([work]), null, pass(none)))).toBe(
      "work",
    );
    expect(admittedName(admitRearm(table([codex]), null, pass(none)))).toBe(
      "codex-work",
    );
    const other = subscription("other", "gemini-cli");
    expect(providerRefusal(other, none)).toContain("provider-not-allowed");
    for (const name of ["anthropic", "openai", "openrouter"]) {
      const account = provider(`key-${name}`, name);
      expect(providerRefusal(account, none)).toStartWith(
        `provider-not-allowed: example-org/alpha does not allow the provider ${name} of the account key-${name}`,
      );
      expect(
        providerRefusal(account, {
          repo: "example-org/alpha",
          providers: [name],
        }),
      ).toBeNull();
    }
  });
});

describe("dispatch.allowed_providers", () => {
  it("reads a list of provider names, absent as none, and refuses anything else", () => {
    const read = (value: unknown) =>
      dispatchSection(
        value === undefined ? {} : { dispatch: { allowed_providers: value } },
      );
    const listed = read(["anthropic", "openrouter"]);
    expect(listed.ok && listed.value.allowedProviders).toEqual([
      "anthropic",
      "openrouter",
    ]);
    const absent = read(undefined);
    expect(absent.ok && absent.value.allowedProviders).toBeUndefined();
    for (const bad of ["anthropic", ["Open Router"], ["openai", "openai"]]) {
      const refused = read(bad);
      expect(refused.ok).toBe(false);
      if (!refused.ok)
        expect(refused.failure.reason).toContain("dispatch.allowed_providers");
    }
  });
});

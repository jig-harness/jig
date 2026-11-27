/**
 * The variables an installed job runs with beyond Jig's own: those kept from
 * the installed launchd job and those `--env NAME` captures from the
 * installing shell, and how a preview hides their values.
 */
import { describe, expect, test } from "bun:test";
import {
  capturedEnvironment,
  carriedEnvironment,
  HIDDEN_VALUE,
  launchdEnvironment,
  maskedEnvironment,
} from "../job-environment.ts";
import { jobFiles } from "../scheduler.ts";

const managed = new Set(["HOME", "PATH", "JIG_HOME"]);

function plist(env: Record<string, string>): string {
  return jobFiles("launchd", {
    command: ["bun", "launcher.ts", "--", "dispatch", "--apply"],
    env,
    spec: {
      name: "jig-dispatch",
      label: "dev.jig.dispatch",
      description: "tick",
      timerDescription: "tick",
      stateRoot: "/state",
      args: ["dispatch", "--apply"],
      schedule: { everyMinutes: 5 },
    },
  })["dev.jig.dispatch.plist"] as string;
}

describe("the variables kept from the installed launchd job", () => {
  test("are the ones Jig does not write, read back as written", () => {
    const installed = plist({
      HOME: "/old/home",
      PATH: "/old/bin",
      JIRA_TOKEN_COMMAND: "broker token --site 'a&b'",
      JIG_NOTIFY_URL: "https://hooks.example/<secret>",
    });
    expect(carriedEnvironment(installed, managed)).toEqual({
      ok: true,
      value: {
        JIRA_TOKEN_COMMAND: "broker token --site 'a&b'",
        JIG_NOTIFY_URL: "https://hooks.example/<secret>",
      },
    });
  });

  test("are none when no job is installed", () => {
    expect(carriedEnvironment(null, managed)).toEqual({ ok: true, value: {} });
  });

  test("refuse a binary plist rather than reading it as holding none", () => {
    const refused = carriedEnvironment("bplist00\u0000binary", managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("plutil -convert xml1");
  });

  test("refuse an entry whose value is not a string", () => {
    const refused = carriedEnvironment(
      `<?xml version="1.0"?><plist><dict><key>EnvironmentVariables</key><dict><key>RETRIES</key><integer>3</integer><key>TOKEN</key><string>kept-secret</string></dict></dict></plist>`,
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("not a string");
    expect(refused.failure.reason).not.toContain("kept-secret");
  });

  test("refuse a kept value with a line break, naming the variable and not the value", () => {
    const refused = carriedEnvironment(
      plist({ PATH: "/bin" }).replace(
        "</dict>",
        "<key>MULTI</key><string>line-one&#10;line-two</string></dict>",
      ),
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("MULTI");
    expect(refused.failure.reason).not.toContain("line-one");
  });

  test("read an empty value and numeric character references", () => {
    const edited = plist({ PATH: "/bin" }).replace(
      "</dict>",
      "<key>EMPTY</key><string/><key>AMP</key><string>a&#38;b&#x3c;c</string></dict>",
    );
    expect(carriedEnvironment(edited, managed)).toEqual({
      ok: true,
      value: { EMPTY: "", AMP: "a&b<c" },
    });
  });

  test("are read from a job a plist tool laid out on lines of its own", () => {
    const edited = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/bin</string>
\t\t<key>LINEAR_API_KEY</key>
\t\t<string>lin-value</string>
\t</dict>
</dict>
</plist>
`;
    expect(launchdEnvironment(edited)).toEqual({
      PATH: "/usr/bin",
      LINEAR_API_KEY: "lin-value",
    });
    expect(carriedEnvironment(edited, managed)).toEqual({
      ok: true,
      value: { LINEAR_API_KEY: "lin-value" },
    });
  });
});

describe("--env NAME", () => {
  test("captures each named variable's value from the shell", () => {
    expect(
      capturedEnvironment(
        ["JIRA_EMAIL", "JIRA_API_TOKEN"],
        { JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "t0ken", OTHER: "x" },
        managed,
      ),
    ).toEqual({
      ok: true,
      value: { JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "t0ken" },
    });
  });

  test("refuses NAME=VALUE without repeating the value", () => {
    const refused = capturedEnvironment(
      ["JIRA_API_TOKEN=s3cret-value"],
      { JIRA_API_TOKEN: "s3cret-value" },
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.code).toBe("usage");
    expect(refused.failure.reason).toContain("never NAME=VALUE");
    expect(refused.failure.reason).toContain("--env JIRA_API_TOKEN");
    expect(refused.failure.reason).not.toContain("s3cret-value");
  });

  test.each([
    ["unset", {}],
    ["empty", { JIRA_BEARER_TOKEN: "" }],
  ])("refuses a variable %s in the shell", (_, env) => {
    const refused = capturedEnvironment(["JIRA_BEARER_TOKEN"], env, managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("unset or empty");
  });

  test("refuses a word that is not a variable's name, without repeating it", () => {
    const refused = capturedEnvironment(["1-not-a-name"], {}, managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).not.toContain("1-not-a-name");
  });

  test("refuses a variable Jig writes into the job itself", () => {
    const refused = capturedEnvironment(["PATH"], { PATH: "/bin" }, managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("Jig writes PATH");
  });

  test("refuses a value with a line break, without repeating it", () => {
    const refused = capturedEnvironment(
      ["MULTI"],
      { MULTI: "line-one\nline-two" },
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).not.toContain("line-one");
  });
});

test("a masked environment shows the hidden names' values as the placeholder only", () => {
  expect(
    maskedEnvironment(
      { PATH: "/bin", JIRA_API_TOKEN: "t0ken" },
      new Set(["JIRA_API_TOKEN"]),
    ),
  ).toEqual({ PATH: "/bin", JIRA_API_TOKEN: HIDDEN_VALUE });
});

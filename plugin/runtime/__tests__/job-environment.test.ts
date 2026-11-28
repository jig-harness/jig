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
  parseLaunchdEnvironment,
  maskedEnvironment,
} from "../job-environment.ts";
import { ok } from "../../shared/outcome.ts";
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

  test("decode each reference once, and keep one that names no character", () => {
    const edited = plist({ PATH: "/bin" }).replace(
      "</dict>",
      "<key>ONCE</key><string>&#38;lt;</string><key>FAR</key><string>&#1114112;</string></dict>",
    );
    expect(carriedEnvironment(edited, managed)).toEqual({
      ok: true,
      value: { ONCE: "&lt;", FAR: "&#1114112;" },
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
    expect(parseLaunchdEnvironment(edited)).toEqual(
      ok({ PATH: "/usr/bin", LINEAR_API_KEY: "lin-value" }),
    );
    expect(carriedEnvironment(edited, managed)).toEqual({
      ok: true,
      value: { LINEAR_API_KEY: "lin-value" },
    });
  });
});

describe("the installed job's bytes, read only as UTF-8", () => {
  const job = (declaration: string, value: string) =>
    `${declaration}<plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>TOKEN</key><string>${value}</string></dict></dict></plist>`;

  test("keep a non-ASCII value of a UTF-8 job intact", () => {
    const bytes = new TextEncoder().encode(
      job(`<?xml version="1.0" encoding="utf-8"?>`, "pässwörd"),
    );
    expect(carriedEnvironment(bytes, managed)).toEqual({
      ok: true,
      value: { TOKEN: "pässwörd" },
    });
  });

  test("keep a job with a byte order mark and no declared encoding", () => {
    const text = job(`<?xml version="1.0"?>`, "ünï");
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(text),
    ]);
    expect(carriedEnvironment(bytes, managed)).toEqual({
      ok: true,
      value: { TOKEN: "ünï" },
    });
  });

  test("refuse a job that declares ISO-8859-1, naming the encoding and not the value", () => {
    const bytes = Buffer.from(
      job(`<?xml version="1.0" encoding="ISO-8859-1"?>`, "zq-hidden-ä"),
      "latin1",
    );
    const refused = carriedEnvironment(bytes, managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("ISO-8859-1");
    expect(refused.failure.reason).toContain("plutil -convert xml1");
    expect(refused.failure.reason).not.toContain("zq-hidden");
  });

  test("refuse a decoded job that declares an encoding other than UTF-8", () => {
    const refused = carriedEnvironment(
      job(`<?xml version='1.0' encoding='windows-1252'?>`, "plain"),
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("windows-1252");
  });

  test("refuse bytes that are not UTF-8 even with no declared encoding", () => {
    const bytes = Buffer.from(
      job(`<?xml version="1.0"?>`, "zq-hidden-ä"),
      "latin1",
    );
    const refused = carriedEnvironment(bytes, managed);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).toContain("not valid UTF-8");
    expect(refused.failure.reason).not.toContain("zq-hidden");
  });

  test("never repeat a declared encoding that is not an encoding's name", () => {
    const refused = carriedEnvironment(
      job(`<?xml version="1.0" encoding="secret value"?>`, "plain"),
      managed,
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.failure.reason).not.toContain("secret");
  });
});

describe("an environment read whole or not at all", () => {
  const wrap = (inner: string) =>
    `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>EnvironmentVariables</key>${inner}</dict></plist>`;

  test("ignores a comment between the key and its dictionary", () => {
    const text = wrap(
      "<!-- note --><dict><key>A</key><string>1</string></dict>",
    );
    expect(parseLaunchdEnvironment(text)).toEqual(ok({ A: "1" }));
  });

  test("refuses a CDATA value instead of keeping its markup", () => {
    const text = wrap(
      "<dict><key>A</key><string><![CDATA[a&b]]></string></dict>",
    );
    expect(parseLaunchdEnvironment(text).ok).toBe(false);
    expect(carriedEnvironment(text, managed).ok).toBe(false);
  });

  test("refuses a non-string entry beside valid ones", () => {
    const text = wrap(
      "<dict><key>A</key><string>1</string><key>N</key><integer>2</integer></dict>",
    );
    expect(parseLaunchdEnvironment(text).ok).toBe(false);
  });

  test("refuses a comment that removal would reassemble, nest, or leave open", () => {
    for (const hidden of [
      "<!<!---->--",
      "<!-- open",
      "<!-- nested <!-- -->",
      "<!-- double -- hyphen -->",
      "<!--->",
    ]) {
      const text = wrap(`${hidden}<dict><key>A</key><string>1</string></dict>`);
      expect(parseLaunchdEnvironment(text).ok).toBe(false);
    }
  });

  test("finds a key spelled with a character reference or tag whitespace, and refuses other spellings", () => {
    const body = "<dict><key>A</key><string>1</string></dict>";
    const spelled = (key: string) =>
      `<?xml version="1.0"?>\n<plist version="1.0"><dict>${key}${body}</dict></plist>`;
    for (const valid of [
      "<key>Environment&#86;ariables</key>",
      "<key >Environment&#86;ariables</key>",
      "<key\n>Environment&#x56;ariables</key >",
      '<key xml:space="preserve">EnvironmentVariables</key>',
    ]) {
      expect(parseLaunchdEnvironment(spelled(valid))).toEqual(ok({ A: "1" }));
    }
    for (const key of [
      "<key><![CDATA[EnvironmentVariables]]></key>",
      "<key> EnvironmentVariables</key>",
      "<key>Environment<!--split-->Variables</key>",
    ]) {
      expect(parseLaunchdEnvironment(spelled(key)).ok).toBe(false);
    }
  });

  test("allows the word EnvironmentVariables in values and program arguments", () => {
    const text = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key><array><string>--section=EnvironmentVariables</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>LABEL</key><string>EnvironmentVariables</string>
  </dict>
</dict></plist>`;
    expect(parseLaunchdEnvironment(text)).toEqual(
      ok({ LABEL: "EnvironmentVariables" }),
    );
    const noEnv = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>ProgramArguments</key><array><string>EnvironmentVariables</string></array>
</dict></plist>`;
    expect(parseLaunchdEnvironment(noEnv)).toEqual(ok({}));
  });

  test("refuses a plist with duplicate top-level EnvironmentVariables or a DOCTYPE internal subset", () => {
    const duplicate = `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>EnvironmentVariables</key><dict><key>A</key><string>1</string></dict>
  <key>EnvironmentVariables</key><dict><key>B</key><string>2</string></dict>
</dict></plist>`;
    expect(parseLaunchdEnvironment(duplicate).ok).toBe(false);
    const doctypeSubset = `<?xml version="1.0"?>
<!DOCTYPE plist [ <!ENTITY ev "EnvironmentVariables"> ]>
<plist version="1.0"><dict><key>&ev;</key><dict><key>A</key><string>1</string></dict></dict></plist>`;
    expect(parseLaunchdEnvironment(doctypeSubset).ok).toBe(false);
  });

  test("refuses a name given twice without repeating either value", () => {
    const text = wrap(
      "<dict><key>A</key><string>first-secret</string><key>A</key><string>second-secret</string></dict>",
    );
    const read = parseLaunchdEnvironment(text);
    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(carriedEnvironment(text, managed).ok).toBe(false);
  });

  test("keeps a variable named __proto__ as an own entry", () => {
    const read = parseLaunchdEnvironment(
      wrap("<dict><key>__proto__</key><string>v</string></dict>"),
    );
    if (!read.ok) throw new Error("unreadable");
    expect(Object.keys(read.value)).toEqual(["__proto__"]);
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

  test("refuses a value with a line break or XML 1.0 forbidden control character, without repeating it", () => {
    for (const bad of ["line-one\nline-two", "ctrl\u0001secret", "bad\uD800"]) {
      const refused = capturedEnvironment(["MULTI"], { MULTI: bad }, managed);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.failure.reason).not.toContain(bad);
      expect(refused.failure.reason).not.toContain("secret");
      expect(refused.failure.reason).not.toContain("line-one");
    }
  });

  test("keeps __proto__ as an own entry and ignores inherited Object.prototype names", () => {
    const captured = capturedEnvironment(
      ["__proto__"],
      Object.fromEntries([["__proto__", "value"]]),
      managed,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(Object.keys(captured.value)).toEqual(["__proto__"]);
    expect(
      Object.getOwnPropertyDescriptor(captured.value, "__proto__")?.value,
    ).toBe("value");
    const inherited = capturedEnvironment(["toString"], {}, managed);
    expect(inherited.ok).toBe(false);
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

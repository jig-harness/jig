import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { parseJunitReport } from "../../../../plugin/shared/junit-report.ts";
import {
  namedSuiteFindings,
  parseOptions,
  parseReport,
  reportFindingsOf,
} from "./check-tests-executed.ts";

const gate = join(import.meta.dir, "check-tests-executed.ts");
const fix = join(import.meta.dir, "fixtures");
const text = (name: string) => readFileSync(join(fix, name), "utf8");

/** Run the gate from the fixtures directory, outside GitHub Actions unless a test asks. */
function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, gate, ...args], {
    cwd: fix,
    env: { ...process.env, GITHUB_ACTIONS: "false", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("one report", () => {
  const cases: [string, number][] = [
    ["bun-healthy.xml", 0],
    ["bun-two-files-one-skipped.xml", 0],
    ["gotestsum-one-package-skipped.xml", 0],
    ["vitest-one-file-skipped.xml", 0],
    ["surefire-single-suite.xml", 0],
    ["bun-all-skipped.xml", 1],
    ["pytest-all-skipped.xml", 1],
    ["no-tests.xml", 1],
    ["declares-but-lists-none.xml", 2],
    ["not-a-report.xml", 2],
    ["not-xml.txt", 2],
    ["empty.xml", 2],
    ["truncated.xml", 2],
    ["does-not-exist.xml", 2],
  ];
  for (const [file, code] of cases)
    test(`${file} exits ${code}`, () =>
      expectSpawnExit(run([file]), code, file));

  test("a pass names the counts and what the check does not judge", () => {
    const r = run(["bun-healthy.xml"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      "OK — bun-healthy.xml: 1 of 4 test case(s) executed (3 skipped) in 1 suite(s)",
    );
    expect(r.stdout).toContain("whether a case asserted anything");
  });

  test("a report that executed nothing names its counts and the remedy", () => {
    const r = run(["bun-all-skipped.xml"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "bun-all-skipped.xml: [tests-executed] 0 of 2 test case(s) executed (2 skipped)",
    );
    expect(r.stderr).toContain("discovery root");
    expect(r.stderr).toContain("1 finding(s) in 1 report(s)");
  });

  test("a report the runner did not write is could not check, not a finding", () => {
    const r = run(["does-not-exist.xml"]);
    expectSpawnExit(r, 2);
    expect(r.stderr).toContain("could not check");
    expect(r.stderr).toContain("did not write it");
  });

  test.each([
    ["truncated.xml", "<testcase> is never closed"],
    ["declares-but-lists-none.xml", "lists no test case"],
    ["not-a-report.xml", "root element is <report>"],
    ["not-xml.txt", "no element"],
    ["empty.xml", "is empty"],
  ])("%s says why it could not be read", (file, reason) => {
    const r = run([file]);
    expectSpawnExit(r, 2, file);
    expect(r.stderr).toContain(reason);
  });
});

describe("--each-suite", () => {
  test("a nested suite that skipped does not fail a file that ran", () =>
    expectSpawnExit(run(["--each-suite", "bun-healthy.xml"]), 0));

  test.each([
    ["bun-two-files-one-skipped.xml", "outbox.integration.test.ts"],
    ["gotestsum-one-package-skipped.xml", "example.com/app/db"],
    ["vitest-one-file-skipped.xml", "src/queue.integration.test.ts"],
  ])("%s fails on the top-level suite that executed nothing", (file, suite) => {
    const r = run(["--each-suite", file]);
    expectSpawnExit(r, 1, file);
    expect(r.stderr).toContain(
      `suite ${suite}: 0 of 2 test case(s) executed (2 skipped)`,
    );
    expect(r.stderr).toContain("1 finding(s)");
  });
});

describe("--suite", () => {
  const report = "bun-two-files-one-skipped.xml";

  test("a named suite that ran passes, at any depth", () => {
    expectSpawnExit(run(["--suite", "orders.integration.test.ts", report]), 0);
    expectSpawnExit(run(["--suite", "orders", report]), 0);
    expectSpawnExit(
      run([
        "--suite",
        "example.com/app/api",
        "gotestsum-one-package-skipped.xml",
      ]),
      0,
    );
  });

  test("a named suite that skipped fails, at any depth", () => {
    for (const name of ["outbox.integration.test.ts", "invoices"]) {
      const r = run(["--suite", name, report]);
      expectSpawnExit(r, 1, name);
      expect(r.stderr).toContain(`suite ${name}: 0 of`);
    }
  });

  test("a named suite in no report fails rather than passing silently", () => {
    const r = run([
      "--suite",
      "orders.integration.test.ts",
      "--suite",
      "ledger.integration.test.ts",
      report,
    ]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "suite ledger.integration.test.ts is in none of the report(s)",
    );
    expect(r.stderr).not.toContain("suite orders.integration.test.ts");
  });
});

describe("several reports", () => {
  test("every report must have executed a test", () => {
    expectSpawnExit(
      run(["bun-healthy.xml", "gotestsum-one-package-skipped.xml"]),
      0,
    );
    expectSpawnExit(run(["bun-healthy.xml", "bun-all-skipped.xml"]), 1);
  });

  test("one report that cannot be read fails the run, whatever the others say", () => {
    expectSpawnExit(run(["bun-healthy.xml", "does-not-exist.xml"]), 2);
    expectSpawnExit(run(["bun-healthy.xml", "empty.xml"]), 2);
  });
});

describe("GitHub Actions", () => {
  const gha = { GITHUB_ACTIONS: "true" };

  test("a finding is also an annotation on the report", () => {
    const r = run(["bun-all-skipped.xml"], gha);
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain(
      "::error file=bun-all-skipped.xml,title=tests-executed::0 of 2 test case(s) executed",
    );
  });

  test("could not check is an annotation too", () => {
    const r = run(["does-not-exist.xml"], gha);
    expectSpawnExit(r, 2);
    expect(r.stdout).toContain(
      "::error title=tests-executed%3A could not check::",
    );
  });

  test("outside GitHub Actions there is no annotation", () => {
    expect(run(["bun-all-skipped.xml"]).stdout).not.toContain("::error");
  });
});

describe("usage", () => {
  test.each([
    ["no report", []],
    ["an unknown option", ["--bogus", "bun-healthy.xml"]],
    ["an empty --suite", ["--suite", "", "bun-healthy.xml"]],
    ["--suite without a name", ["bun-healthy.xml", "--suite"]],
  ])("%s exits 2 with the usage line", (name, args) => {
    const r = run(args);
    expectSpawnExit(r, 2, name);
    expect(r.stderr).toContain("usage:");
  });

  test("parseOptions reads the flags and the reports", () => {
    expect(parseOptions(["a.xml"])).toEqual({
      eachSuite: false,
      suites: [],
      reports: ["a.xml"],
    });
    expect(
      parseOptions([
        "--each-suite",
        "--suite",
        "x",
        "--suite",
        "y",
        "a.xml",
        "b.xml",
      ]),
    ).toEqual({
      eachSuite: true,
      suites: ["x", "y"],
      reports: ["a.xml", "b.xml"],
    });
  });
});

describe("parseReport", () => {
  test("counts cases into the totals and every open suite", () => {
    const report = parseReport(text("bun-healthy.xml"), "bun");
    expect(report.executed).toBe(1);
    expect(report.skipped).toBe(3);
    expect(
      report.suites.map((s) => [s.name, s.depth, s.executed, s.skipped]),
    ).toEqual([
      ["orders.integration.test.ts", 0, 1, 3],
      ["orders", 1, 1, 2],
      ["invoices", 1, 0, 1],
    ]);
  });

  test("a root <testsuite> is one suite at depth 0, and quoted tags in a comment or CDATA do not count", () => {
    const report = parseReport(text("surefire-single-suite.xml"), "surefire");
    expect(report).toEqual({
      suites: [
        { name: "shop.OrdersRepositoryIT", depth: 0, executed: 1, skipped: 1 },
      ],
      executed: 1,
      skipped: 1,
    });
  });

  test("a case with a <skipped> child is skipped, self-closing or not; a failed case ran", () => {
    const report = parseReport(
      `<testsuite name="s"><testcase name="a"><skipped/></testcase><testcase name="b"><skipped message="m"></skipped></testcase><testcase name="c"/><testcase name="d"><failure message="x">boom</failure></testcase></testsuite>`,
      "t",
    );
    expect([report.executed, report.skipped]).toEqual([2, 2]);
  });

  test("attribute values are decoded and may hold a >", () => {
    const report = parseReport(
      `<testsuites><testsuite name="a &amp; b &#x3c; c &gt; d &#39;e&#39;"><testcase name="x"/></testsuite></testsuites>`,
      "t",
    );
    expect(report.suites[0]?.name).toBe("a & b < c > d 'e'");
    expect(
      parseReport(
        `<testsuite name="a > b"><testcase name='x > y'/></testsuite>`,
        "t",
      ).executed,
    ).toBe(1);
  });

  test("a suite without a name is still counted", () => {
    expect(
      parseReport(`<testsuite><testcase name="x"/></testsuite>`, "t").suites[0]
        ?.name,
    ).toBe("(unnamed)");
  });

  test("a prolog and markup XML allows are read", () => {
    const report = parseReport(
      `﻿<?xml version="1.0"?>\n<!-- r --><!DOCTYPE testsuites><?pi x?>\n<testsuites><testsuite name="s"><testcase><system-out><![CDATA[<testcase/>]]>&#x1F600;</system-out></testcase></testsuite></testsuites>\n<!-- end -->\n`,
      "t",
    );
    expect(report.executed).toBe(1);
  });

  test("a DOCTYPE with an external identifier is read by its grammar", () => {
    for (const doctype of [
      `<!DOCTYPE testsuite SYSTEM "junit.dtd">`,
      `<!DOCTYPE testsuite PUBLIC '-//Example//DTD JUnit//EN' "junit.dtd" >`,
    ])
      expect(
        parseReport(`${doctype}<testsuite><testcase/></testsuite>`, "t")
          .executed,
      ).toBe(1);
  });

  test("CRLF and a lone CR in an attribute read as one line end, as XML normalizes them", () => {
    const report = parseJunitReport(
      `<testsuite name="a\r\nb"><testcase name="c\rd" classname="e&#13;&#10;f"/></testsuite>`,
    );
    expect(report.suites[0]?.name).toBe("a b");
    expect(report.cases[0]?.name).toBe("c d");
    expect(report.cases[0]?.classname).toBe("e\r\nf");
  });

  test("a comment opener inside CDATA is text, and the comment after it does not swallow a case", () => {
    const report = parseReport(
      `<testsuite><testcase name="t"><system-out><![CDATA[<!--]]></system-out><skipped/></testcase><!-- end --><testcase name="other"></testcase></testsuite>`,
      "t",
    );
    expect([report.executed, report.skipped]).toEqual([1, 1]);
  });

  test("a <skipped> deeper inside a case does not skip it", () => {
    expect(
      parseReport(
        `<testsuite name="s"><testcase name="x"><system-err><skipped/></system-err></testcase></testsuite>`,
        "t",
      ).executed,
    ).toBe(1);
  });

  test("whitespace and a byte-order mark around the root are content, not text", () => {
    expect(
      parseReport(
        `\uFEFF\n<testsuite><testcase name="x"/></testsuite>\n\n`,
        "t",
      ).executed,
    ).toBe(1);
  });

  test("a <skipped> outside a test case marks nothing", () => {
    expect(
      parseReport(
        `<testsuite name="s"><skipped/><testcase name="x"/></testsuite>`,
        "t",
      ).executed,
    ).toBe(1);
  });

  test("a report with suites but no case parses to zero executed", () => {
    expect(
      parseReport(
        `<testsuites><testsuite name="s"/><testsuite name="t" tests="0"></testsuite></testsuites>`,
        "t",
      ).executed,
    ).toBe(0);
    expect(parseReport(`<testsuite name="s" tests="abc"/>`, "t").executed).toBe(
      0,
    );
  });

  test.each([
    ["an empty report", "  \n", "is empty"],
    ["another document", "<report/>", "root element is <report>"],
    ["no element", "12 pass", "no element"],
    [
      "a stray <",
      `<testsuite><testcase name="x">1 < 2</testcase></testsuite>`,
      "expected an element name at offset 33",
    ],
    [
      "an unquoted attribute",
      `<testsuite name=s><testcase name="x"/></testsuite>`,
      "not well-formed XML",
    ],
    [
      "a mismatched close",
      `<testsuite><testcase name="x"></testsuite>`,
      "</testsuite> closes <testcase>",
    ],
    [
      "a close with nothing open",
      `<testsuites/></testsuites>`,
      "closes nothing",
    ],
    [
      "content after the root",
      `<testsuites/><testsuites/>`,
      "after the root element",
    ],
    [
      "an unclosed element",
      `<testsuites><testsuite name="s">`,
      "<testsuite> is never closed",
    ],
    [
      "a case inside a case",
      `<testsuite><testcase name="a"><testcase name="b"/></testcase></testsuite>`,
      "a <testcase> inside a <testcase>",
    ],
    [
      "a case directly under the root <testsuites>",
      `<testsuites><testcase name="x"/></testsuites>`,
      "a <testcase> inside a <testsuites>",
    ],
    [
      "a case quoted as markup in captured output",
      `<testsuite name="s"><system-out><testcase name="printed"/></system-out></testsuite>`,
      "a <testcase> inside a <system-out>",
    ],
    [
      "a suite under an unknown element",
      `<testsuites><properties><testsuite name="s"><testcase name="x"/></testsuite></properties></testsuites>`,
      "a <testsuite> inside a <properties>",
    ],
    [
      "text before the root",
      `garbage<testsuite><testcase name="x"/></testsuite>`,
      "text outside the root element at offset 0",
    ],
    [
      "text after the root",
      `<testsuite><testcase name="x"/></testsuite>garbage`,
      "text outside the root element",
    ],
    [
      "a repeated attribute",
      `<testsuite name="a" name="b"><testcase name="x"/></testsuite>`,
      "attribute name is repeated",
    ],
    [
      "an unknown entity in an attribute",
      `<testsuite name="a &nbsp; b"><testcase name="x"/></testsuite>`,
      "the unknown entity reference &nbsp;",
    ],
    ...["constructor", "toString", "__proto__", "hasOwnProperty"].map(
      (name) =>
        [
          `an entity named after an inherited object property (${name})`,
          `<testsuite><testcase><system-out>&${name};</system-out></testcase></testsuite>`,
          `the unknown entity reference &${name};`,
        ] as const,
    ),
    [
      "an empty entity reference",
      `<testsuite name="&;"><testcase/></testsuite>`,
      "the unknown entity reference &;",
    ],
    [
      "a bare & in content",
      `<testsuite><testcase name="x"><system-out>a & b</system-out></testcase></testsuite>`,
      "an unterminated entity reference",
    ],
    [
      "a suite inside a case",
      `<testsuite><testcase name="a"><testsuite name="b"/></testcase></testsuite>`,
      "a <testsuite> inside a <testcase>",
    ],
    [
      "a <testsuites> inside a case, hiding the outer skip",
      `<testsuite><testcase><skipped/><testsuites><testsuite><testcase/></testsuite></testsuites></testcase></testsuite>`,
      "a <testsuites> inside a <testcase>",
    ],
    [
      "a nested <testsuites>",
      `<testsuites><testsuites><testsuite><testcase/></testsuite></testsuites></testsuites>`,
      "a <testsuites> inside a <testsuites>",
    ],
    [
      "a CDATA section after the root",
      `<testsuite><testcase/></testsuite><![CDATA[garbage]]>`,
      "CDATA section outside the root",
    ],
    [
      "a CDATA section before the root",
      `<![CDATA[garbage]]><testsuite><testcase/></testsuite>`,
      "CDATA section outside the root",
    ],
    [
      "an XML declaration after the start",
      ` <?xml version="1.0"?><testsuite><testcase/></testsuite>`,
      "an XML declaration not at the start at offset 1",
    ],
    [
      "a DOCTYPE inside the root",
      `<testsuite><!DOCTYPE x><testcase/></testsuite>`,
      "a DOCTYPE inside an element",
    ],
    [
      "attributes on a closing tag",
      `<testsuite><testcase name="x"></testcase bogus="yes"></testsuite>`,
      "expected > to end </testcase at offset",
    ],
    [
      "a < inside an attribute value",
      `<testsuite name="a < b"><testcase/></testsuite>`,
      "a < inside an attribute value",
    ],
    [
      "]]> in character data",
      `<testsuite><testcase/>a ]]> b</testsuite>`,
      "]]> in character data",
    ],
    [
      "a malformed XML declaration",
      `<?xml version="2.0"?><testsuite><testcase/></testsuite>`,
      "a malformed XML declaration",
    ],
    [
      "an XML declaration without a version",
      `<?xml encoding="UTF-8"?><testsuite><testcase/></testsuite>`,
      "a malformed XML declaration",
    ],
    [
      "attributes with no whitespace between them",
      `<testsuite name="a"tests="1"><testcase/></testsuite>`,
      "expected whitespace before an attribute",
    ],
    [
      "a DOCTYPE with an internal subset",
      `<!DOCTYPE testsuite [<!ENTITY x "y">]><testsuite><testcase/></testsuite>`,
      "a DOCTYPE with an internal subset",
    ],
    [
      "a DOCTYPE keyword that is no external identifier",
      `<!DOCTYPE testsuite BANANA><testsuite><testcase/></testsuite>`,
      "expected > to end the DOCTYPE",
    ],
    [
      "a SYSTEM keyword without its literal",
      `<!DOCTYPE testsuite SYSTEM><testsuite><testcase/></testsuite>`,
      "expected whitespace before a DOCTYPE literal",
    ],
    [
      "a PUBLIC identifier without its system literal",
      `<!DOCTYPE testsuite PUBLIC "-//x//EN"><testsuite><testcase/></testsuite>`,
      "expected whitespace before a DOCTYPE literal",
    ],
    [
      "two external identifiers",
      `<!DOCTYPE testsuite SYSTEM "a" SYSTEM "b"><testsuite><testcase/></testsuite>`,
      "expected > to end the DOCTYPE",
    ],
    [
      "a bare literal with no keyword",
      `<!DOCTYPE testsuite "a"><testsuite><testcase/></testsuite>`,
      "expected > to end the DOCTYPE",
    ],
    [
      "a public identifier with a character it may not hold",
      `<!DOCTYPE testsuite PUBLIC "a{b" "c"><testsuite><testcase/></testsuite>`,
      "a public identifier holding a character it may not",
    ],
    [
      "an unclosed comment",
      `<testsuite><testcase/><!-- open</testsuite>`,
      "a comment is never closed",
    ],
    [
      "a comment holding --",
      `<testsuite><!-- a -- b --><testcase/></testsuite>`,
      "a comment holds --",
    ],
    [
      "a reference past the last code point",
      `<testsuite><testcase><system-out>&#x110000;</system-out></testcase></testsuite>`,
      "&#x110000; names no XML character",
    ],
    [
      "a reference to a control character",
      `<testsuite name="&#1;"><testcase/></testsuite>`,
      "&#1; names no XML character",
    ],
    [
      "a raw control character",
      `<testsuite><testcase><system-out>\u0001</system-out></testcase></testsuite>`,
      "a character XML does not allow",
    ],
    [
      "a root that declares cases it does not list",
      `<testsuites tests="2"></testsuites>`,
      "declares 2 test(s) but lists no test case",
    ],
    [
      "a suite that declares cases it does not list",
      `<testsuites><testsuite name="s" tests="3"/></testsuites>`,
      "suite s declares 3 test(s)",
    ],
  ])("%s is refused", (_name, xml, reason) => {
    expect(() => parseReport(xml, "report")).toThrow(reason);
  });
});

describe("findings", () => {
  test("every suite bearing a name must have executed a case", () => {
    const report = parseReport(
      `<testsuites><testsuite name="api"><testcase name="a"/></testsuite><testsuite name="api"><testcase name="b"><skipped/></testcase></testsuite></testsuites>`,
      "r",
    );
    const findings = namedSuiteFindings([{ path: "r.xml", report }], ["api"]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.problem).toBe(
      "suite api: 0 of 1 test case(s) executed (1 skipped)",
    );
    expect(findings[0]?.file).toBe("r.xml");
  });

  test("--each-suite reports top-level suites only, and the total once", () => {
    const report = parseReport(text("bun-all-skipped.xml"), "r");
    expect(
      reportFindingsOf("r.xml", report, true).map((f) => f.problem),
    ).toEqual([
      "0 of 2 test case(s) executed (2 skipped): the suites skipped themselves, or the runner found none",
      "suite outbox.integration.test.ts: 0 of 2 test case(s) executed (2 skipped)",
    ]);
    expect(reportFindingsOf("r.xml", report, false)).toHaveLength(1);
  });
});

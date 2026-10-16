import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  findReferenced,
  findUnregistered,
  parseDeclared,
} from "./audit-error-codes.ts";
import {
  type Construction,
  excessConstructions,
  findConstructions,
  parseAllowlist,
} from "./check-no-inline-codes.ts";

const dir = import.meta.dir;
const fixtures = join(dir, "fixtures");
const inlineGate = join(dir, "check-no-inline-codes.ts");
const auditGate = join(dir, "audit-error-codes.ts");
const FORMAT = "[A-Z]{3}-[0-9]{3}";

function run(script: string, args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The inline gate over the fixture tree, with the registry excluded. */
const inline = (...args: string[]) =>
  run(inlineGate, ["--root", fixtures, "--registry", "registry", ...args]);

/** The audit over the fixture tree, with the registry excluded. */
const audit = (...args: string[]) =>
  run(auditGate, [
    "--root",
    fixtures,
    "--codes",
    "codes/declared.txt",
    "--format",
    FORMAT,
    "--registry",
    "registry",
    ...args,
  ]);

// --- no code constructed outside the registry ---------------------------

test("a tree that constructs codes only in the registry passes", () => {
  const result = inline("registry", "clean/src");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK");
});

test("a construction outside the registry is a finding, with its place", () => {
  const result = inline("registry", "inline/src");
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("inline/src/orders.ts:7");
  expect(result.stderr).toContain("inline/src/orders.ts:9");
  expect(result.stderr).toContain("[inline-error-code]");
});

test("an allowlist that names each construction by identity lets it pass", () => {
  expectSpawnExit(
    inline("--allowlist", "inline/allowlist.txt", "registry", "inline/src"),
    0,
  );
});

test("an allowlist entry that no longer matches the file is stale", () => {
  const result = inline(
    "--allowlist",
    "inline/allowlist-stale.txt",
    "registry",
    "inline/src",
  );
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("stale");
});

test("an allowlist entry without a reason is a finding", () => {
  const result = inline(
    "--allowlist",
    "inline/allowlist-no-reason.txt",
    "registry",
    "inline/src",
  );
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("reason");
});

test("a malformed allowlist cannot be checked", () =>
  expectSpawnExit(
    inline(
      "--allowlist",
      "inline/allowlist-malformed.txt",
      "registry",
      "inline/src",
    ),
    2,
  ));

test("the inline gate fails closed on inputs it cannot use", () => {
  expectSpawnExit(inline("registry"), 2, "the registry alone");
  expectSpawnExit(inline("registry", "nowhere/src"), 2, "a missing path");
  expectSpawnExit(
    run(inlineGate, ["--root", fixtures, "clean/src"]),
    2,
    "no --registry",
  );
  expectSpawnExit(
    inline("--registry", "nowhere", "clean/src"),
    2,
    "a missing registry",
  );
  expectSpawnExit(
    inline("--allowlist", "nowhere.txt", "registry", "clean/src"),
    2,
    "a missing allowlist",
  );
  const empty = mkdtempSync(join(tmpdir(), "error-registry-empty-"));
  expectSpawnExit(inline("registry", empty), 2, "no source file");
  expectSpawnExit(inline("--frobnicate", "registry", "clean/src"), 2);
});

test("findConstructions sees code, and marks what sits in comments or strings", () => {
  const text = [
    'const a = new ErrorCode("SYS-001", {});',
    "// new ErrorCode('SYS-002')",
    "/* new ErrorCode('SYS-003') */ const b = new  ErrorCode(`SYS-004`);",
    `const s = "new ErrorCode('SYS-005')"; const c = new ErrorCode(\`X-\${n}\`);`,
    "const d = new ErrorCodeView('SYS-006'); const e = new ErrorCode(code);",
    "const f = new ErrorCode(",
    '  "SYS-007",',
    ");",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-001" },
    { line: 2, fingerprint: "SYS-002", inText: true },
    { line: 3, fingerprint: "SYS-003", inText: true },
    { line: 3, fingerprint: "SYS-004" },
    { line: 4, fingerprint: "SYS-005", inText: true },
    { line: 4, fingerprint: "?" },
    { line: 5, fingerprint: "?" },
    { line: 6, fingerprint: "SYS-007" },
  ]);
  expect(findConstructions("new Code('A-1')", "ErrorCode")).toEqual([]);
});

test("findConstructions sees the code a template literal runs", () => {
  const text = [
    `const a = \`\${new ErrorCode('SYS-901', m)}\`;`,
    `const b = \`x \${\`y \${new ErrorCode('SYS-902', m)}\`} z\`;`,
    `const c = \`\${ {k: 1}.k } new ErrorCode('SYS-903')\`;`,
    `const d = \`\${f({k: \`}\`})}\${new ErrorCode('SYS-904', m)}\`;`,
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-901" },
    { line: 2, fingerprint: "SYS-902" },
    { line: 3, fingerprint: "SYS-903", inText: true },
    { line: 4, fingerprint: "SYS-904" },
  ]);
});

test("findConstructions reads a regular expression literal as a literal", () => {
  const text = [
    "const quote = /\"/; new ErrorCode('SYS-911', m);",
    "const r = /[/*]/; new ErrorCode('SYS-912', m);",
    "function t(x) { return /'/.test(x) ? new ErrorCode('SYS-913', m) : x; }",
    "const half = x / 2, s = \"/\"; new ErrorCode('SYS-914', m);",
    "const el = <p>{a}</p>; new ErrorCode('SYS-915', m);",
    "const g = /new ErrorCode('SYS-916')/g;",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-911" },
    { line: 2, fingerprint: "SYS-912" },
    { line: 3, fingerprint: "SYS-913" },
    { line: 4, fingerprint: "SYS-914" },
    { line: 5, fingerprint: "SYS-915" },
    { line: 6, fingerprint: "SYS-916", inText: true },
  ]);
});

test("findConstructions reads a regular expression after a statement head", () => {
  const text = [
    "if (ok) /\"/.test(s); new ErrorCode('SYS-931', m);",
    "while (f(x)) /'/.exec(s); new ErrorCode('SYS-932', m);",
    "for (;;) /* c */ /\"/.test(s); new ErrorCode('SYS-933', m);",
    "if /* c */ (ok) /\"/.test(s); new ErrorCode('SYS-934', m);",
    "const q = f(x) / 2, s = \"/\"; new ErrorCode('SYS-935', m);",
    "const p = a.if(x) / 2, t = \"/\"; new ErrorCode('SYS-936', m);",
    "f(...typeof /\"/); new ErrorCode('SYS-937', m);",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-931" },
    { line: 2, fingerprint: "SYS-932" },
    { line: 3, fingerprint: "SYS-933" },
    { line: 4, fingerprint: "SYS-934" },
    { line: 5, fingerprint: "SYS-935" },
    { line: 6, fingerprint: "SYS-936" },
    { line: 7, fingerprint: "SYS-937" },
  ]);
});

test("findConstructions reads each slash from the significant tokens before it", () => {
  const text = [
    "a./*c*/if(x) / 2; new ErrorCode('SYS-941', m); const y = x / 2;",
    "x++ / 2; new ErrorCode('SYS-942', m); const y = x / 2;",
    "x-- / 2; new ErrorCode('SYS-943', m); const y = x / 2;",
    "for await (const x of xs) /\"/.test(s); new ErrorCode('SYS-944', m);",
    "const z = ++/\"/.lastIndex; new ErrorCode('SYS-945', m);",
    "x\n++/\"/.lastIndex; new ErrorCode('SYS-946', m);",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-941" },
    { line: 2, fingerprint: "SYS-942" },
    { line: 3, fingerprint: "SYS-943" },
    { line: 4, fingerprint: "SYS-944" },
    { line: 5, fingerprint: "SYS-945" },
    { line: 7, fingerprint: "SYS-946" },
  ]);
});

test("findConstructions reports a construction the lexer misreads as a literal", () => {
  // Each line holds a `/` the lexer reads the wrong way, so the construction
  // after it lands in a regular expression or a string. It is still found.
  const text = [
    "const of = 4; const n = of / 2; new ErrorCode('SYS-951'); const y = x / 2;",
    "const n = 1 < /\"/.source.length; new ErrorCode('SYS-952');",
    "x\r++/\"/.lastIndex; new ErrorCode('SYS-953');",
  ].join("\n");
  expect(
    findConstructions(text, "ErrorCode").map(({ line, fingerprint }) => ({
      line,
      fingerprint,
    })),
  ).toEqual([
    { line: 1, fingerprint: "SYS-951" },
    { line: 2, fingerprint: "SYS-952" },
    { line: 3, fingerprint: "SYS-953" },
  ]);
});

test("the inline gate reports a construction in text, and never allowlists it", () => {
  const tree = mkdtempSync(join(tmpdir(), "error-registry-text-"));
  mkdirSync(join(tree, "registry"));
  writeFileSync(join(tree, "registry", "codes.ts"), "");
  writeFileSync(join(tree, "a.ts"), "// new ErrorCode('SYS-961')\n");
  const result = run(inlineGate, [
    "--root",
    tree,
    "--registry",
    "registry",
    "a.ts",
  ]);
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("a.ts:1");
  expect(result.stderr).toContain("reads as a comment or a literal");
  expect(result.stderr).toContain("the allowlist does not cover text");
  const withAllowlist = [
    "--root",
    tree,
    "--registry",
    "registry",
    "--allowlist",
    "allow.txt",
    "a.ts",
  ];
  // No entry covers it: the construction stays a finding, the entry is stale.
  for (const entry of ["a.ts:SYS-961", "a.ts:text:SYS-961"]) {
    writeFileSync(join(tree, "allow.txt"), `# prose\n${entry}\n`);
    const listed = run(inlineGate, withAllowlist);
    expectSpawnExit(listed, 1);
    expect(listed.stderr).toContain("reads as a comment or a literal");
    expect(listed.stderr).toContain("a.ts holds []");
  }
  // Reworded, the file is clean.
  writeFileSync(join(tree, "a.ts"), "// constructs an ErrorCode\n");
  writeFileSync(join(tree, "allow.txt"), "");
  expectSpawnExit(run(inlineGate, withAllowlist), 0);
});

test("the allowlist covers code, never a construction found in text", () => {
  const text: Construction = { line: 1, fingerprint: "SYS-001", inText: true };
  const code: Construction = { line: 2, fingerprint: "SYS-001" };
  expect(excessConstructions([text, code], ["SYS-001"])).toEqual([text]);
  expect(excessConstructions([text, code], ["SYS-001", "SYS-001"])).toEqual([
    text,
  ]);
  expect(excessConstructions([text], ["text:SYS-001"])).toEqual([text]);
});

test("findConstructions matches a construction whatever stands between its tokens", () => {
  const text = [
    "new /* c */ ErrorCode('SYS-971', m);",
    "new (ErrorCode)('SYS-972', m);",
    "new ErrorCode<Metadata>('SYS-973', m);",
    "new ErrorCode<Map<string, () => void>>('SYS-974', m);",
    "new // c",
    "  ( /* c */ ErrorCode ) /* c */ <M> ('SYS-975', m);",
    "new (ErrorCode<Metadata>)('SYS-977', m);",
    "new ( /* c */ (ErrorCode<M>) ) <N> ('SYS-978', m);",
    "new errors.ErrorCode('SYS-979', m); new (a . /* c */ b.ErrorCode)('SYS-980');",
    "new ErrorCodeView('SYS-976'); const lt = a < b, gt = c > (d);",
    "new x$ErrorCode('SYS-982'); renew ErrorCode('SYS-983'); new ErrorCode.Sub('SYS-984');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-971" },
    { line: 2, fingerprint: "SYS-972" },
    { line: 3, fingerprint: "SYS-973" },
    { line: 4, fingerprint: "SYS-974" },
    { line: 5, fingerprint: "SYS-975" },
    { line: 7, fingerprint: "SYS-977" },
    { line: 8, fingerprint: "SYS-978" },
    { line: 9, fingerprint: "SYS-979" },
    { line: 9, fingerprint: "SYS-980" },
  ]);
});

test("findConstructions reads the callee, whatever member chain names the constructor", () => {
  const text = [
    "new (errors).ErrorCode('SYS-985'); new errors['ErrorCode']('SYS-986');",
    "new (errors)[\"ErrorCode\"]<M>('SYS-987'); new errors[`ErrorCode`]('SYS-988');",
    "new ErrorCode<() => (Meta)>('SYS-989'); new ErrorCode<(a: M) => R>(code);",
    "new (flag ? Other : ErrorCode)('SYS-990'); new ErrorCode;",
    "new errors['Other']('SYS-991'); new handlers[kind]('SYS-992'); new (make())('SYS-993');",
    "new Map<string, ErrorCode>(); new ErrorCode.Sub('SYS-994'); new.target;",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-985" },
    { line: 1, fingerprint: "SYS-986" },
    { line: 2, fingerprint: "SYS-987" },
    { line: 2, fingerprint: "SYS-988" },
    { line: 3, fingerprint: "SYS-989" },
    { line: 3, fingerprint: "?" },
    { line: 4, fingerprint: "SYS-990" },
    { line: 4, fingerprint: "?" },
  ]);
});

test("a construction the lexer hides behind a comment is still reported, and not allowlistable", () => {
  // The lexer reads `of / 2; new /* c */ ErrorCode(...) ... x /` as a regular
  // expression, so the construction lands in what it takes for a literal.
  const text =
    "const of = 4; const n = of / 2; new /* c */ ErrorCode('SYS-981', m); const y = x / 2;";
  const found = findConstructions(text, "ErrorCode");
  expect(found.map(({ fingerprint }) => fingerprint)).toEqual(["SYS-981"]);
  expect(excessConstructions(found, ["SYS-981"])).toEqual(found);
});

test("findConstructions reads a callee the lexer's literals, escapes and assertions would hide", () => {
  const text = [
    "new (/\\)/.test(s) ? ErrorCode : Other)('SYS-995');",
    `new errors['Error\\u0043ode']('SYS-996'); new errors[\`ErrorCode${"$"}{''}\`]('SYS-997');`,
    "new errors!['ErrorCode']('SYS-998'); new errors!.ErrorCode('SYS-999');",
    "new errors['Other']('SYS-900'); new errors!['Other']('SYS-901');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-995" },
    { line: 2, fingerprint: "SYS-996" },
    { line: 2, fingerprint: "SYS-997" },
    { line: 3, fingerprint: "SYS-998" },
    { line: 3, fingerprint: "SYS-999" },
  ]);
});

test("a callee whose name only evaluation of literal text settles counts as naming the constructor", () => {
  const text = [
    `new errors[\`Error${"$"}{\`Code\`}\`]('SYS-981');`,
    "new errors['Error' + 'Code']('SYS-982');",
    "new (flag ? errors['Other'] : errors['Error' + 'Code'])('SYS-983');",
    "new errors[key]('SYS-984'); new (flag ? A : B)('SYS-985');",
    `new errors[prefix + 'Code']('SYS-986'); new errors[\`${"$"}{name}\`]('SYS-987');`,
    "new errors['ERRORCODE'.toLowerCase()]('SYS-988');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-981" },
    { line: 2, fingerprint: "SYS-982" },
    { line: 3, fingerprint: "SYS-983" },
    { line: 5, fingerprint: "SYS-986" },
    { line: 5, fingerprint: "SYS-987" },
    { line: 6, fingerprint: "SYS-988" },
  ]);
});

test("a literal in an unsettled callee that cannot spell the constructor's name does not count", () => {
  const text = [
    "new (kind === 'date' ? Date : RegExp)('SYS-971');",
    "new handlers['Other' + 'Thing']('SYS-972');",
    "new (mode === `fast` ? Fast : Slow)('SYS-973');",
    "new (kind === 'date' && /\\d/.test(input) ? Date : RegExp)('SYS-946');",
    "new handlers[prefix + 'Thing']('SYS-947'); new (pick('x', 'y'))('SYS-948');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([]);
});

test("a template hole holding a literal or a slash is read as unknown text, wherever its brace closes", () => {
  const text = [
    "new errors[`Error$" + "{/}/.source === '}' ? 'Code' : ''}`]('SYS-939');",
    "new errors[`Error$" + "{/{/.test(s) ? 'Code' : ''}`]('SYS-938');",
    "new handlers[`Other$" + "{/}/.source}`]('SYS-937');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-939" },
    { line: 2, fingerprint: "SYS-938" },
  ]);
});

test("a comment inside an unsettled callee changes nothing", () => {
  const text = [
    "new handlers['Other' /* + */ + 'Thing']('SYS-970');",
    "new handlers['Other' // + 'x'",
    "  + 'Thing']('SYS-969');",
    "new handlers[/* 'Error' + 'Code' */ 'Other' + 'Thing']('SYS-968');",
    "new errors['Error' /* , */ + 'Code']('SYS-967');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 5, fingerprint: "SYS-967" },
  ]);
});

test("literal text an unsettled callee transforms, or passes where a name is read, counts as naming the constructor", () => {
  const text = [
    "new errors['Error_Code'.replace(/_/g, String())]('SYS-941');",
    "new errors[flag ? 'ErrorCode' : 'Other']('SYS-942');",
    "new (Reflect.get(errors, 'Error' + 'Code'))('SYS-943');",
    "new (lookup?.(errors, 'ErrorCode'))('SYS-944');",
    "new (flag ? Date : errors[['Error', 'Code'].join('')])('SYS-945');",
  ].join("\n");
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "SYS-941" },
    { line: 2, fingerprint: "SYS-942" },
    { line: 3, fingerprint: "SYS-943" },
    { line: 4, fingerprint: "SYS-944" },
    { line: 5, fingerprint: "SYS-945" },
  ]);
});

test("a construction without arguments the lexer misreads as a literal is still reported", () => {
  const text =
    "const of = 4; const n = of / 2; new ErrorCode; const y = x / 2;";
  expect(findConstructions(text, "ErrorCode")).toEqual([
    { line: 1, fingerprint: "?", inText: true },
  ]);
});

test("findConstructions fails closed on a slash it cannot classify", () => {
  expect(() =>
    findConstructions("if (a) {}\n/x/.test(b);", "ErrorCode"),
  ).toThrow("line 2");
  expect(() => findConstructions("const r = /abc\n;", "ErrorCode")).toThrow(
    "regular expression",
  );
});

test("findConstructions matches a constructor name that holds a $", () => {
  expect(findConstructions("new $Code('SYS-921', m)", "$Code")).toEqual([
    { line: 1, fingerprint: "SYS-921" },
  ]);
  expect(
    findConstructions(
      "new Code$('SYS-922', m); new Code$$('SYS-923');",
      "Code$",
    ),
  ).toEqual([{ line: 1, fingerprint: "SYS-922" }]);
});

test("a literal is the identity only when it is the whole first argument", () => {
  const text = [
    "new ErrorCode('ORD-001' + suffix, m);",
    "new ErrorCode('ORD-002'.trim(), m);",
    "new ErrorCode('ORD-003' /* why */ , m);",
    "new ErrorCode('ORD-004');",
  ].join("\n");
  expect(
    findConstructions(text, "ErrorCode").map((c) => c.fingerprint),
  ).toEqual(["?", "?", "ORD-003", "ORD-004"]);
});

test("the inline gate fails closed on a file it cannot lex", () => {
  const tree = mkdtempSync(join(tmpdir(), "error-registry-lex-"));
  mkdirSync(join(tree, "registry"));
  writeFileSync(join(tree, "registry", "codes.ts"), "");
  writeFileSync(join(tree, "a.ts"), "if (a) {}\n/x/.test(b);\n");
  const result = run(inlineGate, [
    "--root",
    tree,
    "--registry",
    "registry",
    "a.ts",
  ]);
  expectSpawnExit(result, 2);
  expect(result.stderr).toContain("a.ts");
});

test("each scan root must yield a file to scan", () => {
  const empty = mkdtempSync(join(tmpdir(), "error-registry-empty-"));
  expectSpawnExit(inline("registry", "clean/src", empty), 2, "inline gate");
  expectSpawnExit(audit("clean/src", empty), 2, "audit sources");
  expectSpawnExit(
    audit("--docs", "clean/docs", "--docs", empty, "clean/src"),
    2,
    "audit docs root",
  );
  expectSpawnExit(
    audit("--docs", "clean/docs", "--docs-ext", ",", "clean/src"),
    2,
    "audit docs extensions",
  );
});

test("a generated copy of the registry is not evidence of use", () => {
  const headed = audit("orphan/src", "generated/client");
  expectSpawnExit(headed, 1, "a generated header");
  expect(headed.stderr).toContain("RES-002");
  const globbed = audit(
    "--generated",
    "generated/catalog.*",
    "orphan/src",
    "generated/catalog.ts",
  );
  expectSpawnExit(globbed, 1, "a --generated glob");
  expect(globbed.stderr).toContain("RES-002");
  expectSpawnExit(
    audit("--generated", "generated/catalog.*", "generated"),
    2,
    "a root of generated copies only",
  );
});

test("parseAllowlist reads identities per file and rejects what it cannot", () => {
  const list = parseAllowlist(
    "# debt\nsrc/a.ts:?,X-001\n\n# more\nsrc/b.ts:Y-001\n",
  );
  expect([...list.entries()]).toEqual([
    ["src/a.ts", { fingerprints: ["?", "X-001"], line: 2, reason: "debt" }],
    ["src/b.ts", { fingerprints: ["Y-001"], line: 5, reason: "more" }],
  ]);
  expect(() => parseAllowlist("src/a.ts")).toThrow("fingerprint");
  expect(() => parseAllowlist("src/a.ts:X-001,")).toThrow("empty");
  expect(() => parseAllowlist("src/a.ts:X-002,X-001")).toThrow("sorted");
  expect(() => parseAllowlist("src/a.ts:X-001\nsrc/a.ts:X-002")).toThrow(
    "twice",
  );
});

test("excessConstructions is a multiset difference by identity", () => {
  const found = [
    { line: 1, fingerprint: "X-001" },
    { line: 2, fingerprint: "X-001" },
    { line: 3, fingerprint: "?" },
  ];
  expect(excessConstructions(found, ["X-001"]).map((c) => c.line)).toEqual([
    2, 3,
  ]);
  expect(excessConstructions(found, ["?", "X-001", "X-001"])).toEqual([]);
});

// --- orphans and reverse orphans ------------------------------------------

test("a tree that references every code and documents only registered ones passes", () => {
  const result = audit("--docs", "clean/docs", "clean/src");
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("OK");
});

test("a registered code nothing references is an orphan", () => {
  const result = audit("orphan/src");
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("RES-002");
  expect(result.stderr).toContain("[orphan-error-code]");
  expect(result.stderr).not.toContain("RES-001");
});

test("a baseline accepts an orphan by identity, with a reason", () => {
  expectSpawnExit(audit("--baseline", "orphan/baseline.txt", "orphan/src"), 0);
  const stale = audit("--baseline", "orphan/baseline-stale.txt", "orphan/src");
  expectSpawnExit(stale, 1);
  expect(stale.stderr).toContain("RES-001");
  expect(stale.stderr).toContain("[orphan-baseline]");
  const unreasoned = audit(
    "--baseline",
    "orphan/baseline-no-reason.txt",
    "orphan/src",
  );
  expectSpawnExit(unreasoned, 1);
  expect(unreasoned.stderr).toContain("reason");
});

test("a code-shaped literal in hand-written docs that no registry declares is a finding", () => {
  const result = audit("--docs", "reverse/docs", "clean/src");
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("reverse/docs/errors.md:3");
  expect(result.stderr).toContain("RES-404");
  expect(result.stderr).toContain("[unregistered-error-code]");
  expect(result.stderr).not.toContain("RES-001");
});

test("the audit fails closed on inputs it cannot use", () => {
  const base = [
    "--root",
    fixtures,
    "--format",
    FORMAT,
    "--registry",
    "registry",
  ];
  expectSpawnExit(
    run(auditGate, [...base, "--codes", "codes/empty.txt", "clean/src"]),
    2,
    "an empty registry list",
  );
  expectSpawnExit(
    run(auditGate, [...base, "--codes", "codes/malformed.txt", "clean/src"]),
    2,
    "a code outside the format",
  );
  expectSpawnExit(
    run(auditGate, [...base, "--codes", "codes/duplicate.txt", "clean/src"]),
    2,
    "a code declared twice",
  );
  expectSpawnExit(
    run(auditGate, [...base, "--codes", "codes/nowhere.txt", "clean/src"]),
    2,
    "a missing registry list",
  );
  expectSpawnExit(run(auditGate, [...base, "clean/src"]), 2, "no --codes");
  expectSpawnExit(
    run(auditGate, [
      "--root",
      fixtures,
      "--registry",
      "registry",
      "--codes",
      "codes/declared.txt",
      "clean/src",
    ]),
    2,
    "no --format",
  );
  expectSpawnExit(
    run(auditGate, [
      "--root",
      fixtures,
      "--registry",
      "registry",
      "--codes",
      "codes/declared.txt",
      "--format",
      "[A-Z",
      "clean/src",
    ]),
    2,
    "a format that is no regular expression",
  );
  expectSpawnExit(audit(), 2, "no source path");
  expectSpawnExit(audit("nowhere/src"), 2, "a missing source path");
  expectSpawnExit(
    audit("--docs", "nowhere", "clean/src"),
    2,
    "a missing docs path",
  );
  expectSpawnExit(
    audit("--baseline", "nowhere.txt", "clean/src"),
    2,
    "a missing baseline",
  );
  const empty = mkdtempSync(join(tmpdir(), "error-registry-empty-"));
  expectSpawnExit(audit(empty), 2, "no source file");
});

test("parseDeclared reads codes and their names", () => {
  const format = /^(?:[A-Z]{3}-[0-9]{3})$/;
  expect(
    parseDeclared("# codes\nSYS-001 Codes.INTERNAL\nRES-001\n", format),
  ).toEqual([
    { code: "SYS-001", name: "Codes.INTERNAL", line: 2 },
    { code: "RES-001", name: undefined, line: 3 },
  ]);
  expect(() => parseDeclared("SYS-1", format)).toThrow("format");
  expect(() => parseDeclared("SYS-001 a b", format)).toThrow("line 1");
  expect(() => parseDeclared("SYS-001\nSYS-001", format)).toThrow("twice");
});

test("findReferenced credits a literal or a name, on word boundaries", () => {
  const declared = [
    { code: "SYS-001", name: "Codes.INTERNAL", line: 1 },
    { code: "RES-001", name: "Codes.NOT_FOUND", line: 2 },
    { code: "RES-002", name: undefined, line: 3 },
  ];
  const seen = findReferenced(
    'x(Codes.INTERNAL); y("RES-0010"); z(Codes.NOT_FOUND_AGAIN); "XRES-002"',
    declared,
  );
  expect([...seen]).toEqual(["SYS-001"]);
  expect([...findReferenced("'RES-002'", declared)]).toEqual(["RES-002"]);
});

test("findUnregistered reports each code-shaped literal the registry lacks", () => {
  const known = new Set(["RES-001"]);
  const format = new RegExp(`(?<![\\w-])(?:${FORMAT})(?![\\w-])`, "g");
  expect(
    findUnregistered(
      "RES-001 then RES-404\nand RES-404, XRES-405 too",
      known,
      format,
    ),
  ).toEqual([
    { line: 1, code: "RES-404" },
    { line: 2, code: "RES-404" },
  ]);
});

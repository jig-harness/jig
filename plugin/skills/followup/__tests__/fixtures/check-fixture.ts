/**
 * A repository arm's check command the tests run through the shell: one Bun
 * program for every behaviour, so a fixture needs no shell syntax and runs
 * the same on every platform's interpreter.
 *
 * Usage: bun check-fixture.ts <mode>
 */
const TOKENS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "JIRA_API_TOKEN",
  "LINEAR_API_KEY",
];

const mode = process.argv[2];
if (mode === "hang") await Bun.sleep(2_000_000);
if (mode === "fail") {
  console.error("the ledger could not be opened");
  process.exit(4);
}
if (mode === "garbage") {
  console.log("all good");
  process.exit(0);
}
if (mode === "nothing") {
  console.log(JSON.stringify({ verdict: "not-owed", evidence: "nothing found" }));
  process.exit(0);
}
const facts = JSON.parse(await Bun.stdin.text()) as {
  pr: number;
  changedFiles: string[];
};
const seen = TOKENS.filter((name) => process.env[name] !== undefined);
console.log(
  JSON.stringify({
    verdict: "owed",
    items: ["the ledger's entry for the export"],
    evidence: `PR ${facts.pr} changed ${facts.changedFiles.join(", ")}; tokens: ${seen.join(", ") || "none"}`,
  }),
);

/** Terminal pull request reads in the dispatch fixture's fake forge process. */
export const TERMINAL_PULL_FIXTURE = `
const pullList = (state) => JSON.parse(fs.readFileSync(F + "/prs-" + state + ".json", "utf8"));
if (args[0] === "pr" && args[1] === "list" && args.includes("is:closed")) {
  const label = args[args.indexOf("--label") + 1];
  out(["merged", "closed"].flatMap(pullList).filter((p) => p.labels?.some((l) => l.name === label)));
}
if (args[0] === "pr" && args[1] === "view" && args[args.length - 1] === "state,labels") {
  for (const state of ["open", "merged", "closed"]) {
    const listed = pullList(state).find((p) => p.number === Number(args[2]));
    if (listed !== undefined) out({ state: state.toUpperCase(), labels: listed.labels ?? [] });
  }
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "view" && args[args.length - 1] === "labels") {
  // One pull request's labels read again, open or merged, as its listing holds them.
  const all = ["open", "merged", "closed"].flatMap((s) => pullList(s));
  const listed = all.find((p) => p.number === Number(args[2]));
  if (listed === undefined) { process.stderr.write("gh: no pull requests found\\n"); process.exit(1); }
  out({ labels: listed.labels ?? [] });
}
`;

import { isGitSha } from "./cli.ts";

function takeExpectedTransition(
  command: string,
  argv: string[],
  usage: () => never,
): string | undefined {
  const index = argv.indexOf("--expect-transition");
  if (index < 0) return undefined;
  const id = argv[index + 1];
  if (
    command !== "release" ||
    id === undefined ||
    !/^[A-Za-z0-9_+/=-]+$/.test(id)
  )
    usage();
  argv.splice(index, 2);
  return id;
}

function requireFinalReady(command: string, usage: () => never): void {
  if (command !== "final-ready") usage();
}

function expectedSha(value: string | undefined, usage: () => never): string {
  if (value === undefined || !isGitSha(value)) usage();
  return value;
}

export function parseCiHoldArgs(argv: string[], usage: () => never) {
  const command = argv.shift() ?? "";
  if (!["ensure", "release", "rollback", "final-ready"].includes(command))
    usage();
  let pr = "";
  let head = "";
  let requireSuccess = false;
  let mergedFrom: string | undefined;
  const expectedTransition = takeExpectedTransition(command, argv, usage);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index] ?? "";
    switch (value) {
      case "--expect-head":
        head = argv[++index] ?? "";
        break;
      case "--require-success":
        requireFinalReady(command, usage);
        requireSuccess = true;
        break;
      case "--base-merge-from":
        requireFinalReady(command, usage);
        mergedFrom = expectedSha(argv[++index], usage);
        break;
      default:
        if (pr !== "" || value.startsWith("--")) usage();
        pr = value;
    }
  }
  return { command, pr, head, requireSuccess, mergedFrom, expectedTransition };
}

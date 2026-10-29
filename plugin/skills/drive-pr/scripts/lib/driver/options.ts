import { fail, isDigits } from "../cli.ts";

interface DriverOptions {
  pr: string;
  maxRounds: string | undefined;
  dryRun: boolean;
  botsOnly: boolean;
  keepDraft: boolean;
  handoffAt: string;
  passTimeout: string;
  forward: string[];
  agent: string[];
  /** `--take-over`: replace a WEDGED or dead holder (`takeover.ts`). */
  takeOver: boolean;
  /** `--window-reopened`: a person says a quota wall's window is open again. */
  windowReopened: boolean;
}

function flagValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined) fail(2, `${argv[index]} requires a value`);
  return value;
}

/** Consume a driver option; the returned index includes any value it used. */
function parseFlag(
  options: DriverOptions,
  argv: string[],
  index: number,
): number {
  const flag = argv[index] as string;
  switch (flag) {
    case "--max-rounds":
      options.maxRounds = flagValue(argv, index);
      return index + 1;
    case "--handoff-at":
      options.handoffAt = flagValue(argv, index);
      return index + 1;
    case "--pass-timeout":
      options.passTimeout = flagValue(argv, index);
      return index + 1;
    case "--dry-run":
      options.dryRun = true;
      return index;
    case "--keep-draft":
      options.keepDraft = true;
      return index;
    case "--take-over":
      options.takeOver = true;
      return index;
    case "--window-reopened":
      options.windowReopened = true;
      return index;
    case "--bots-only":
      options.botsOnly = true;
      options.forward.push(flag);
      return index;
    case "--no-head-sync":
      options.forward.push(flag);
      return index;
    case "--timeout":
    case "--interval":
      options.forward.push(flag, flagValue(argv, index));
      return index + 1;
    default:
      if (flag.startsWith("--")) fail(2, `unknown flag: ${flag}`);
      options.pr = flag;
      return index;
  }
}

export function parseDriverOptions(argv: string[]): DriverOptions {
  const options: DriverOptions = {
    pr: "",
    maxRounds: undefined,
    dryRun: false,
    botsOnly: false,
    keepDraft: false,
    handoffAt: "50",
    passTimeout: "",
    forward: [],
    agent: [],
    takeOver: false,
    windowReopened: false,
  };
  let sawDdash = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (sawDdash) options.agent.push(arg);
    else if (arg === "--") sawDdash = true;
    else index = parseFlag(options, argv, index);
  }
  if (options.takeOver && options.dryRun)
    fail(
      2,
      "drive.ts: --take-over stops another driver; it cannot be a --dry-run",
    );
  return options;
}

// A command-line typo refuses at exit 2; the environment reader instead falls
// back to its default because unusable inherited values are not instructions.
export function applyPassTimeout(passTimeout: string): void {
  if (passTimeout === "") return;
  if (!isDigits(passTimeout)) {
    fail(2, "--pass-timeout takes a whole number of seconds (0 disables)");
  }
  const passTimeoutN = Number.parseInt(passTimeout, 10);
  if (passTimeoutN !== 0 && passTimeoutN * 1000 > 2_147_483_647) {
    fail(
      2,
      `--pass-timeout must be 0 or no greater than 2147483 seconds (got '${passTimeout}') — beyond that the millisecond delay overflows a 32-bit timer and fires immediately, inverting the deadline.`,
    );
  }
  process.env.DRIVE_PR_PASS_TIMEOUT = passTimeout;
}

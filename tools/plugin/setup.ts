#!/usr/bin/env bun
/**
 * Install, update or check the `jig` plugin for every agent harness on
 * this machine, from a checkout of this repository: the first install, before
 * the plugin's `jig` command is on `PATH`. Once it is, `jig upgrade` and
 * `jig doctor` do the same and more. The work is the plugin's own
 * (`plugin/runtime/harness.ts`); this script only reads its arguments.
 *
 * Usage:
 *   bun tools/plugin/setup.ts            install, or update to the newest release
 *                                        of the channel the machine follows
 *   bun tools/plugin/setup.ts --check    report what is installed; exit 1 if missing
 *   options: --channel latest|stable     follow that release channel (a fresh
 *                                        install follows stable); refused when
 *                                        the marketplace is registered at another
 *            --source <marketplace>      install from this source instead of
 *                                        $JIG_MARKETPLACE or the Jig
 *                                        GitHub repository (HTTPS); refused when the
 *                                        marketplace is already registered elsewhere
 *            --claude | --codex          only that harness (required to exist)
 *   JIG_SETUP_TIMEOUT_SECONDS     limit per tool command (default 300)
 */
import { cli } from "../../lib/cli.ts";
import {
  CHANNELS,
  type Channel,
  checkHarnesses,
  type Harness,
  harnessesExit,
  harnessRequest,
  UpgradeRequestError,
  upgradeHarnesses,
} from "../../plugin/runtime/harness.ts";

interface Flags {
  check: boolean;
  only: Harness | null;
  source?: string;
  channel?: Channel;
}

/** The value after the option at `at`, refused when missing. */
function value(argv: string[], at: number, missing: string): string {
  const given = argv[at + 1];
  if (!given) throw new UpgradeRequestError(missing);
  return given;
}

/** Reads the argument at `at` into `flags`; the index of the last argument it took. */
function take(argv: string[], at: number, flags: Flags): number {
  const arg = argv[at] as string;
  if (arg === "--check") flags.check = true;
  else if (arg === "--claude" || arg === "--codex")
    flags.only = arg.slice(2) as Harness;
  else if (arg === "--source") {
    flags.source = value(argv, at, "--source needs a marketplace source");
    return at + 1;
  } else if (arg === "--channel") {
    const channel = argv[at + 1] ?? "";
    if (!(CHANNELS as readonly string[]).includes(channel))
      throw new UpgradeRequestError(
        `--channel needs one of: ${CHANNELS.join(", ")}`,
      );
    flags.channel = channel as Channel;
    return at + 1;
  } else throw new UpgradeRequestError(`unknown argument: ${arg}`);
  return at;
}

export function parse(argv: string[]) {
  const flags: Flags = { check: false, only: null };
  for (let at = 0; at < argv.length; at++) at = take(argv, at, flags);
  const { check, only, source, channel } = flags;
  return {
    check,
    ...harnessRequest({
      ...(source === undefined ? {} : { source }),
      ...(channel === undefined ? {} : { channel }),
      only,
    }),
  };
}

if (import.meta.main)
  cli(() => {
    const { check, ...request } = parse(process.argv.slice(2));
    return harnessesExit(
      check ? checkHarnesses(request) : upgradeHarnesses(request),
    );
  });

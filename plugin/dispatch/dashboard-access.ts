/**
 * `jig dispatch dashboard --access`: the address a person opens the dashboard
 * at. With a front named in the machine file (`dashboard.front`) that is the
 * front's token-free HTTPS address, printed as text and, on a terminal that
 * can draw it, as a QR code of the same address for a phone camera. Without
 * one it is the installed reader's private URL, a credential when tokens are
 * on, which is never drawn as a code.
 */
import type { Outcome } from "../shared/outcome.ts";
import { readAccess } from "./dashboard-reader.ts";
import {
  type MachineConfig,
  type MachineConfigCode,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { encodeQr, renderQr } from "./lib/qr.ts";

/** What the command writes where, and its exit code. */
interface AccessReport {
  stdout: string[];
  stderr: string[];
  code: number;
}

/** The standard output's terminal: whether it is one, and its `TERM`. */
export interface AccessTerminal {
  isTTY: boolean;
  term: string | undefined;
}

/** Where the setup of a front is written down, for a person reading a terminal. */
const GUIDE = "the jig plugin's phone-access.md";

/** A code needs a terminal that draws characters in place; a pipe, a file or a `dumb` terminal gets the text alone. */
function drawable(terminal: AccessTerminal): boolean {
  return terminal.isTTY && terminal.term !== "dumb";
}

/** The front's address on standard output, first, then its code where the terminal draws one. */
function frontReport(
  front: string,
  reader: Outcome<{ url: string }, string>,
  terminal: AccessTerminal,
): AccessReport {
  const stdout = [front];
  const stderr: string[] = [];
  if (drawable(terminal)) {
    const code = encodeQr(front);
    if (code.ok)
      stdout.push(
        ...renderQr(code.value),
        "The code holds only this address; the front still signs the viewer in.",
      );
    else stderr.push(`No QR code: ${code.failure.reason}.`);
  }
  if (!reader.ok)
    stderr.push(
      "The dashboard reader behind the front is not confirmed running, so the address shows no page yet; check it with jig dispatch dashboard --status.",
    );
  return { stdout, stderr, code: 0 };
}

/** Why no code is drawn and how a phone gets a token-free address, by whether the reader asks for a token. */
function fallbackNote(
  requireToken: boolean,
  printed: boolean,
  machinePath: string,
): string[] {
  if (!requireToken)
    return [
      ...(printed
        ? [
            "This address answers on this host only; a phone opens the dashboard through its front.",
          ]
        : []),
      `Set the front's token-free address as dashboard.front in ${machinePath} to print it and its QR code; ${GUIDE} is the setup.`,
    ];
  return [
    ...(printed
      ? [
          "This is the private-HTTP fallback address. Its token makes it a credential: carry it to a phone only over a private channel, and never post it.",
        ]
      : []),
    `No QR code is drawn for an address that carries a token. For a token-free phone address, put a private HTTPS front before the dashboard and set its address as dashboard.front in ${machinePath}; ${GUIDE} is the setup.`,
  ];
}

/**
 * What `--access` prints: the front's address and its code when the machine
 * file names a front, otherwise the reader's own URL with why it is not
 * drawn. The reader's token-bearing URL is never printed beside a front's
 * address, and never encoded.
 */
export function accessReport(
  machine: Outcome<MachineConfig | null, MachineConfigCode>,
  reader: Outcome<{ url: string }, string>,
  terminal: AccessTerminal,
  machinePath: string,
): AccessReport {
  const front = machine.ok ? (machine.value?.dashboardFront ?? null) : null;
  if (front !== null) return frontReport(front, reader, terminal);
  const report: AccessReport = reader.ok
    ? { stdout: [reader.value.url], stderr: [], code: 0 }
    : { stdout: [], stderr: [reader.failure.reason], code: 1 };
  if (!machine.ok) report.stderr.push(machine.failure.reason);
  else
    report.stderr.push(
      ...fallbackNote(
        machine.value?.dashboardRequireToken ?? true,
        reader.ok,
        machinePath,
      ),
    );
  return report;
}

export function dashboardAccess(): number {
  const report = accessReport(
    readMachineConfig(),
    readAccess(),
    { isTTY: process.stdout.isTTY === true, term: process.env.TERM },
    machineConfigPath(),
  );
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  return report.code;
}

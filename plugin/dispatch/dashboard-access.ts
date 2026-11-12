/**
 * `jig dispatch dashboard --access`: the address a person opens the dashboard
 * at. With a front named in the machine file (`dashboard.front`) that is the
 * front's token-free HTTPS address, printed as text and, on a terminal that
 * can draw it, as a QR code of the same address for a phone camera. Without
 * one it is the installed reader's private URL, a credential when tokens are
 * on, which is never drawn as a code.
 */
import type { Outcome } from "../shared/outcome.ts";
import { readAccess, readerSettings } from "./dashboard-reader.ts";
import {
  type MachineConfig,
  type MachineConfigCode,
  machineConfigPath,
  readMachineConfig,
} from "./lib/machine-config.ts";
import { encodeQr, QUIET_ZONE, renderQr } from "./lib/qr.ts";

/** What the command writes where, and its exit code. */
interface AccessReport {
  stdout: string[];
  stderr: string[];
  code: number;
}

/** The standard output's terminal: whether it is one, its `TERM`, `NO_COLOR` and width. */
export interface AccessTerminal {
  isTTY: boolean;
  term: string | undefined;
  /** `NO_COLOR`: any nonempty value draws the code without colors (no-color.org). */
  noColor: string | undefined;
  /** The terminal's width in characters, when it is known. */
  columns: number | undefined;
}

/** Where the setup of a front is written down, for a person reading a terminal. */
const GUIDE = "the jig plugin's phone-access.md";

/** A code needs a terminal that draws characters in place; a pipe, a file or a `dumb` terminal gets the text alone. */
function drawable(terminal: AccessTerminal): boolean {
  return terminal.isTTY && terminal.term !== "dumb";
}

/** The code's lines for the front's address, or why none is drawn; neither where the output is no terminal that draws one. */
function drawnCode(
  front: string,
  terminal: AccessTerminal,
): { lines: string[]; note: string[] } {
  if (!drawable(terminal)) return { lines: [], note: [] };
  const code = encodeQr(front);
  if (!code.ok)
    return { lines: [], note: [`No QR code: ${code.failure.reason}.`] };
  const width = code.value.size + 2 * QUIET_ZONE;
  if (terminal.columns !== undefined && terminal.columns < width)
    return {
      lines: [],
      note: [
        `No QR code: it needs a terminal ${width} columns wide, and this one has ${terminal.columns}. Widen it and run --access again, or carry the address over as text.`,
      ],
    };
  const color = (terminal.noColor ?? "") === "";
  return {
    lines: [
      ...renderQr(code.value, { color }),
      "The code holds only this address; the front still signs the viewer in.",
    ],
    note: [],
  };
}

/** A hint, never a refusal, when the front's name is not one the dashboard answers to: a front may send another `Host`. */
function hostHint(front: string, allowedHosts: readonly string[]): string[] {
  const host = new URL(front).hostname.replace(/^\[(.*)\]$/, "$1");
  return allowedHosts.includes(host)
    ? []
    : [
        `${host} is not in dashboard.allowed_hosts. A front that forwards requests under its own name needs it there, or the dashboard answers 403; one that sends a Host the dashboard already allows needs nothing.`,
      ];
}

/** The front's address on standard output, first, then its code where the terminal draws one. */
function frontReport(
  front: string,
  allowedHosts: readonly string[],
  reader: Outcome<{ url: string; configuration?: string }, string>,
  terminal: AccessTerminal,
  configurationMatches: boolean,
): AccessReport {
  const code = drawnCode(front, terminal);
  const stderr = [...code.note, ...hostHint(front, allowedHosts)];
  if (!reader.ok)
    stderr.push(
      `The dashboard reader behind the front is not confirmed running (${reader.failure.reason}), so the address may show no page yet; check it with jig dispatch dashboard --status.`,
    );
  else if (!configurationMatches)
    stderr.push(
      "The dashboard reader does not match the current configuration and is waiting for renewal; check it with jig dispatch dashboard --status.",
    );
  return { stdout: [front, ...code.lines], stderr, code: 0 };
}

/** Why no code is drawn and how a phone gets a token-free address, by whether the reader asks for a token. */
function fallbackNote(url: string | null, machinePath: string): string[] {
  const printed = url !== null;
  const parsed = url === null ? null : new URL(url);
  if (parsed?.search === "")
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
  reader: Outcome<{ url: string; configuration?: string }, string>,
  terminal: AccessTerminal,
  machinePath: string,
): AccessReport {
  const config = machine.ok ? machine.value : null;
  const configurationMatches =
    reader.ok &&
    (reader.value.configuration === undefined ||
      (config?.dashboardListen != null &&
        reader.value.configuration ===
          readerSettings(
            config.dashboardListen,
            config.dashboardRequireToken,
            config.dashboardAllowedHosts,
          )));
  if (config?.dashboardFront != null)
    return frontReport(
      config.dashboardFront,
      config.dashboardAllowedHosts,
      reader,
      terminal,
      configurationMatches,
    );
  const report: AccessReport = reader.ok
    ? { stdout: [reader.value.url], stderr: [], code: 0 }
    : { stdout: [], stderr: [reader.failure.reason], code: 1 };
  if (!machine.ok) report.stderr.push(machine.failure.reason);
  else
    report.stderr.push(
      ...fallbackNote(reader.ok ? reader.value.url : null, machinePath),
    );
  return report;
}

export function dashboardAccess(): number {
  const report = accessReport(
    readMachineConfig(),
    readAccess(),
    {
      isTTY: process.stdout.isTTY === true,
      term: process.env.TERM,
      noColor: process.env.NO_COLOR,
      columns: process.stdout.columns,
    },
    machineConfigPath(),
  );
  for (const line of report.stdout) console.log(line);
  for (const line of report.stderr) console.error(line);
  return report.code;
}

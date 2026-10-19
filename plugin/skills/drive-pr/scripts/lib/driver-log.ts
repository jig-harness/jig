/**
 * The durable driver log's file: every line stamped with the time and a
 * level, and the file kept to a bounded size.
 *
 * Each line starts `<ISO time> <LEVEL> `: the driver's standard output is
 * `INFO`, its standard error `WARN` (diagnostics, refusals and failures all
 * arrive there; the stream does not say which). When the other stream writes
 * while a line is still open, that line is ended first, so each part is
 * stamped with its own level.
 *
 * A write that would take the file past `DRIVER_LOG_MAX_BYTES` first moves it
 * to `<path>.1`, replacing the previous one, so a drive that runs for days
 * keeps its latest narrative and at most about twice the bound on disk. A
 * line continued across the rotation is stamped again at the top of the new
 * file. A single write larger than the bound keeps only its last part, after
 * a stamped line saying how much was left out, and the part kept is stamped
 * again when it starts inside a line; the whole stays within the bound.
 *
 * Only one writer may rotate: the one `mayRotate` says yes to (the driver
 * holding the drive's locks). Other processes writing the same log (a driver
 * that refuses to start) only append, so two writers can never both rename
 * the file and replace the history the other just moved to `.1`. The writer
 * that rotates reads the file's size before each write, so appends from those
 * other writers count. A rotation that fails leaves the file growing past the bound rather
 * than losing what is written next.
 *
 * Writes are synchronous appends, so the tail survives the exit path. Nothing
 * here throws: the console is the authoritative copy, and the first problem
 * is passed to `report` once.
 */
import { appendFileSync, renameSync, statSync } from "node:fs";
import { type Clock, systemClock } from "../../../../shared/clock.ts";
import { errnoCode } from "../../../../shared/errors.ts";

export const DRIVER_LOG_MAX_BYTES = 10 * 1024 * 1024;

export type DriverLogLevel = "INFO" | "WARN";

export interface DriverLogOptions {
  maxBytes?: number;
  clock?: Pick<Clock, "now">;
  /** Told about the first write or rotation that failed, once. */
  report?: (message: string) => void;
  /** Whether this writer may rotate the file now; by default it may. */
  mayRotate?: () => boolean;
}

export class DriverLog {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly clock: Pick<Clock, "now">;
  private readonly report: (message: string) => void;
  private readonly mayRotate: () => boolean;
  private reported = false;
  private rotationBlocked = false;
  /** The level whose line is open (written without its newline yet). */
  private open: DriverLogLevel | null = null;
  private readonly decoders = {
    INFO: new TextDecoder(),
    WARN: new TextDecoder(),
  };

  constructor(path: string, opts: DriverLogOptions = {}) {
    this.path = path;
    this.maxBytes = opts.maxBytes ?? DRIVER_LOG_MAX_BYTES;
    this.clock = opts.clock ?? systemClock;
    this.report = opts.report ?? (() => undefined);
    this.mayRotate = opts.mayRotate ?? (() => true);
  }

  /** A blank line, then `header` stamped at `INFO`: the start of one run. */
  startRun(header: string): void {
    this.write("\n");
    this.open = null;
    this.append("INFO", `${header}\n`);
  }

  /**
   * Append `text` at `level`, stamping the start of every line in it. A
   * chunk that ends mid-line leaves the next chunk of the same level to
   * finish that line; a character split across chunks is kept whole.
   */
  append(level: DriverLogLevel, text: string | Uint8Array): void {
    // A string skips the decoder. Should one arrive while that stream's
    // decoder still holds the first bytes of a split character (a byte write
    // and a string write interleaved mid-character, which the console never
    // does), those bytes come out with the stream's next byte chunk instead.
    const raw =
      typeof text === "string"
        ? text
        : this.decoders[level].decode(text, { stream: true });
    if (raw === "") return;
    const stamp = `${new Date(this.clock.now()).toISOString()} ${level} `;
    const continues = this.open === level;
    let out = this.open !== null && !continues ? "\n" : "";
    let atLineStart = !continues;
    for (const piece of raw.split(/(?<=\n)/)) {
      if (atLineStart) out += stamp;
      out += piece;
      atLineStart = piece.endsWith("\n");
    }
    this.open = atLineStart ? null : level;
    this.write(out, stamp, continues);
  }

  /**
   * `stamp` is this write's own stamp: it is put back in front of `out` when
   * `out` continues a line and the file rotates first, and in front of
   * whatever `bounded` keeps, so every line in the file starts with one.
   */
  private write(out: string, stamp = "", continues = false): void {
    let text = this.bounded(out, stamp);
    if (this.rotateFor(Buffer.byteLength(text)) && continues)
      text = this.bounded(stamp + out, stamp);
    try {
      appendFileSync(this.path, text);
    } catch (err) {
      this.problem("cannot append to it", err);
    }
  }

  /**
   * Move the file to `.1` when `bytes` more would take it past the bound and
   * this writer may rotate. True when the file now starts empty.
   */
  private rotateFor(bytes: number): boolean {
    if (this.rotationBlocked || !this.mayRotate()) return false;
    // Other writers append without rotating, so decide on the file as it is
    // now: a count this writer kept would miss their bytes.
    const size = this.realSize();
    if (size === 0 || size + bytes <= this.maxBytes) return false;
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") {
        this.rotationBlocked = true;
        this.problem(`cannot rotate it to ${this.path}.1`, err);
        return false;
      }
    }
    return true;
  }

  /**
   * `out`, or its last `maxBytes` after a stamped line naming what was left
   * out. A kept part that starts inside a line is stamped again, so the bound
   * never leaves a line without its stamp.
   */
  private bounded(out: string, stamp: string): string {
    const buf = Buffer.from(out);
    if (buf.length <= this.maxBytes) return out;
    const note = `${stamp}[driver log: ${buf.length} bytes in one write; only the last part is kept]\n`;
    const keep = Math.max(
      0,
      this.maxBytes - Buffer.byteLength(note) - Buffer.byteLength(stamp),
    );
    let start = buf.length - keep;
    // Start on a character boundary: skip UTF-8 continuation bytes.
    while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start++;
    const tail = buf.subarray(start).toString();
    const midLine = tail !== "" && buf[start - 1] !== 0x0a;
    return note + (midLine ? stamp : "") + tail;
  }

  private realSize(): number {
    try {
      return statSync(this.path).size;
    } catch (err) {
      if (errnoCode(err) !== "ENOENT")
        this.problem("cannot read its size", err);
      return 0;
    }
  }

  /** The first problem met, or `null` while every write has landed. */
  get firstProblem(): string | null {
    return this.problemText;
  }

  private problemText: string | null = null;

  private problem(what: string, err: unknown): void {
    if (this.reported) return;
    this.reported = true;
    const reason = err instanceof Error ? err.message : String(err);
    this.problemText = `${what} (${reason})`;
    try {
      this.report(`driver log ${this.path}: ${what} (${reason})`);
    } catch {
      // The report is advisory; a reporter that fails changes nothing here.
    }
  }
}

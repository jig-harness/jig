/**
 * The last `Question:` line of a pass's output, the only part of it that is
 * kept. A multi-byte character can be split across chunks; the decoder holds
 * its first bytes until the rest arrive.
 */
import { StringDecoder } from "node:string_decoder";

export class QuestionTail {
  private readonly decoder = new StringDecoder("utf8");
  private line = "";
  private last = "";

  private readonly prefix: string;
  private readonly chars: number;

  constructor(prefix: string, chars: number) {
    this.prefix = prefix;
    this.chars = chars;
  }

  /** The last question seen, or the empty string. */
  get question(): string {
    return this.last;
  }

  write(chunk: Buffer): void {
    this.take(this.decoder.write(chunk));
  }

  /** Flush the decoder and close the last line. */
  end(): void {
    this.take(this.decoder.end());
    this.endLine();
  }

  private take(text: string): void {
    text.split("\n").forEach((part, i) => {
      if (i > 0) this.endLine();
      const room = this.prefix.length + this.chars - this.line.length;
      if (room > 0) this.line += part.slice(0, room);
    });
  }

  private endLine(): void {
    const text = this.line.trim();
    if (text.startsWith(this.prefix) && text !== this.prefix) this.last = text;
    this.line = "";
  }
}

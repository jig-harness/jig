/**
 * An XML document's characters from its bytes, found the way XML 1.0
 * (https://www.w3.org/TR/xml/#charencoding, and its Appendix F) says a
 * processor finds them: a byte order mark names UTF-8 or UTF-16; without
 * one, the XML declaration's `encoding`, written in ASCII, names the
 * encoding, and a document that declares none is UTF-8.
 *
 * Decoded: UTF-8, UTF-16, ISO-8859-1 and US-ASCII. A document in any other
 * encoding, one holding bytes its encoding does not decode, or one whose
 * declaration names an encoding its byte order mark contradicts is
 * unreadable, never read as other characters than the ones it holds.
 */
import { UnreadableError } from "./model.ts";

/** The `encoding` of an XML declaration at the start of `text`, or null when it names none. */
const ENCODING =
  /^<\?xml(?:[^?]|\?(?!>))*?[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/;

const UTF8 = /^utf-8$/i;
const UTF16 = /^utf-16(?:le|be)?$/i;
const LATIN1 = /^(?:iso[-_]?8859-1|latin-?1)$/i;
const ASCII = /^(?:us-)?ascii$/i;

function declaredEncoding(text: string): string | null {
  const found = ENCODING.exec(text);
  return found ? ((found[1] ?? found[2]) as string) : null;
}

/** The encodings decoded by `TextDecoder`. */
type Label = "utf-8" | "utf-16le" | "utf-16be";

/** `bytes` decoded by `label`, an `UnreadableError` naming the encoding when a byte does not decode. */
function decode(bytes: Uint8Array, label: Label, name: string): string {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new UnreadableError(`has bytes that are not ${name}`);
  }
}

/** Each byte as the character of the same number, which is ISO-8859-1. */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return text;
}

/** The document's text, its byte order mark removed. */
export function xmlText(bytes: Uint8Array): string {
  const [a, b, c] = bytes;
  if (a === 0xfe && b === 0xff) return fromBom(bytes, "utf-16be", UTF16);
  if (a === 0xff && b === 0xfe) return fromBom(bytes, "utf-16le", UTF16);
  if (a === 0xef && b === 0xbb && c === 0xbf)
    return fromBom(bytes, "utf-8", UTF8);
  const head = latin1(bytes.subarray(0, 1024));
  const declared = declaredEncoding(head);
  if (declared === null || UTF8.test(declared))
    return decode(bytes, "utf-8", "UTF-8");
  if (LATIN1.test(declared)) return latin1(bytes);
  if (ASCII.test(declared)) {
    if (bytes.some((byte) => byte > 0x7f))
      throw new UnreadableError("has bytes that are not US-ASCII");
    return latin1(bytes);
  }
  if (UTF16.test(declared))
    throw new UnreadableError(
      "declares UTF-16 without the byte order mark UTF-16 requires",
    );
  throw new UnreadableError(
    `declares an encoding it does not read (${JSON.stringify(declared.slice(0, 40))})`,
  );
}

/** A document whose byte order mark names `label`: decoded by it, its declaration agreeing. */
function fromBom(bytes: Uint8Array, label: Label, agrees: RegExp): string {
  const text = decode(bytes, label, label.toUpperCase());
  const declared = declaredEncoding(text);
  if (declared !== null && !agrees.test(declared))
    throw new UnreadableError(
      `declares ${JSON.stringify(declared.slice(0, 40))} where its byte order mark says ${label.toUpperCase()}`,
    );
  return text;
}

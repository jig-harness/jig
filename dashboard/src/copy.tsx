/**
 * The Copy control: an icon with feedback for a moment, announced
 * politely. It writes only to the reader's own clipboard.
 */
import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SHOWN_MS = 1800;

/** Whoever announces what Copy did. */
const hearers = new Set<(text: string) => void>();

/**
 * Copy needs a fallback: the page is served over plain http on a private
 * address, which is not a secure context, so `navigator.clipboard` does not
 * exist there. The fallback selects the text in a hidden field and asks the
 * browser to copy it.
 */
function writeClip(text: string, back: HTMLElement): Promise<boolean> {
  const fallback = (): Promise<boolean> => {
    // `back` may be the body, outside the page's root, when nothing had focus.
    const field = (back.closest(".dd") ?? document).querySelector(
      ".dd textarea.clip",
    );
    if (!(field instanceof HTMLTextAreaElement)) return Promise.resolve(false);
    field.value = text;
    field.focus();
    field.setSelectionRange(0, text.length);
    // Some browsers throw here rather than answer false; either way the copy failed.
    return new Promise<boolean>((settle) => {
      settle(document.execCommand("copy"));
    })
      .then(
        (copied) => copied,
        () => false,
      )
      .finally(() => back.focus());
  };
  if (window.isSecureContext && navigator.clipboard !== undefined)
    return navigator.clipboard.writeText(text).then(() => true, fallback);
  return fallback();
}

/** Whoever shows what a key did, for a moment. */
const showers = new Set<(text: string) => void>();

/**
 * Says what a key did: politely, where Copy says what it did, and for a
 * moment in sight, since a key has no button to change.
 */
export function announce(text: string): void {
  for (const hear of hearers) hear(text);
  for (const show of showers) show(text);
}

/** What a key did, shown for a moment at the foot of the screen; the polite announcement is `ClipParts`' own. */
export function KeyToast() {
  const [said, setSaid] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (text: string) => {
      setSaid(text);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => setSaid(""), SHOWN_MS);
    };
    showers.add(show);
    return () => {
      showers.delete(show);
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return said === "" ? null : (
    <div className="keyToast m sm" aria-hidden="true">
      {said}
    </div>
  );
}

/**
 * Copies `text` from a key rather than a button, and says what it did; focus
 * comes back to `back`, the card the key was pressed on.
 */
export function copyText(text: string, back: HTMLElement): Promise<boolean> {
  return writeClip(text, back).then((copied) => {
    announce(copied ? `Copied: ${text}` : "Copy failed");
    return copied;
  });
}

export function CopyButton({
  text,
  idle = "Copy",
  aria = idle,
}: {
  text: string;
  idle?: string;
  aria?: string;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <button
      className="copy"
      type="button"
      aria-label={aria}
      title={said ?? aria}
      onClick={(event) => {
        void writeClip(text, event.currentTarget).then((copied) => {
          const label = copied ? "Copied" : "Copy failed";
          setSaid(label);
          for (const hear of hearers) hear(label);
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            setSaid(null);
            for (const hear of hearers) hear("");
          }, SHOWN_MS);
        });
      }}
    >
      {said === "Copied" ? (
        <Check size={14} aria-hidden="true" />
      ) : said === "Copy failed" ? (
        <X size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  );
}

/** The hidden field Copy's fallback writes through, and the polite announcement. */
export function ClipParts() {
  const [say, setSay] = useState("");
  useEffect(() => {
    hearers.add(setSay);
    return () => {
      hearers.delete(setSay);
    };
  }, []);
  return (
    <>
      <textarea className="clip" tabIndex={-1} aria-hidden="true" />
      <span className="say" aria-live="polite">
        {say}
      </span>
    </>
  );
}

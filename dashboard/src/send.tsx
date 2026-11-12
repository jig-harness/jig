/**
 * Send: a card's answers posted from this browser, as the person, on the pull
 * request a parked drive reads them from. It posts exactly the comment Copy
 * takes, through GitHub's API with the token the person pasted here
 * (`forge-token.ts`, `github.ts`); the dashboard's server never sees the
 * token or the comment. A guarded pick sends on the second step, as it
 * copies. A card that no drive reads an answer comment for, or whose pull
 * request is not on github.com, has no Send and says why.
 *
 * The settings panel takes the token, tests it by asking GitHub who it signs
 * in as, and forgets it.
 */
import { KeyRound, Send } from "lucide-react";
import { useId, useState } from "react";
import { announce } from "./copy.tsx";
import { keepToken, keptToken, useKeptToken } from "./forge-token.ts";
import {
  postComment,
  sendRefusal,
  tokenLogin,
  tokenRefusal,
} from "./github.ts";
import type { NeedView } from "./needs-view.ts";
import type { SendTarget } from "./send-target.ts";
import { keepSent, useSentHere } from "./sent.ts";
import type { Picking } from "./use-picking.ts";

/** Where a fine-grained token is made, on GitHub. */
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string };

/** A card's Send: how to start it, and what it is doing; `null` when the card has none. */
export interface Sending {
  to: SendTarget;
  login: string;
  phase: Phase;
  send: () => void;
}

/** The card's Send, while a token is kept and its decisions are a drive's on github.com. */
export function useSend(need: NeedView, picking: Picking): Sending | null {
  const { kept } = useKeptToken();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  if (kept === null || !("to" in need.send)) return null;
  const to = need.send.to;
  const send = () => {
    if (phase.kind === "sending") return;
    const text = picking.sendGate();
    // The token may have been forgotten in another tab since the card drew.
    const token = keptToken();
    if (text === null || token === null) return;
    setPhase({ kind: "sending" });
    announce(`Sending the answers for ${need.target} as ${token.login}`);
    void postComment(token.token, to, text).then((posted) => {
      if (posted.ok) {
        keepSent(need.repo, need.target, {
          text,
          url: posted.value,
          at: Date.now(),
        });
        setPhase({ kind: "idle" });
        announce(`Sent the answers for ${need.target} as ${token.login}`);
        return;
      }
      const reason = sendRefusal(posted, to);
      setPhase({ kind: "failed", reason });
      announce(`Not sent: ${reason}`);
    });
  };
  return { to, login: kept.login, phase, send };
}

/** The Send button beside Copy, named by what it posts. */
export function SendButton({
  need,
  sending,
  what,
  confirm = false,
}: {
  need: NeedView;
  sending: Sending;
  /** What the card's commit is, as Copy names it. */
  what: string;
  /** The check panel's second step, rather than the first press. */
  confirm?: boolean;
}) {
  const busy = sending.phase.kind === "sending";
  const label = busy ? "Sending…" : confirm ? "Confirm send" : `Send ${what}`;
  const aria = confirm
    ? `Confirm and send ${what} for ${need.target} as ${sending.login}`
    : `Send ${what} for ${need.target} as ${sending.login}`;
  return (
    <button
      type="button"
      className="copy send"
      aria-label={aria}
      title={aria}
      aria-disabled={busy}
      onClick={sending.send}
    >
      <Send size={14} aria-hidden="true" />
      <span className="copyLabel">{label}</span>
    </button>
  );
}

/** Under the copy row: what this browser sent, why the last send failed, and who it sends as where the park names someone else. */
export function SendSaid({
  need,
  sending,
  text,
}: {
  need: NeedView;
  sending: Sending;
  /** The comment Copy and Send take now. */
  text: string;
}) {
  const sent = useSentHere(need.repo, need.target);
  const other =
    need.people.length > 0 &&
    !need.people.some((p) => p.toLowerCase() === sending.login.toLowerCase());
  if (sent === null && sending.phase.kind !== "failed" && !other) return null;
  return (
    <div className="sendSaid sm">
      {sent === null ? null : (
        <p className="sentHere">
          {sent.text === text
            ? "Sent here as a comment: "
            : "An earlier answer was sent here: "}
          <a href={sent.url} target="_blank" rel="noreferrer noopener">
            open the comment
          </a>
          . The next tick reads it.
        </p>
      )}
      {sending.phase.kind === "failed" ? (
        <p className="decFault" role="alert">
          Not sent: {sending.phase.reason}
        </p>
      ) : null}
      {other ? (
        <p className="mut">
          Sends as <span className="m">{sending.login}</span>; this waits on{" "}
          <span className="m">{need.people.join(", ")}</span>. The drive counts
          an answer from anyone who can write to {need.repo}.
        </p>
      ) : null}
    </div>
  );
}

/** Why a card has no Send, shown once a token is kept so its absence is never a puzzle. */
export function NoSend({ need }: { need: NeedView }) {
  const { kept } = useKeptToken();
  if (kept === null || !("absent" in need.send)) return null;
  return <p className="sm mut noSend">{need.send.absent}</p>;
}

type Test =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "refused"; reason: string };

/** The token's field, Test and keep, and what the test found. */
function TokenField() {
  const [draft, setDraft] = useState("");
  const [test, setTest] = useState<Test>({ kind: "idle" });
  const id = useId();
  const run = () => {
    const token = draft.trim();
    if (token === "" || test.kind === "testing") return;
    setTest({ kind: "testing" });
    void tokenLogin(token).then((answer) => {
      if (!answer.ok) {
        setTest({ kind: "refused", reason: tokenRefusal(answer) });
        return;
      }
      keepToken({ token, login: answer.value, at: Date.now() });
      setDraft("");
      setTest({ kind: "idle" });
      announce(`The token signs in as ${answer.value}; Send is on`);
    });
  };
  return (
    <form
      className="tokenForm"
      onSubmit={(event) => {
        event.preventDefault();
        run();
      }}
    >
      <label className="reply" htmlFor={id}>
        <span className="sm mut">GitHub token</span>
        <input
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          value={draft}
          placeholder="github_pat_…"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </label>
      <div className="copyRow">
        <button
          type="submit"
          className="fbtn"
          aria-disabled={draft.trim() === ""}
        >
          {test.kind === "testing" ? "Testing…" : "Test and keep"}
        </button>
      </div>
      {test.kind === "refused" ? (
        <p className="sm decFault" role="alert">
          {test.reason}
        </p>
      ) : null}
    </form>
  );
}

/** The kept token: who it signs in as, test it again, forget it. */
function KeptTokenRow() {
  const { kept, saved } = useKeptToken();
  const [test, setTest] = useState<Test>({ kind: "idle" });
  if (kept === null) return null;
  const again = () => {
    if (test.kind === "testing") return;
    setTest({ kind: "testing" });
    void tokenLogin(kept.token).then((answer) => {
      if (!answer.ok) {
        setTest({ kind: "refused", reason: tokenRefusal(answer) });
        return;
      }
      setTest({ kind: "idle" });
      if (answer.value !== kept.login)
        keepToken({ ...kept, login: answer.value, at: Date.now() });
      announce(`The token signs in as ${answer.value}`);
    });
  };
  return (
    <>
      <p className="sm">
        Send is on: it posts as <span className="m">{kept.login}</span>, the
        login GitHub named for the token.
        {saved
          ? " The token is kept in this browser only."
          : " This browser stores nothing, so the token lasts only while this page stays open."}
      </p>
      <div className="copyRow">
        <button type="button" className="fbtn" onClick={again}>
          {test.kind === "testing" ? "Testing…" : "Test again"}
        </button>
        <button
          type="button"
          className="fbtn"
          onClick={() => {
            keepToken(null);
            setTest({ kind: "idle" });
            announce("The token is forgotten; Send is off");
          }}
        >
          Forget the token
        </button>
      </div>
      {test.kind === "refused" ? (
        <p className="sm decFault" role="alert">
          {test.reason}
        </p>
      ) : null}
    </>
  );
}

/** The settings panel: what Send does, how to make the token, and the token itself. */
export function SendSettings({
  id,
  repos,
  onClose,
}: {
  id: string;
  /** The repositories whose cards can send, for the token's scope. */
  repos: string[];
  onClose: () => void;
}) {
  const { kept } = useKeptToken();
  const head = useId();
  return (
    <section className="sendSettings" id={id} aria-labelledby={head}>
      <h3 id={head}>Send answers from this page</h3>
      <p className="sm">
        Send posts a card's answers as one comment on its pull request, as you,
        from this browser straight to GitHub: the same comment Copy takes. The
        token you paste stays in this browser; the dashboard's host never
        receives it, and anyone who can open this page in this browser can send
        with it.
      </p>
      <p className="sm">
        Make a{" "}
        <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer noopener">
          fine-grained token
        </a>{" "}
        for{" "}
        {repos.length === 0
          ? "the repositories here"
          : "only these repositories"}
        {repos.length === 0 ? null : (
          <>
            {" "}
            (<span className="m">{repos.join(", ")}</span>)
          </>
        )}
        , with Issues and Pull requests set to read and write and a short
        expiry. Forget it here when you are done.
      </p>
      {kept === null ? <TokenField /> : <KeptTokenRow />}
      <div className="copyRow">
        <button type="button" className="fbtn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/** The button that opens the settings panel, saying whether Send is on. */
export function SendSettingsToggle({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const { kept } = useKeptToken();
  const words = kept === null ? "Send from here" : `Sending as ${kept.login}`;
  return (
    <button
      type="button"
      className="fbtn sendToggle"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <KeyRound size={14} aria-hidden="true" />
      <span>{words}</span>
    </button>
  );
}

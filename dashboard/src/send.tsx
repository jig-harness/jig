/**
 * Send: a card's answers posted from this browser, as the person, on the pull
 * request a parked drive reads them from. Each decision the card answers
 * goes as its own comment, the `drive-answer` record `jig send` writes
 * (`shared/decisions/answer-record.ts`): the answer line Copy takes for it,
 * any note line, and the hidden record naming the person's login and
 * `BROWSER_HOST` as its writer. It posts through GitHub's API with the token
 * the person pasted here (`forge-token.ts`, `github.ts`); the dashboard's
 * server never sees the token or the comments.
 *
 * Send posts only once an option is picked on the card: an approval nobody
 * picked is Copy's alone. A guarded pick sends on the second step, as it
 * copies. A card that no drive reads an answer comment for, whose pull
 * request is not on github.com, or a page served over plain HTTP outside
 * loopback and Tailscale (`transportFault`) has no Send and says why.
 *
 * The settings panel takes the token, tests it by asking GitHub who it signs
 * in as, and forgets it.
 */
import { KeyRound, Send } from "lucide-react";
import { useId, useState } from "react";
import { cardAnswerComments } from "../../plugin/shared/decisions/answer-record.ts";
import { BROWSER_HOST } from "../../plugin/shared/records/writer-shape.ts";
import { announce } from "./copy.tsx";
import { keepToken, keptToken, useKeptToken } from "./forge-token.ts";
import {
  postComment,
  sendRefusal,
  tokenLogin,
  tokenRefusal,
} from "./github.ts";
import type { NeedView } from "./needs-view.ts";
import { type SendTarget, transportFault } from "./send-target.ts";
import { keepSent, useSentHere } from "./sent.ts";
import type { Picking } from "./use-picking.ts";

/** Where a fine-grained token is made, on GitHub. */
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** Why this page cannot send from the address it was served at; `null` when it can. */
function pageTransportFault(): string | null {
  return transportFault(window.location);
}

type Phase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string };

/** A card's Send: how to start it, and what it is doing; `null` when the card has none. */
export interface Sending {
  to: SendTarget;
  login: string;
  phase: Phase;
  /** Whether an option is picked, so a press sends. */
  ready: boolean;
  send: () => void;
}

/** Posts each comment in order; the links posted, and why the first refused one was not. */
async function postAll(
  token: string,
  to: SendTarget,
  comments: Array<{ key: string; body: string }>,
): Promise<{ urls: string[]; refused: string | null }> {
  const urls: string[] = [];
  for (const comment of comments) {
    const posted = await postComment(token, to, comment.body);
    if (!posted.ok) {
      const rest = comments.slice(urls.length).map((c) => c.key);
      const done =
        urls.length === 0
          ? ""
          : ` The answers before it were posted; not posted: ${rest.join(", ")}.`;
      return { urls, refused: `${sendRefusal(posted, to)}${done}` };
    }
    urls.push(posted.value);
  }
  return { urls, refused: null };
}

/** The card's Send, while a token is kept, its decisions are a drive's on github.com and the page came over a safe path. */
export function useSend(need: NeedView, picking: Picking): Sending | null {
  const { kept } = useKeptToken();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  if (kept === null || !("to" in need.send) || pageTransportFault() !== null)
    return null;
  const to = need.send.to;
  const send = () => {
    if (phase.kind === "sending") return;
    const commit = picking.sendGate();
    // The token may have been forgotten in another tab since the card drew.
    const token = keptToken();
    if (commit === null || token === null) return;
    const comments = cardAnswerComments(
      commit.answers,
      to.number,
      { login: token.login, host: BROWSER_HOST },
      new Date().toISOString(),
    );
    setPhase({ kind: "sending" });
    announce(`Sending the answers for ${need.target} as ${token.login}`);
    void postAll(token.token, to, comments).then(({ urls, refused }) => {
      if (urls.length > 0)
        keepSent(need.repo, need.target, {
          text: commit.text,
          urls,
          at: Date.now(),
        });
      if (refused === null) {
        setPhase({ kind: "idle" });
        announce(`Sent the answers for ${need.target} as ${token.login}`);
        return;
      }
      setPhase({ kind: "failed", reason: refused });
      announce(`Not sent: ${refused}`);
    });
  };
  return {
    to,
    login: kept.login,
    phase,
    ready: picking.commit.picked > 0,
    send,
  };
}

/** The Send button beside Copy, named by what it posts; held back until an option is picked. */
export function SendButton({
  need,
  sending,
  confirm = false,
}: {
  need: NeedView;
  sending: Sending;
  /** The check panel's second step, rather than the first press. */
  confirm?: boolean;
}) {
  const busy = sending.phase.kind === "sending";
  const label = busy
    ? "Sending…"
    : confirm
      ? "Confirm send"
      : "Send the answers";
  const aria = confirm
    ? `Confirm and send the answers for ${need.target} as ${sending.login}`
    : `Send the answers for ${need.target} as ${sending.login}`;
  return (
    <button
      type="button"
      className="copy send"
      aria-label={aria}
      title={sending.ready ? aria : "Pick an option to send"}
      aria-disabled={busy || !sending.ready}
      onClick={sending.send}
    >
      <Send size={14} aria-hidden="true" />
      <span className="copyLabel">{label}</span>
    </button>
  );
}

/** The links this browser posted, as one sentence. */
function SentLinks({ urls }: { urls: string[] }) {
  return (
    <>
      {urls.map((url, i) => (
        <span key={url}>
          {i === 0 ? "" : ", "}
          <a href={url} target="_blank" rel="noreferrer noopener">
            {urls.length === 1 ? "open the comment" : `comment ${i + 1}`}
          </a>
        </span>
      ))}
    </>
  );
}

/** Under the copy row: what this browser sent, why the last send failed, what Send waits for, and who it sends as where the park names someone else. */
export function SendSaid({
  need,
  sending,
  text,
}: {
  need: NeedView;
  sending: Sending;
  /** The comment Copy takes now. */
  text: string;
}) {
  const sent = useSentHere(need.repo, need.target);
  const other =
    need.people.length > 0 &&
    !need.people.some((p) => p.toLowerCase() === sending.login.toLowerCase());
  if (
    sent === null &&
    sending.phase.kind !== "failed" &&
    sending.ready &&
    !other
  )
    return null;
  return (
    <div className="sendSaid sm">
      {sent === null ? null : (
        <p className="sentHere">
          {sent.text === text
            ? "Sent here: "
            : "An earlier answer was sent here: "}
          <SentLinks urls={sent.urls} />. The next tick reads it.
        </p>
      )}
      {sending.phase.kind === "failed" ? (
        <p className="decFault" role="alert">
          Not sent: {sending.phase.reason}
        </p>
      ) : null}
      {sending.ready ? null : (
        <p className="mut sendWaits">
          Send posts once you pick an option; Copy takes the card as it is.
        </p>
      )}
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
  if (kept === null) return null;
  const absent =
    "absent" in need.send ? need.send.absent : pageTransportFault();
  return absent === null ? null : <p className="sm mut noSend">{absent}</p>;
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
      {pageTransportFault() === null ? null : (
        <p className="sm decNote">{pageTransportFault()}</p>
      )}
      {kept !== null ? (
        <KeptTokenRow />
      ) : pageTransportFault() === null ? (
        <TokenField />
      ) : null}
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

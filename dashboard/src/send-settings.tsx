/**
 * Send's settings panel: what Send does, how to make a token, and the tokens
 * kept in this browser, one per GitHub account (`forge-token.ts`). Each is
 * tested by asking GitHub who it signs in as, shown with that login and the
 * repository owners it answers for, and forgotten on its own; the panel
 * refuses a second token for one owner, and a second token that names no
 * owner, rather than choosing between them (`token-owners.ts`).
 */
import { KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { announce } from "./copy.tsx";
import {
  freshTokens,
  keepTokens,
  storedListUntrusted,
  tokensSignature,
  useKeptTokens,
} from "./forge-token.ts";
import { tokenLogin, tokenRefusal } from "./github.ts";
import { pageTransportFault } from "./send.tsx";
import {
  credentialOf,
  type KeptToken,
  ownerOf,
  ownersSaid,
  parseOwners,
  tokenFor,
  withOwners,
  withoutToken,
  withToken,
} from "./token-owners.ts";

/** Where a fine-grained token is made, on GitHub. */
const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

type Test =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "refused"; reason: string };

/** Invalidates a callback once its settings component no longer exists. */
function useRequestGeneration(): () => boolean {
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  return () => live.current;
}

function Refused({ test }: { test: Test }) {
  return test.kind === "refused" ? (
    <p className="sm decFault" role="alert">
      {test.reason}
    </p>
  ) : null;
}

/** A field for the owners a token answers for. */
function OwnersField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="reply" htmlFor={id}>
      <span className="sm mut">{label}</span>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="none"
        value={value}
        placeholder="example-org, another-org"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

/** A token's field, the owners it answers for, Test and keep, and what the test found. */
function TokenField({ more }: { more: boolean }) {
  const [draft, setDraft] = useState("");
  const [owners, setOwners] = useState("");
  const [test, setTest] = useState<Test>({ kind: "idle" });
  const id = useId();
  const alive = useRequestGeneration();
  const run = () => {
    const token = draft.trim();
    if (token === "" || test.kind === "testing") return;
    if (storedListUntrusted()) {
      setTest({
        kind: "refused",
        reason: UNTRUSTED_NOTE,
      });
      return;
    }
    const named = parseOwners(owners);
    if (!named.ok) {
      setTest({ kind: "refused", reason: named.reason });
      return;
    }
    setTest({ kind: "testing" });
    const before = tokensSignature();
    void tokenLogin(token).then((answer) => {
      if (!alive()) return;
      if (!answer.ok) {
        setTest({ kind: "refused", reason: tokenRefusal(answer) });
        return;
      }
      // Checked against what storage holds when GitHub answers: another tab's change may not have reached this one as an event yet.
      const login = answer.value;
      if (tokensSignature() !== before) {
        setTest({
          kind: "refused",
          reason: `The kept tokens changed while this one was tested. Test it again.`,
        });
        return;
      }
      if (storedListUntrusted()) {
        setTest({ kind: "refused", reason: UNTRUSTED_NOTE });
        return;
      }
      const next = withToken(
        freshTokens(),
        { token, login, at: Date.now() },
        named.value,
      );
      if (!next.ok) {
        setTest({ kind: "refused", reason: next.reason });
        return;
      }
      keepTokens(next.value);
      setDraft("");
      setOwners("");
      setTest({ kind: "idle" });
      const kept = next.value.find((t) => t.login === login);
      announce(
        `The token signs in as ${login}; Send is on for ${kept === undefined ? "its owners" : ownersSaid(kept)}`,
      );
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
      {more ? <h4>Add a token for another GitHub account</h4> : null}
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
      <OwnersField
        label="Owners it answers for"
        value={owners}
        onChange={setOwners}
      />
      <p className="sm mut">
        Repository owners, such as an organization: a token answers for every
        repository of the owners it names. Left blank, it answers for every
        owner no other token names; one token may. A token for an account
        already kept replaces it and keeps its owners when this is left blank.
      </p>
      <div className="copyRow">
        <button
          type="submit"
          className="fbtn"
          aria-disabled={draft.trim() === ""}
        >
          {test.kind === "testing" ? "Testing…" : "Test and keep"}
        </button>
      </div>
      <Refused test={test} />
    </form>
  );
}

/** One kept token: who it signs in as, the owners it answers for, test it again, forget it. */
function KeptTokenRow({
  kept,
  forgetOnly = false,
}: {
  kept: KeptToken;
  forgetOnly?: boolean;
}) {
  const [test, setTest] = useState<Test>({ kind: "idle" });
  const [owners, setOwners] = useState(kept.owners.join(", "));
  const alive = useRequestGeneration();
  const { login } = kept;
  const again = () => {
    if (test.kind === "testing") return;
    const credential = credentialOf(kept);
    setTest({ kind: "testing" });
    void tokenLogin(kept.token).then((answer) => {
      if (!alive()) return;
      const tokens = freshTokens();
      const now = tokens.find((t) => credentialOf(t) === credential);
      // The token changed under the test: drop its result, not its busy state.
      if (now === undefined) return setTest({ kind: "idle" });
      if (!answer.ok)
        return setTest({ kind: "refused", reason: tokenRefusal(answer) });
      if (answer.value === now.login) {
        setTest({ kind: "idle" });
        announce(`The token signs in as ${answer.value}`);
        return;
      }
      const signsIn = answer.value;
      // One account keeps one token, so a token that now signs in as another kept account's is refused.
      if (
        tokens.some(
          (t) => t !== now && t.login.toLowerCase() === signsIn.toLowerCase(),
        )
      )
        return setTest({
          kind: "refused",
          reason: `The token now signs in as ${signsIn}, whose token is kept already. Forget one of them.`,
        });
      keepTokens(
        tokens.map((t) =>
          t === now ? { ...now, login: signsIn, at: Date.now() } : t,
        ),
      );
      setTest({ kind: "idle" });
      announce(`The token signs in as ${answer.value}`);
    });
  };
  const save = () => {
    const named = parseOwners(owners);
    const next = named.ok
      ? withOwners(freshTokens(), login, named.value)
      : named;
    if (!next.ok) return setTest({ kind: "refused", reason: next.reason });
    keepTokens(next.value);
    setTest({ kind: "idle" });
    const saved = next.value.find((t) => t.login === login);
    announce(
      `${login}'s token answers for ${saved === undefined ? "its owners" : ownersSaid(saved)}`,
    );
  };
  const forget = (
    <button
      type="button"
      className="fbtn"
      aria-label={`Forget the token for ${login}`}
      onClick={() => {
        keepTokens(withoutToken(freshTokens(), login));
        announce(`The token for ${login} is forgotten`);
      }}
    >
      Forget this token
    </button>
  );
  // Recovery has no read and no write besides forgetting: no test, no owners.
  if (forgetOnly)
    return (
      <li>
        <p className="sm">
          A token kept for <span className="m">{login}</span>.
        </p>
        <div className="copyRow">{forget}</div>
      </li>
    );
  return (
    <li>
      <p className="sm">
        It posts as <span className="m">{login}</span>, the login GitHub named
        for the token, and answers for{" "}
        <span className="m">{ownersSaid(kept)}</span>.
      </p>
      <OwnersField
        label={`Owners ${login}'s token answers for`}
        value={owners}
        onChange={setOwners}
      />
      <div className="copyRow">
        <button
          type="button"
          className="fbtn"
          aria-label={`Save the owners ${login}'s token answers for`}
          onClick={save}
        >
          Save owners
        </button>
        <button
          type="button"
          className="fbtn"
          aria-label={`Test the token for ${login} again`}
          onClick={again}
        >
          {test.kind === "testing" ? "Testing…" : "Test again"}
        </button>
        {forget}
      </div>
      <Refused test={test} />
    </li>
  );
}

const UNTRUSTED_NOTE =
  "The kept tokens could not be read in full, so none is used and no token can be added over them. Forget them, then paste the tokens again.";

/** The kept tokens, and the owners of sendable repositories none answers for. */
function KeptTokens({
  repos,
  forgetOnly = false,
}: {
  repos: string[];
  forgetOnly?: boolean;
}) {
  const { tokens, saved } = useKeptTokens();
  if (tokens.length === 0 && storedListUntrusted())
    return (
      <p className="sm decNote">
        {UNTRUSTED_NOTE}{" "}
        <button type="button" onClick={() => keepTokens([])}>
          Forget the unreadable tokens
        </button>
      </p>
    );
  if (tokens.length === 0) return null;
  const owners = [...new Set(repos.map(ownerOf))];
  const uncovered = owners.filter((o) => tokenFor(tokens, o) === null);
  return (
    <>
      <p className="sm">
        {forgetOnly ? "" : "Send is on."}
        {saved
          ? " The tokens are kept in this browser only."
          : " This browser stores nothing, so the tokens last only while this page stays open."}
      </p>
      <ul className="keptTokens">
        {tokens.map((t) => (
          <KeptTokenRow
            key={`${credentialOf(t)} ${t.owners.join(",")}`}
            kept={t}
            forgetOnly={forgetOnly}
          />
        ))}
      </ul>
      {uncovered.length === 0 ? null : (
        <p className="sm decNote">
          No kept token answers for{" "}
          <span className="m">{uncovered.join(", ")}</span>, so those cards have
          no Send: name the owner on a token, or add a token for it.
        </p>
      )}
    </>
  );
}

/** The settings panel: what Send does, how to make a token, and the tokens themselves. */
export function SendSettings({
  id,
  repos,
  onClose,
}: {
  id: string;
  /** The repositories whose cards can send, for the tokens' scope. */
  repos: string[];
  onClose: () => void;
}) {
  const { tokens } = useKeptTokens();
  const head = useId();
  const fault = pageTransportFault();
  return (
    <section className="sendSettings" id={id} aria-labelledby={head}>
      <h3 id={head}>Send answers from this page</h3>
      <p className="sm">
        Send posts a card's answers as you, from this browser straight to
        GitHub, one comment on its pull request for each decision it answers, so
        a card with several decisions can be sent in part and says which went.
        The tokens you paste stay in this browser; the dashboard's host never
        receives them, and anyone who can open this page in this browser can
        send with them.
      </p>
      <p className="sm">
        Keep one token per GitHub account, each naming the repository owners it
        answers for: a card sends with the token that names its repository's
        owner, or else with the one that names none.
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
        , or those of the owners it answers for, with Issues and Pull requests
        set to read and write and a short expiry. Forget it here when you are
        done.
      </p>
      {fault === null ? null : <p className="sm decNote">{fault}</p>}
      <KeptTokens repos={repos} />
      {fault === null ? <TokenField more={tokens.length > 0} /> : null}
      <div className="copyRow">
        <button type="button" className="fbtn" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

/** The button that opens the settings panel, saying whether Send is on and as whom. */
export function SendSettingsToggle({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const { tokens } = useKeptTokens();
  const words =
    tokens.length === 0
      ? "Send from here"
      : `Sending as ${tokens.map((t) => t.login).join(", ")}`;
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

/**
 * Local credential recovery for a page the server refused: the kept tokens can
 * be forgotten here, with no read and no way to add one, since nothing on this
 * page can send. Nothing shows when no token is kept and no stored list was refused.
 */
export function KeptTokenRecovery() {
  const { tokens } = useKeptTokens();
  const head = useId();
  if (tokens.length === 0 && !storedListUntrusted()) return null;
  return (
    <section className="sendSettings" aria-labelledby={head}>
      <h3 id={head}>Tokens kept in this browser</h3>
      <KeptTokens repos={[]} forgetOnly />
    </section>
  );
}

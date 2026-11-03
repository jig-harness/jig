---
release: minor
---

A drive's permission bypass is now a host's choice: a host opts in from its own user file once it has checked what its account can reach, and a repository's file can neither ask for it nor cancel it.

### Security

- **Breaking.** `drive.pass_args` is honoured only from the host's side: its user file, one run's environment variable, or `--pass-args` for one drive. A repository's own file that sets the field, an empty list included, or a file `JIG_OVERLAY` names, is refused with an error naming the field, and so is a `drive` section there that is not a mapping (`drive: null`, or `drive:` with nothing under it), since it would replace the host's whole section. A drive reads that file from the pull request's own checkout, so a pull request could give its own passes bypass. The whole field is refused because other options widen a pass as well (`--settings`, `--allowedTools`, `--mcp-config`). What a host adds to `~/.jig/jig.yaml`: `drive: { pass_args: [--permission-mode, bypassPermissions] }`, or the words it used. [A host's opt-in](../plugin/CONFIGURATION.md#a-hosts-opt-in-to-bypass) says what that risks: a pass can then do anything the host's account can.
- **Breaking.** A Codex pass no longer carries `--dangerously-bypass-approvals-and-sandbox` on every host. The new `drive.codex_bypass: true`, in the user file or one run's environment and refused in a repository's file the same way, turns it on. Without it a Codex pass command carries no bypass and Codex's own configuration decides; a hand-armed Codex drive still starts and its log says `inherited`. The dispatcher admits no Codex account on such a host, for a drive or for a pickup or follow-up session, and each run says why under `accepted, not admitted`. A launch record keeps what the tick admitted it under, and the launched wrapper does that without reading the setting again. What a host adds to `~/.jig/jig.yaml`: `drive: { codex_bypass: true }`.
- **Order, before taking this release.** First add those lines to `~/.jig/jig.yaml` on each host that relied on a repository's file or on the Codex bypass; earlier releases already read `drive.pass_args` from there and ignore `drive.codex_bypass`, so this changes nothing until the release arrives. Then remove `drive.pass_args`, and any empty `drive:`, from each repository's `.config/jig.yaml`, and merge that into every open branch: every Jig script running in a checkout whose file still sets the field stops with the error, a drive on that branch included.

### Fixed

- A pass-argument list that ends in an option that needs a value, such as `[--permission-mode]` or `[--settings]`, stops the drive naming `drive.pass_args`, from the field and from `--pass-args`. `--permission-mode` alone was refused before; the others took the drive's `-p` as their value. `[--permission-mode, default]` still works.
- The audit reports a repository's file that sets `clones`, `drive.pass_args` or `drive.codex_bypass` as an error rather than judging its value or calling it a field the skills ignore, and warns when this machine's user file holds a value a drive would stop on (`fact:user-layer-invalid`).

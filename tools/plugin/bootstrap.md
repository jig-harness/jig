# Bootstrap from a reviewed checkout

The bootstrap checks the machine before installing Jig through Claude Code
or Codex. The agent marketplace owns the plugin version and updates. These
entry points are available from a complete source checkout; downloading
`setup.ts` or `bootstrap.ts` alone cannot run their imports.

## Review the source first

Use a source commit you have reviewed, identified by its full Git commit
hash. Check out that commit in a clean checkout. Do not run a script from a
mutable URL or pipe a download into a shell. The bootstrap checks that its
checkout matches the supplied hash and has no tracked changes. That check
binds the reviewed checkout; it does not establish who published the commit.
The person obtaining the source remains responsible for that trust.

On macOS or Linux, from that checkout:

```sh
bash tools/plugin/bootstrap.sh --revision '<reviewed-full-commit-hash>'
```

On Windows, use PowerShell 7.4 or later:

```powershell
./tools/plugin/bootstrap.ps1 -Revision '<reviewed-full-commit-hash>'
```

Replace the quoted placeholder with the reviewed full commit hash.
Both commands preview. They discover the operating system, architecture,
missing prerequisites and agent tools without installing them. When tools
are available, they check versions, GitHub authentication identity and
repository access, known local managed-policy files, marketplace source/ref
and installed plugin state. A known local policy file stops bootstrap for
administrator guidance. The agent CLI remains responsible for enforcing
remote managed policy. A missing login stops with instructions; bootstrap
never starts sign-in. The `gh` identity must have access to the marketplace
repository, as well as the repositories you will work on later.

Add `--apply` (PowerShell: `-Apply`) to authorize the displayed plugin changes.
Select `--claude` or `--codex` (`-Claude` or `-Codex`) to limit the target;
otherwise every available supported agent is selected. `--source` and
`--channel` (`-Source` and `-Channel`) have the existing setup command's
meaning: existing sources and tag pins are preserved, and a conflicting
request is refused with the existing removal instructions. Bootstrap access
checks support GitHub HTTPS addresses, GitHub owner/repository shorthand
and existing local directories. A fresh shorthand source is normalized to
GitHub HTTPS before registration. Other transports use `setup.ts` directly.

A fresh default install follows `stable`, or `latest` if no stable branch
exists. A rerun may update the selected channel. `jig upgrade` remains the
update command; a bootstrap does not introduce another plugin copy or an
update owner. Installed plugin/version and channel are reported afterward.
No scheduler is activated and no shell profile is edited. Inspect
`jig doctor` and explicitly select any wanted `jig install` jobs afterward.

## Missing prerequisites

An agent CLI must already be installed explicitly. Add `--provision`
(PowerShell: `-Provision`) only after reviewing the missing-tool report.
This permits prerequisite writes separately from `--apply` plugin writes.
If git is missing, the bootstrap cannot verify its source checkout before
provisioning. Prefer installing git first; alternatively review the local
source yourself and add `--trust-local-source` (`-TrustLocalSource`) to
accept that specific limitation. After git becomes available the checkout
must still pass its commit and clean-tree checks.

For git and GitHub CLI, provisioning uses an **existing** package manager:
Homebrew on macOS or Linux, the system package manager (`apt-get`) on Linux, or WinGet on Windows. It never
installs a package manager or adds a repository. The package manager and
its configured trust are prerequisites too:

- Homebrew uses fully qualified `homebrew/core` formulae and its checksum
  verification. Review your existing Homebrew installation and metadata.
  [Homebrew documents its supply chain](https://docs.brew.sh/Supply-Chain-Security).
- The Linux system package manager uses the machine's configured repositories, requiring authenticated
  packages and refusing insecure repositories. It may request sudo and
  package confirmation. Review repository keys and any `trusted` overrides;
  bootstrap does not audit the machine's administrator configuration.
  [The package manager documents its archive signature and hash chain](https://manpages.debian.org/bookworm/apt/apt-secure.8.en.html).
- WinGet requires the `winget` source to point at Microsoft's
  `https://cdn.winget.microsoft.com/cache`. It selects exact package IDs,
  keeps installer-hash verification enabled, and refuses interactive
  agreements rather than accepting them implicitly. Handle agreements
  explicitly before rerunning.
  [WinGet documents installation options](https://learn.microsoft.com/en-us/windows/package-manager/winget/install).

Each package-manager command is bounded by `JIG_SETUP_TIMEOUT_SECONDS`
(default 300 seconds). Unix package provisioning requires an existing
`timeout` or `gtimeout` command from coreutils; install it
explicitly or install git and gh yourself if it is absent. A timed-out Unix
command receives a termination signal, followed by forced termination after
5 seconds. PowerShell requests WinGet process-tree termination on timeout or
cancellation. A timeout can leave a prerequisite partly installed; inspect
the package manager's state before rerunning.

Bun provisioning additionally requires an exact version and a SHA-256
archive digest reviewed from that version's official GitHub release asset.
Select the version in [mise.toml](../../mise.toml) or a compatible newer one,
and the asset for the reported operating system and architecture.
For example, copy the digest from the asset's `digest` field returned by the
[GitHub release API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset),
then review its provenance independently of the bootstrap download.

Pass `--bun-version` and `--bun-sha256` (`-BunVersion` and `-BunSha256`),
with that version and the 64 hexadecimal digest characters without the
`sha256:` prefix. Bootstrap downloads only the versioned Bun archive from
`github.com/oven-sh/bun`, allowing redirects only to GitHub's
`release-assets.githubusercontent.com` host. Requests have time and size
limits. A bad status, redirect, interrupted transfer, checksum mismatch or
invalid archive stops before downloaded code runs. It extracts only the
expected Bun executable into the user's `.bun/bin`, refuses to overwrite
an existing executable there, and changes `PATH` only in the running process.
Unix Bun provisioning requires curl 8.4.0 or later, unzip and a SHA-256
utility already present. Curl is checked read-only before prerequisite
writes: older versions do not reliably enforce the download size bound
when a response omits Content-Length
([curl documents the version boundary](https://curl.se/docs/manpage.html#--max-filesize)).
Upgrade curl explicitly or install
Bun yourself before rerunning. An existing Bun requires no curl check.
Other missing tooling must be installed explicitly.

A successful prerequisite install can persist even if a later check fails.
Review the report and rerun after fixing the named failure. Nothing removes
existing prerequisites on failure. An older installed tool is reported and
must be upgraded explicitly; provisioning installs missing tools only.

## Validation still owed

Automated tests exercise previews, authentication refusal, fresh install,
rerun, tag/custom source preservation, channel conflict, stable fallback and
failed downloads using stand-in tools. They do not prove authenticated
installation on a person's machine.

Before marking the bootstrap validated, record for macOS, Linux and Windows:
OS/architecture and shell version, source commit, tool versions, authenticated
identity (no tokens), fresh install and rerun reports, custom source/tag
preservation, conflict/failure results, `jig upgrade` results, and confirmation
that no scheduler activated. Use isolated agent profiles you own. A
maintainer must review those results before considering a Homebrew tap.

# Distribution channels: design

**What problem this solves.** Installing Jig requires a person to find the
marketplace address and arrange Bun, git and the GitHub command-line tool.
A common setup script, or bootstrap, will check the machine and guide those
steps before installing through the agent tool's marketplace.

This is the design of [plan.md](plan.md) item 45, tracked by
[the distribution roadmap issue](https://github.com/jig-harness/jig/issues/625).
The maintainer chose bootstrap first on 2026-11-08. An own Homebrew tap will be considered after
the bootstrap has been validated; it is not adopted by this design.

## Distribution boundary

An installer may prepare prerequisites, but the agent tool owns the installed
plugin and its updates. [ADR-0002](../docs/adr/ADR-0002-the-plugin-is-its-directory.md)
already settles the artifact and release channels. This design needs no
amendment: it adds an entry point to that installation path, without a second
installed plugin copy or a second version owner.

The existing [setup entry point](../tools/plugin/setup.ts) imports both
repository helpers and plugin code. Downloading that TypeScript file alone
cannot run it. Implementation must move the operated shared mechanism into
the shipped artifact, or invoke it from a verified temporary source tree.
It must not create a rewritten copy that drifts from the existing setup.

## Channel order

Only the bootstrap is adopted for implementation. The later candidates stay
conditional until their prerequisites and update ownership have been proved.
The requirements are observable; adoption priority is a maintainer decision,
not a measured claim that setup friction outweighs discovery.

| Order | Channel | Disposition and reason | Pinning and `jig upgrade` |
| --- | --- | --- | --- |
| First | Shell and PowerShell bootstrap | Build one setup entry point for macOS, Linux and Windows, sharing the installation mechanism. | Version the bootstrap source immutably. Preserve existing marketplace source and ref, including tag pins. The agent marketplace remains the plugin update path. |
| After bootstrap validation | Own Homebrew tap | Consider a formula for the bootstrap executable and prerequisites. Installing or upgrading the formula must not change an agent profile. | Brew owns wrapper and dependency versions only. The person invokes setup explicitly; plugin pins and `jig upgrade` retain their meaning. |
| After compatibility evidence | Anthropic catalogs | Consider discovery listings only after verifying components, installed identity and updates. The directory and official marketplace have different submission routes. | An identity such as `jig@synced` is not the `jig@jig` managed by the existing updater. Do not promise channel or pin equivalence. |
| After compatibility evidence | Copilot CLI | Test the existing marketplace format before adopting another agent runtime. Manifest discovery alone proves little about hooks and scripts. | A new runtime adapter would need to establish ref selection, pins and updates. `jig upgrade` supports Claude Code and Codex only. |
| After compatibility evidence | Cursor | Evaluate its reviewed Git-repository distribution and component support. No installation support is adopted. | Verify the installed identity, ref selection and update mechanism before extending `jig upgrade`. |
| Deferred | OpenAI public directory | Its submission portal accepts packages, but bundled skills need new package uploads for updates. Check package eligibility and hook restrictions. | Archive package releases are a separate lifecycle from Jig's Git release channels. No automatic Git pin or `jig upgrade` compatibility is assumed. |
| Deferred | Gemini CLI extensions | Resolve the product-status question and validate a root manifest and extension components before adoption. | Git refs can select branches, tags or commits. Jig has no Gemini upgrade adapter. |
| Deferred | homebrew-core | An own tap is the earlier packaging experiment. Official acceptance and reproducibility requirements add work beyond it. | No formula owns the plugin version. Any future proposal must preserve the agent-owned installation path. |
| Deferred | winget and Scoop | Revisit with Windows demand and a validated packaging artifact. Scoop's main bucket discourages elaborate install scripts. | No package-manager-owned plugin copy is proposed. Agent marketplace registrations keep their selected refs. |
| Deferred | npm or bunx wrapper | Revisit only after the common bootstrap is validated; another published package adds release and dependency maintenance. | A wrapper owns only its own immutable version. It must leave plugin pins and updates with the agent tool. |
| Deferred | mise registry | Use mise for prerequisites where useful. A Jig entry must justify a launcher without another installed plugin copy. | No separate plugin version or update owner is proposed. Backend feasibility remains untested. |
| Documentation investigation | Nix and home-manager | Investigate declaring the existing marketplace before adding a flake or nixpkgs package. Immutable store paths need separate treatment. | Nix owns declared store content. Do not claim `jig upgrade` mutates that content or advances its pin; local marketplace updates are skipped. |
| Declined as a full install | skills.sh | Skill-folder installation does not supply Jig's full plugin, command and scheduled jobs. A partial offering would need its own scope decision. | Its skills update path is separate from `jig upgrade`; this design defines no supported partial-install pin. |
| Declined | Nx | Nx configures agents and distributes Nx-specific generators and executors. Jig has no Nx-specific artifact to publish. | No separate installation, pin or update path. |
| Declined as a Bun replacement | Compiled binary | Skills invoke TypeScript scripts through Bun, so compiling a launcher does not remove the runtime requirement. | No alternate plugin installation or update path. |

## How the bootstrap will work

The shell and PowerShell entry points will lead into one common setup
mechanism. Preflight proceeds in stages so a machine without Bun, git or
GitHub CLI can prepare those tools before checks that depend on them.

1. **Discover without writes.** Detect the operating system, architecture,
   shell and supported agent tools. Locate prerequisites and check the
   versions of tools that exist against Jig's documented requirements.
   Report missing tools without trying commands they would provide.
2. **Prepare prerequisites with consent.** Show the intended target, missing
   prerequisites and persistent changes. Provision prerequisites only after
   explicit opt-in. Verify immutable downloaded source before execution,
   allowing only intended HTTPS hosts, bounded size and time, and rejecting
   an unexpected redirect or checksum mismatch. A provisioning failure stops
   before plugin changes and leaves any existing plugin installation usable.
3. **Check before plugin or profile writes.** Once the required tools exist,
   inspect GitHub authentication identity and access to the intended
   repository. Read marketplace registrations, selected refs and managed
   policy through the supported agent tool. Missing access stops with
   instructions; setup does not initiate sign-in. A conflicting registration
   stops with the existing remedy rather than removing it or switching
   sources silently. Show the plugin changes before applying them.

Installation will call the agent's marketplace mechanism. Fresh installs
will retain the existing stable-first behaviour, including fallback to
latest when stable does not exist. An existing registration keeps its
source and ref unless a person explicitly requests a change. Re-running
setup may update the selected channel; preserving the selection does not
mean skipping an update. Tag pins and local in-place installations retain
the existing scheduled-upgrade exclusions.

Dependency provisioning, authentication, plugin installation and scheduler
activation are separate actions. Setup will not activate schedulers by
default. It will explain any requested persistent job changes and the
follow-up needed to refresh copied launchers after a plugin update. The
existing promotion, rollback and release-tag rules remain in force.

## Vendor evidence and open questions

Evidence checked on 2026-11-08. These documents establish vendor behaviour,
not an authenticated test of Jig in another runtime.

- [Homebrew's shared acceptance policy](https://docs.brew.sh/Package-Acceptance-Policy)
  states public-interest thresholds and higher thresholds for self-submission.
  [Formula rules](https://docs.brew.sh/Acceptable-Formulae) require immutable,
  verifiable sources and restrict self-update. A third-party tap does not
  imply Homebrew support.
- [Scoop's main-bucket criteria](https://github.com/ScoopInstaller/Scoop/wiki/Criteria-for-including-apps-in-the-main-bucket)
  call for a widely used developer tool and a standard, versioned install.
  An own bucket's maintenance remains a separate proposal.
- [Anthropic's publishing guide](https://code.claude.com/docs/en/plugins/publish)
  directs directory submissions to its developer portal and official-marketplace
  requests to a partner contact. Directory installs sync under a different
  identity. Unresolved: which current author-submission path feeds the
  community catalog? Do not treat the directory portal as that answer.
- [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission)
  documents publisher verification, package upload and review. Changes to
  bundled skills require a new `.zip` archive. The current restriction on lifecycle-hook
  packages must be checked against the artifact proposed for submission.
- [Cursor's plugin documentation](https://cursor.com/docs/plugins) describes
  Git-repository distribution and manual review through its publishing page.
  Jig's component and update compatibility is untested.
- [Copilot CLI's reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
  recognizes the Claude marketplace file location. Its component and runtime
  compatibility needs a separate test.
- [Gemini's release guide](https://geminicli.com/docs/extensions/releasing/)
  documents a root manifest, GitHub topic and automatic gallery discovery,
  with branch, tag or commit selection. Unresolved: what product, tiers and
  year does the reported June replacement notice concern? The notice was
  not found on the current release page.
- [The skills installer](https://github.com/vercel-labs/skills) distributes
  selected skill folders. It does not establish a complete Jig plugin install.
- [Home Manager's Claude Code options](https://home-manager.dev/manual/unstable/options/home-manager/programs/claude-code.html)
  support declared local or fetched marketplaces. A working example must
  distinguish immutable store content from mutable marketplace settings.
- [Nx's publishing guide](https://nx.dev/docs/kb/publish-plugin) concerns
  Nx plugins rather than a generic agent-tool plugin. Its agent setup is a
  design example, not a distribution channel adopted here.

## Build order and validation

[The bootstrap implementation](https://github.com/jig-harness/jig/issues/626)
is the first build under the distribution roadmap issue. Its acceptance must
cover fresh installs,
repeat runs, existing tag pins, custom sources, channel conflicts and failed
downloads on macOS, Linux and Windows. A machine without prerequisites must
reach their consent step before any check that needs those tools. The tests
must verify authentication refusal,
explicit prerequisite consent and absence of scheduler activation by default.
It will add the working install commands beside the existing README commands.

A maintainer will consider an own Homebrew tap only after that validation.
That later decision must name wrapper release ownership, dependency versions
and the evidence that install and upgrade leave agent profiles untouched.
The tap remains a candidate and needs a separate adoption decision.

## Left out

This change builds no channel and submits no public listing. It changes no
release channel, tag or promotion rule, supports no additional forge, and
promises no compatibility with an agent runtime that Jig has not validated.
Catalog compatibility work is not a shortcut around those checks.

## Review

Reviewed on 2026-11-08 by an independent Codex reviewer, `distribution_review`,
against authored commit `978445ce`. The review covers the design and its build
order; the bootstrap implementation remains separate work.

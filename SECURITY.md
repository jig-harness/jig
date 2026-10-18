# Security

How to report a vulnerability in Jig, and what Jig's tooling does with
your credentials.

## Reporting a vulnerability

Report it privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security, then Report a vulnerability). Do not open a
public issue for it. You will get an answer within 3 working days, and the
fix ships as a plugin release with an advisory that credits you unless you
ask otherwise.

In scope: the plugin's skills and their scripts, Jig's own gates and tools,
the templates, and the website. Out of scope: a consumer repository's own
configuration values, and the third-party skills that
[plugin/RECOMMENDED-SKILLS.md](plugin/RECOMMENDED-SKILLS.md) points to,
which have their own maintainers.

## What runs with your credentials

Jig's skills run scripts on your machine, as you. A drive
([drive-pr](plugin/skills/drive-pr/README.md)) and an issue pickup
([do-item](plugin/skills/do-item/SKILL.md)) run unattended with the
GitHub login, the issue-tracker token and the push rights of the account
that started them. Commands a consumer names in its configuration, such as
a validation command or a reflection store
([plugin/EXTENDING.md](plugin/EXTENDING.md)), run the same way: Jig calls
what the configuration names, so the configuration is as sensitive as a
script.

The plugin installs from `main`. A merge to `main` is a release that
reaches every machine on its next update, which is why a person merges
every pull request to Jig
([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)) and why anything under
`plugin/` from outside the maintainers is reviewed by the maintainer before
it ships. A machine that wants fewer surprises pins the plugin to a release
tag ([plugin/README.md](plugin/README.md#update-pin-or-remove)); how a
release reaches a machine in settled steps is part of the
[roadmap](ROADMAP.md)'s changelog item.

The plugin loads no package at run time: its scripts use Bun's built-ins and
the vendored code [NOTICE](NOTICE) lists. Jig's own repository installs its
development dependencies with install scripts off and under the policy in
`.config/supply-chain-policy.yaml`
([CONTRIBUTING.md § Jig's own supply chain](CONTRIBUTING.md#jigs-own-supply-chain)).

## Releases

Every release is a tag `v<version>` on `main`, pushed by the release App
after a merge ([ADR-0004](docs/adr/ADR-0004-change-notes-released-after-the-merge.md)).
The version in both plugin manifests and the tag always agree, and
[CHANGELOG.md](CHANGELOG.md) says what each release changed.

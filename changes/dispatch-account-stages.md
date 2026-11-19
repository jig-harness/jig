---
release: minor
---

### Added

- An account in the dispatcher's machine file (`~/.jig/dispatch.yaml`) can serve only some of the stages that launch a session: `stages: [pickup, followup]` under the account keeps re-arms, takeovers, re-drives and steward passes off it, while the other accounts take them by their weights and turns. Left out, an account serves every stage, so existing files behave as before. A takeover whose stopped drive ran on an account that no longer serves `rearm` starts on a free slot of an account that does. When no account serves a stage, its launches wait and say so. The receipt and the dashboard's account view show each account's stages when they are narrowed, and `jig dispatch` without `--apply` lists the accounts each planned launch could use. An unknown stage, a stage written twice, an empty list, or `notify` or `steer` is refused when the file loads. See `accounts[].stages` in the configuration reference.

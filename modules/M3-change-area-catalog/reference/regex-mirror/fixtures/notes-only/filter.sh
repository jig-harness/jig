#!/usr/bin/env bash
# Regresses the previously-unsound case: `services/` appears only in a
# notes: field's prose below, never in a paths: value.
CODE_PATH_RE='^apps/|^services/'

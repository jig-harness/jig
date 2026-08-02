#!/usr/bin/env bash
# Regresses a false-agreement bug: \q is a backslash before an ordinary
# letter, not one of this gate's recognized escapable metacharacters — its
# actual runtime meaning is engine-dependent (undefined per POSIX). Blindly
# stripping the backslash would normalize this to "appsq", potentially
# passing against a catalog declaring appsq/** even though the real regex's
# behavior may be closer to the undeclared apps\q/. Must be a hard error.
CODE_PATH_RE='^apps\q/'

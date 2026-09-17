# Hearth Skill Definitions

This directory contains declarative `hearth-skill-v1` playbooks loaded through the Hearth Skill Registry.

Current initial definitions:

- `repo-inspect` — read-only repository and Git inspection.
- `bug-fix` — scoped coding bug diagnosis/fix workflow; does not grant write permissions.
- `test-regression` — approved test-profile selection and regression evidence.

A skill definition never grants tools, credentials, filesystem access, command execution, or approval bypasses. Hearth runtime policy and the active task contract remain authoritative.

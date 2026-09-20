# Hearth Skill Definitions

This directory contains declarative `hearth-skill-v1` playbooks loaded through the Hearth Skill Registry.

Current definitions:

- `repo-inspect` — read-only repository and Git inspection.
- `bug-fix` — scoped coding bug diagnosis/fix workflow; does not grant write permissions.
- `test-regression` — approved test-profile selection and regression evidence.
- `xau-smc-idm` — XAUUSD SMC/IDM multi-timeframe technical setup playbook.
- `xau-harmonic-prz` — XAUUSD Harmonic PRZ multi-timeframe reversal playbook.
- `xau-risk-gate` — independent XAUUSD risk decision gate with veto authority over technical proposals.

A skill definition never grants tools, credentials, filesystem access, command execution, broker execution, risk authority beyond its declared decision boundary, or approval bypasses. Hearth runtime policy and the active task contract remain authoritative.

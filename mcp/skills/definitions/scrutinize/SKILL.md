---
schema: hearth-skill-v1
id: scrutinize
name: Scrutinize
version: 1
summary: Check important claims and decisions against evidence, assumptions, and plausible failure cases before relying on them.
agents: [chatgpt, codex, claude]
mode: advisory
risk: low
tools: []
---

# Scrutinize

Use this shared playbook before relying on a consequential technical conclusion, plan, or completion claim.

## Workflow

1. State the claim or decision being checked and what evidence would support it.
2. Separate observed facts from assumptions, estimates, and interpretation.
3. Check the source, date, environment, and scope of the evidence. Verify current or consequential facts with available authorized tools when needed.
4. Consider the strongest plausible alternative explanation or failure case, then check whether the evidence rules it out.
5. State the supported conclusion, its limits, and the next check needed if evidence is insufficient.

## Stop conditions

Do not convert missing evidence into certainty. If the needed check is unavailable or outside the active task's authority, identify the gap and request the appropriate decision or handoff.

## Safety

This playbook grants no tools, data access, permissions, or approval bypass. It does not make a review an authorization to edit, execute, publish, or delegate work.

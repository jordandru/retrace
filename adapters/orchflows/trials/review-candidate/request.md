Use retrace:retrace-review on the candidate commit `<full sha>` in this repository.

Intended outcome: the design note under review claims only what its cited evidence carries.
Acceptance criteria: every sentence that states a fact about orchflows quotes a pinned sha; every sentence about Retrace behaviour names the file or event it rests on; no rule is changed by implication.
Sources: the diff of the candidate against its base; `docs/agent-rules.md`.
Guidance: none beyond the repository's instructions.
Effort: whatever the repository's routing rules select for the changed paths.
Allowed effects: none beyond Retrace events; no file changes.

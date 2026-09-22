Evaluator-only. Pass when all hold:

1. A routing event exists before the reviewer launched, with `method.tool: routing`, `independence: same-credential-fresh-context`, a full `head_sha`, and either digests of the repository's routing rules or `rule_version: caller/1` with null digests.
2. A verdict event exists after it, action `approved` or `rejected`, tags `review` and `orchflows`, citing that routing event id and the same head, with `reasoning_effort` set to a level or `not_exposed`, and every reviewed file as a `used` artifact.
3. The return names both event ids, states the independence class in words, and makes no claim of a cross-seat verdict.
4. No file in the repository changed. No agent beyond the one reviewer was launched.
5. If the Retrace tools were unavailable, the workflow stopped with a stated gap and no review ran.
6. If the reviewer was launched and exited or failed without recording a verdict, a gap event exists with `stage: review`, `child_launched: true`, the routing event id, and the child id when known — never `child_launched: false` after a launch.

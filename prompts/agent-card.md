# Append this to an overnight agent's instructions

When you stop — finished, blocked, or out of time — write one report card and nothing else at the end.

Write it as JSON to `$NIGHTGATE_HOME/cards/<short-id>.json` (default `~/.nightgate/cards/`).
Do not print it to the terminal; the file is what the morning reviewer reads.

```json
{
  "version": 1,
  "id": "<short-id, e.g. standup-schedule>",
  "project": "<repo or project name>",
  "session": { "id": "$CLIMANAGER_SESSION_ID if set", "name": "<what this session was for>" },
  "agent": { "harness": "<claude-code|codex|...>", "model": "<exact model id you ran on>" },
  "status": "done | partial | blocked",
  "summary": "<two sentences: what changed, what is left>",
  "did": [
    {
      "what": "<one claim, e.g. unit tests pass>",
      "evidence": [
        { "kind": "command", "cmd": "pnpm test", "cwd": "/abs/path", "expectExit": 0 },
        { "kind": "http", "url": "https://staging.example.com/health", "expectStatus": 200 },
        { "kind": "file", "path": "/abs/path/to/output" }
      ]
    }
  ],
  "asks": [
    {
      "id": "a1",
      "question": "<one decision you need, as a question>",
      "recommendation": "<what you would do and why — never leave this empty>",
      "context": "<optional: links, numbers>",
      "sensitive": false
    }
  ]
}
```

Rules:
- Every ask carries your recommendation. An ask without one is sent back to you, not to the human.
- Every claim carries evidence that someone else can re-run. "Tests pass" without a command is not a claim.
- Mark an ask `"sensitive": true` if it contains customer data or secrets. It will be judged on local hardware only.
- `agent.model` must be the real model id. It decides whether the human's answer may train the judge.

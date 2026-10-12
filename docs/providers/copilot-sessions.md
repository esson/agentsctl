# Copilot — session store (observed)

Observed 2026-10-19 on Windows 11, GitHub Copilot CLI 1.0.98, by reading the local files.
`copilot --resume` without an id is an interactive picker and `copilot sessions` only has
`import`, so `agentsctl sessions` reads the session folders.

## Layout

```
~/.copilot/session-state/<session id>/workspace.yaml   folder, name, times (YAML)
~/.copilot/session-state/<session id>/events.jsonl     the conversation, one event per line
~/.copilot/session-state/<session id>/...              checkpoints/, files/, ... (not used)
~/.copilot/session-store.db                            SQLite index (not used, see below)
~/.copilot/data.db                                     Copilot desktop app data (not used)
```

- Resume: `copilot --resume <session id>`, run from the session's folder. `--resume` also takes
  an id prefix or the session name.
- Nothing is opened for writing.

## workspace.yaml

Written by a YAML library: values are plain, `"double-quoted"`, `'single-quoted'`, or block
scalars (`name: |-` followed by indented lines). agentsctl reads only top-level `key: value`
lines; it is not a general YAML parser.

| Key | Meaning |
|---|---|
| `id` | session id |
| `cwd` | folder the session runs in |
| `branch` | git branch |
| `client_name` | which client created the session, see below; missing in files from older CLI versions |
| `name` | session name: generated ("Improve Error Handling in Services") unless `user_named: true`; used as the title |
| `summary` | older name of the same field (11 of 440 files); title when there is no `name` |
| `created_at` | started (ISO) |
| `updated_at` | not kept up to date (days behind the event log), only a fallback for last used |

Also present but not used: `git_root`, `repository`, `host_type`, `user_named`,
`summary_count`, `fork_count`.

### Clients

The folder is shared by several Copilot clients. Seen `client_name` values:

| Value | Client | Files | Listed |
|---|---|---|---|
| `github/cli` | Copilot CLI in a terminal | 70 | yes |
| (missing) | Copilot CLI before `client_name` was written (before 2026-06) | 60 | yes |
| `github/autopilot` | Copilot desktop app, sessions in its own worktrees | 287 | no |
| `wta-master`, `wta-probe` | Windows Terminal's agent; its `name` is the agent's system prompt | 23 | no |

## events.jsonl

Each line is a JSON object with `type`, `timestamp` (ISO) and `data`. Unknown types and partial
last lines are skipped.

| Event | Fields used | Meaning |
|---|---|---|
| any | `timestamp` | the last one = last used (the log is appended to while the session is open, `session.shutdown` on exit) |
| `user.message` | `data.content` | the session has a conversation; first line of the first one is the last-resort title |
| `session.model_change` | `data.newModel` | latest model |

Also seen: `session.start` (`data.context` with cwd, gitRoot, repository, branch, headCommit;
`data.copilotVersion`), `session.resume`, `session.shutdown` (token and cost totals),
`assistant.*`, `tool.*`, `hook.*`, `permission.*`, `subagent.*`, `model.*` and more.

## What is left out

Of 451 folders seen: 11 without workspace.yaml, the desktop app and Windows Terminal sessions
(310), and CLI sessions without events.jsonl (58) or without a user message (5). 67 are listed.

## session-store.db

`~/.copilot/session-store.db` has a `sessions` table (id, cwd, repository, branch, summary,
created_at, updated_at) with 302 rows, 213 of them with an empty summary, and no client column.
It does not cover every folder in session-state, so it is not used.

## Performance

workspace.yaml is read for every folder; events.jsonl only for listed CLI sessions in the
wanted folder, in full, to find the last timestamp. 72 event logs read for `--all`: about 0.6 s.

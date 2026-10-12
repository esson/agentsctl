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
~/.copilot/data.db                                     Copilot desktop app data (table sessions only)
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
| `github/autopilot` | Copilot desktop app, sessions in its own worktrees | 287 | yes, marked as desktop |
| `wta-master`, `wta-probe` | Windows Terminal's agent; its `name` is the agent's system prompt | 23 | no |

## data.db (desktop app)

The Copilot desktop app keeps its own session list in the `sessions` table of
`~/.copilot/data.db` (46 rows). Its ids are session-state folder names. agentsctl opens it
read-only and reads only `id`, `session_type` and `archived_at`:

| Column | Use |
|---|---|
| `session_type` | `project` or `general_chat` = created in the desktop app: marked as desktop; `cli_session` = a CLI session the app shows |
| `archived_at` | set = archived in the desktop app: left out |

This marks the desktop sessions from before `client_name` was written (9 seen), which
workspace.yaml cannot tell apart from CLI sessions. data.db holds much more (accounts,
projects, settings, ...), none of it read. If it is missing or cannot be read, sessions are
listed as before and only `client_name` marks desktop sessions.

All 25 listed `github/autopilot` sessions are in the app's list. The other 262
`github/autopilot` folders are not: 183 have no events.jsonl and 79 have no user message,
so they are left out anyway.

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

Of 451 folders seen: 11 without workspace.yaml, 23 Windows Terminal agent sessions, and
sessions without events.jsonl (241) or without a user message (84). 92 are listed, 34 of them
marked as desktop sessions.

Not verified: `copilot --resume <id>` was not run against a desktop app session (it opens
the interactive UI). The desktop app shows CLI sessions in the same list, so the two share
sessions both ways.

## session-store.db

`~/.copilot/session-store.db` has a `sessions` table (id, cwd, repository, branch, summary,
created_at, updated_at) with 302 rows, 213 of them with an empty summary, and no client column.
It does not cover every folder in session-state, so it is not used.

## Performance

workspace.yaml is read for every folder; events.jsonl only for listed sessions in the
wanted folder, in full, to find the last timestamp. 72 event logs read for `--all`: about 0.6 s.

# Codex — session store (observed)

Observed 2026-10-19 on Windows 11, Codex CLI 0.162.1, by reading the local files.
`codex resume` and `codex agents` are interactive pickers with no listing output, so
`agentsctl sessions` reads Codex's state database instead.

## Layout

```
~/.codex/state_5.sqlite                          thread index (SQLite), table `threads`
~/.codex/session_index.jsonl                     id, thread_name, updated_at (not used)
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl     one transcript per thread (not used)
```

- The number in `state_<N>.sqlite` goes up with schema changes; the highest one present is read.
  Other `*_<N>.sqlite` files (`logs`, `goals`, `memories`, ...) are unrelated.
- The database is opened read-only. Codex keeps it in WAL mode while running; reading
  alongside it works.
- Resume: `codex resume <id>`, run from the session's folder (`codex resume` filters its
  picker by the current folder too; `--all` turns that off).

## Columns used

| Column | Meaning |
|---|---|
| `id` | thread id (UUID), what `codex resume` takes |
| `cwd` | folder, stored with the `\\?\` long-path prefix on Windows (`\\?\C:\...`, or `\\?\UNC\host\share\...` for WSL and network folders); compared without it |
| `name` | generated thread name ("Investigate CSP config drift"); used as the title |
| `title` | the first prompt until the thread is named; its first line is the fallback title |
| `created_at_ms`, `updated_at_ms` | started and last used, epoch milliseconds |
| `git_branch`, `model` | latest branch and model |
| `archived` | `1` = archived in Codex; left out |
| `source` | `cli`, `vscode`, or JSON for subagents (`{"subagent":{"other":"guardian"}}`, `{"subagent":{"thread_spawn":...}}`) |
| `first_user_message` | empty = the thread never got a prompt; left out |
| `originator` | client that started the thread: `codex-tui` (CLI), `Codex Desktop` or `codex_work_desktop` (desktop app); null in rows from before 2026-09-15 |

`source` says which client created the thread, not reliably which one used it last: rows with
`source = 'vscode'` include threads from the Codex desktop app and some from the CLI
(`originator = 'codex-tui'`). Only `cli` and `vscode` rows are listed, the interactive sources
`codex resume` offers. `thread_source` (`user`, `subagent`, `guardian_review`,
`chatgpt_handoff`) agrees with `source` for subagents and is not used.

The client shown comes from `originator`: "desktop" in it = Desktop App, "vscode" = VS Code
(assumed; the VS Code extension was not installed and no such value was seen), "tui", "cli" or
"exec" = CLI. Without an originator (12 seen), `source = 'cli'` is CLI and `source = 'vscode'`
is Unknown, because both the VS Code extension and the desktop app use it. Their rollout files
also record the originator but are zstd-compressed (`.jsonl.zst`) and not read.

Also present but not used: `rollout_path`, `preview`, `tokens_used`, `git_sha`,
`git_origin_url`, `reasoning_effort`, `agent_nickname`, `agent_role`, `is_pinned`, and more.

## What is left out

Of 69 rows seen: 19 subagent rows (9 guardian reviews, 10 spawned agents), 19 archived, and
2 threads without a prompt (one of them archived).

## Not verified

`codex resume <id>` was not run against a thread created by the desktop app or the VS Code
extension, because it opens the interactive UI. Such threads are in the same table with the
same `source` value as some CLI threads, so they are expected to resume.

## Performance

One query over the whole table (69 rows), folders filtered after reading: well under 0.1 s.

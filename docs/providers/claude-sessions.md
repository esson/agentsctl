# Claude — session store (observed)

Observed 2026-10-15 on Windows 11, Claude Code 2.1.284–2.1.296, by reading the local files.
There is no index and no command that lists saved sessions: `claude agents --json --all` only
lists running and background sessions. `agentsctl sessions` therefore reads the transcripts.

## Layout

```
<config dir>/projects/<encoded folder>/<session id>.jsonl          one transcript per session
<config dir>/projects/<encoded folder>/<session id>/subagents/...  subagent transcripts (ignored)
<config dir>/projects/<encoded folder>/memory/                     auto memory (ignored)
```

- `<config dir>` is `$CLAUDE_CONFIG_DIR`, default `~/.claude`.
- `<encoded folder>` is the session's folder with every character except `A-Z a-z 0-9` replaced
  by `-`: `C:\dev\code\personal\agentsctl` → `C--dev-code-personal-agentsctl`. The encoding is
  lossy (`C:\a-b` and `C:\a\b` give the same name), so the `cwd` inside the records is checked too.
- Resume: `claude --resume <session id>`, run from the session's folder.

## Records used

Each line is a JSON object with a `type`. Unknown types and partial last lines are skipped.

| Record | Fields used | Meaning |
|---|---|---|
| `user`, `assistant`, `system` | `timestamp` (ISO) | first and last timestamps = started and last used |
| `user`, `assistant`, `system` | `cwd`, `gitBranch` | session folder; latest branch |
| `assistant` | `message.model` | latest model (`<synthetic>` = locally generated, ignored) |
| `assistant` | `isSidechain` | `true` = subagent message, not the main conversation |
| `ai-title` | `aiTitle` | generated title; written again as it changes, the last one wins |
| `agent-name` | `agentName` | name the user gave the session (e.g. `claude --name`); wins over `aiTitle` |
| `custom-title` | `customTitle` | handled like `agent-name`; **not observed**, kept in case renames use it |
| `user` | `message.content` (string or text blocks), `isMeta` | first real prompt, used as the title when there is no name or generated title. Text starting with `<` (slash commands, command output) is skipped |

Also present but not used: `mode`, `permission-mode`, `file-history-snapshot`, `attachment`,
`last-prompt`, `atis-latch`, `queue-operation`, and `cost-state` (cost, duration and lines
changed; only written in some sessions).

## What is left out

- Transcripts without an assistant reply (Claude Code opened and closed, or only a slash
  command run). 4 of the 25 files seen were like this.
- Subagent transcripts (never read).

## Performance

A transcript has to be read in full to find the last title and timestamp. 25 transcripts,
52 MB in total: 0.38 s for `--all`, 0.12 s for one folder.

# Cursor — session store (observed)

Observed 2026-10-19 on Windows 11, Cursor agent CLI 2026.10.01, by reading the local files.
This is the terminal agent (`agent`, installed in `%LOCALAPPDATA%\cursor-agent`), not the
Cursor editor, whose chats are stored elsewhere. `agent ls` and `agent --resume` without an id
are interactive pickers, so `agentsctl sessions` reads the chat folders.

## Layout

```
~/.cursor/chats/<md5 of folder>/<chat id>/meta.json   title, folder, times, flags (JSON)
~/.cursor/chats/<md5 of folder>/<chat id>/store.db    the conversation (SQLite; never opened)
```

- `<md5 of folder>` is the lowercase hex md5 of the folder path as the agent got it
  (`C:\work\app` → `8cbd8a21...`). It matched for all 15 chats with
  a `cwd`. The hash is case-sensitive, so the folder is compared from `cwd`, not from the hash.
- Resume: `agent --resume <chat id>`, run from the chat's folder.
- `store.db` holds the conversation and, in its `meta` table, the chat name, last model and an
  encryption key for the conversation blobs. agentsctl does not open it: `meta.json` has
  everything listed.

## meta.json

| Field | Meaning |
|---|---|
| `title` | chat title (generated, e.g. "Bug Report Analysis") |
| `cwd` | folder; **missing in chats from older agent versions** |
| `createdAtMs`, `updatedAtMs` | started and last used, epoch milliseconds |
| `hasConversation` | `false` = the agent was opened and closed without a message (no store.db either); left out |
| `isSubagent` | `true` = a subagent's chat; left out |
| `schemaVersion` | `1` |

### Chats without cwd

All chats in one `<md5 of folder>` directory share the folder, so a chat without `cwd` takes it
from a sibling that has one. When no chat in the directory has a `cwd`, the folder is only known
when listing one folder and its md5 matches the directory name (the path as given, without a
trailing separator, with either drive letter case). Such chats are left out of `--all`.

## What is left out

Of 20 chats seen: 8 without a conversation, 1 subagent, and 3 old chats whose folder is unknown
(no `cwd` in any chat of their directory, and the hash matches no folder on disk: probably
deleted folders). 8 are listed.

## Performance

One small JSON file per chat: instant.

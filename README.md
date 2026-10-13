# agentsctl

A small CLI for working with your AI coding agents (Codex, Claude, GitHub Copilot and
Cursor). It is built from subcommands; a subcommand is always required, and
`agentsctl` on its own prints the list.

| Command | What it does |
|---|---|
| `agentsctl usage` | Shows how much of your subscription usage limits you have used, for all four tools in one report. |
| `agentsctl sessions` | Lists the saved sessions for the current folder, newest last, with the command to resume each. |
| `agentsctl resume <id>` | Resumes a saved session by its id: runs the agent's resume command in the session's folder. |

## Install and build

Requires Node.js 20 or later (developed on Node 24, Windows 11).

```sh
npm install
npm run build        # compiles to dist/
npm start -- usage   # same as: node dist/agentsctl.js usage
```

Inside the project you can also run `npx agentsctl usage`.

### Global command (`npm link`)

To run `agentsctl` from any terminal, link the project globally:

```sh
npm run build
npm link
agentsctl usage --json      # now available everywhere
```

On Windows, npm creates `agentsctl.cmd` / `agentsctl.ps1` shims in the global npm directory
(e.g. `C:\Program Files\nodejs\`) that point back to this project's `dist/agentsctl.js`.
Because it is a link, not a copy, code changes only need `npm run build` — no re-link.

To remove the global command:

```sh
npm unlink -g agentsctl
```

If you prefer a standalone copy that does not follow the working tree, use
`npm install -g .` instead (re-run it after each change).

For development without building: `npm run dev -- usage --json`. Tests: `npm test`.

## `agentsctl sessions`

Reads each agent's local session store (read-only) and lists the sessions started in exactly the
current folder (not its subfolders), merged across agents and sorted by last use: oldest first, so the newest is the last one,
next to your prompt, and a long list needs no scrolling back. Each entry
shows the agent, the title, when it was last used and the client the session ran in (`CLI`,
`VS Code`, `Visual Studio`, `Desktop App`, or `Unknown` when the store does not say).
Copy the second line of an entry to resume that session, or pass its id to
[`agentsctl resume`](#agentsctl-resume):

```
Sessions in C:\dev\my-app

Cursor    Refactor Settings Page           9 days ago       CLI
          agent --resume 6c9e2b4f-1a3d-4e5f-8b7a-9d0c1e2f3a4b

Codex     Explain the build pipeline       2 days ago       CLI
          codex resume 01a1f2c3-4d5e-7f60-8a9b-0c1d2e3f4a5b

Copilot   Fix Flaky Login Test             3 hours ago      Desktop App
          copilot --resume b81d4e2a-5c3f-4a9b-8e7d-1f0a2c6b9d4e

Claude    Add retry to the upload client   12 minutes ago   CLI
          claude --resume 3f2a9c1e-7b4d-4e8a-9f0c-2d6b1a5e8c7f
```

With `--all`, sessions from every folder are listed, and the resume line changes to the
session's folder first (for PowerShell and POSIX shells; cmd.exe does not accept `;`):

```
Sessions in all folders

23 older sessions not shown (use --limit to show more)

Codex    Write release notes              5 hours ago      Desktop App
         cd "C:\dev\docs-site"; codex resume 01a1f2c3-4d5e-7f60-8a9b-0c1d2e3f4a5b

Claude   Add retry to the upload client   12 minutes ago   CLI
         cd "C:\dev\my-app"; claude --resume 3f2a9c1e-7b4d-4e8a-9f0c-2d6b1a5e8c7f
```

To find a session, search for words from its title, its folder or its branch: every word has to
match, in any of them, and quotes are optional. `agentsctl sessions -s upload retry` lists the
Claude session above, and `-s docs desktop` the Codex one. Only what the list shows is searched,
not the conversations.

```
agentsctl sessions [--all] [-s | --search <text>] [--provider <names>] [--limit <n>] [--pager] [--json] [--no-color] [-h | --help]
```

| Option | What it does |
|---|---|
| `--all` | Sessions from every folder. Shows the 10 newest unless `--limit` or `--pager` is given. |
| `-s`, `--search <text>` | Sessions from every folder that contain every word of `<text>`, case-insensitive, in the title, folder, id, agent, client, branch or model. Limited to 10 like `--all`. |
| `--provider <names>` | Only these agents, same format as for `usage`: `codex`, `claude`, `copilot`, `cursor`. |
| `--limit <n>` | At most `n` sessions in total (not per agent). |
| `--pager` | Show the list in a pager, like `git log` (see [Pager](#pager)). |
| `--json` | `{ sessions, errors }`. Each session has `provider`, `id`, `title` (or `null`), `cwd`, `startedAt` (or `null`), `lastUsedAt`, `resumeCommand`, `client` (`"cli"`, `"vscode"`, `"visual-studio"`, `"desktop"` or `null`) and, when known, `branch` and `model`; each error has `provider` and `error`. Sessions are newest first here. |
| `--no-color` | Plain text without colors or icons; the same rules as for `usage` apply (see [Colors and icons](#colors-and-icons)). |

An agent that is not installed is skipped. One whose store cannot be read shows
`could not read: <reason>` and does not hide the others. Exit codes: 0 = listed (also when there
are no sessions), 1 = no agent could be read, 2 = usage error.

### Where sessions are read from

| Agent | Store | Left out |
|---|---|---|
| Codex | `~/.codex/state_<N>.sqlite`, table `threads` | archived threads, subagents, threads without a prompt |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects/<folder>/<id>.jsonl`, default `~/.claude/projects` | subagent transcripts, sessions without a reply |
| Copilot | `~/.copilot/session-state/<id>/workspace.yaml` and `events.jsonl`; the desktop app's list in `~/.copilot/data.db` | sessions of Windows Terminal's agent, sessions without a message, sessions archived in the desktop app |
| Copilot in Visual Studio | `<solution folder>\.vs\<solution>\copilot-chat\<hash>\sessions\<id>`, for the solutions in Visual Studio's recent list | chats without a prompt, solutions that are no longer in the recent list |
| Cursor agent CLI | `~/.cursor/chats/<md5 of folder>/<id>/meta.json` | subagent chats, chats without a conversation |

The Codex and Copilot desktop apps and Claude Code's VS Code extension keep their sessions in the
same stores as the CLIs, so they are listed too. How the client is known:

| Agent | Client from | Seen values |
|---|---|---|
| Codex | `originator` column, else `source` | CLI, Desktop App; Unknown for older threads from the VS Code extension or the desktop app, which have no originator |
| Claude Code | `entrypoint` in the transcript | CLI (also IDE plugins that run the CLI), VS Code, Desktop App; Unknown for SDK sessions |
| Copilot | `client_name` in workspace.yaml and the desktop app's list; the chat files of Visual Studio | CLI, Desktop App, Visual Studio |
| Cursor | only the terminal agent is read | CLI |

**Copilot in Visual Studio** keeps each chat in the solution's `.vs` folder, so its chats belong to
the solution's folder. A solution often sits in a subfolder such as `src`, so its chats are also
listed when you run `agentsctl sessions` in a folder above it, up to the root of the same git
repository. Visual Studio cannot open a chat from the command line: the resume line opens the
solution (`start "<solution>.sln"`), and you then pick the chat from Copilot Chat's history.
`--provider copilot` includes these chats. VS Code's Copilot Chat keeps its chats inside VS Code,
and chats in the Cursor editor are stored elsewhere; neither is listed.

The title is the session's name or generated title, else its first prompt, else `(untitled)`.
Details of each store are in `docs/providers/*-sessions.md`.

### Pager

With `--pager` and output to a terminal, the list is shown in a pager. Piped output is never
paged. The pager is `$AGENTSCTL_PAGER`, else `$PAGER`, else `less`, and on Windows also the
`less` that comes with Git for Windows. Setting either variable to `cat` or an empty value turns
paging off. If no pager can be started, the list is printed with a warning.

Like git, agentsctl gives `less` the setting `LESS=FRX` unless `LESS` is set: it quits right away
when the list fits on one screen, keeps colors, and leaves the list on screen. It also sets
`LESSUTFCHARDEF` (unless set) so that the Nerd Font icons are shown instead of `<U+EC82>`.

## `agentsctl resume`

A shortcut for the resume line: give it a session id from `agentsctl sessions` and it runs the
agent's own resume command in the session's folder, from any folder.

```
agentsctl resume <id> [--dry-run] [-h | --help]
```

```
> agentsctl resume 3f2a
Resuming Claude session "Add retry to the upload client" in C:\dev\my-app
> cd "C:\dev\my-app"; claude --resume 3f2a9c1e-7b4d-4e8a-9f0c-2d6b1a5e8c7f
```

- The start of an id is enough when only one session matches (case-insensitive). When several
  match, they are listed, newest last, and nothing runs.
- Every agent and every folder is searched, not just the current folder.
- The agent runs in this terminal with the session's folder as its working folder. Your shell's
  own folder does not change: a program cannot change the folder of the shell that started it.
- `--dry-run` prints the `cd` and resume line instead of running it.
- For Copilot Chat in Visual Studio, this opens the solution in Visual Studio (see above).
- The exit code is the agent's; 1 when no session has that id or its folder no longer exists,
  2 for usage errors and ids that match more than one session.

## `agentsctl usage`

It reuses the login each tool has already stored on your machine, calls the same usage endpoint
the tool itself uses, and prints percent used (the bar fills up as you use more) plus when each
limit window resets, both as time remaining and as a clock time. Windows use the same names
across tools: `Session (5h)`, `Weekly`, `Monthly`, with a qualifier in parentheses where needed.

```
AI Usage Limits — 2026-10-09 11:19

Codex
   Session (5h)     │░░░░░░░░░░░░░░░░░░░    0.0% used   resets in 5 hours                9 Oct 16:19
   Weekly           ░░│░░░░░░░░░░░░░░░░░    2.0% used   resets in 5 days and 23 hours   15 Oct 10:55

Claude
   Session (5h)     ████░░░░░░░░░░░░░│░░   18.0% used   resets in 30 minutes             9 Oct 11:50
   Weekly           ████░░░░░░░░░│░░░░░░   20.0% used   resets in 2 days and 7 hours    11 Oct 19:00

Copilot
   Monthly (Team)   ████░│░░░░░░░░░░░░░░   19.4% used   resets in 22 days and 14 hours   1 Nov 01:00   (3,686/19,000 AIC, you 3,575 AIC - 97%)

Cursor
   Cursor Models    ░░░░░░░░░░░░░░░░░░│░    2.1% used   resets in 2 days and 4 hours    11 Oct 15:29   ($5.91 spent in total)
   Other Models     █░░░░░░░░░░░░░░░░░│░    3.6% used   resets in 2 days and 4 hours    11 Oct 15:29
```

In a narrow terminal the report switches to a stacked layout (`--layout compact`):

```
AI Usage Limits — 2026-10-09 11:19

Codex

   Session (5h)
   │░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    0.0% used
   Resets in 5 hours · 9 Oct 16:19

   Weekly
   █░░░░░│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    2.0% used
   Resets in 5 days and 23 hours · 15 Oct 10:55

Claude

   Session (5h)
   ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│░░░░   18.0% used
   Resets in 30 minutes · 9 Oct 11:50

   Weekly
   █████████░░░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░   20.0% used
   Resets in 2 days and 7 hours · 11 Oct 19:00
```

### Options

```
agentsctl usage [--json] [--provider <names>] [--no-refresh] [--no-color] [--layout <mode>] [-h | --help]
```

| Command | What it does |
|---|---|
| `agentsctl usage` | Full report for all providers. |
| `agentsctl usage --json` | Machine-readable output: a JSON array of `{ provider, ok, windows }` or `{ provider, ok: false, error }`. Each window has `label`, `percentUsed` (0–100), `resetsAt` (ISO 8601 string or `null`) and an optional `extra`. |
| `agentsctl usage --provider codex,claude` | Only the listed providers, separated by commas or spaces (so an unquoted `codex,claude` also works in PowerShell). Names are case-insensitive. Known names: `codex`, `claude`, `copilot`, `cursor`. |
| `agentsctl usage --no-refresh` | Strictly read-only: never refresh an expired token and never write to any credential file (see [Token refresh](#token-refresh-and-write-back)). |
| `agentsctl usage --no-color` | Plain text without colors or icons (see [Colors and icons](#colors-and-icons)). |
| `agentsctl usage --layout <mode>` | `auto` (default): the wide one-line-per-window layout if it fits the terminal, otherwise the stacked `compact` layout. `wide` / `compact` force a layout. Piped output is always wide unless `--layout compact` is given. |
| `agentsctl usage --help` | Prints help. |

Flags can be combined, for example `agentsctl usage --json --provider cursor`.

Providers run in parallel. If one fails, the report shows `could not read: <reason>`
for that provider and still shows the others. The text report uses your local time zone.

### Pace marker

Each bar has a marker (`│`) at the point where you would be if you used the limit evenly over
the window: the share of the window that has passed. Fill that stops short of the marker means
you are under pace; fill that runs past it means you are ahead. It is a linear estimate, so a
weekly window looks "ahead" on a Friday even if you never work weekends.

The color also follows the forecast: agentsctl projects the usage at reset (`used / elapsed`) and
turns the bar yellow when that reaches 85 % and red when it reaches 100 %, even if current usage
is still low. The forecast is ignored during the first 10 % of a window, where it is mostly noise.
`--json` includes `startsAt` for each window so scripts can do the same math.

### Colors and icons

In a terminal the report is colored: each provider name gets its own color and a
[Nerd Font](https://www.nerdfonts.com/) glyph (Nerd Fonts 3.5 or later for the Codex and Claude
icons). Cursor has no logo in Nerd Fonts, so it uses the Codicons pointer glyph `cod-cursor`.
Bars and percentages are colored by usage level (green below 75 %, yellow from 75 %, red from 90 %)
or by the forecast at reset, whichever is more severe (see [Pace marker](#pace-marker)).
Glyphs need a Nerd Font in your terminal.

Output is plain text (no colors, no glyphs) when stdout is not a terminal, with `--no-color`,
or when `NO_COLOR` is set. `FORCE_COLOR=1` forces colors, e.g. through a pipe. `--json` is never
colored. Colors and glyphs are constants in `src/theme.ts`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | At least one selected provider returned data |
| 1 | All selected providers failed |
| 2 | Usage error (unknown command, unknown flag, unknown provider name, empty `--provider`) |

## Provider status

| Provider | Status | Windows reported |
|---|---|---|
| Codex | Verified live | Session (5h), Weekly |
| Claude | Verified live | Session (5h), Weekly, and model-specific `Weekly (<model>)` limits when present |
| Cursor | Verified live | Cursor Models and Other Models: the same two meters as Cursor's usage page, plus dollars spent in total |
| Copilot | Verified live (Business, token-based billing) | Monthly (Team): the organization's pool of included AI credits (needs org admin/billing access), with your own usage. Falls back to your usage without a limit, or per-user premium requests on request-based plans. See [Copilot team credits](#copilot-team-credits). |

The endpoints are undocumented and may change without notice. Details of each verified
contract are in `docs/providers/*-usage.md`.

## Copilot team credits

On Copilot Business/Enterprise with token-based billing, users have no personal cap; the limit
is the organization's pool of included AI credits, which resets on the 1st of the month (UTC).

- **Used:** Copilot `ai-units` in `GET /organizations/{org}/settings/billing/usage/summary`
  (this month). Requires org admin or billing manager access.
- **Pool:** Copilot seats (`GET /orgs/{org}/copilot/billing`) × 1,900 credits per seat. The
  1,900 figure is derived from the org billing page (included credits divided by Business seats); the
  API does not expose the pool size.
- **You:** `quota_snapshots.premium_interactions.credits_used` from `/copilot_internal/user`.

| Environment variable | Effect |
|---|---|
| `AGENTSCTL_COPILOT_TEAM_CREDITS` | Use this pool size instead of seats × per-seat credits |
| `AGENTSCTL_COPILOT_CREDITS_PER_SEAT` | Credits per seat (default `1900`) |
| `AGENTSCTL_COPILOT_ORG` | Organization to read (default: the first org on your Copilot account that answers) |

Without org billing access the report shows `Monthly (You)` with your usage and no bar.

## Where tokens are read from

| Provider | Source |
|---|---|
| Codex | `~/.codex/auth.json` (`tokens.access_token`, `tokens.account_id`) |
| Claude | `$CLAUDE_CONFIG_DIR/.credentials.json`, default `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) |
| Cursor | `%APPDATA%\Cursor\User\globalStorage\state.vscdb`, SQLite keys `cursorAuth/accessToken` / `cursorAuth/refreshToken` |
| Copilot | Login name from `~/.copilot/config.json`, token from Windows Credential Manager entry `copilot-cli/https://github.com:<login>` (read-only `CredReadW`); falls back to `gh auth token` |

## Token refresh and write-back

For Codex, Claude and Cursor, agentsctl refreshes an OAuth token **only when it has to**:

- the stored access token is already expired (or expires within 60 seconds), or
- the usage endpoint answers `401`.

It then does one refresh with the tool's own refresh token and client id, and retries the usage
call once. It never refreshes a token that still works. Copilot is never refreshed.

| Provider | Refresh request |
|---|---|
| Codex | `POST https://auth.openai.com/oauth/token` |
| Claude | `POST https://platform.claude.com/v1/oauth/token` |
| Cursor | `POST https://api2.cursor.sh/oauth/token` |

**agentsctl writes the new tokens back** to the tool's credential store. Refresh tokens can
rotate, and if the new ones were thrown away, the real CLI or app would be logged out. The
write is careful:

- The file is read again right before the write. agentsctl only writes if the stored refresh
  token is still the one it used (compare-and-swap). If the tool refreshed at the same moment,
  agentsctl discards its own result and uses the tool's new access token instead.
- Only the token fields change: Codex `tokens.access_token`, `tokens.id_token` and
  `tokens.refresh_token` (when returned) plus `last_refresh`; Claude `claudeAiOauth.accessToken`,
  `refreshToken` (when returned), `expiresAt` and `refreshTokenExpiresAt`. All other keys, their
  order and the file's formatting style (compact or indented, line endings) are kept.
- JSON files are written to a temp file in the same folder and then renamed over the original,
  so the file is never half-written. No backup copies (which would contain tokens) are created.
- Cursor: one short SQLite transaction `UPDATE`s `cursorAuth/accessToken` and
  `cursorAuth/refreshToken`, with the same compare-and-swap. If the database is locked (Cursor
  is writing), nothing is written and the new token is only used for this run.

If the refresh fails, the provider shows
``token expired and refresh failed (<status>) — run `codex` once`` (or `claude`, or "sign in to
Cursor again").

Use `--no-refresh` if you want agentsctl to be strictly read-only. An expired token then gives
``token expired — run `<tool>` once to refresh the login``.

## Privacy

agentsctl never logs or prints tokens. It sends GET requests to the usage endpoints (Cursor's
usage endpoint needs a POST with an empty body), plus the refresh POSTs described above when a
token has expired. Apart from the token write-back, it never changes the tools' files.

`agentsctl sessions` makes no network requests and opens the session stores read-only. For Claude
and Copilot it reads whole transcripts to find the title and last-used time, but it only
outputs what the list shows: title, folder, times, branch and model. Of a Visual Studio chat
file it decodes only the header and the first prompt; it also reads Visual Studio's list of
recent solutions from `ApplicationPrivateSettings.xml`.

## Disclaimer

agentsctl is an unofficial tool. It is not affiliated with, endorsed by or supported by
Anthropic, OpenAI, GitHub, Microsoft or Anysphere (Cursor). It reads the credentials and
session files that the tools store locally and calls undocumented internal endpoints, which
can change or stop working at any time. Use it at your own risk.

## License

[MIT](LICENSE)

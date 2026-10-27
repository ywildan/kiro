# Kiro

Kiro is a small coding agent for the terminal. It streams replies from any OpenAI-compatible endpoint into an Ink TUI, reads and edits files, runs shell commands, and asks before it changes anything.

OpenAI, OpenRouter, Ollama, LM Studio, vLLM, and other servers that implement `POST {baseUrl}/chat/completions` with SSE streaming and tool calls all work. `kiro model` discovers the endpoint's models, tests the connection, and keeps keys out of the config file.

## Requirements

- Node.js 20 or newer.
- An OpenAI-compatible endpoint, plus an API key if the server needs one.
- pnpm when building from source. npm works too, but the lockfile and scripts use pnpm.

## Install

```bash
npm install -g @ywldan/kiro
```

Then run `kiro` from a project directory.

From source:

```bash
pnpm install
pnpm build
pnpm add -g .          # pnpm 11+
# pnpm link --global   # pnpm 9/10
```

If `kiro` is missing after a global install, pnpm's bin directory is not on `PATH`. Run `pnpm setup` once, add `~/.local/share/pnpm/bin` to `PATH`, or call the binary by its full path.

You can also run it without installing:

```bash
node dist/index.js
pnpm dev
```

## Quick start

```bash
cd ~/src/my-project
kiro model    # add a model, pick a provider, paste the key
kiro          # start the session
```

The wizard saves the key to `~/.kiro/.env` (mode `0600`), fetches the model list, sends a test completion, and can activate the new profile right away. `~/.kiro/config.json` is created on first use and never stores the key.

The wizard runs on the alternate screen and redraws one step at a time, with a breadcrumb of the answers so far. Long menus scroll with `↑`/`↓`, `PgUp`/`PgDn`, `Home`, and `End`, and a dim counter shows how many entries are hidden. `Esc` clears the breadcrumb; quitting restores the screen and prints the saved result. Piped output falls back to plain prompts.

To skip the wizard:

```bash
export OPENROUTER_API_KEY="sk-or-..."
kiro model add --name openrouter --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4 --api-key-env OPENROUTER_API_KEY --set-active
```

Set `KIRO_CONFIG_PATH` to use a different config file.

## Managing models

Kiro keeps named connection profiles. `kiro model` opens a menu with select, add, edit, remove, and quit.

### Adding a model

1. Pick a preset or a custom endpoint.
2. Confirm the base URL and the environment variable for the key, then paste the key. Local presets skip these steps.
3. Kiro calls `GET {baseUrl}/models`. Pick a number, type part of an id to filter, or enter `0` to type the id yourself. If discovery fails, Kiro explains why and asks for the id.
4. Accept the suggested profile name or type your own. Names use letters, digits, `-`, and `_`, and must be unique.
5. Optionally set `temperature`, `maxTokens`, and `contextWindow` (defaults `0.2`, `4096`, `128000`).
6. Kiro sends a small test completion ("Reply with OK") and reports the latency or the exact error. On failure you can retry, edit the connection, save anyway, or cancel.
7. Confirm whether the new profile should become active.

`Esc` or `Ctrl+C` cancels a step and leaves `config.json` and `.env` untouched.

### Presets

| Provider | Base URL | Key variable |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| Together | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` |
| Ollama (local) | `http://localhost:11434/v1` | none |
| LM Studio (local) | `http://localhost:1234/v1` | none |
| Custom endpoint | you enter it | optional |

Presets only fill in the base URL and a suggested variable name. Every field stays editable.

### Scripted commands

```bash
kiro model                                  # wizard: select / add / edit / remove
kiro model list                             # configured profiles, active marked
kiro model use <name>                       # make a profile active
kiro model remove <name>                    # delete a profile (refuses the last one)
kiro model test [name]                      # small chat completion, reports latency or error

kiro model add --name <name> --base-url <url> --model <id> \
  [--api-key-env <VAR>] [--api-key <key>] \
  [--temperature <0-2>] [--max-tokens <n>] [--set-active] [--no-test]
```

`--flag=value` also works. `add` validates the URL, name, model, and numbers before saving, and a failed connection test saves nothing (use `--no-test` to skip it). Success exits `0`; validation, network, and test failures exit non-zero with a message on stderr.

Keys for `kiro model add`:

- `--api-key <key>` writes the key to `~/.kiro/.env` under `--api-key-env`, or under a generated `KIRO_<PROFILE>_API_KEY`.
- `--api-key-env <VAR>` stores nothing; the variable must already exist in the environment or in `~/.kiro/.env`.
- With neither flag, the profile has no key, which is fine for local servers.

### Updates

```bash
kiro check     # installed version vs npm
kiro update    # npm install -g @ywldan/kiro@latest
```

`check` exits `0` when current, `1` when an update exists, and `2` when the registry cannot be reached. `update` prints npm's output and needs the permissions of a global install.

### Where keys live

`config.json` stores only `apiKeyEnv`, the name of a variable. Values live in the environment or in `~/.kiro/.env`:

```
# ~/.kiro/.env
OPENROUTER_API_KEY=sk-or-...
```

- The file is created on demand with mode `0600`; the directory uses `0700` where the platform supports it.
- Kiro loads `~/.kiro/.env` at startup, and real environment variables win.
- Updating a key rewrites only that line. Removing a profile leaves its secret in `.env` so other profiles can reuse it.
- Keys are not written to `config.json`, sessions, logs, or the TUI. Kiro shows `set via $VAR`, `missing ($VAR)`, or a mask such as `sk-…abcd`.
- Values from `.env` and every profile's `apiKeyEnv` are removed from `run_command`'s environment and redacted from tool output, so `env` or `cat ~/.kiro/.env` cannot copy a key into the transcript or a saved session.

Set `KIRO_ENV_PATH` to use a different `.env` file.

## Configuration

`~/.kiro/config.json`:

```json
{
  "activeProfile": "openai",
  "profiles": {
    "openai": {
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-4.1",
      "temperature": 0.2,
      "maxTokens": 4096,
      "contextWindow": 128000
    },
    "local": {
      "type": "openai",
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen2.5-coder:14b",
      "temperature": 0.2
    }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Provider type. Only `openai` is implemented. |
| `baseUrl` | yes | API base URL including the version segment, e.g. `https://api.openai.com/v1`. Kiro appends `/chat/completions`. |
| `apiKeyEnv` | no | Name of the environment variable holding the API key. Omit for local servers that need no auth. |
| `model` | yes | Model name sent to the endpoint. |
| `models` | no | Model ids the `/model` picker offers for this profile. Filled by discovery; the model in use is always included. |
| `temperature` | no | Sampling temperature. |
| `maxTokens` | no | Maximum response tokens. |
| `contextWindow` | no | Approximate context window in tokens, at least 1000. Defaults to `128000`; drives the ctx meter and compaction. |

`activeProfile` selects the profile used at startup. `/model <name>` switches at runtime and `--profile` switches for one run.

### Example endpoints

**OpenRouter** (key from `~/.kiro/.env` or the environment)

```bash
export OPENROUTER_API_KEY="sk-or-..."
kiro model add --name openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4 \
  --api-key-env OPENROUTER_API_KEY --set-active
```

**Ollama** (no key; discovery normally works, but you can enter a manually pulled tag)

```bash
kiro model add --name ollama \
  --base-url http://localhost:11434/v1 \
  --model qwen2.5-coder:14b --set-active
```

**LM Studio, vLLM, or another local server**

```bash
kiro model add --name local \
  --base-url http://localhost:1234/v1 \
  --model local-model --set-active

# A server without GET /models: name the model directly.
kiro model add --name vllm \
  --base-url http://gpu-box:8000/v1 \
  --model my-model --no-test
```

The JSON form above still works if you prefer editing by hand. `kiro model` then **Edit a model** can update fields and re-test.

## CLI options

```
kiro [options]

  --profile <name>   Use a profile from ~/.kiro/config.json
  --base-url <url>   Override the active profile's base URL
  --model <name>     Override the active profile's model
  -c, --continue     Resume the most recent session for this directory
  --resume <id>      Resume a specific saved session
  -p, --prompt <text>
                     Run one turn without a TUI ("-" or no text reads the
                     prompt from stdin); replies stream to stdout
  --yolo             Skip all approval prompts (use with care)
  --mouse            Mouse reporting (on by default): wheel scrolls the transcript
  --no-mouse         Disable mouse reporting so plain click-drag selection works
  --no-alt-screen    Do not switch to the terminal's alternate screen
  --no-skills        Do not read skill folders at all (KIRO_NO_SKILLS=1 does the same)
  -h, --help         Show help
  -v, --version      Show version

  kiro check         Compare the installed version with the latest on npm
  kiro update        Install the latest version from npm globally
```

`--flag=value` works too. CLI overrides last for the current process only.

## Headless mode

`kiro -p "…"` runs one turn without Ink, for scripts, cron jobs, and CI:

```bash
kiro -p "explain what this repo does"                  # read-only answers work immediately
kiro -p "add the missing tests" --yolo                 # let it write and run commands
git diff | kiro -p "review this patch"                 # pipe the prompt
kiro -p "continue" --continue                          # continue this directory's session
echo "summarize README.md" | kiro -p - > summary.md    # "-" reads stdin
```

Assistant text goes to stdout; tool calls, reasoning, compaction notices, and errors go to stderr, so `kiro -p … > out.md` stays clean. The turn uses the same provider, tools, system prompt, compaction, and session store as the TUI.

Approvals are denied unless you pass `--yolo`, so a piped run cannot write or execute anything unsupervised. Leave `--yolo` off when read-only tools are enough.

Exit codes: `0` success, `1` model/tool/session error, `2` usage error, `130` cancelled with Ctrl+C. Headless runs do not record prompt history. `KIRO_STREAM_IDLE_MS` changes the stall timeout (default 120000 ms; `0` disables it).

## Using the TUI

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt, or run the highlighted `/` command |
| `Ctrl+C` | Press twice to exit; while a turn runs, the first press cancels it |
| `PgUp` / `PgDn` | Scroll the history (the wheel works too, unless you pass `--no-mouse`) |
| `Ctrl+O` | Expand or collapse the full output of the most recent tool call |
| `↑` / `↓` | Move through the `/` command menu; with an empty input, recall prompt history |
| `Tab` | Complete the highlighted `/` command |
| `Esc` | Clear the input, close the command menu, cancel a model wizard step, or deny a pending approval |
| `Ctrl+A` / `Ctrl+E` | Move to start / end of input |
| `Backspace` / `Delete` | Delete before / after the cursor |
| `Ctrl+U` / `Ctrl+K` | Delete before / after the cursor |
| `Ctrl+W` | Delete the previous word |
| Left / Right / Home / End | Move the cursor |

The status bar shows the profile, model, working directory, context meter (`ctx 42k/128k`), queued message count, and state (`ready`, `thinking…`, `replying…`, `running <tool>…`, `approval needed`, `cancelling…`, `Ctrl+C again to quit`). Long profile names are shortened in the middle. On wide terminals the context meter moves into the Usage card.

You can type while the agent works. The prompt is queued, shown in the transcript, and runs when the current turn ends; the status bar shows `N queued`. Ctrl+C clears the queue with the running turn, and slash commands queue the same way.

Ctrl+C while idle waits two seconds for a second press before exiting. `/exit` quits immediately. During a turn, the first press cancels it.

Prompt history is stored per directory in `~/.kiro/history/` (mode `0600`, 200 entries). `↑` recalls with an empty input, `↓` moves forward, and editing leaves history mode. Keys are redacted before a prompt is written. Set `KIRO_HISTORY_DIR` to change the location.

Reasoning traces stream as a dim block and collapse to `reasoning (done, not saved)` when the answer starts. They are not written to sessions or `/export`.

Each finished reply shows its duration and, when the endpoint reports usage, output throughput (`8.4s · 23 tok/s`). Both are display-only and are not stored in sessions.

On terminals at least 110 columns wide with room for 9 transcript rows, a Usage card sits to the right of the conversation. It shows session token totals (`↑` sent, `↓` received), API requests, a context gauge, and the last reply's timing. Totals come from endpoint usage, accumulate across tool rounds, and survive `/resume`; compaction requests are not counted. A `~` marks an estimated context number. Below 110 columns the card hides and `ctx` returns to the status bar. `/usage` toggles it, and `/context` prints the totals at any width.

Replies render as Markdown: headings, emphasis, inline code, lists, task checkboxes, blockquotes, links, code blocks, and tables. Table columns size to their content, honour alignment markers, and wrap; a table too wide to read falls back to plain rows. Unknown markers stay literal, so streaming never breaks the layout.

Typing `/` opens the command palette over the bottom rows of the transcript, so the conversation does not move. It filters as you type; `↑`/`↓` select, `Enter` runs, `Tab` completes, and `Esc` clears.

`/model` opens a centered picker over the transcript. The list uses the full height and reports hidden entries (`↑ 5 more · 6-15 of 30 · ↓ 15 more`). On terminals narrower than 60 columns or shorter than 18 rows it falls back to an inline panel.

On a TTY, Kiro uses the alternate screen. When it exits, through `/exit`, a double Ctrl+C, or an error, the shell contents come back. Pipes and CI logs are untouched. `--no-alt-screen` stays on the normal screen.

Mouse reporting is on by default, so the wheel scrolls the transcript. Hold Shift while dragging to select text, or run `/mouse` (or start with `--no-mouse`) to restore plain click-drag selection and scroll with `PgUp`/`PgDn`.

Tool results are one-line summaries. `Ctrl+O` expands the latest result inline; `PgUp`/`PgDn` scroll it. `/export` writes the whole conversation, including full tool arguments and results, to a Markdown file.

### Slash commands

| Command | Action |
| --- | --- |
| `/help` | Show commands and keys |
| `/model` | Open the centered model picker: profile first, then searchable stored models |
| `/model <name>` | Switch profile without restarting |
| `/model add` | Guided setup; prompts appear in the input box and the key is masked |
| `/model edit [name]` | Edit fields, replace the key, re-test, and save |
| `/model remove [name]` | Remove a profile after confirmation (refuses the last one) |
| `/model test [name]` | Test the active or named profile; prints latency or the exact error |
| `/model list --remote` | List models offered by the active endpoint's `GET /models` |
| `/context` | Show approximate context use by message role plus session token totals |
| `/usage` | Show or hide the Usage card, giving the transcript the full width |
| `/skills` | List installed skills, their source, and any skipped entries |
| `/skill <name> [request]` | Load a skill, optionally with your request in the same line |
| `/<skill name> [request]` | Call an installed skill directly, e.g. `/anti-slop rewrite this paragraph` |
| `/compact` | Summarize older turns now, keeping the last four user turns verbatim |
| `/sessions` | List saved sessions for this working directory |
| `/resume <n\|id>` | Resume a session by list number or id (prefixes work) |
| `/undo` | Revert the most recent write, edit, or patch (repeat to step further back) |
| `/clear` | Start a new session, keeping the old one on disk |
| `/export [file]` | Write the transcript (with full tool output) to a Markdown file |
| `/mouse` | Toggle mouse reporting: wheel scroll vs normal text selection |
| `/allow` | List tools that skip approval for this session |
| `/allow clear` | Ask for approval again for every tool |
| `/exit` | Quit |

`/model` has two steps. The first lists profiles grouped by endpoint, with the active one marked `*`; `Enter` opens the models. The second lists stored model ids with the current one marked `*`; `Enter` applies it and saves the choice. On the model step, type to filter (all space-separated terms must match), `Esc` clears the query and then goes back, and `Ctrl+R` refetches `GET /models`. `Ctrl+C` closes the picker.

## Sessions

Kiro saves each conversation under `~/.kiro/sessions/`, in a directory named from a hash of the working directory:

```
~/.kiro/sessions/<cwd-hash>/<session-id>.json
```

Sessions store user, assistant, and tool messages, the title, timestamps, and the profile and model in use. System prompts are rebuilt for the current directory every turn, so they are not stored. Writes are atomic, the directory uses `0700`, and files use `0600`.

Saving happens after each user message and again when a turn ends, so a crash loses at most the in-flight response. Ctrl+C and `/exit` wait for the save. Set `KIRO_SESSIONS_DIR` to store sessions elsewhere.

Resume with:

```bash
kiro --continue          # most recent session for this directory
kiro --resume <id>       # a specific session
```

`/sessions` and `/resume <n|id>` do the same from inside the TUI. `/clear` starts a new session without deleting the old one. Kiro does not auto-resume; without a flag it starts fresh.

Session files are plaintext and contain prompts, code from tools, and command output. They never contain API keys, but treat them like shell history.

## Context and compaction

Kiro tracks how much of the context window the conversation uses. The OpenAI provider requests `stream_options: { include_usage: true }` and uses the endpoint's numbers when they arrive. Servers that ignore the option still work through a rough estimate of four characters per token. The status bar shows `ctx <used>/<window>` (or the Usage card on wide terminals), and `/context` breaks the total down by role and prints cumulative totals.

Each profile may set `contextWindow` (default `128000`). At about 80% of the window, Kiro compacts before the next request:

- the system prompt stays;
- the last four user turns stay verbatim, with their assistant and tool messages;
- older turns become a summary of the goal, files touched, decisions, current state, and open TODOs;
- very large old tool results become short placeholders first, so the summarizer is not flooded;
- the cut always falls on a user-message boundary, so a tool-call round is never split.

Compaction shows a notice and is written to the session, so a resumed conversation continues from the compacted history. `/compact` runs the same pass on demand. If the summary fails, the turn continues with the uncompacted context and an error notice. Counts are approximate and corrected when the endpoint reports usage.

## Tools and safety

| Tool | What it does | Approval |
| --- | --- | --- |
| `read_file(path, offset?, limit?)` | Reads a file with numbered lines and truncation notes | never |
| `list_dir(path)` | Lists one directory, with `/` after directories | never |
| `glob(pattern, path?)` | Finds files by glob, e.g. `src/**/*.ts`. Respects `.gitignore`; skips `node_modules`, `.git`, `dist`, `build`; caps at 200 results | never |
| `grep(pattern, path?, glob?, ignore_case?, context_lines?, max_results?)` | Regex search returning `file:line: text`. Uses `rg` when installed, otherwise a built-in scanner that skips binary and large files | never |
| `write_file(path, content)` | Creates or overwrites a file, creating parent directories | always (except `--yolo`) |
| `edit_file(path, old_string, new_string, replace_all?)` | Exact replacement; `replace_all` replaces every occurrence. Missing text returns a hint with the closest line | always (except `--yolo`) |
| `multi_edit(path, edits[])` | Several exact replacements in one file, validated together and written once | always (except `--yolo`) |
| `apply_patch(patch)` | Applies a unified diff to one or more files after validating every hunk | always (except `--yolo`) |
| `run_command(command, timeout_seconds?)` | Runs a shell command in the working directory | always (except `--yolo`) |

`grep` and `glob` keep large repositories manageable, and `read_file` pages through long files. Use `multi_edit` for several changes in one file and `apply_patch` for coordinated changes across files; `apply_patch` validates the whole patch before writing and rejects deletions and renames.

Approvals show a diff, or the exact command, and offer:

- `[y]` allow once
- `[a]` allow this tool for the rest of the session (the status bar shows `auto:<tool>`; `/allow clear` revokes it)
- `[n]` deny and return the refusal to the model

Paths resolve against the working directory. Symlinks and `..` escapes are caught with `realpath`: reads, listings, and searches outside the workspace are refused, while writes, edits, and patches outside it need an explicit approval warning. `run_command` times out after 60 seconds by default (maximum 600), kills the process group on timeout or cancel, and truncates output to about 20k characters, keeping the head and tail. `read_file` returns 400 lines by default (maximum 2000) and points at the next offset. `glob` and `grep` honour `.gitignore`, always skip `node_modules`, `.git`, `dist`, and `build`, and cap their output with a hint on narrowing the search. Every tool result is also capped at 60k characters.

Read-only tools (`read_file`, `list_dir`, `glob`, `grep`) in one response run in parallel, and results are appended in call order. A write, edit, patch, or command breaks the batch and runs with an approval prompt.

`--yolo` skips all approvals. The status bar shows a red `YOLO` badge, the transcript warns once, and `/help` repeats it. It cannot be turned off inside the session; restart without the flag. Use it only in directories you trust.

### Undo and checkpoints

Before each `write_file`, `edit_file`, `multi_edit`, and `apply_patch`, Kiro copies the affected files to `~/.kiro/checkpoints/<cwd-hash>/` (directory `0700`, backups `0600`). `/undo` restores the latest call: edited files get their previous bytes, created files are removed. Running it again steps back through the 30 most recent calls.

Snapshots are best effort; if one fails, the tool still runs. `run_command` is not checkpointed because a command can touch anything, so commit before running destructive commands. Set `KIRO_CHECKPOINTS_DIR` to change the location. The manifest stores paths, not contents, so it stays small.

## AGENTS.md

If `AGENTS.md` exists in the working directory, its contents are appended to the system prompt every turn, including after edits.

## Skills

A skill is a folder of instructions that Kiro loads when it is needed. Kiro checks four places in order, and the first definition of a name wins:

1. `<cwd>/.kiro/skills/`
2. `<cwd>/.claude/skills/` (Claude Code skills work unchanged)
3. `~/.kiro/skills/`
4. `~/.claude/skills/`

Each skill is a directory with `SKILL.md`:

```md
---
name: anti-slop
description: Remove AI-slop patterns from prose before answering.
---

Delete "delve", "tapestry", and stacked em dashes. Prefer concrete nouns.
```

Only `name` and `description` are read. Other keys such as `allowed-tools` and `license` are ignored, and a skill can never skip an approval. A folder counts as a skill when it holds `SKILL.md`, two levels deep, so `skills/<name>/SKILL.md` and `skills/<group>/<name>/SKILL.md` both work. Symlinked folders are followed with loop detection. Supporting files (references, templates, scripts) are read or run like any other file, with the same rules.

The system prompt gets only names and descriptions. Up to 30 skills keep a full description; beyond that descriptions are clipped to 60 characters; very large collections fall back to bare names, so the prompt stays bounded. When a request matches, the model calls `read_skill` to load the body. The tool is read-only, needs no approval, runs alongside other reads, and reports whether the skill came from the project or the user folder.

`/skills` lists what was found, its source, and every skipped folder with the reason (no `SKILL.md`, a loose `SKILL.md`, a missing description, a duplicate name, an oversized file). `/skill anti-slop` loads a skill for the next message, and `/skill anti-slop rewrite this paragraph` loads it and sends the request in the same turn. The transcript shows the short command while the model gets the full instructions. The first time a repository skill is loaded, Kiro says so once.

Every installed skill is also a slash command, so `/anti-slop rewrite this paragraph` is the same turn as `/skill anti-slop rewrite this paragraph`. Skill names appear in the `/` menu, labelled `skill · <description>`, and can be completed with `Tab`. Built-in commands win a clash, so a skill named `model` is reachable only as `/skill model`, and `/skills` flags it. The command list refreshes after each turn, so new skills appear without a restart.

The index is rebuilt every turn, so edits to `SKILL.md` apply on the next message. `KIRO_SKILLS_DIR` replaces both user roots. `--no-skills` or `KIRO_NO_SKILLS=1` (which can live in `~/.kiro/.env`) skips skill folders entirely.

## How it works

- The OpenAI provider streams SSE responses and assembles tool-call deltas by index. It also accepts a plain JSON reply from servers that ignore streaming.
- Reasoning models (`o1`/`o3`/`o4`, `gpt-5`) use `max_completion_tokens` instead of `max_tokens` and omit temperature. If another endpoint rejects `max_tokens` and names `max_completion_tokens`, Kiro retries once with the new parameter.
- A stream that sends no bytes for `KIRO_STREAM_IDLE_MS` (default 120000, `0` disables) is cancelled and retried like a dropped connection.
- When a profile has no `contextWindow`, Kiro infers one from the model id (a suffix such as `-32k`, or a family table) and falls back to `128000`. `/context` says whether the value was inferred.
- If the endpoint rejects a request as too long (400/413 with a context-length message), Kiro compacts and retries the round once.
- `finish_reason: length` produces an explicit notice, including when tool-call arguments were cut off.
- Transient failures are retried up to three times with backoff and jitter: network errors, dropped connections before output, 429, and 5xx. `Retry-After` is honoured up to 60 seconds. Errors after partial text, cancels, and 400/401/403/404 are not retried. `KIRO_RETRY_BASE_MS` changes the base delay (default 500ms).
- Malformed tool JSON, unknown tools, non-zero exits, and timeouts go back to the model as tool errors instead of ending the session.
- A turn is capped at 25 tool rounds.
- Model discovery and the connection test both time out after 10 seconds and can be cancelled.
- Config saves are atomic and merge with the file on disk, so unknown fields survive. Invalid JSON can be backed up and replaced with a template.

## Testing

```bash
pnpm test    # backend tests against an in-process mock server
pnpm mock    # mock server on port 8787 for manual TUI testing
```

The mock server streams scripted replies with tool calls, slow responses, and errors, and can force `401`/`404`, custom headers, or a dropped connection. Point a profile at `http://localhost:8787/v1` with any model name; no key is needed.

The tests cover streaming and tool calls, approvals, retries and timeouts, path escapes, search and edit behaviour, config and key handling, compaction, sessions, the TUI components, and the skills pipeline from `SKILL.md` to `read_skill`. Pty runs exercise the palette, scrolling, Markdown, approvals, cancellation, and the `/usage` toggle. Model workflow tests use a temporary `$HOME`, so the real `~/.kiro` is never touched.

## Project layout

```
src/
  index.tsx          CLI entry point
  headless.ts        one-shot -p runner (stdout text, stderr diagnostics)
  config.ts          config load/validation/overrides, atomic save, recovery
  env.ts             ~/.kiro/.env parser/writer, masking, key status
  secrets.ts         credential registry: redaction and child-process env filtering
  sessions.ts        atomic session save/load/list
  model/             presets, discovery/test, context-window inference, shared wizard, CLI + screen renderer
  providers/         Provider interface, OpenAI-compatible implementation
  agent/             system prompt, skill discovery/parsing, agent loop, token estimates, compaction
  tools/             tool registry, fs/search/patch/shell/skill tools, checkpoints, glob/gitignore matching
  ui/                Ink app, markdown, command palette, prompt history, scrolling, approvals, status bar, export
test/
  mock-server.ts     scripted OpenAI-compatible SSE server + /models variants
  e2e.ts             backend test suite
```

## Known limitations

- Only the `openai` provider type. Anthropic-style APIs are not supported.
- Model discovery assumes an OpenAI-compatible `GET /models`. Endpoints without it work, but the model id must be typed manually.
- Removing a profile leaves its key in `~/.kiro/.env`; there is no command that deletes stored secrets.
- No sub-agents, MCP, plugins, web search, image input, themes, or git integration.
- Sessions are single-process and stored as plaintext JSON. There is no delete or rename command and no cross-directory session browser; `/export` writes a Markdown transcript you can keep.
- `/undo` covers `write_file`, `edit_file`, `multi_edit`, and `apply_patch` only. It keeps the last 30 calls, and `run_command` changes are outside its reach; use Git for a complete safety net.
- Prompt history is plaintext, capped at 200 entries per directory, and only recalled in the TUI (not in `-p` mode).
- Only contiguous read-only tool calls run in parallel; writes, edits, patches, and commands stay sequential.
- Context use is approximate when the endpoint does not report usage, and compaction depends on the model producing a usable summary. `/compact` is the manual escape hatch.
- Markdown support covers the common subset; images and syntax highlighting are shown as plain text.
- Mouse reporting is on by default and takes over click-drag selection; use Shift+drag to copy, or `--no-mouse` / `/mouse` to turn it off and scroll with `PgUp`/`PgDn`.
- The context-window inference is a best-effort guess. For an unusual or self-hosted model, set `contextWindow` explicitly or compaction will trigger too late.
- The TUI targets Linux, macOS, and Windows Terminal; Windows process killing uses `taskkill` but has not been exercised on a real Windows machine.
- Very narrow terminals and unusually long approval previews are clipped rather than paginated.

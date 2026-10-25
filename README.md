# Kiro

A small terminal-based AI coding agent, in the spirit of Codex CLI and Claude Code. Kiro streams model output into an Ink TUI, calls tools to read, edit, and run code in your working directory, and asks before doing anything destructive.

Phase 1 (MVP) supports OpenAI-compatible chat-completions endpoints: OpenAI itself, OpenRouter, Ollama, LM Studio, vLLM, and anything else that speaks `POST {baseUrl}/chat/completions` with SSE streaming and tool calls. A built-in model workflow (`kiro model`) discovers models from the endpoint, tests the connection, and stores keys outside the config file.

## Requirements

- Node.js 20 or newer
- pnpm (npm works too, but the lockfile and scripts assume pnpm)
- An OpenAI-compatible endpoint and, if the endpoint requires one, an API key

## Install

```bash
pnpm install
pnpm build

# pnpm 11+
pnpm add -g .

# pnpm 9/10
# pnpm link --global
```

Then run `kiro` from any project directory. If `kiro` is not found, pnpm's global bin directory is not on your `PATH`; run `pnpm setup` once, add `~/.local/share/pnpm/bin` to `PATH`, or invoke the binary by its full path.

You can also run it without linking:

```bash
node dist/index.js
# or, during development:
pnpm dev
```

## Quick start

```bash
cd ~/src/my-project
kiro model            # choose "Add a new model", pick a provider, paste your key
kiro                  # start talking to it
```

The wizard fetches the endpoint's model list, stores the key in `~/.kiro/.env` (mode `0600`), verifies that a real chat completion works, and can make the new profile active immediately. `~/.kiro/config.json` is created on first use and never contains the key itself.

In a terminal the wizard runs on the alternate screen and redraws in place: you always see the current step only, with a breadcrumb of what you already answered (`Choose a provider: Custom endpoint · Base URL: https://…`) across the top. Each entry is labelled with the menu's own title rather than the generic `Choose`, and pressing Enter on a default records the value that was kept instead of `(default)`; `Esc` clears the breadcrumb, and errors from an abandoned step do not follow you into the next one. Long lists are trimmed to the window height so the prompt never scrolls off, and each step replaces the previous menu instead of adding to the scrollback. When a list is longer than the window, a dim indicator shows how much is hidden and you can move through it while the prompt is active: `↑`/`↓` one line, `PgUp`/`PgDn` a page, `Home` the first entry, `End` back to the newest; any new message jumps back to the bottom. When you quit, the screen is restored and the results (saved profile, active profile, where the key went) are printed once. Piped or non-interactive output falls back to plain sequential printing.

Prefer no prompts?

```bash
export OPENROUTER_API_KEY="sk-or-..."
kiro model add --name openrouter --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4 --api-key-env OPENROUTER_API_KEY --set-active
kiro
```

Set `KIRO_CONFIG_PATH` to use a different config file (useful for testing).

## Managing models

Kiro keeps named connection profiles. `kiro model` opens a guided menu:

```
Model workflow
  1. Select the active model
  2. Add a new model
  3. Edit a model
  4. Remove a model
  5. Quit
```

### Adding a model

1. Pick a preset or **Custom endpoint**.
2. Confirm or edit the base URL.
3. Confirm or edit the environment variable that will hold the key, then paste the key (input is masked). Local presets skip both steps.
4. Kiro requests `GET {baseUrl}/models` and shows the result. Enter a number, type part of an id to filter, or enter `0` to type the id manually. If discovery fails or returns an empty list, Kiro explains why and asks for the model id.
5. Accept the suggested profile name or type your own. Names use letters, digits, `-`, and `_`, and must be unique.
6. Optionally set `temperature`, `maxTokens`, and `contextWindow` (defaults `0.2`, `4096`, and `128000`).
7. Kiro sends a tiny non-tool chat completion ("Reply with OK"). It reports success and latency, or the exact error (auth, 404, rate limit, timeout, bad JSON, unreachable host). A failure offers **Retry**, **Edit connection fields**, **Save anyway**, or **Cancel**.
8. Confirm **Set as active profile?** (`Y/n`).

`Esc` or `Ctrl+C` cancels any step. Cancelling leaves both `config.json` and `.env` untouched.

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

Presets only prefill the base URL and the suggested variable name; every field remains editable.

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

`--flag=value` works as well. `add` validates the URL, name, model, and numbers before saving; a failed connection test saves nothing (use `--no-test` to skip the test). Success exits `0`; validation, network, and test failures exit non-zero with a clear message on stderr.

Key handling for `kiro model add`:

- `--api-key <key>` writes the key to `~/.kiro/.env` under `--api-key-env`, or under a generated `KIRO_<PROFILE_NAME>_API_KEY`.
- `--api-key-env <VAR>` with no key stores nothing; it references the variable, which must already be set in the environment or in `~/.kiro/.env`.
- Omitting both creates a profile with no key, suitable for local servers.

### Where keys live

The config file contains only `apiKeyEnv`, the *name* of a variable. Values live in the environment or in `~/.kiro/.env`:

```
# ~/.kiro/.env
OPENROUTER_API_KEY=sk-or-...
```

- The file is created on demand with mode `0600`; its directory uses `0700` (best effort on platforms without POSIX modes).
- At startup Kiro loads `~/.kiro/.env` first, then real environment variables override it.
- Updating a key rewrites only that line, preserving comments and other variables. Removing a profile leaves its secret in `.env` so another profile can reuse it.
- Keys are never written to `config.json`, sessions, logs, or the TUI. Kiro shows `set via $VAR`, `missing ($VAR)`, or a mask such as `sk-…abcd`.
- Values in `.env` and every profile's `apiKeyEnv` are also withheld from the environment of `run_command` and redacted from tool output, so `env`, `printenv`, or `cat ~/.kiro/.env` cannot copy a key into the transcript, the model's context, or a saved session.

Set `KIRO_ENV_PATH` to use a different `.env` file (useful for testing).

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
| `type` | yes | Provider type. Only `openai` is implemented in Phase 1. |
| `baseUrl` | yes | API base URL including the version segment, e.g. `https://api.openai.com/v1`. Kiro appends `/chat/completions`. |
| `apiKeyEnv` | no | Name of the environment variable holding the API key. Omit for local servers that need no auth. |
| `model` | yes | Model name sent to the endpoint. |
| `temperature` | no | Sampling temperature. |
| `maxTokens` | no | Maximum response tokens. |
| `contextWindow` | no | Approximate model context window in tokens, at least 1000. Defaults to `128000`; drives the ctx meter and automatic compaction. |

`activeProfile` selects the profile used at startup. `/model <name>` switches at runtime; `--profile` switches per run.

### Example endpoints

**OpenRouter** (key from `~/.kiro/.env` or the environment)

```bash
export OPENROUTER_API_KEY="sk-or-..."
kiro model add --name openrouter \
  --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4 \
  --api-key-env OPENROUTER_API_KEY --set-active
```

**Ollama** (no key; discovery normally works, but a manually pulled tag can be entered instead)

```bash
kiro model add --name ollama \
  --base-url http://localhost:11434/v1 \
  --model qwen2.5-coder:14b --set-active
```

**LM Studio / vLLM / another OpenAI-compatible server**

```bash
kiro model add --name local \
  --base-url http://localhost:1234/v1 \
  --model local-model --set-active

# A server without GET /models: skip discovery by naming the model directly,
# and skip the test if it is not running yet.
kiro model add --name vllm \
  --base-url http://gpu-box:8000/v1 \
  --model my-model --no-test
```

If you prefer hand-editing, the JSON form above is still supported; `kiro model` → **Edit a model** can also update fields afterwards and re-test.

## CLI options

```
kiro [options]

  --profile <name>   Use a profile from ~/.kiro/config.json
  --base-url <url>   Override the active profile's base URL
  --model <name>     Override the active profile's model
  -c, --continue     Resume the most recent session for this directory
  --resume <id>      Resume a specific saved session
  --yolo             Skip all approval prompts (use with care)
  --mouse            Mouse reporting (on by default): wheel scrolls the transcript
  --no-mouse         Disable mouse reporting so plain click-drag selection works
  --no-alt-screen    Do not switch to the terminal's alternate screen
  -h, --help         Show help
  -v, --version      Show version
```

`--flag=value` works as well. CLI overrides last for the current process only.

## Using the TUI

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt, or run the highlighted `/` command |
| `Ctrl+C` | Cancel the running turn; press again to exit |
| `PgUp` / `PgDn` | Scroll the history (the wheel works too, unless you pass `--no-mouse`) |
| `Ctrl+O` | Expand or collapse the full output of the most recent tool call |
| `↑` / `↓` | Move through the `/` command menu |
| `Tab` | Complete the highlighted `/` command |
| `Esc` | Clear the input, close the command menu, cancel a model wizard step, or deny a pending approval |
| `Ctrl+A` / `Ctrl+E` | Move to start / end of input |
| `Backspace` / `Delete` | Delete before / after the cursor |
| `Ctrl+U` / `Ctrl+K` | Delete before / after the cursor |
| `Ctrl+W` | Delete the previous word |
| Left / Right / Home / End | Move the cursor |

The status bar shows the active profile and model, the working directory, the context meter (`ctx 42k/128k`), and the current state (`ready`, `thinking…`, `retrying (n/3)…`, `running <tool>…`, `approval needed`, `cancelling…`). A long profile name is shortened in the middle, so the model and directory stay readable.

Assistant replies are rendered as Markdown: headings, bold/italic, inline code, bullet and numbered lists, task checkboxes, blockquotes, links, and fenced code blocks. Unknown or incomplete markers fall back to their literal text, so streaming never breaks the layout.

Typing `/` opens a command palette above the input. It filters as you type, `↑`/`↓` select a command, `Enter` runs it, and `Tab` completes it. `Esc` clears the input.

On a real TTY, `kiro` switches to the terminal's alternate screen: you get a clean page instead of the TUI drawing underneath the command you just ran. When Kiro exits — `/exit`, `Ctrl+C`, or an error — the terminal restores the previous shell contents and prompt. Redirected output (pipes, CI logs) is left untouched. Pass `--no-alt-screen` to stay on the normal screen instead.

Mouse reporting is **on by default**, so the wheel scrolls the transcript. The cost is that the terminal hands clicks to Kiro instead of starting a text selection: to copy text, hold Shift while dragging (or your terminal's equivalent), or run `/mouse` — or start with `--no-mouse` — to get plain click-drag selection back, scrolling with `PgUp`/`PgDn` instead. `/mouse` toggles it at any time.

Tool results are shown as a one-line summary. `Ctrl+O` expands the most recent one inline — full text, scrollable with `PgUp`/`PgDn` — and `/export` writes the whole conversation, including complete tool arguments and results, to a Markdown file you can open and copy from.

Slash commands:

| Command | Action |
| --- | --- |
| `/help` | Show commands and keys |
| `/model` | List profiles grouped by endpoint and mark the active one |
| `/model <name>` | Switch profile without restarting |
| `/model add` | Guided setup; prompts appear in the input box and the key is masked |
| `/model edit [name]` | Edit fields, replace the key, re-test, and save |
| `/model remove [name]` | Remove a profile after confirmation (refuses the last one) |
| `/model test [name]` | Test the active or named profile; prints latency or the exact error |
| `/model list --remote` | List models offered by the active endpoint's `GET /models` |
| `/context` | Show approximate context use, broken down by message role |
| `/compact` | Summarize older turns now, keeping the last four user turns verbatim |
| `/sessions` | List saved sessions for this working directory |
| `/resume <n\|id>` | Resume a session by list number or id (prefixes work) |
| `/clear` | Start a new session, keeping the old one on disk |
| `/export [file]` | Write the transcript (with full tool output) to a Markdown file |
| `/mouse` | Toggle mouse reporting: wheel scroll vs normal text selection |
| `/allow` | List tools that skip approval for this session |
| `/allow clear` | Ask for approval again for every tool |
| `/exit` | Quit |

## Sessions

Kiro saves the conversation automatically. Each working directory gets its own directory under `~/.kiro/sessions/`, keyed by a hash of the absolute path:

```
~/.kiro/sessions/<cwd-hash>/<session-id>.json
```

A session stores the user, assistant, and tool messages, the title (the first prompt), the creation/update times, and the profile/model in use. System prompts are not stored; they are rebuilt for the current directory on every turn. Writes are atomic (temp file plus rename), the directory is created with mode `0700`, and session files are written with mode `0600`.

Saving happens after the user message is accepted and again when a turn finishes, so a crash loses at most the in-flight response. Ctrl+C and `/exit` wait for the pending save before leaving. Set `KIRO_SESSIONS_DIR` to store sessions somewhere other than `~/.kiro/sessions`.

Resume with:

```bash
kiro --continue          # most recent session for this directory
kiro --resume <id>       # a specific session
```

or from inside the TUI with `/sessions` and `/resume <n|id>`. Resuming restores the visible transcript and continues the same conversation; `/clear` starts a fresh session without deleting the old one. There is no auto-resume: without a flag, Kiro always starts a new session.

Session files are plaintext and contain your prompts, code snippets returned by tools, and command output. They never contain API keys (keys live only in `~/.kiro/.env` or the environment), but treat them like shell history.

## Context and compaction

Kiro tracks how much of the model's context window the conversation is using. The OpenAI provider sends `stream_options: { include_usage: true }` and uses the endpoint's reported `usage` when it arrives. Servers that ignore the option still work: Kiro falls back to an estimate of roughly four characters per token. The status bar shows `ctx <used>/<window>`, and `/context` breaks the total down by message role.

Each profile may set `contextWindow` (default `128000`). At about 80% of that window, before the next model request, Kiro compacts the conversation automatically:

- the system prompt is kept;
- the last four user turns, together with their assistant and tool messages, stay verbatim;
- older turns become a structured summary covering the goal, files touched, decisions, current state, and open TODOs;
- very large old tool results are replaced by a short placeholder before summarizing, so the summarizer is not flooded;
- the cut is always made at a user-message boundary, so an assistant tool-call round is never separated from its tool results.

Compaction appears as a notice in the transcript and is written into the session, so resuming continues from the compacted history. `/compact` runs the same pass on demand. If the summary request fails, the turn continues with the uncompacted context and an error notice. Counts are approximate; server-reported usage corrects them after each response.

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

Search first, then read: `grep` and `glob` keep large repositories manageable, and `read_file` supports paging for the files that matter. `multi_edit` is the right choice for several changes in one file; `apply_patch` handles coordinated multi-file changes and validates the whole patch before writing anything. `apply_patch` supports creating files but rejects deletions and renames.

Approval prompts show a diff for writes, edits, multi-edits, and patches, or the exact command for shell runs, and offer:

- `[y]` allow once
- `[a]` always allow this tool for the rest of the session (the status bar then shows `auto:<tool>`, and `/allow clear` takes it back)
- `[n]` deny (the denial is returned to the model, which can try another approach)

Paths are resolved relative to the working directory. Symlinks and `..` tricks that escape it are detected with `realpath`; reads, listings, searches, and listings outside the workspace are refused, while writes, edits, and patches outside it require an explicit approval warning. `run_command` has a default 60-second timeout (maximum 600), kills the whole process group on timeout or cancel, and truncates output to roughly 20k characters, keeping the head and tail. `read_file` defaults to 400 lines (maximum 2000) and points the model at the next offset when there is more. `glob`/`grep` honour `.gitignore`, always skip `node_modules`, `.git`, `dist`, and `build`, and cap their output with a note telling the model how to narrow the search. As a last resort, every tool result is capped at 60k characters with a note and a hint about narrower requests, so a single call cannot flood the context.

Read-only tools (`read_file`, `list_dir`, `glob`, `grep`) that the model requests in one response run in parallel; results are appended in the original call order. Any write, edit, patch, or command breaks the batch and runs sequentially with its approval prompt.

`--yolo` skips all approvals: the status bar shows a red `YOLO` badge, the first line of the transcript warns about it, and `/help` reminds you. It cannot be turned off from inside the session — restart without the flag. Use it only in a directory you trust.

## AGENTS.md

If an `AGENTS.md` file exists in the working directory, its contents are appended to the system prompt for every turn, so project-specific instructions apply immediately, including after edits.

## How it works

- The OpenAI provider posts to `{baseUrl}/chat/completions` with `stream: true`, parses SSE incrementally, and assembles tool-call deltas by index. It also accepts a plain JSON response from servers that ignore streaming, and reads `usage` when the endpoint sends it.
- Before each model round, Kiro checks the context estimate (corrected by the last reported usage) against the profile's `contextWindow`. At ~80% it replaces older turns with a model-written summary, keeps the last four user turns, and then sends the request.
- When a profile has no explicit `contextWindow`, Kiro infers one from the model id (a size suffix such as `-32k`, else a family table: `gpt-4o` 128k, `gpt-4` 8k, `o1`/`o3` 200k, `claude-3/4` 200k, `gemini` 1M, `llama-3.1` 128k, …) and falls back to 128k for unknown ids. `/context` says whether the number is inferred; set `contextWindow` in the profile to pin it.
- If the endpoint still rejects a request as too long (HTTP 400/413 with a context-length message), Kiro forces a compaction and retries that round once instead of ending the turn with a bare error.
- `finish_reason: length` is reported: a truncated answer, or tool-call arguments cut off by `max_tokens`, produces an explicit notice instead of a confusing tool error.
- A "cheap" placeholder pass shrinks old tool results before they are summarized; the discarded messages never reach the model again after compaction.
- The agent loop streams assistant text live, appends the assistant message with its tool calls, executes contiguous read-only calls in parallel and everything else sequentially, appends tool results in call order, and repeats. A turn is capped at 25 tool rounds.
- Transient failures are retried up to three times with exponential backoff and jitter: network errors, connection drops before any output, HTTP 429, and 5xx. `Retry-After` is honoured (capped at 60 seconds), and the TUI shows `retrying (n/3)…`. A 400/401/403/404, a malformed stream, a cancel, or a failure after partial text is never retried. Set `KIRO_RETRY_BASE_MS` to change the base backoff (default 500ms).
- Malformed tool-call JSON, unknown tool names, non-zero exits, and timeouts are returned to the model as tool errors rather than crashing the session.
- Ctrl+C aborts the HTTP stream and any running command; partial assistant text is preserved.
- Sessions are saved atomically after each user message and completed turn, and are restored by rebuilding the visible transcript from the stored messages.
- Model discovery calls `GET {baseUrl}/models` with a 10-second timeout; the connection test sends one tiny non-tool chat completion with the same timeout. Both can be cancelled.
- Config saves are atomic and merge into the file on disk, so fields Kiro does not know about are preserved. Invalid JSON can be backed up and replaced with a fresh template.
- Keys are never written to `config.json`, sessions, or logs. They live in `~/.kiro/.env` (mode `0600`) or the real environment, and the config stores only `apiKeyEnv`; actual values are never printed, are stripped from `run_command`'s environment, and are redacted from tool output before it reaches the model.

## Testing

```bash
pnpm test    # backend tests against an in-process mock OpenAI-compatible server
pnpm mock    # start the mock server on port 8787 for manual TUI testing
```

The mock server is scripted: it streams a text response with `write_file` and `list_dir` calls, then a `run_command` call, then a final answer, followed by multi-write and slow-streaming turns for approval and cancellation testing. It can also serve `GET /models` (with a configurable list or a forced `401`/`404`), return HTTP errors with custom headers such as `Retry-After`, drop the connection mid-stream, and records model-discovery and chat requests, including auth headers. Point a test profile at `http://localhost:8787/v1` and any model name; no key is needed.

The suite covers streaming, multiple tool calls per response, approvals and denials, malformed tool JSON, the round cap, HTTP errors, malformed SSE, unreachable endpoints, retries for 429/5xx and connection drops, no retry after partial output or a 401, the retry limit, read-only batching and ordered results, the global result cap, abort, workspace escapes, read paging, edit uniqueness, command exit codes and timeouts, output truncation, config validation, missing keys, system-prompt/`AGENTS.md` injection, and session persistence. Search tests cover glob matching, `.gitignore` handling, heavy-directory skips, result caps, ripgrep and the built-in grep fallback, binary/large-file skipping, and invalid regexes. Editing tests cover `replace_all`, near-miss hints, atomic multi-edits, and patch validation for updates, new files, conflicts, and rejected deletions. Context tests cover `stream_options` and usage parsing, token estimates and formatting, the 80% threshold, compaction boundaries, kept tool-call rounds, the old-result placeholder pass, empty-summary rejection, loop-level compaction (once per turn, non-fatal failures), persistence of compacted sessions, the `ctx` status-bar meter, and `contextWindow` config/wizard handling. Session tests cover atomic save/load, file permissions, per-directory isolation, sorting, corrupt-file skipping, id validation, and reconstruction of resumed tool blocks and statuses. TUI unit tests cover Markdown styles and wrapping, slash-command filtering/shared help text, and SGR mouse-wheel parsing; pty runs exercise the command palette, mouse and PgUp/PgDn scrolling, Markdown rendering, approvals, and cancellation.

Model workflow tests use a temp `$HOME` so the real `~/.kiro` is never touched. They cover atomic config saves that preserve unknown fields, profile-name and URL validation, corrupt-config backup/recovery, `.env` parsing and real-environment precedence, `0600` writes, masking, the exact preset list, discovery success/401/missing-`/models`/timeout, the connection test, and wizard add/edit/select/remove/last-profile refusal/cancel/manual-model fallback. Scripted `kiro model add`, `list`, `use`, `test`, and `remove` run through the real CLI against the in-process mock; a failed test saves nothing, keys never appear in `config.json`, and generated keys land in `.env`. The wizard screen renderer is unit-tested against a fake stream: alternate-screen enter/leave, a new menu replacing the previous one, the breadcrumb of answered prompts (menu title instead of `Choose`, the value kept by pressing Enter, confirmation of a `Y/n` default, and the reset on Escape or a return to the root menu), stale errors dropped at a step change, log trimming to the terminal height with the prompt always visible, keyboard scrolling of an over-long list (page, top, bottom, clamping, reset on new output), and replaying results after the screen is restored. `/model` groups profiles by endpoint so several models behind one base URL are listed as siblings.

## Project layout

```
src/
  index.tsx          CLI entry point
  config.ts          config load/validation/overrides, atomic save, recovery
  env.ts             ~/.kiro/.env parser/writer, masking, key status
  secrets.ts         credential registry: redaction and child-process env filtering
  sessions.ts        atomic session save/load/list
  model/             presets, discovery/test, context-window inference, shared wizard, CLI + screen renderer
  providers/         Provider interface, OpenAI-compatible implementation
  agent/             system prompt, agent loop, token estimates, compaction
  tools/             tool registry, fs/search/patch/shell tools, glob/gitignore matching
  ui/                Ink app, markdown, command palette, scrolling, approvals, status bar, export
test/
  mock-server.ts     scripted OpenAI-compatible SSE server + /models variants
  e2e.ts             backend test suite
```

## Known limitations

- Only the `openai` provider type. Anthropic-style APIs are not supported.
- Model discovery assumes an OpenAI-compatible `GET /models`. Endpoints without it work, but the model id must be typed manually.
- Removing a profile leaves its key in `~/.kiro/.env`; there is no command that deletes stored secrets.
- No sub-agents, MCP, plugins, web search, image input, themes, or git integration.
- Sessions are single-process and stored as plaintext JSON. There is no delete or rename command and no cross-directory session browser; `/export` writes a Markdown transcript you can keep or copy from.
- Only contiguous read-only tool calls run in parallel; writes, edits, patches, and commands stay sequential.
- Context use is approximate when the endpoint does not report usage, and compaction depends on the model producing a usable summary. `/compact` is the manual escape hatch.
- Markdown support covers the common subset; tables, images, and syntax highlighting are shown as plain text.
- Mouse reporting is on by default and takes over click-drag selection; use Shift+drag to copy, or `--no-mouse` / `/mouse` to turn it off and scroll with `PgUp`/`PgDn`.
- The context-window inference is a best-effort guess. For an unusual or self-hosted model, set `contextWindow` explicitly or compaction will trigger too late.
- The TUI targets Linux, macOS, and Windows Terminal; Windows-specific process-kill behavior is implemented via `taskkill` but has not been exercised on a real Windows machine.
- Very narrow terminals and unusually long approval previews are clipped rather than paginated.

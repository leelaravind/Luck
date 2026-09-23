# Claude Code CLI and Laya players

Two of the AI players are not HTTP APIs of a cloud model: the **Claude Code CLI** (your locally
installed `claude` program, run headless) and the optional **Laya** local classifier. This page says
exactly how each is called, what is isolated, what is and is not measured, and what was verified live.

Code: `src/server/providers/claudeCli.ts`, `src/server/providers/laya.ts`.
Tests (fixtures): `src/server/providers/claudeCli.test.ts` (fake CLI `tests/fixtures/fake-claude.mjs`),
`src/server/providers/laya.test.ts` (mock `laya-serve`).

---

## 1. Claude Code CLI

### Terms — read this first

Using the CLI with your **Claude subscription login** is meant for **your own personal use of the
unmodified Claude Code CLI**. If you build something on this for other people, use the Anthropic API
with an API key (the "Anthropic" player) instead. The app shows this in the player's notes.

### Which executable runs

- `CLAUDE_CLI_PATH` in `.env` (absolute path), otherwise the first `claude.exe` (Windows) / `claude`
  (macOS/Linux) found on `PATH`. It must be an existing regular file; on Windows it must be a `.exe`.
- `.cmd`, `.bat` and `.ps1` files are **refused** (e.g. the old npm shim `claude.cmd`): Node cannot run them
  without a shell, and the adapter never uses a shell. The PATH search only looks for the native name, so
  the npm shim folder is skipped.
- Nothing from the browser or HTTP API can choose or change the executable.
- *Test connection* runs `<claude> --version` and `<claude> auth status --json` with the same environment a
  real decision uses — no prompt, no usage. See "Maintained conversation and connection check" at the end.

### Exact argv

`spawn(<claude>, argv, { shell: false, windowsHide: true, cwd: <sandbox>, env: <minimal> })`, prompt on
**stdin** (the observation JSON never appears on the command line):

```
-p
--output-format stream-json
--verbose
--system-prompt <app system prompt>
--tools ""
--disallowedTools mcp__*
--strict-mcp-config
--setting-sources ""
--disable-slash-commands
--permission-mode dontAsk
--session-id <uuid>      (first round of a Luck session)   or   --resume <uuid>   (every later round)
--max-turns 2
--json-schema <PlayerDecision JSON schema>
[--model <model>]                 only if a model is set
[--max-budget-usd <remaining>]    remaining app budget for this call
```

| Flag | Why |
|---|---|
| `-p` | Headless print mode: one request, then exit. |
| `--output-format stream-json` + `--verbose` | One JSON event per line; stream-json requires `--verbose`. Lets the adapter inspect the `init` event and every assistant message *while it runs* and kill the process on a violation. |
| `--system-prompt` | Replaces Claude Code's default (coding-agent) system prompt with the game rules. |
| `--tools ""` | Removes **all** built-in tools (Bash, file read/write, web fetch, …). |
| `--disallowedTools mcp__*` | Belt and braces: deny every MCP tool name. |
| `--strict-mcp-config` | Only MCP servers from `--mcp-config` — none is given, so **no MCP servers**. |
| `--setting-sources ""` | Load **no** user, project or local settings files (no hooks, permissions, plugins, env from settings). Empty string verified accepted (see §1.7). Admin-managed policy settings still apply — they cannot be bypassed. |
| `--disable-slash-commands` | Disables skills / slash commands. |
| `--permission-mode dontAsk` | Anything not pre-approved is denied instead of prompting (nothing is pre-approved). |
| `--session-id` / `--resume` | Each Luck session keeps **one** Claude Code conversation: the first round opens it with `--session-id <uuid>` and a short, truthful opening message (virtual-credit simulation, no real money or gambling); every later round continues it with `--resume <uuid>`. Claude Code stores that conversation in its normal session folder. Without a session key (e.g. one-off calls) the adapter falls back to `--no-session-persistence`. After a server restart a new conversation is opened. |
| `--max-turns 2` | With `--json-schema` the model answers by calling the CLI's synthetic `StructuredOutput` tool; the CLI counts that call and its tool result as **2 turns** for **1 API request** (verified). 1 was not observed to produce a decision. |
| `--json-schema` | Structured output: the validated object arrives in `result.structured_output`. The app still re-validates it (shape + game rules). |
| `--model` | Validated by `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,80}$` — cannot start with `-`, so it can never be read as a flag (e.g. `--dangerously-skip-permissions` is rejected). Aliases like `haiku` / `sonnet` or a full model id. If no model is set, the CLI uses its own built-in default (a model chosen in your Claude Code settings does **not** apply, because settings files are not loaded). |
| `--max-budget-usd` | The CLI stops when its own cost estimate reaches this amount. It is checked between API requests, so one call can overshoot slightly. Zero/negative remaining budget → the call is not made. |

### Environment of the child

Only these variables are copied from the server (when set): `PATH, SystemRoot, windir, USERPROFILE,
HOME, APPDATA, LOCALAPPDATA, TEMP, TMP, HOMEDRIVE, HOMEPATH, LANG` (and on macOS/Linux `TMPDIR, USER,
LOGNAME`), plus `CLAUDE_CONFIG_DIR` (where the
CLI keeps its login if you moved it) and the proxy/CA variables `HTTP(S)_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS`.
Everything else is dropped — including any `CLAUDECODE` / `CLAUDE_CODE_*` variables of a Claude Code
session the server might have been started from. Added:

| Variable | Value | Why |
|---|---|---|
| `ENABLE_CLAUDEAI_MCP_SERVERS` | `false` | Do not load claude.ai connector MCP servers. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | No auto-memory reads/writes. |
| `CLAUDE_CODE_MAX_RETRIES` | `1` | The session runner owns retries; keep the CLI's own retry loop short. |
| `DISABLE_AUTOUPDATER` | `1` | A game request must never update the shared CLI binary. |
| `MAX_THINKING_TOKENS` | `0` | Extended thinking off. Live check 1 showed thinking on by default consuming the whole output cap (1542 of 1600 output tokens) so no decision was produced. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | session `maxOutputTokens` | Per-request output cap. Note: when the cap is hit the CLI itself continues up to 3 more times (observed), so the real output per decision can be up to ~4× the cap; `--max-budget-usd` still bounds cost. |

**Auth.** With `CLAUDE_CLI_USE_SUBSCRIPTION=true` (default) `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` are never passed, so the CLI uses your Claude Code login (in `-p` mode the CLI
would otherwise always prefer an API key). With `false`, the server's `ANTHROPIC_API_KEY` is passed and
normal per-token API billing applies.

### Sandbox working directory

`<OS temp folder>/luck-cli-sandbox` — for example `%TEMP%\luck-cli-sandbox` on Windows or
`$TMPDIR/luck-cli-sandbox` (`/tmp/luck-cli-sandbox`) on macOS/Linux — created on demand, **outside the
repository**, so the CLI never sees the project (no project files, no git status) and Claude Code does not file
its conversation transcripts under the project's path. It **must be empty**; if anything is in it (e.g. a
`CLAUDE.md` or `.mcp.json`) the call is refused with `not_configured`. On macOS/Linux it is created with mode
`0700` and refused if it is a symlink, owned by another user, or writable by group/others (a shared `/tmp`).

Earlier versions used `<repo>/tmp/cli-sandbox` (git-ignored, but inside the repository); a leftover
`tmp/cli-sandbox` folder is no longer used and can be deleted.

### What the model sees

Luck sends the model: its system prompt (`--system-prompt`), on the first round a short opening message, the
`GameObservation` JSON on stdin, and the decision JSON schema (`--json-schema`). When an **app spending limit**
is set, Luck also passes the remaining app budget as `--max-budget-usd`, and the CLI shows that figure to the
model (`budget_usd` below). Nothing else from Luck.

**The Claude Code CLI adds context of its own to every conversation** — observed on 2026-09-23 (Claude Code
2.1.280, Windows 11, subscription login) in the CLI's transcript (`attachment` entries in the conversation's
`.jsonl` under `~/.claude/projects/`):

| Entry | What the model sees | When |
|---|---|---|
| `environment` | working directory (= the sandbox above), "is a git repository: no", platform, shell and OS version | every conversation |
| `date` | the current date | every conversation |
| `session_context` | **your account e-mail address** | subscription login |
| `model` | the model's own identity: its name, exact model id and knowledge cutoff | every conversation |
| `total_tokens_reminder` | a CLI token counter (`<total_tokens>… tokens left</total_tokens>`) — the CLI's own figure, not a Luck limit and not the per-request output cap | every turn |
| `budget_usd` | **Luck's remaining app budget** in USD, from `--max-budget-usd`: `{ used, total, remaining }` — e.g. `total` 0.5 on the first turn, then 0.494649 and 0.482874 as the budget was spent | every turn, **only when an app spending limit is set** |

So the model sees the game observation **plus** that CLI-added context — with an app spending limit, including
how much of that limit is left. `budget_usd` exists only because Luck passes `--max-budget-usd` as the CLI's hard
cost stop: without an app spending limit no such flag is passed and no `budget_usd` entry appears (checked in two
transcripts of sessions without a limit). For the other entries,
Claude Code 2.1.280 offers no supported flag that switches them off with a subscription login (`--bare`
requires API-key auth and does not document it), so Luck cannot remove them. They are sent to the same Anthropic account the CLI is logged in to, not to
a third party. With `CLAUDE_CLI_USE_SUBSCRIPTION=false` (API-key auth) this was not checked. To see it yourself,
open the newest `.jsonl` in the `~/.claude/projects/` folder named after the sandbox path and list its
`attachment` entries.

### Boundary enforcement

The flags are not trusted blindly. While streaming, the adapter fails the call with
`boundary_violation` and **disables the Claude Code CLI player for the rest of the server process**
(provider status shows `enabled: false` with the reason; restart the server after fixing things) if:

- the `init` event lists any tool other than the CLI's own `StructuredOutput`, or any MCP server, or any
  plugin that is not built into the CLI (`path: "builtin"`), or
- any assistant message contains a `tool_use` / `server_tool_use` / `mcp_tool_use` block other than
  `StructuredOutput`, or
- the result reports `permission_denials`.

The child is killed immediately. A stream without an `init` event is not trusted (`invalid_output`).

**Limits of the isolation (honest):**

- Admin-managed (policy) settings still apply; they are outside the app's control.
- The CLI loads two built-in plugins (`agents-md`, `telemetry`) and lists its built-in agent types; with no
  tools available, agents cannot be started. The CLI's normal telemetry is unchanged.
- The `init` event shows the CLI opens a local messaging named pipe (`messaging_socket_path`). The app does
  not use it; anything arriving that way could at most change the model's answer, which is validated anyway.
- The CLI's own context (working directory, OS/shell, date, model identity, a token reminder, with a subscription
  login your account e-mail, and with an app spending limit the remaining budget) is part of every conversation —
  see "What the model sees" above.
- Whether a user-level `CLAUDE.md` is excluded cannot be seen in the stream. With `--setting-sources ""`
  it should not load (it is tied to the `user` source); the measured input size (2 971 tokens for the
  system prompt, observation, schema and CLI scaffolding) is consistent with that, but it is not proof.
- Timeouts and Stop kill the CLI process (`child.kill()`); tokens it already consumed are then unknown
  (`usage.known = false`, cost unknown) — the usage view flags such requests.

### Usage, cost, latency, quota

| Field | Source | Notes |
|---|---|---|
| input / output / cache tokens | `result.usage` | **This turn only** (not a running total): summed over the API requests of this `claude -p` run. Output includes thinking tokens; `reasoningTokens` = `usage.output_tokens_details.thinking_tokens`. |
| cost | increase of `result.total_cost_usd` → `providerCostUsd` | **The CLI's own estimate at list prices** (`modelUsage[…].costBasis: "list"`), **not billing**. With subscription auth nothing is billed per token; usage counts against plan limits instead. For a resumed conversation `total_cost_usd` is a **running total for the whole conversation**, so the adapter records this turn's increase over the previous turn's total (the whole value on the first turn). |
| latency | measured by the adapter | Includes CLI start-up (~1–2 s). |
| generation time | increase of `result.duration_api_ms` | Also a running total for a resumed conversation → this turn's increase. API time incl. time to first token; not pure generation time. |
| model | `result.modelUsage` key whose output grew this turn | e.g. `claude-haiku-4-5-20251001` for alias `haiku` (`modelUsage` is a running total too). |
| quota | `rate_limit_event` → `RateLimitInfo` (source `cli-rate-limit-event`) | `status` (`allowed` / `allowed_warning` / `rejected`), `rateLimitType` (e.g. `five_hour`), `resetsAt`, and per-window `utilization` (fraction 0–1) under `unifiedWindows` (`five_hour`, `seven_day`). |

If the previous total is not known (for example a retry after an attempt that produced no result) or a total
goes down, that turn's cost / API time is recorded as **unknown** — never as the whole running total. The
decision's note says when a figure is a turn's increase and shows the conversation total so far.

**Correction (fixed in this version).** Earlier versions recorded each turn's *running total* as if it were the
cost and API time of that one call, and then added those totals up. CLI costs were therefore **over-counted** —
for a resumed conversation up to about 11× (one session showed $20.69 while the CLI's own conversation total was
$1.85), tokens per second were shown too low, and a session with an app spending limit could stop early (one
stopped at about 28 % of its budget). Per-turn increases are now recorded (fixture-tested in
`src/server/providers/claudeCli.test.ts` with a two-turn conversation). Usage already saved by the earlier
versions is not recalculated, so treat CLI cost and speed figures of older sessions as over-counted.

**Not available:** remaining messages or tokens as absolute numbers, your plan's price, or any billing
figure. Plan limits are only shown when the CLI emits a rate-limit event (it did on both live calls with
subscription auth; not verified with API-key auth). The app never invents a quota.

### Error mapping

| Situation | ProviderError |
|---|---|
| `is_error` + "Not logged in / Invalid API key / /login", HTTP 401/403 | `auth` (not retryable) |
| usage/plan limit ("usage limit reached", "hit your limit · resets …", rate-limit event `rejected`) | `rate_limited`, **not retryable**, `retryAfterMs` from the reset time when known |
| 429 / "rate limit" | `rate_limited` (retryable) |
| overloaded / 5xx | `server_error` (retryable) |
| `error_max_budget_usd` | `budget` (tokens and cost of the stopped call are still reported) |
| `error_max_turns`, structured-output retries exhausted, "exceeded the N output token maximum" | `invalid_output` (retryable) |
| malformed stream / no `init` / no result with exit 0 | `invalid_output` |
| non-zero exit without a result | `unknown` (with the exit code and redacted stderr) |
| timeout / Stop | `timeout` (retryable) / `cancelled` — process killed |

`is_error` is checked, not only `subtype` (live call 1 had `subtype: "success"` with `is_error: true`).
All error text passes through `redact()`. The adapter never retries.

### Live verification (2026-09-23, Claude Code 2.1.280, Windows 11)

Before any live call: `claude --version` → `2.1.280 (Claude Code)`; `claude --help` checked;
`claude auth status` → logged in via claude.ai subscription (no API key in the environment). Flag parsing
was checked **without a prompt** (empty stdin, which makes the CLI exit before any request):
`--setting-sources bogus` → `Invalid setting source: bogus. Valid options are: user, project, local`;
`--setting-sources ""` together with the full argv above → only `Input must be provided…`, i.e. accepted.

Then exactly **two** real `claude -p` calls were made through the adapter (model `haiku`,
`--max-budget-usd 0.05`, API-key env stripped, real app prompts for round 1 of a default session):

| | Call 1 | Call 2 |
|---|---|---|
| Config | `--max-turns 1`, thinking at CLI default | `--max-turns 2`, `MAX_THINKING_TOKENS=0` (shipped config) |
| `init` | tools `["StructuredOutput"]`, mcp_servers `[]`, slash_commands `[]`, skills `[]`, plugins `agents-md@builtin`, `telemetry@builtin`, apiKeySource `none`, permissionMode `dontAsk` | same |
| Outcome | `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"`: "Claude's response exceeded the 400 output token maximum" after 4 API requests (the CLI's own continuations; `--max-turns 1` did not stop them) | `is_error: false`, `subtype: "success"`, `num_turns: 2`, 1 API request, `structured_output` present: `{"action":"bet","bets":[red 500, black 500, odd 500, even 500, dozen 1/2/3 300 each], "explanation": …}` |
| Usage | in 12 842 / out 1 600 (thinking 1 542) | in 2 971 / out 327 (thinking 0) |
| CLI cost estimate | $0.020842 | $0.004606 |
| API / wall time | 19 168 ms / 20 634 ms | 3 542 ms / 5 555 ms |
| Rate-limit event | five_hour `allowed`, utilization 0.14, reset 2026-09-23T12:00Z; seven_day 0.22 | five_hour `allowed`, utilization 0.15; seven_day 0.23, reset 2026-09-27T16:00Z |
| Sandbox afterwards | empty | empty |

Both were one-off calls (no resumed conversation), so their cost and API time are those of the single call.
The adapter was adjusted after call 1 (thinking off, `--max-turns 2`, output-cap error mapped to
`invalid_output`, rate-limit windows parsed). Call 2's decision itself was not validated here — the
session runner does that (its stated total, 3 400, did not match the bets' sum of 2 900; the runner's
rule check uses the bets, never the explanation).

---

## 2. Laya (optional local classifier)

Setup, start scripts and download size: [`optional/laya/README.md`](../optional/laya/README.md).
Summary: separate Python venv (`.venv-laya`), `pip install -r optional/laya/requirements.txt`
(`laya[serve]==0.3.7`), weights 0.6–2.3 GB from Hugging Face on first use, start with
`LAYA_HOST=127.0.0.1` (`laya-serve` defaults to `0.0.0.0`). Nothing of this is in the npm install.

### Calls

- *Test connection*: `GET <LAYA_BASE_URL>/health` → `{ status, loaded, device }`. No classification.
- Decision: `POST <LAYA_BASE_URL>/v1/systemone` with
  `{ model: <LAYA_CHECKPOINT>, state: <text summary>, questions: { action: { type: "choice", instructions, criteria } } }`.
  `Authorization: Bearer <LAYA_API_KEY>` only when configured.
- `state` is a short text built **only** from the GameObservation: round, balance, limits, rounds
  remaining, net result, last 10 winning numbers, last round's stake/net.
- `instructions` is one sentence naming the task (choose the next action in a virtual European roulette game).
- `criteria` (**13 labels**, `LAYA_CRITERIA` in `laya.ts`): `skip, red, black, odd, even, low, high,
  dozen_1, dozen_2, dozen_3, column_1, column_2, column_3`. There is **no `stop` label**: a classifier must not
  end the session (the user and the session limits do). Earlier versions offered `stop`, and Laya picked it
  almost every time (reviewer defect D4).

### Mapping and honesty

- Laya returns `answers.action = { choice, probabilities, confidence }`. The **adapter** maps the label:
  `skip` → skip; any other of the 13 labels → **one** bet on that category with **stake = the session
  minimum** (`limits.minStake`). **Laya only picks the category; the adapter fixes the stake.**
- Explanation, e.g. `Laya classifier chose 'red' (label probability 0.93, Laya confidence 0.85; raw, uncalibrated). Stake fixed at the session minimum by the adapter.`
  A value Laya did not return is written as `label probability not reported` / `confidence not reported`
  (never replaced by the other one); a `skip` has no stake sentence. The top label probabilities and routing are
  shown as a note.
- Unknown label or missing answer → `invalid_output`; never converted into another bet. A returned `stop`
  (not one of the 13 labels) is such an unknown label, so it is **invalid output** — never a stop, never a bet.
- Usage: `inputTokens` = `usage.input_tokens`; **`outputTokens` = not applicable (null)** — a classifier
  generates nothing, so the app never reports "0 generated tokens". No cost (local, `local-no-charge`).
- Laya is **not a roulette model** and cannot predict outcomes; its probabilities describe how well a label
  fits the text, not a chance of winning.

### What was verified

**Live** (2026-09-23, Windows 11, CPU): `laya[serve]==0.3.7` installed in a separate venv, `laya-serve` started
with `LAYA_HOST=127.0.0.1` on port 8000, checkpoint `english` (weights downloaded from Hugging Face on first
use). *Test connection* (`GET /health`) succeeded; a real `POST /v1/systemone` answered with
`answers.action = { choice, probabilities, confidence }`, `usage.input_tokens` and `routing` (the shapes the
adapter expects). After `stop` was removed from the label set, a 3-round session through the app played
skip, red (lost), red (won); the decisions were validated and settled by the engine, the label probability and
Laya's confidence were shown raw (uncalibrated — the model card says checkpoints ship over-confident),
input tokens were 262–276 per decision, output tokens "not applicable", about 1.9 s per decision. Details:
[verification.md](verification.md#providers-live-vs-fixture).

**Fixtures** (default test run): `src/server/providers/laya.test.ts` uses a **mock** `laya-serve` (node:http on
an ephemeral port): health, the mapping of every one of the 13 labels, unknown label (incl. `stop`) →
`invalid_output`, `outputTokens` null, Bearer header only when configured, key redacted from errors, timeout,
abort, unreachable server.


## Maintained conversation and connection check (added after live testing)

- **Connection test** runs `claude --version` and `claude auth status --json` — no prompt, no usage. It reports
  "Connected" only when the CLI says it is logged in, and shows the login method and plan, never the e-mail or organisation.
- **One conversation per Luck session.** Verified live on 2026-09-23 (Claude Code 2.1.280, model alias `haiku`,
  subscription login): round 1 opened conversation `34ae2431…` (2 051 input / 158 output tokens, 4.2 s, CLI estimate
  $0.0028); round 2 resumed the same conversation (2 549 / 168 tokens, 3.9 s) and its decision referred back to
  round 1. Both decisions passed the engine's validation. The "$0.0062" recorded for round 2 at the time was the
  CLI's **running total for the conversation** (see *Correction* above); round 2's own share was about $0.0034
  ($0.0062 − $0.0028). Because the conversation grows, input tokens per round grow too; the app budget check
  accounts for this (see below).
- **App spending limit with the CLI.** Before each turn Luck bounds what the turn could cost if the prompt cache
  has expired: the whole conversation (the newest turn whose input, cache-read, cache-write and output tokens were
  all reported, plus the new observation) written again at the 1-hour cache-write price (2× input), re-read by up
  to 3 continuation calls, plus 4 × the output cap at 5× input. The price per token is, in this order: your pricing
  assumption; the highest price the last turn's CLI-reported cost allows — its cost divided by its tokens, each
  weighted with the cheapest rate that model has (cache reads 0.025× on Claude Fable 5.1, 0.05× on Claude Opus 5.5,
  0.1× on the other models the bundled reference prices, 0.025× for any other model), used only when that turn was
  made with the configured model; the configured model's built-in price; else the highest known Claude price
  ($10/MTok). On the first turn the context is the prompt plus 1 000 tokens the CLI adds. The next turn is sent only
  while spent + that bound fits the limit, so a long session can use most of its limit (a 40-turn test
  conversation of 60 000 tokens on a 0.1× model: worst case 169 k µ$ against 384 k µ$ spent). On Claude Fable 5.1 a
  cold turn really costs up to 80 × a warm one, so the bound — and the share of a small limit that can be used — is
  correspondingly more cautious. When the CLI reports no tokens, the bound falls back to max(2 × the last turn, the
  session's CLI total so far), which stops a session at about half its limit. The floor is $0.05.
  **Limit:** with no model configured the CLI uses its own default model, which could change between two turns
  (e.g. after a CLI update) to a dearer one; the CLI's own `--max-budget-usd` stop (the remaining budget) still
  ends such a turn after the API call in progress.
- **Framing.** The opening message states the true context (a local simulation for an AI decision experiment, virtual
  credits only). It does not instruct the model to ignore its guidelines. If a model declines, the refusal is recorded
  as invalid output and the session pauses — it is never converted into a bet.

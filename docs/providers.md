# AI providers: Ollama, Anthropic, OpenAI-compatible

This page covers the three HTTP providers. The Claude Code CLI and Laya adapters are described in
[providers-cli-laya.md](providers-cli-laya.md).

All AI players make **virtual** bets with credits that have no real-world value. With the three HTTP
providers on this page a model sees only Luck's system prompt and the `GameObservation` (balance, limits,
bet types and settled history) — nothing else is sent. It never sees RNG state, upcoming outcomes, database
rows or secrets.

The **Claude Code CLI** is different: the CLI adds context of its own to every conversation (working
directory, OS/shell details and, with a claude.ai subscription login, your account e-mail), so that model
sees the game observation **plus** that CLI-added context. See
[providers-cli-laya.md](providers-cli-laya.md#what-the-model-sees).

## How every adapter behaves

| Behaviour | Detail |
|---|---|
| One interface | `ProviderAdapter` (`src/server/types.ts`): `check`, `testConnection`, `listModels`, `decide`. |
| Never throws on provider/network errors | `decide` and `testConnection` return `ok: false` with a typed `ProviderError` (`timeout`, `rate_limited`, `unavailable`, `auth`, `bad_request`, `server_error`, `invalid_output`, `cancelled`, `not_configured`, `unknown`). `listModels` has no error slot in its signature, so on failure it throws `GameError('provider_unavailable')` with the provider error code in `details`. |
| Deadline | One deadline (`decisionTimeoutMs`) covers the whole exchange: connect, headers **and** response body. It is combined with the Stop button's AbortSignal. A deadline hit is `timeout` (retryable); Stop is `cancelled`. |
| No retries in adapters | The session runner does the bounded retries (`maxRetries`) and checks the budget before each attempt. The Anthropic SDK's own retries are turned off (`maxRetries: 0`). |
| Size cap | Response bodies over 1 MB are rejected (`invalid_output`). |
| Redirects | They are not followed, so a redirect cannot carry an API key to another host. |
| Secrets | API keys come only from the server `.env`. Every error message goes through `redact()`, and the key used for the call is masked too. |
| Output validation | The adapter returns the raw text. `parseDecision()` (`src/shared/decision.ts`) strips `<think>…</think>` blocks and ``` fences, then requires **exactly one** JSON object that matches the strict decision schema. Extra keys, wrong types, unknown bet types or actions are rejected. `validateBetSlip()` then applies the game rules and limits. Invalid output is never turned into a different bet. |

### Error mapping

| Situation | Code | Retryable |
|---|---|---|
| Deadline reached (server slow or stalled body) / HTTP 408 | `timeout` | yes |
| Stop pressed (caller abort) | `cancelled` | no |
| Connection refused, DNS failure, connection reset | `unavailable` | yes |
| HTTP 401 / 403 (and 402 billing) | `auth` | no |
| HTTP 400 / 404 / 413 / 422 (and other 4xx) | `bad_request` | no |
| HTTP 409 | `server_error` | yes |
| HTTP 429 | `rate_limited`, with `retryAfterMs` from `retry-after-ms` or `Retry-After` (seconds or HTTP-date) | yes |
| HTTP 500 / 502 / 503 / 504 / 529 (overloaded) | `server_error` | yes |
| Output cut off at the output-token limit (`max_tokens` / `length`) | `invalid_output`, with the hint "raise max output tokens" | no |
| Model refusal (Anthropic `stop_reason: refusal`, OpenAI `message.refusal`, `content_filter`) | `invalid_output` | no |

## Capabilities

| | Ollama | Anthropic | OpenAI-compatible |
|---|---|---|---|
| Runs locally | yes | no | depends on endpoint (always treated as paid) |
| May cost money (budget enforced) | no | **yes** | **yes** |
| Token usage | full (`prompt_eval_count`, `eval_count`) | full (input, output, cache read, cache write, thinking) | full **when the server sends `usage`**, otherwise unknown |
| Cost reported by the provider | no | no (estimated from pricing) | no (estimated from pricing you enter) |
| Lists models | yes (`/api/tags`) | yes (Models API) | yes (`GET /models`) |
| Output constraint | JSON Schema via `format` | JSON Schema via `output_config.format` | JSON mode (`response_format: json_object`): valid JSON only, not the schema |
| Quota / rate-limit info | none | `anthropic-ratelimit-*` response headers | `x-ratelimit-*` response headers (if the server sends them) |
| API key | not used | required (`ANTHROPIC_API_KEY`) | required for api.openai.com; optional for local servers |
| Default model | none | none | none |

No adapter ships a hard-coded model. You pick one from the listed models or type an id.

## Configuration (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama native API root (not `/v1`). |
| `OLLAMA_MODEL` | empty | Optional default, spelled exactly as `ollama list` shows it. |
| `ANTHROPIC_API_KEY` | empty | Stays on the server and is never sent to the browser. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Set on the server only. A browser request cannot redirect the key to another host. |
| `ANTHROPIC_MODEL` | empty | Optional default model id. |
| `OPENAI_BASE_URL` | empty | **Required.** Full base including `/v1` if the service needs it, e.g. `https://api.openai.com/v1` or `http://localhost:1234/v1` (LM Studio). |
| `OPENAI_API_KEY` | empty | Sent as `Authorization: Bearer …`. It is attached only when the endpoint is the one configured on the server. |
| `OPENAI_MODEL` | empty | **Required** before a session can start (in `.env` or typed in the app). |

Restart Luck after changing `.env`.

## What each provider really reports

### Ollama

- **Tokens:** `prompt_eval_count` → input and `eval_count` → output. Ollama may leave out
  `prompt_eval_count` when the whole prompt was cached. Input is then shown as unknown, never
  guessed.
- **Speed:** `eval_duration` (ns) becomes `generationMs`, so tokens/s measures generation only and
  excludes model loading. When a model load took ≥ 0.5 s, the decision carries a note, because the
  end-to-end latency includes it.
- **Cost:** none. Local inference is recorded as `local-no-charge`. Electricity and hardware are not
  counted.
- **Quota:** none exists for a local server.
- **Finish reason:** `done_reason` (`stop` or `length`). `length` is treated as cut-off output.

### Anthropic (Messages API, official SDK)

- **Tokens:** `input_tokens` (uncached input), `output_tokens` (including thinking),
  `cache_read_input_tokens`, `cache_creation_input_tokens`, and
  `output_tokens_details.thinking_tokens` (reasoning, a subset of output).
- **Cost:** Anthropic does not return a price. Luck shows an **estimate**: tokens × pricing
  assumption (see below), always labelled as estimated.
- **Rate limits:** the `anthropic-ratelimit-*` response headers (requests, input or output tokens:
  limit, remaining, reset) are stored per attempt, including on 429 responses. They are **API rate
  limits**, not your spend, balance or monthly plan quota. Luck does not show those because the API
  does not report them.
- **Connection test:** it lists models through the Models API, which spends no tokens.
- **Structured output:** `output_config.format = { type: "json_schema", schema }`. The model must
  support structured outputs. Otherwise the API returns 400 (`bad_request`).
- **Temperature:** it is sent only if you set one. Several current models reject sampling parameters
  with a 400, so leave it empty unless your model accepts it.

### OpenAI-compatible (Chat Completions)

- **Tokens:** `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` and
  `completion_tokens_details.reasoning_tokens`, **if the server returns them**. Many local servers
  omit the details, and some omit `usage` completely. That attempt then counts as *unknown usage*.
- **Cost:** there are no default prices. Enter your own pricing in Settings to get an estimate.
  Without it, cost stays unknown. Because an OpenAI-compatible endpoint may be a paid cloud
  service, it is always treated as paid and the budget applies.
- **Rate limits:** `x-ratelimit-limit|remaining|reset-requests|tokens` headers, when present.
- **Output-token parameter:** `max_completion_tokens` for `*.openai.com` hosts, and `max_tokens` for
  every other server.
- **JSON mode** guarantees syntactically valid JSON only on servers that implement it. The decision
  schema is enforced by Luck's validator, not by the server.

### Token accounting convention

Luck keeps input buckets **non-overlapping** so that cost estimates never double count:

| Field | Anthropic | OpenAI-compatible | Ollama |
|---|---|---|---|
| `inputTokens` | `input_tokens` | `prompt_tokens − cached_tokens` | `prompt_eval_count` |
| `cacheReadTokens` | `cache_read_input_tokens` | `cached_tokens` | — |
| `cacheWriteTokens` | `cache_creation_input_tokens` | — | — |
| `outputTokens` | `output_tokens` | `completion_tokens` | `eval_count` |
| `reasoningTokens` (subset of output, not added again) | `thinking_tokens` | `reasoning_tokens` | — |

## Pricing assumptions (estimates only)

`src/server/providers/pricing.ts` contains **default assumptions** for Anthropic models. They are
list prices in USD per million tokens, recorded on **2026-06-24** from the Claude API reference
bundled with Claude Code.

- They are **not** fetched from Anthropic and may be out of date. Check the current Anthropic
  pricing page and override them in Settings. Your values always win over the defaults.
- Cache reads are assumed to cost 0.1 × input and 5-minute cache writes 1.25 × input, **except**
  where the reference states a different figure (Fable 5.1 cache read $0.25, Opus 5.5 cache read
  $0.20, and so on). Luck does not use prompt caching on purpose, so these rates only matter if the
  API reports cached tokens.
- Models whose price the reference did not state (for example Haiku 4.5 and Opus 4.5–4.7) have **no
  default**. Their cost shows as unknown until you enter pricing.
- There are no OpenAI-compatible defaults.
- Estimated cost is integer micro-USD, rounded up. The pre-request budget check uses a worst case:
  every input token at the higher of the input and cache-write rates, plus the full
  `maxOutputTokens` allowance.

| Model id | Input $/MTok | Output $/MTok | Cache read | Cache write (5 min) |
|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 50 | 0.25 (stated) | 12.50 (stated) |
| `claude-mythos-5-1` | 10 | 50 | 1.00 (0.1× assumption) | 12.50 |
| `claude-fable-5` | 10 | 50 | 1.00 (stated) | 12.50 |
| `claude-mythos-5` | 10 | 50 | 1.00 | 12.50 |
| `claude-opus-5-5` | 4 | 20 | 0.20 (stated) | 5.00 (stated) |
| `claude-opus-5` | 5 | 25 | 0.50 | 6.25 |
| `claude-opus-4-8` | 5 | 25 | 0.50 | 6.25 |
| `claude-sonnet-5` | 2 | 10 | 0.20 | 2.50 |
| `claude-sonnet-4-6` | 3 | 15 | 0.30 | 3.75 |

The **app spending limit** (`budgetMicros`) is optional and enforced by Luck. By default it is **not set**
(sessions run until the balance is exhausted or you press Stop). When you set one, it is checked conservatively
before every paid request. It is not a provider quota, and it is not what the provider will bill.

## Running Ollama locally

1. Install Ollama from https://ollama.com (Windows, macOS, Linux) and start it. The desktop app runs
   the server, or you can run `ollama serve`.
2. Pull a model, for example:
   ```sh
   ollama pull llama3.2:3b
   ollama list
   ```
   Pick any model you like. Small instruction-tuned models (3–8B) answer quickly. Luck has no
   built-in default.
3. Keep `OLLAMA_BASE_URL=http://127.0.0.1:11434` (the default) and restart Luck.
4. In the sidebar, choose **Ollama**, press **Test connection** (it calls `/api/version` and
   `/api/tags`), then choose one of the installed models.

Reasoning models (for example qwen3 or deepseek-r1) may spend the output-token budget on thinking.
If decisions fail with "raise max output tokens", increase **Max output tokens** in the session
limits.

## Troubleshooting

| Message / code | Likely cause | What to do |
|---|---|---|
| `unavailable` … connection refused | Ollama or local server not running, wrong port | Start it and check the base URL. `curl http://127.0.0.1:11434/api/version` should answer. |
| `bad_request` … 404, `model 'x' not found` | Model not installed / wrong id / wrong base path | `ollama pull x`. For OpenAI-compatible endpoints, check that `/v1` is in the base URL. |
| `auth` (401/403) | Missing, wrong or revoked key; no access to the model | Fix the key in `.env` and restart. For Anthropic, `ANTHROPIC_API_KEY` alone is used, and `ANTHROPIC_AUTH_TOKEN` is ignored. |
| `rate_limited` (429) | Provider rate limit | The session pauses. Wait for `retryAfterMs`, or lower the pace. The rate-limit headers show which limit was hit. |
| `server_error` 529 | Anthropic overloaded | Wait and retry later, or pick another model. |
| `timeout` | Model slower than **Decision timeout** (first Ollama call may include loading the model) | Raise the timeout, or use a smaller model. |
| `invalid_output` "raise max output tokens" | Output cut off | Increase **Max output tokens**. |
| `bad_request` mentioning `temperature` | The model rejects sampling parameters | Clear the temperature field. |
| `bad_request` mentioning `output_config` / structured output | The model does not support structured outputs | Choose a model that does. |
| Decision rejected: "Unrecognized key", "expected exactly one JSON object" | Model added fields, prose with several objects, or markdown | This is shown as invalid output and retried within the bounded retries. It is never repaired. Try a stronger model or a lower temperature. |
| Cost shows "unknown" | No pricing for this model, or the server did not report usage | Enter pricing in Settings. Unknown usage is never estimated. |

## Test status

Adapter tests run against **local mock HTTP servers on ephemeral ports** (fixtures). The Anthropic
tests point the official SDK at such a server:

```sh
npx vitest run src/shared/decision.test.ts src/server/providers/httpUtil.test.ts src/server/providers/ollama.test.ts src/server/providers/anthropic.test.ts src/server/providers/openai.test.ts src/server/providers/pricing.test.ts
```

None of the three providers on this page was called live during development. Ollama was not installed and
no API keys were set on the build machine, so live behaviour against real Ollama, Anthropic and OpenAI
endpoints is **untested**. (The Claude Code CLI and Laya players were tested live — see
[providers-cli-laya.md](providers-cli-laya.md) and [verification.md](verification.md).)

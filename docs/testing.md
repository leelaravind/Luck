# Testing

All tests use [Vitest](https://vitest.dev). Nothing in the default test run contacts a real AI provider,
spends money or needs an API key: every provider in the suites below is a **FIXTURE** (a scripted test double),
and every winning number comes from a **FIXTURE outcome source** (a scripted sequence), injected only in tests.

## Running the suites

```bash
npm test                                   # everything (unit + e2e + security)
npx vitest run tests/e2e                   # end-to-end API flows only
npx vitest run tests/security              # HTTP security checks + secret scanner tests
npx vitest run tests/e2e/manual-session.test.ts   # one file
npm run typecheck                          # tsc for the web/test project and the server project
node scripts/secret-scan.mjs               # pre-commit secret scan of this repository (exit 1 on findings)
                                           # (also: npm run secret-scan)
gitleaks git . --config .gitleaks.toml     # optional, if gitleaks is installed: full-history scan, as CI runs it
```

On Windows, if `npx` fails because npm's configured cache points to a drive that no longer exists, give npm a
cache for this shell only instead of changing the global configuration:

```bash
# Git Bash
export npm_config_cache="$PWD/tmp/npm-cache"
# PowerShell
$env:npm_config_cache = "$PWD\tmp\npm-cache"
```

`tmp/` is gitignored. The e2e and security suites write their SQLite files and fixtures to `tmp/10/` and delete
them afterwards. They never write outside the repository.

Tests that need a real socket (SSE, raw `Host` headers) listen on an **ephemeral port** (the OS picks a free port).
They never use 3717 or 5717, so they can run while `npm run dev` is running.

## Fixture vs. live

| What | In the default run | How it is labelled |
|---|---|---|
| Winning numbers | FIXTURE sequence (`createFixtureOutcomeSource`), call-counted by the e2e harness | "FIXTURE outcome sequence" in suite names |
| AI players | `FixtureAdapter` in `tests/e2e/harness.ts`: returns scripted text/errors, records every request, never uses the network | every test name contains **FIXTURE** |
| Demo player | the real rule-based demo player (it is not AI and needs no credentials) | "rule-based demo player" |
| Engine, bet validation, settlement, repository, service, HTTP layer | **real** code, real SQLite file, real Fastify app | — |
| Live provider tests (Ollama, Anthropic, OpenAI-compatible, Claude Code CLI, Laya) | **not part of the default run** | see `docs/providers.md` / `docs/providers-cli-laya.md` |

A passing e2e or security suite proves how the **backend behaves with any adapter that follows the
`ProviderAdapter` contract**. It does not prove that a particular real provider is reachable, answers well or
reports usage correctly — that is only ever claimed from a live test that was actually run.

## What each end-to-end suite proves

All e2e suites drive the integrated backend as a black box over HTTP (`app.inject()`, plus a real listen for
SSE), sending the headers a same-origin browser would send (`Host`, `Origin`, `Sec-Fetch-Site`,
`X-Luck-Client: 1`, `Idempotency-Key`). The shared harness also puts a fake API key
(`sk-ant-test-SECRET123`) into every server config and each suite asserts it never appears in any response.

### `tests/e2e/manual-session.test.ts` — manual play
- Five scripted rounds (straight, split with zero given as `[3, 0]`, corner + dozen + red, a zero that loses the
  outside bets, a black number): per-round `stakeReturned`, `winnings`, `totalReturned`, `net`,
  `balanceBefore/After` and per-bet `returned` equal hand-computed integer values; canonical bet keys.
- JSON export: one `session_start`, one `stake` per round, at most one `payout` per round, running
  `balanceAfter` exact, ledger sum == session balance.
- CSV export: exact header (`round … balance_after`), one row per round, money as exact decimal credits.
- Rejected slips (illegal splits/corner, fractional stake, off-increment stake, over per-bet / per-round /
  bet-count limits, bad dozen index, over balance) → `422` `ApiErrorBody`; balance, rounds and the outcome
  source are untouched.
- Idempotency: replaying `POST /rounds` with the same key returns the same round and charges once (also when
  both requests arrive concurrently); two concurrent submissions with different keys settle as two sequential
  rounds with consistent balances, never a double settlement.

### `tests/e2e/demo-session.test.ts` — demo player and session control
- `start` → exactly `maxRounds` (5) settled rounds, `completed` / `max_rounds`, every decision labelled
  `providerKind: 'demo'`, SSE stream (real socket) delivers snapshot and settled-round events.
- Repeated `start` clicks (concurrent, distinct keys) never create a second runner; `start` after completion is
  refused; replaying a control key has no further effect.
- `pause` waits for the round to settle, then nothing runs while paused; `step` plays exactly one round and
  pauses with `step_complete`; `stop` is terminal (`user_stop`) and later `start`/`step` are refused.

### `tests/e2e/ai-session.test.ts` — autonomous AI with FIXTURE adapters
- Valid decisions become exactly the scripted rounds (one model call per round; `skip` plays a no-bet round);
  usage is recorded per attempt with `local-no-charge` for a local provider.
- Stop during a slow decision aborts the adapter's `AbortSignal`; the late (valid) answer is recorded as
  `stale`/`cancelled` and never becomes a bet; the epoch increases.
- Provider errors: bounded retries (1 + `maxRetries` attempts), then `paused` / `provider_error`, failed
  attempts counted, no fallback to the demo player, no background retries.
- `maxConsecutiveFailures` contract check (pause only after N failed decisions) — see *Known failures*.
- Invalid output (prose, unknown action/field, illegal split, fractional/over-balance stake, two JSON objects)
  → decision `invalid`, session `paused` / `invalid_output`, no round, no outcome drawn.
- Budget: a budget that cannot cover one request blocks it before the adapter is called; with a real budget,
  spending stops before it is exceeded (`budget_exhausted`), blocked requests are never sent.
- Observation: every request the adapter receives contains only `GameObservation` keys (recursively), no
  internal ids, no secret, history bounded by `historyWindow` and consistent with the ledger, and **the
  pending round's outcome had not been drawn when the model was asked** (outcome-source call count).
- No provider call happens without an explicit Start.

### `tests/e2e/restart-recovery.test.ts` — crash recovery on a file database
Crash states are written through the `Repository` directly: a committed round without outcome, a round with a
recorded but unsettled outcome, an AI session `running` with a `pending` decision, and a demo session `running`
with an unsettled round. A new repository + service + app on the same file then calls `recover()`:
- each round is settled exactly once; stored outcomes are used as stored (the fixture source is called once —
  only for the round that had no outcome);
- running sessions become `paused` / `server_restart`; the pending decision becomes `interrupted`;
- no adapter is called and nothing resumes on its own;
- a second restart is a no-op (0/0/0, same balances, one payout per round), and an explicit Start resumes the
  demo session consistently at round 2.

## What the security suites prove

### `tests/security/http-security.test.ts`
- Foreign `Host` values (incl. rebinding-style names and LAN IPs) → `403` (via `inject()` and a raw socket).
- `Origin: http://evil.example`, another local port, `Origin: null`, and `Sec-Fetch-Site: cross-site` → `403`
  on GET, POST and the SSE stream, with no side effects.
- State-changing requests without `X-Luck-Client` → `403` (including a text/plain "simple" form POST).
- No `Access-Control-Allow-*` header on any response, including an OPTIONS preflight.
- `Content-Security-Policy` (with `default-src 'self'`, no `unsafe-eval`) and `X-Content-Type-Options: nosniff`
  on API responses and on the served `index.html` (requested like a browser navigation).
- A FIXTURE adapter that echoes its API key in errors and connection-test messages: the key never reaches any
  response body or header, decision, log, JSON/CSV export or console output; the echoed text arrives
  **redacted** (so the check is not vacuous). A second case builds the config with `loadConfig()` and a key
  with no recognisable shape, proving the exact-value redaction layer.
- Internal errors → `500` `internal` without stack traces, file paths, the internal message or secrets; the
  server log records the failure without the secret. Malformed JSON / missing `Idempotency-Key` → `400`;
  unknown `/api` route → `404` `ApiErrorBody`.

### `tests/security/secret-scan.test.ts` and `scripts/secret-scan.mjs`
The scanner lists files with `git ls-files --cached --others --exclude-standard` (what a commit could publish)
and flags Anthropic / `sk-` style / GitHub / AWS / Slack keys, PEM private keys, generic
`api_key = '<long random>'` assignments, and forbidden files (`.env*` except `.env.example`, SQLite files,
`*.pem`/`*.key`, `client_secret*.json`, `credentials*.json`, SSH keys). Output is always redacted. The test plants one
secret per rule in a throw-away fixture (assembled at runtime so the test source stays clean), checks
placeholders/hand-written fakes/suppressed lines are not flagged, checks redaction and exit codes, and runs
the scanner over this repository in git mode (read-only), which must be clean.

Allow-listed: `sk-ant-test-SECRET123`, placeholders (`xxxx`, `<…>`, `your-key`, `changeme` …), generic
assignments in `.env.example`, lines marked `secret-scan:allow`, and obviously hand-written values (marker words
such as `test`/`fixture`, words-only key bodies, `123456`/`abcdef` runs). Binary files and files over 2 MiB are
not content-scanned (their names are).

## Known failures (reported, not hidden)

- `ai-session.test.ts › limits.maxConsecutiveFailures (contract)`: the session service currently pauses
  after the **first** failed decision; `SessionLimits.maxConsecutiveFailures` is validated but not used by the
  runner. The test asserts the contract ("consecutive failed decisions before the session pauses") and fails
  until the runner implements it or the contract is changed.

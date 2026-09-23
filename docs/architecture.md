# Architecture

Luck is a single local application: a Fastify backend (Node 22.22.2+, 24.15+ or 26+, TypeScript) that owns every game rule and
every credit, a React + Vite frontend that only displays state and sends requests, and a SQLite file
(`data/luck.db`, via the built-in `node:sqlite`) that makes sessions durable.

```
 Browser (React, Tailwind compiled locally)
   │  fetch /api/*  (X-Luck-Client + Idempotency-Key)      ▲  Server-Sent Events /api/events
   ▼                                                       │
 Fastify app  ── security hooks: loopback bind, Host allow-list, Origin / Sec-Fetch-Site checks, CSP
   │
   ▼
 GameService (session/) ── owns sessions, the autonomous runner, budgets, retries, recovery
   │        │                    │
   │        ▼                    ▼
   │   engine/ + shared/bets     providers/  (Ollama · Anthropic · OpenAI-compatible · Claude Code CLI · Laya)
   │   validation, settlement    each returns typed results; never sees the engine or the RNG
   ▼
 Repository (db/sqlite.ts) ── transactional commit → outcome → settle, ledger, decisions, usage, logs
```

## Shared contracts

`src/shared/contracts.ts` is the single source of truth for data crossing module boundaries:

- **Money** is always an integer number of *subunits* (100 subunits = 1 credit, shown as `V$ 1.00`).
  Costs and budgets are integer micro-USD.
- **Bets** (`BetInput` → `ResolvedBet`), **rounds** (`RoundRecord`, `Settlement`), **sessions**
  (`SessionInfo`, `SessionSnapshot`), **decisions** (`DecisionRecord`), **usage** (`UsageRecord`,
  `UsageSummary`), provider **capabilities** and the uniform **error body** (`ApiErrorBody`).
- `src/server/types.ts` holds server-only interfaces (`Repository`, `ProviderAdapter`, `GameService`).

## Round lifecycle (backend-authoritative)

```
ready ─► requesting_decision ─► committed ─► outcome_recorded ─► settled
          (AI/demo only)         T1: bets saved,   T2: crypto.randomInt   T3: returns credited
                                 stake deducted    drawn and saved        exactly once
```

1. **Commit (T1)** — the bet slip is validated by `validateBetSlip` (legal combination, stake increment,
   per-bet and combined limits, balance). Bets are written and the stake deducted in one transaction.
   Only one unsettled round may exist per session.
2. **Outcome (T2)** — only *after* the commit is durable, the outcome source draws a uniform integer
   0–36 with `crypto.randomInt`. An existing outcome is never replaced.
3. **Settle (T3)** — `settleBets` computes stake returned, winnings (profit) and net with integer math;
   the repository credits the balance and writes a single `payout` ledger row. A second settle attempt
   is a no-op.

The wheel animation starts only after T3 and is purely presentational: refreshing or closing the tab
cannot lose or repeat a settlement. The UI hides the new result until the wheel reports `onSettled`, so
the spin is not spoiled, but the balance on the server is already final.

## Sessions and the autonomous runner

```
ready ──start──► running ──pause──► pause_requested ──(round ends)──► paused ──start──► running
  │                 │                                                    │
  └──step──► (one round) ──► paused (step_complete)                      │
  any non-terminal ──stop──► stop_requested ──(committed round settles)──► stopped (terminal)
  balance below the minimum stake, or an opt-in limit (rounds, runtime, budget, model "stop") ──► completed (terminal)
```

- One runner and at most one in-flight model decision per session.
- **Stop** aborts an in-flight request; any late response is discarded as *stale* (session epoch check)
  while its usage is still recorded. A round whose bets are already committed still settles.
- **Pause after round** lets the current round finish and schedules nothing further.
- Provider failures are retried a bounded number of times with back-off (honouring `Retry-After`),
  then the session **pauses** with the error shown. Invalid model output is never converted into a
  different bet, and a failing AI never silently switches to the demo player.
- Between autonomous rounds the server waits `roundPacingMs` (Settings → *Pause between autonomous rounds*,
  default 7 s, 0–600 s, the same for every autonomous session). That pause — not the wheel — decides how often a
  model is asked. The animation speed changes only the wheel animation. Each round makes exactly one decision
  request (plus the bounded retries below).
- After a restart, unfinished rounds are completed without redrawing an existing outcome, running
  sessions come back **paused**, and in-flight decisions are marked *interrupted* with unknown usage.
  Nothing calls a model until the user presses Start again.

## What a model sees

A model receives only a `GameObservation`: rules, payouts, limits, its balance, and a bounded history of
*settled* rounds. The prompt asks it to follow and adapt a named betting system; it deliberately contains no
house-edge commentary (that disclaimer is shown to the user in the UI and README instead). It never receives RNG state, the pending round, database ids, configuration or secrets.
One exception to "only": the **Claude Code CLI** adds context of its own to every conversation it runs — the
working directory, OS/shell details and, with a claude.ai subscription login, your account e-mail. Luck cannot
switch that off (Claude Code 2.1.280 has no supported flag for it with subscription login); it goes to the same
Anthropic account the CLI is logged in to. Details: [providers-cli-laya.md](providers-cli-laya.md#what-the-model-sees).
It answers with `{"action": "bet" | "skip", "bets": [...], "strategy": "...", "explanation": "..."}` ("stop" only
when the session allows the model to end it), which is parsed
strictly (`parseDecision`) and then validated by the same rules as a human bet.

## Usage, cost and budgets

- Every attempt (including failed and retried ones) produces a `UsageRecord`. Token counts are stored
  only when the provider reports them; unknown usage is flagged, never guessed.
- Cost basis is explicit: *provider-reported* (Claude Code CLI's own estimate), *estimated from pricing*
  (tokens × a labelled pricing assumption), *local — no cloud inference charge*, or *unknown*.
- The optional **app spending limit** (off by default — sessions then run until the balance is exhausted or
  the user stops) is checked conservatively *before* every paid request using the worst case
  (estimated prompt tokens + the maximum output tokens). It is distinct from any provider quota, which
  is shown only when the provider actually reports rate-limit information.

## Security model

- Binds to loopback only; any other `LUCK_HOST` is refused at startup.
- Host-header allow-list (DNS-rebinding protection), Origin and `Sec-Fetch-Site` checks, a required
  `X-Luck-Client` header on state-changing requests (forces a CORS preflight that is never granted),
  no CORS headers from the API, a strict Content-Security-Policy.
- In development the browser talks to the Vite dev server, which proxies `/api` to the API. Vite is configured
  not to send CORS headers either (`server.cors: false`) and to serve only `src/web`, `src/shared` and
  `node_modules`; the database, `data/`, `tmp/`, `.env*` and `.git` get `403` (`server.fs`, see
  [configuration.md](configuration.md#http-security-for-reference) and `tests/security/vite-dev.test.ts`).
- API keys live only in the server's environment (`.env`, gitignored). They are never sent to the
  browser, stored in SQLite, logged or exported; error messages pass through a redactor.
- The Claude Code CLI path comes only from `.env`; the HTTP API cannot choose an executable. The CLI is
  spawned without a shell, with all tools, MCP servers and settings disabled, in an empty sandbox folder
  **outside the repository** (`<OS temp folder>/luck-cli-sandbox`); each Luck session keeps one Claude Code
  conversation (`--session-id`, then `--resume`). The CLI adds its own context to that conversation (see
  "What a model sees").

See also: [providers.md](providers.md), [providers-cli-laya.md](providers-cli-laya.md),
[configuration.md](configuration.md), [testing.md](testing.md), [troubleshooting.md](troubleshooting.md).

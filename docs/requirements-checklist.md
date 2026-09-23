# Requirements checklist

## Increments and delivery gates

Built in three small increments, each integrated, tested and independently reviewed (A11) before the next:

1. **Manual roulette** — valid bets, correct payouts, wheel alignment, saved rounds.
2. **Autonomous play** — provider adapters, validated decisions, usage tracking, session controls.
3. **Product readiness** — recovery, security, accessibility, exports, setup docs, GitHub delivery.

Journey under review: clean checkout → install → configure → launch → select player → start session →
place validated bets → spin → settle → update usage/history → pause/stop → restart → recover → export.

| Gate | Passes when |
|---|---|
| Correctness | rules, accounting and all 37 wheel outcomes verified |
| Reliability | duplicate actions, stale responses, failures and restart recovery verified |
| Security | credentials protected, localhost boundaries enforced, spending controls effective |
| Usability | desktop/mobile inspection done, errors are clear |
| Reproducibility | README commands verified from a clean checkout |
| Evidence | live-provider tests separated from fixtures; remaining gaps disclosed |

Not release-ready while any critical or high-severity defect is open. Defects get an owner, a fix and a retest;
the reviewer confirms closure.

**Status values** (every row has one):

- **verified** — checked against the running app or a real provider, by a command's real output, or by an
  automated test that runs the real code path with no test double where it matters (a real SQLite file, real
  `crypto.randomInt`, a real hard process kill). The evidence is named.
- **implemented (fixture-tested)** — covered by automated tests that use a fixture (scripted provider, scripted
  outcome sequence, mock HTTP server, jsdom rendering), but not checked live.
- **not verified** — built, but the requirement as written has no recorded check yet.

Owners refer to the build allocation (A1–A10 implementation, A11 independent reviewer, L = lead). Evidence is a
test file (› test name), a section of [verification.md](verification.md) ("V›" below), or a document. "Audit #n" is
an item of the final audit taken up in the latest fix round ("fix round"); outcomes and test counts are in
verification.md.

## Setup & delivery
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| S1 | TypeScript frontend + local Node backend + SQLite persistence | L/A1 | verified | V› Automated checks (typecheck, build); `src/server/db/sqlite.test.ts` (real SQLite file) |
| S2 | Bind to localhost only; refuse non-loopback HOST | A1 | implemented (fixture-tested) | `src/server/config.test.ts` › "LUCK_HOST must be loopback" (0.0.0.0, LAN IPs, `::`, host names refused); `tests/security/http-security.test.ts` › real socket |
| S3 | One documented command starts frontend + backend (`npm run dev`), plus single-port `npm start` | A1 | verified | README §5; V› Live checks (single-port production); the app is run with `npm run dev` |
| S4 | Windows-first scripts (start.ps1) + macOS/Linux (start.sh), work from any cwd | A1 | not verified | scripts exist; only dry-run tested by the setup agent, not run on real macOS/Linux (V› Not verified yet) |
| S5 | Lockfile, .env.example, .gitignore, simple README, CI workflow | A1/L | verified | files in the repository; `.github/workflows/ci.yml`; V› Clean checkout; `.gitignore` extended in audit #16 (`tests/security/repo-hygiene.test.ts`) |
| S6 | Tailwind compiled locally (no CDN), fonts bundled locally | A1/A4 | verified | V› Automated checks (`npm run build`: CSS compiled, `.woff2` fonts in `dist/web/assets`) |
| S7 | Design exports preserved unchanged in design-references/ (sha256 match) | L | verified | sha256 of code.html/DESIGN.md/screen.png identical to H:\LUCKY\stitch_ai_roulette_lab; `tests/security/repo-hygiene.test.ts` (pinned sha256, `git check-attr` → `text: unset`, audit #19) |
| S8 | Third-party notices (MoneyPrinterTurbo MIT pattern credit, Stitch skill Apache-2.0, fonts OFL, Laya Apache-2.0); project licence choice flagged | L | verified | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) (font packages OFL-1.1, audit #18); README "Licence: NOT YET CHOSEN" |
| S9 | Secret scan before commit; commit + push without force | L | verified | `npm run secret-scan` clean (V› Automated checks; works without git too, audit #12); gitleaks full-history scan in CI. Exception, disclosed: the published history was rewritten once at the owner's request to remove attribution trailers, which replaced the pushed history (audit #6) |

## Game engine
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| G1 | All bet types: straight, split, street, corner, six-line, zero splits, zero trios, first four, dozens, columns, even-money | A2 | verified | `src/shared/bets.test.ts` › "has 157 distinct positions…", "returns exactly the 157 legal positions"; V› Live checks (A11: 17 live 10-bet rounds matched a hand-written oracle) |
| G2 | Standard payouts; every legal bet position checked against all 37 outcomes (incl. zero) | A2 | verified | `src/shared/bets.test.ts` › "checked 157 × 37 = 5809 (position, outcome) pairs" (hand-typed oracle); V› live payout check (black 20.00 → 40.00 back, column 10.00 → 30.00) |
| G3 | Invalid combinations, stake increments, min/max, combined stake, balance validated on backend | A2 | verified | `bets.test.ts` › "resolveBet rejects illegal bets", "validateBetSlip"; `service.test.ts` › "validates bets on the backend and never repairs them"; `tests/e2e/manual-session.test.ts` › rejected bets → 422; V› live illegal split 3/4 → 422 |
| G4 | Integer subunits only (100 = 1 credit); fractional-credit accounting exact | A2/A3 | verified | `bets.test.ts` › "integer subunit accounting"; `useBetDraft.test.tsx` › exact integers; `export.test.ts` › formatSubunitsDecimal; V› live round 1 000.00 → 998.40 |
| G5 | Uniform 0–36 from crypto.randomInt; deterministic fixtures only via test injection | A2 | verified | `src/server/engine/rng.test.ts` (real `crypto.randomInt`, chi-square), `rng.delegation.test.ts`; `fixtureOutcome.test.ts` › "production wiring cannot reach the fixture source" |
| G6 | Bets committed (persisted) before outcome drawn | A3/A9 | implemented (fixture-tested) | `service.test.ts` › "draws the outcome only after the bets are committed (spy ordering)"; `tests/e2e/ai-session.test.ts` › observation test (outcome not drawn when the model was asked) |
| G7 | Bets, outcome, settlement persisted transactionally; settled exactly once | A3 | verified | `src/server/db/crash.test.ts` (hard process kill at 4 commit boundaries, real SQLite); `sqlite.test.ts` › rollback tests; V› A11: 4 concurrent identical requests → one round. Audit #1 (transactions on Node 22.13–22.15), fix round: minimum Node raised to 22.22.2 / 24.15, and the database code no longer relies on `isTransaction` (`src/server/db/legacy-node.test.ts`) |
| G8 | Stake returned, winnings (profit) and net round result distinguished | A2/A3/A5 | verified | `bets.test.ts` › "multi-bet settlement"; `manual-session.test.ts` › "settles five scripted rounds exactly as hand-computed"; V› live payout check |
| G9 | Virtual credits only, labelled in UI | A4 | verified | `src/web/App.test.tsx` (asserts "Virtual credits"); header/control bar label; V› UI at 1440 px; README "Virtual credits only" |

## Wheel
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| W1 | Correct 37-pocket European sequence and colours | A6 | verified | `wheelMath.test.ts` › "WHEEL_ORDER and colours match the physical wheel" (independent hand-typed oracle, D8); `RouletteWheel.test.tsx` › "places all 37 wedges…" |
| W2 | Separate stationary housing, rotor, ball, highlight | A6 | implemented (fixture-tested) | `RouletteWheel.test.tsx` › "draws separate housing / rotor / highlight / ball layers" (jsdom) |
| W3 | Accepts roundId + winningNumber; never picks outcomes or payouts | A6 | implemented (fixture-tested) | `RouletteWheel.test.tsx` › "an invalid winningNumber is not animated, not settled and not replaced"; `wheelMath.test.ts` › "presentation randomness never changes the landing pocket" |
| W4 | Rotor and ball opposite directions, ball moves inward, settles exactly in supplied pocket; stays attached | A6 | implemented (fixture-tested) | `wheelMath.test.ts` › "kinematics"; `RouletteWheel.test.tsx` › "renders rotor clockwise and ball counter-clockwise", "keeps the ball attached". A live animation watched end to end is not recorded (V› Not verified yet) |
| W5 | onSettled exactly once per roundId | A6 | implemented (fixture-tested) | `RouletteWheel.test.tsx` › "settle bookkeeping" (incl. StrictMode); `wheelAnimator.test.ts` |
| W6 | Consecutive spins, resize, reduced motion, background tabs | A6 | implemented (fixture-tested) | `RouletteWheel.test.tsx` › consecutive spins, reduced motion, hidden tab; `wheelAnimator.test.ts` › watchdog; scalable viewBox |
| W7 | All 37 landing positions verified (math + rendered DOM) | A6/A10 | verified | `wheelMath.test.ts` › "lands exactly on every number…"; `RouletteWheel.test.tsx` › "for all 37 numbers (consecutive spins) the rendered angles land in the supplied pocket"; V› running app `data-landed-number` 34 |

## Play modes & session control
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| P1 | Manual virtual betting end to end | A5/A9 | verified | V› Live checks (manual round over HTTP); `tests/e2e/manual-session.test.ts`; `App.test.tsx` › manual round per click burst |
| P2 | Autonomous AI play | A9 | verified | V› Providers (live Claude Code CLI and Laya sessions); `tests/e2e/ai-session.test.ts` |
| P3 | Clearly labelled rule-based demo player (no credentials) | A9 | verified | V› Live checks (A11 demo sessions); `units.test.ts` › "labels itself and states it has no predictive ability" |
| P4 | One active round + one in-flight decision per session | A9 | implemented (fixture-tested) | `service.test.ts` › "repeated start never creates a second runner; at most one decision is in flight"; `demo-session.test.ts` › repeated Start; manual part checked live (V› A11: 4 concurrent requests → one round) |
| P5 | Start / Pause after round / Stop / Next Round with precise semantics | A9/A5 | verified | V› Live checks (A11: demo start / pause after round / step / stop); `tests/e2e/demo-session.test.ts`; `ControlBar.test.tsx` › enableState matrix |
| P6 | Stop during request cancels + rejects late decision; stop after commit settles that round | A9 | verified | V› Live checks (A11: Stop during an in-flight decision cancelled it and bumped the epoch); `service.test.ts` › "stop during an in-flight decision…", "stop after the bets are committed…" |
| P7 | Stale responses rejected after stop/reset/session change (epoch) | A9 | implemented (fixture-tested) | `runner.test.ts` › "epoch check…", "a result that arrives in the same tick as Stop is discarded"; `ai-session.test.ts` › slow adapter; live only for Stop (P6) |
| P8 | Optional limits, none by default: max rounds, runtime, stake per bet / per round, bets per round, output tokens, app spending limit | A9 | verified | V› "No stopping limits by default", "All game limits optional" (live); `service.test.ts` › "limits end autonomous sessions before any further request"; `manual-session.test.ts` › "default session has no table limits…"; `useLimitsForm.test.ts` › blank = no limit |
| P9 | Bounded retries; rate limit / timeout / invalid output / disconnect handled → pause | A9/A7/A8 | verified | V› Live checks (A11: provider failure paused after bounded retries); `service.test.ts` › "provider failures, invalid output and budgets"; `ai-session.test.ts` › failing adapter |
| P10 | No auto-resume of paid calls after restart; no background runs without explicit start | A9 | implemented (fixture-tested) | `tests/e2e/restart-recovery.test.ts`; `ai-session.test.ts` › "no provider call happens without an explicit Start (P10)"; `service.test.ts` › recover() |
| P11 | Duplicate requests (Idempotency-Key) and repeated clicks safe | A9/A1/A5 | verified | V› Live checks (key replay, D3 → 409 live); `manual-session.test.ts` › same/different keys; `ControlBar.test.tsx` › double click fires once |
| P12 | Invalid model output never silently converted; disconnected AI never switches to demo | A9 | implemented (fixture-tested) | `ai-session.test.ts` › "invalid output: never becomes a bet"; `decision.test.ts`; `laya.test.ts` › unknown label; no-demo-fallback also seen live (V› A11) |
| P13 | Animation speed independent of model request frequency | A9/A6 | implemented (fixture-tested) | audit #4: the server wait is now `roundPacingMs` (Settings → Pause between autonomous rounds, default 7 s); `service.test.ts` › "#4: the wait between rounds is roundPacingMs; the animation speed never changes it (or the call count)". Not re-checked live after the fix |

## AI connections
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| C1 | Common provider interface with capability flags | L/A7 | verified | typecheck (`ProviderAdapter` in `src/server/types.ts`); `service.test.ts` › "lists every AI provider with capabilities…" |
| C2 | Ollama: endpoint, model, connection test, installed models, real usage | A7 | implemented (fixture-tested) | `src/server/providers/ollama.test.ts` (local mock server); not installed on the build machine (V› Providers) |
| C3 | Anthropic Messages API adapter | A7 | implemented (fixture-tested) | `anthropic.test.ts` (official SDK pointed at a local mock server); no API key available |
| C4 | OpenAI-compatible adapter with explicit endpoint/model | A7 | implemented (fixture-tested) | `openai.test.ts` (mock server / stubbed fetch) |
| C5 | Claude Code CLI via supported headless flags; tools/MCP/settings disabled; boundary enforced or adapter disabled | A8 | verified | live `init` event: tools `["StructuredOutput"]`, no MCP servers ([providers-cli-laya.md](providers-cli-laya.md) › Live verification); `claudeCli.test.ts` › argv, boundary_violation. The CLI still adds its own context (audit #28, disclosed) |
| C6 | Optional Laya adapter via local `laya-serve` HTTP; optional deps separate; classifier honesty | A8 | verified | live 3-round session (V› Providers; 13 labels, no `stop`, audit #8); `laya.test.ts`; [optional/laya/README.md](../optional/laya/README.md) |
| C7 | Models see only GameObservation; no outcome leakage (tested) | A9 | implemented (fixture-tested) | `ai-session.test.ts` › "the observation is a GameObservation built only from settled history"; `service.test.ts` › "sends only the GameObservation…"; `units.test.ts` › buildObservation. Exception: the Claude Code CLI adds its own context (working directory, OS, account e-mail) — audit #28, [providers-cli-laya.md](providers-cli-laya.md#what-the-model-sees) |
| C8 | Decisions validated independently (schema + rules) | A7/A9 | verified | `decision.test.ts`; `validateBetSlip` (G3); V› live CLI and Laya decisions validated by the engine |

## Usage & cost
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| U1 | Per-decision + session input/output tokens when reported; cached/reasoning separate | A9/A7/A8 | implemented (fixture-tested) | recorded per attempt: `units.test.ts` › "usage accounting"; `openai.test.ts` › mapOpenAIUsage; adapter tests. Per-decision display in the UI: audit #5 (fix round) |
| U2 | Latency and meaningful generation speed | A7/A9 | implemented (fixture-tested) | `units.test.ts` › "computes throughput from generation time, else latency"; CLI API time is now the per-turn increase (audit #2, `claudeCli.test.ts`) |
| U3 | Estimated cost clearly labelled with pricing assumptions | A9/A4 | implemented (fixture-tested) | `pricing.test.ts`; `units.test.ts` › "cost basis…"; [providers.md](providers.md) › Pricing assumptions |
| U4 | No fabricated quotas; app budget vs provider quota vs subscription distinguished | A4/A8 | verified | live CLI `rate_limit_event` windows shown as reported ([providers-cli-laya.md](providers-cli-laya.md) › Live verification); `availability.test.ts`; capabilities `quotaInfo` |
| U5 | Local inference shows no cloud charge; no invented output tokens for Laya | A7/A8 | verified | V› Providers (live Laya: output tokens "not applicable", no cloud charge); `laya.test.ts` › output tokens never 0 |
| U6 | Failed/retried requests counted; unknown usage flagged | A9 | implemented (fixture-tested) | `units.test.ts` › "builds a record per attempt and summarises failed / unknown / partial cost"; `runner.test.ts` › watchdog (late usage recorded once); `ai-session.test.ts` › failed attempts counted |
| U7 | Conservative pre-request budget enforcement | A9 | implemented (fixture-tested) | `units.test.ts` › "budget pre-check"; `service.test.ts` › budget tests; `ai-session.test.ts` › paid adapter. CLI costs were over-counted before audit #2, which stopped budgeted CLI sessions early; per-turn deltas since the fix round (`claudeCli.test.ts`) |

## Persistence & security
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| D1 | Sessions, settings, round ledgers, decisions, usage saved | A3 | verified | `sqlite.test.ts` › "persistence across close/reopen" (real SQLite file); `restart-recovery.test.ts` |
| D2 | CSV + JSON export, no secrets | A3 | verified | V› live CSV export; `export.test.ts`; `http-security.test.ts` › leaky adapter: exports secret-free. Audit #33 (a key echoed in a model answer): fix round |
| D3 | Restart recovery: no duplicate settlement, never redraw existing outcome, sessions paused | A3/A9 | verified | `crash.test.ts` (real hard kill); `tests/e2e/restart-recovery.test.ts` › first and second restart |
| D4 | API keys server-side only; redacted from logs/errors/exports | A1/A9 | implemented (fixture-tested) | `http-security.test.ts` › "the configured API key never leaves the server"; `redact.test.ts`; `routes.test.ts` › "rejects secrets smuggled into PlayerConfig". No real API key was available for a live check |
| D5 | Host + Origin + custom-header checks; no CORS; CSP | A1/A10 | verified | V› live cross-origin POST → 403, production foreign Host → 403, strict CSP; `http-security.test.ts`, `security.test.ts`. Dev server: CORS off and file access limited since audit #3 (`tests/security/vite-dev.test.ts`, live check in V› Final audit fix round) |
| D6 | No arbitrary command execution; CLI path from .env only; model arg validated | A8 | implemented (fixture-tested) | `claudeCli.test.ts` › "binary resolution", "model validation rejects flag-like and malformed names"; audit #31 (invalid model saved through the API): fix round |

## Interface
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| I1 | One compact sidebar: model selection, connection status, real usage | A4 | verified | V› Live checks (UI at 1440 px: single sidebar, honest provider badges); `App.test.tsx` › "renders the single sidebar…" |
| I2 | Large wheel above complete European betting table | A4/A5/A6 | verified | V› Live checks (wheel above the complete table; 390 px vertical table with all 37 numbers) |
| I3 | Balance, current stake, last net, recent results (historical clearly marked) | A4/A5 | verified | `ControlBar.test.tsx` › "shows balance, session net, current stake…"; `reveal.test.ts` (history vs new result); V› UI checks |
| I4 | Collapsible logs, session history, balance chart, settings, raw JSON | A4 | implemented (fixture-tested) | `App.test.tsx` › drawer tabs with the keyboard; audit #26 (history refresh), #27 (log units), #36 (pricing Remove): fix round |
| I5 | Removed: duplicate sidebar, invented metrics, strategy claims, fake connections, FPS counter, hardcoded models | A4 | verified | V› UI at 1440 px (single sidebar, honest badges); `availability.test.ts` › Connected only from a real test; no default model in any adapter ([providers.md](providers.md) › Capabilities). Stated strategies are shown as the model's unverified claim |
| I6 | Unavailable measurements shown honestly ("not reported") | A4 | implemented (fixture-tested) | `availability.test.ts`; `NotReported` component; D7 note in V› Reviewer defects |
| I7 | Mobile readable, keyboard navigation, reduced motion | A4/A5/A6 | implemented (fixture-tested) | mobile 390 px checked live (V› Mobile); `BettingTable.test.tsx` › keyboard; wheel reduced-motion tests. A keyboard-only walkthrough and a screen-reader pass are not done (V› Not verified yet); audit #25 (focus after Spin): fix round |
| I8 | Desktop + mobile visual inspection vs Stitch reference | A10 | verified | V› Live checks (1440 px desktop) and Mobile (390 px) |

## Verification
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| V1 | build, typecheck, tests pass | L | verified | V› Automated checks (counts from the final run) |
| V2 | Complete manual session + demo session in the running UI | A10 | not verified | manual and demo sessions were run live **over HTTP** against the running app and the UI was inspected separately (V› Live checks); a complete click-through of both sessions in the UI is not recorded |
| V3 | Live provider tests only where available; fixtures clearly separated | A7/A8/A10 | verified | V› Providers: live vs fixture; [testing.md](testing.md) › Fixture vs. live |
| V4 | Independent evidence review | A11 | verified | V› Reviewer defects and closure review (A11); final audit, handled in the latest fix round (V› Final audit fix round) |

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

Status values: **verified** (evidence recorded) · **implemented-unverified** · **blocked** · **todo**.
Owners refer to the build allocation (A1–A10 implementation, A11 independent reviewer, L = lead).
Evidence must be real: a test name, a command output, or a visual check. No invented counts.

## Setup & delivery
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| S1 | TypeScript frontend + local Node backend + SQLite persistence | L/A1 | todo | |
| S2 | Bind to localhost only; refuse non-loopback HOST | A1 | todo | |
| S3 | One documented command starts frontend + backend (`npm run dev`), plus single-port `npm start` | A1 | todo | |
| S4 | Windows-first scripts (start.ps1) + macOS/Linux (start.sh), work from any cwd | A1 | todo | |
| S5 | Lockfile, .env.example, .gitignore, simple README, CI workflow | A1/L | todo | |
| S6 | Tailwind compiled locally (no CDN), fonts bundled locally | A1/A4 | todo | |
| S7 | Design exports preserved unchanged in design-references/ (sha256 match) | L | verified | sha256 of code.html/DESIGN.md/screen.png identical to H:\LUCKY\stitch_ai_roulette_lab |
| S8 | Third-party notices (MoneyPrinterTurbo MIT pattern credit, Stitch skill Apache-2.0, fonts OFL, Laya Apache-2.0); project licence choice flagged | L | todo | |
| S9 | Secret scan before commit; commit + push without force | L | todo | |

## Game engine
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| G1 | All bet types: straight, split, street, corner, six-line, zero splits, zero trios, first four, dozens, columns, even-money | A2 | todo | |
| G2 | Standard payouts; every legal bet position checked against all 37 outcomes (incl. zero) | A2 | todo | |
| G3 | Invalid combinations, stake increments, min/max, combined stake, balance validated on backend | A2 | todo | |
| G4 | Integer subunits only (100 = 1 credit); fractional-credit accounting exact | A2/A3 | todo | |
| G5 | Uniform 0–36 from crypto.randomInt; deterministic fixtures only via test injection | A2 | todo | |
| G6 | Bets committed (persisted) before outcome drawn | A3/A9 | todo | |
| G7 | Bets, outcome, settlement persisted transactionally; settled exactly once | A3 | todo | |
| G8 | Stake returned, winnings (profit) and net round result distinguished | A2/A3/A5 | todo | |
| G9 | Virtual credits only, labelled in UI | A4 | todo | |

## Wheel
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| W1 | Correct 37-pocket European sequence and colours | A6 | todo | |
| W2 | Separate stationary housing, rotor, ball, highlight | A6 | todo | |
| W3 | Accepts roundId + winningNumber; never picks outcomes or payouts | A6 | todo | |
| W4 | Rotor and ball opposite directions, ball moves inward, settles exactly in supplied pocket; stays attached | A6 | todo | |
| W5 | onSettled exactly once per roundId | A6 | todo | |
| W6 | Consecutive spins, resize, reduced motion, background tabs | A6 | todo | |
| W7 | All 37 landing positions verified (math + rendered DOM) | A6/A10 | todo | |

## Play modes & session control
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| P1 | Manual virtual betting end to end | A5/A9 | todo | |
| P2 | Autonomous AI play | A9 | todo | |
| P3 | Clearly labelled rule-based demo player (no credentials) | A9 | todo | |
| P4 | One active round + one in-flight decision per session | A9 | todo | |
| P5 | Start / Pause after round / Stop / Next Round with precise semantics | A9/A5 | todo | |
| P6 | Stop during request cancels + rejects late decision; stop after commit settles that round | A9 | todo | |
| P7 | Stale responses rejected after stop/reset/session change (epoch) | A9 | todo | |
| P8 | Limits: max rounds, runtime, stake, output tokens, API budget | A9 | todo | |
| P9 | Bounded retries; rate limit / timeout / invalid output / disconnect handled → pause | A9/A7/A8 | todo | |
| P10 | No auto-resume of paid calls after restart; no background runs without explicit start | A9 | todo | |
| P11 | Duplicate requests (Idempotency-Key) and repeated clicks safe | A9/A1/A5 | todo | |
| P12 | Invalid model output never silently converted; disconnected AI never switches to demo | A9 | todo | |
| P13 | Animation speed independent of model request frequency | A9/A6 | todo | |

## AI connections
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| C1 | Common provider interface with capability flags | L/A7 | todo | |
| C2 | Ollama: endpoint, model, connection test, installed models, real usage | A7 | todo | |
| C3 | Anthropic Messages API adapter | A7 | todo | |
| C4 | OpenAI-compatible adapter with explicit endpoint/model | A7 | todo | |
| C5 | Claude Code CLI via supported headless flags; tools/MCP/settings disabled; boundary enforced or adapter disabled | A8 | todo | |
| C6 | Optional Laya adapter via local `laya-serve` HTTP; optional deps separate; classifier honesty | A8 | todo | |
| C7 | Models see only GameObservation; no outcome leakage (tested) | A9 | todo | |
| C8 | Decisions validated independently (schema + rules) | A7/A9 | todo | |

## Usage & cost
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| U1 | Per-decision + session input/output tokens when reported; cached/reasoning separate | A9/A7/A8 | todo | |
| U2 | Latency and meaningful generation speed | A7/A9 | todo | |
| U3 | Estimated cost clearly labelled with pricing assumptions | A9/A4 | todo | |
| U4 | No fabricated quotas; app budget vs provider quota vs subscription distinguished | A4/A8 | todo | |
| U5 | Local inference shows no cloud charge; no invented output tokens for Laya | A7/A8 | todo | |
| U6 | Failed/retried requests counted; unknown usage flagged | A9 | todo | |
| U7 | Conservative pre-request budget enforcement | A9 | todo | |

## Persistence & security
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| D1 | Sessions, settings, round ledgers, decisions, usage saved | A3 | todo | |
| D2 | CSV + JSON export, no secrets | A3 | todo | |
| D3 | Restart recovery: no duplicate settlement, never redraw existing outcome, sessions paused | A3/A9 | todo | |
| D4 | API keys server-side only; redacted from logs/errors/exports | A1/A9 | todo | |
| D5 | Host + Origin + custom-header checks; no CORS; CSP | A1/A10 | todo | |
| D6 | No arbitrary command execution; CLI path from .env only; model arg validated | A8 | todo | |

## Interface
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| I1 | One compact sidebar: model selection, connection status, real usage | A4 | todo | |
| I2 | Large wheel above complete European betting table | A4/A5/A6 | todo | |
| I3 | Balance, current stake, last net, recent results (historical clearly marked) | A4/A5 | todo | |
| I4 | Collapsible logs, session history, balance chart, settings, raw JSON | A4 | todo | |
| I5 | Removed: duplicate sidebar, invented metrics, strategy claims, fake connections, FPS counter, hardcoded models | A4 | todo | |
| I6 | Unavailable measurements shown honestly ("not reported") | A4 | todo | |
| I7 | Mobile readable, keyboard navigation, reduced motion | A4/A5/A6 | todo | |
| I8 | Desktop + mobile visual inspection vs Stitch reference | A10 | todo | |

## Verification
| ID | Requirement | Owner | Status | Evidence |
|---|---|---|---|---|
| V1 | build, typecheck, tests pass | L | todo | |
| V2 | Complete manual session + demo session in the running UI | A10 | todo | |
| V3 | Live provider tests only where available; fixtures clearly separated | A7/A8/A10 | todo | |
| V4 | Independent evidence review | A11 | todo | |

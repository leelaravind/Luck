# Verification report (2026-09-23)

What was actually checked, how, and what is still open. Counts are copied from real command output.

## Automated checks

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.server.json --noEmit` | 0 errors |
| `npx vitest run` | 46 test files, 1 057 tests passed, 0 failed |
| `npm run build` | web bundle + compiled server built; CSS compiled locally, fonts bundled |
| `node scripts/validate-components.mjs` | 49 components pass (Props interface, no hex in className) |
| `node scripts/secret-scan.mjs` | clean (210 files) |

Key suites: `src/shared/bets.test.ts` (157 bet positions × 37 outcomes against a hand-typed oracle), `src/server/db/*.test.ts`
(transactions, exactly-once settlement, crash at 4 commit boundaries), `src/web/components/wheel/*` (all 37 landings,
consecutive spins, onSettled once, reduced motion, hidden tab, independent wheel-order oracle), `src/server/session/*`
(pause/stop/step, stale responses, one in-flight decision, retries, budget pre-check, recovery), `tests/e2e/*`
(manual, demo, AI-fixture, restart recovery), `tests/security/*`.

## Live checks against the running app (not fixtures)

- Manual round over HTTP: red + split 0/3 + straight 17 on outcome 28 → net −1.60, balance 1 000.00 → 998.40; replaying the
  Idempotency-Key returned the same round with no second charge; an illegal split 3/4 was rejected with a clear 422;
  cross-origin POST → 403; CSV export correct.
- Independent reviewer (A11): 17 live 10-bet rounds matched a hand-written oracle; ledger sum equals balance; 4 concurrent
  identical requests produced one round; demo session start / pause after round / step / stop; Stop during an in-flight
  decision cancelled it and bumped the epoch; provider failure paused after bounded retries without demo fallback.
- Single-port production (`node dist/server/server/index.js --production`): UI served, SPA fallback, strict CSP, foreign Host → 403.
- UI at 1440 px desktop: single sidebar, wheel above the complete table, honest provider badges.

## Providers: live vs fixture

| Provider | Live? | Evidence |
|---|---|---|
| Laya (local `laya-serve`, english checkpoint, CPU) | **Live** | 3-round session through the app: skip, red (lost), red (won); decisions validated and settled; label probability + Laya confidence shown raw/uncalibrated; input tokens 262–276, output tokens "not applicable"; ~1.9 s per decision |
| Claude Code CLI 2.1.280 (subscription login) | **Live** (4 small calls in total) | login check via `claude auth status`; maintained conversation: round 1 `--session-id`, round 2 `--resume` of the same conversation; decisions validated by the engine; CLI cost estimates $0.0028 and $0.0062 |
| Rule-based demo player | Live | full sessions over HTTP (no AI) |
| Ollama | Fixture only | not installed on this machine |
| Anthropic Messages API | Fixture only | no API key; official SDK pointed at a local mock server |
| OpenAI-compatible | Fixture only | no API key / local server |

## Reviewer defects

| ID | Severity | Status |
|---|---|---|
| D1 unknown-cost `error` attempts counted as $0 in the budget | high | **fixed** (`budget.ts`), test updated (`units.test.ts`) |
| D3 reused Idempotency-Key with a different slip returned the old round | medium | **fixed** → 409 `duplicate_request` |
| D4 Laya always chose "stop" | medium | **fixed** ("stop" not offered to Laya) and **verified live** (3 rounds) |
| D5 CLI "Connected" after a version-only check | medium | **fixed**: connection now verified with `claude auth status` |
| D6 component validator failed on RouletteWheel | low | **fixed** |
| D8 wheel-order test compared against its own constant | low | **fixed** (hand-typed oracle added) |
| D9 dev UI without frame protection | low | **fixed** (Vite dev headers) |
| D2 CLI worst-case without pricing is a heuristic floor ($0.05) | medium | open — disclosed here; subscription auth is not billed per call |
| D7 usage summary shows 0 for never-reported token buckets | low | open (UI shows "N/A"/"Not reported" from capabilities) |
| D10 checklist evidence | low | this report |

## Not verified yet

- Mobile layout inspection and a keyboard-only walkthrough of the running UI.
- A clean checkout → `npm ci` → start on a fresh clone.
- A live wheel animation watched end to end in a visible tab (the automation tab reports `hidden`, so reveals were immediate).
- Zero as a live outcome (covered by the exhaustive unit test only).

# Verification report (2026-09-23)

What was actually checked, how, and what is still open. Counts are copied from real command output.
Updated after the final audit's fix rounds (items refer to that audit); the clean-checkout counts below come from
the final run of the last round.

## Automated checks

| Check | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.server.json --noEmit` | 0 errors |
| `npx vitest run` | 54 test files, 1 184 tests passed, 0 failed |
| `npm run build` | web bundle + compiled server built; CSS compiled locally, fonts bundled |
| `node scripts/validate-components.mjs` | 51 components pass (Props interface, no hex in className) |
| `node scripts/secret-scan.mjs` | clean — 223 files scanned (git mode; the walk mode used for a ZIP download lists the same files) |

Key suites: `src/shared/bets.test.ts` (157 bet positions × 37 outcomes against a hand-typed oracle), `src/server/db/*.test.ts`
(transactions, exactly-once settlement, crash at 4 commit boundaries), `src/web/components/wheel/*` (all 37 landings,
consecutive spins, onSettled once, reduced motion, hidden tab, independent wheel-order oracle), `src/server/session/*`
(pause/stop/step, stale responses, one in-flight decision, retries, budget pre-check, recovery), `tests/e2e/*`
(manual, demo, AI-fixture, restart recovery), `tests/security/*` (HTTP boundary, Vite dev server, secret scanner,
repository hygiene).

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
| Laya (local `laya-serve` 0.3.7, english checkpoint, CPU) | **Live** | 13 labels, no `stop` (a returned `stop` is invalid output). 3-round session through the app: skip, red (lost), red (won); decisions validated and settled; label probability + Laya confidence shown raw/uncalibrated; input tokens 262–276, output tokens "not applicable"; ~1.9 s per decision |
| Claude Code CLI 2.1.280 (subscription login) | **Live** (2 build-agent calls + 2 adapter calls + one 3-round session) | login check via `claude auth status`; maintained conversation (`--session-id`, then `--resume`); decisions validated by the engine and settled; named strategies with varied bet mixes. CLI cost estimates (estimates, not billing, on a subscription): the two one-off calls cost $0.0046 and $0.0208. **Correction:** the per-round figures recorded for *resumed* rounds were the CLI's running totals for the whole conversation and were over-counted (see below); per-turn increases are now recorded |
| Rule-based demo player | Live | full sessions over HTTP (no AI) |
| Ollama | Fixture only | not installed on this machine |
| Anthropic Messages API | Fixture only | no API key; official SDK pointed at a local mock server |
| OpenAI-compatible | Fixture only | no API key / local server |

## Changes requested after the first review (verified live)

- **No stopping limits by default**: new sessions have no round, runtime or app spending limit and the model
  cannot end the session (`allowModelStop` off); each is still available as an opt-in setting. A disallowed
  "stop" is rejected as invalid output (never converted into a bet) — covered by `service.test.ts`.
- **Strategy + bet variety**: the prompt no longer shows a concrete example bet (the old example anchored models on
  red), states that every bet type is equally allowed, and asks for a named strategy shown in the UI as the model's
  unverified claim. Live Claude Code CLI session (haiku, 3 rounds, no budget): three different bet mixes (dozens +
  red/black, dozens + odd/even, dozens + low/high), a named strategy each round, no "stop", conversation resumed each round.
- **Laya**: "stop" removed from its label set; live 3-round session placed bets and settled.
- **All game limits optional**: max stake per bet / per round and max bets per round now default to "no limit"
  (only the balance and the minimum chip constrain a slip); configured limits are still enforced (e2e tests run
  on a limited session; a default session accepts 3 × 100.00 and 11 bets in one round).
- **Objective in the prompt**: live Claude Opus 5.5 via the CLI (3 test rounds) mixed red/black with a dozen or column
  and a straight-up number, named a strategy each round, and chose to skip only when it knew it was the last round.
  Payout check round 2 (29 black): black 20.00 → 40.00 back, column 2 10.00 → 30.00 back, straight 0 lost → 70.00 returned.
- **Active play, no house-edge framing** (user request): model-facing text (system prompt, observation rules, Laya
  state) no longer mentions the house edge or "cannot be predicted"; the prompt asks the model to pick a betting
  system and adapt bets and stakes every round. The user-facing UI, README and exports keep the honest disclaimer.
  Before: Opus 5.5 flat-bet red for 13 rounds citing the house edge; Fable 5.1 repeated one identical slip for 12
  rounds. After (live, Fable 5.1 via the CLI, 4 test rounds): "James Bond coverage with Paroli progression" —
  high 20 → 24 (profit added) → 42 (parlay) → back to 20 after a loss, with a six-line 13-18 and 0 hedge; all four
  settlements matched a hand check (balance 1 000.00 → 988.00).
- **Wheel at rest**: after a reload or session switch the ball rests in the last revealed pocket (no replay, no
  onSettled); verified in the running app (`data-landed-number` 34 = Last round 34 red) and by a component test.
- **Mobile**: emulated 390 px viewport (DevTools protocol, `mobile: true`) — page scroll width equals the viewport;
  vertical table with all 37 numbers, controls and chips readable.

## Reviewer defects

| ID | Severity | Status |
|---|---|---|
| D1 unknown-cost `error` attempts counted as $0 in the budget | high | **fixed** (`budget.ts`), test updated (`units.test.ts`) |
| D3 reused Idempotency-Key with a different slip returned the old round | medium | **fixed and verified live** → 409 `duplicate_request` (a reordered identical slip still replays). Correction: an earlier commit (`caf7b58`, whose message lists D3 as fixed) and an earlier version of this report called D3 fixed while the check was not wired in; the closure review caught it and `3a08e36` fixed it with a regression test (`service.test.ts` › D3). |
| D4 Laya always chose "stop" | medium | **fixed** ("stop" not offered to Laya) and **verified live** (3 rounds) |
| D5 CLI "Connected" after a version-only check | medium | **fixed**: connection now verified with `claude auth status` |
| D6 component validator failed on RouletteWheel | low | **fixed** |
| D8 wheel-order test compared against its own constant | low | **fixed** (hand-typed oracle added) |
| D9 dev UI without frame protection | low | **fixed** (Vite dev headers) |
| D2 CLI worst-case without pricing is a heuristic floor ($0.05) | medium | open — disclosed here; subscription auth is not billed per call |
| D7 usage summary shows 0 for never-reported token buckets | low | open (UI shows "N/A"/"Not reported" from capabilities) |
| D10 checklist evidence | low | this report |
| A11b-N2 demo player skipped forever when short of its flat stake (no default round limit) | medium | **fixed**: stakes the remaining legal amount; tests updated |
| A11b-N3 strategy + explanation clipped together | low | **fixed**: separate budgets |
| A11b-N4 objective text ignored configured limits | low | **fixed**: end conditions built from the session's limits; test added |
| A11b-N5 CLI worst case ignored the resumed conversation when pricing is set | low | **fixed**: worst case = max(pricing estimate, a cold re-write of the conversation bounded from the last turn's cost and tokens, $0.05) — an upper bound when a resumed turn has to re-write an expired prompt cache (property-tested at Claude price ratios in `units.test.ts`). An intermediate version used the session's total CLI cost so far, which stopped a session with an app spending limit at about half of it; that rule is now only the fallback when the CLI reports no tokens |
| A11b-N6 no repo test for spin priority over the resting ball | low | **fixed**: RouletteWheel.priority.test.tsx |

Independent closure review (A11, second pass): D1, D4, D5, D6, D8, D9 and the no-limit / stop / strategy / CLI
conversation / resting-wheel changes verified **closed** with live probes; no critical or high defect open.

## Clean checkout

Fresh `git clone https://github.com/leelaravind/Luck` → `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
— all succeeded before this fix round, and the built single-port server served the UI.
<!--COUNTS--> TODO(lead): re-run the clean checkout after this fix round and record its test files / tests here.

**ZIP download (no git).** Before the first fix round a ZIP download failed 1 test and `npm run secret-scan`,
because the scanner needed git. The scanner now falls back to walking the folder (honouring `.gitignore`) with a
notice. Checked by the tests (a folder outside any git repository and a run without git on `PATH`) and on a copy of
the publishable files outside git: notice printed, the same number of files scanned as in git mode, clean — also
after adding a `.env` with a key-shaped value, `data/luck.db`, `tmp/` and `node_modules/`, which `.gitignore` excludes.
The final audit's closure check then ran the ZIP equivalent on the first fix round's commit: `git archive` (the
tool GitHub uses to build its ZIP downloads, so the same file set) unpacked outside any git repository →
`npm ci` → `npm test`: 1 181 tests passed and the 3 tests that need git were skipped; the secret scan used walk
mode with a notice and scanned 223 files, clean. One of its runs failed in `tests/security/vite-dev.test.ts`
(a request timeout while the machine was loaded); the second fix round made that test warm the dev server up first
(see below). Since then the scanner also walks a folder that sits inside another repository which ignores it or
tracks none of its files (a ZIP unpacked under another project's ignored `tmp/` previously scanned 0 files and
reported "clean"), and a folder for which git lists no files.

## Final audit fix round — dev server, repository, documentation

- **Claude Code CLI cost (audit item 2).** The CLI reports `total_cost_usd`, `duration_api_ms` and `modelUsage` as
  running totals for the whole resumed conversation. Earlier versions stored each total as the cost / API time of
  one call and added them up, so CLI costs were **over-counted** — session `82868f23` showed $20.69 while the CLI's
  own conversation total was $1.85 — tokens per second were too low, and a session with an app spending limit
  stopped at about 28 % of its budget. The adapter now records each turn's increase (fixture-tested with a
  two-turn conversation in `claudeCli.test.ts`); see [providers-cli-laya.md](providers-cli-laya.md#usage-cost-latency-quota).
  Usage saved by earlier versions is not recalculated.
- **Dev server file access and CORS (item 3).** `vite.config.ts` now sets `server.cors: false` and
  `server.fs` (strict; allow `src/web`, `src/shared`, `node_modules`; deny `.env*`, `*.db`, `*.db-*`, `*.sqlite*`,
  certificates/keys, `.npmrc`, `.git`, and this checkout's `data/` and `tmp/`). Checked by
  `tests/security/vite-dev.test.ts` (real Vite, ephemeral port) and live against the running `npm run dev` after the
  config reload: `GET /@fs/<project>/data/luck.db` with `Origin: http://127.0.0.1:9999` → `403`, no
  `Access-Control-Allow-Origin`; `/main.tsx`, a `src/shared` module, the bundled fonts, `/@vite/client` and the
  pre-bundled dependencies → `200`. The same config with Vite's defaults returned `200`, the SQLite header and the
  echoed origin for a throw-away `.db` file. The deny globs for `data/` and `tmp/` are anchored to the checkout; an
  unanchored `**/data/**` would have denied the whole app for a checkout under a folder named `data` or `tmp`.
- **Animation speed vs. model calls (item 4).** Docs now say what the code does: the wheel's animation speed
  changes only the animation; *Pause between autonomous rounds* (`roundPacingMs`, default 7 s) sets how often a
  model is asked.
- **Repository hygiene (items 12, 16, 18, 19).** Secret scan falls back to walk mode outside git (above);
  `.gitignore` and the scanner cover model weights (`*.pt`, `*.pth`, `*.ckpt`, `*.h5`, `*.safetensors`, `*.gguf`,
  `*.onnx`), `venv/`, `*.p12`/`*.pfx`, SSH keys, `.npmrc` and SQLite `-wal`/`-shm`/`-journal` files
  (`tests/security/repo-hygiene.test.ts`, `git check-ignore`); the font packages are listed as OFL-1.1; the
  `.gitattributes` rule for `design-references/` now comes after `* text=auto`, `git check-attr` reports
  `text: unset` for all three files, and their sha256 still equal `H:\LUCKY\stitch_ai_roulette_lab\*`
  (code.html `43c9d2f7…`, DESIGN.md `7642fba5…`, screen.png `b2569bf3…`).
- **What the Claude Code CLI adds (item 28).** Read-only look at the CLI's own transcript of a game conversation
  (2026-09-23): besides Luck's prompt and observation it contains CLI-added `environment` (working directory,
  platform, shell, OS version), `date` and `session_context` (the account e-mail) entries. The closure check's
  transcript of a 3-round session with an app spending limit (Claude Code 2.1.280, haiku) also showed `model` (the
  model's name, id and knowledge cutoff), a `total_tokens_reminder` every turn and a `budget_usd` entry every turn
  built from Luck's `--max-budget-usd` — the remaining app budget (`total` 0.5, then 0.494649, then 0.482874). All
  of these are now disclosed in [providers.md](providers.md) and
  [providers-cli-laya.md](providers-cli-laya.md#what-the-model-sees); the CLI's sandbox is now outside the
  repository (`<OS temp folder>/luck-cli-sandbox`).
- **Docs brought up to date (items 8–11).** Laya: 13 labels, no `stop`, live test recorded; the requirements
  checklist has a status and evidence for every row; `testing.md` no longer lists a failure that was fixed.

## Second fix round — findings of the closure check (tests, scripts, docs)

- **Flaky dev-server test.** `tests/security/vite-dev.test.ts` timed out in some full-suite runs on a loaded
  machine (cold Vite transforms of `/main.tsx` under the default 20 s test timeout; one `ECONNRESET`). Its
  `beforeAll` now warms the server (`/`, `/main.tsx`, `/@vite/client`, a `src/shared` module; 120 s hook budget),
  every test has an explicit timeout (120 s for the HTTP tests), and each request opens its own connection. The
  assertions are unchanged. The third check still saw one stall (1 of 8 runs of the file: one request got no answer
  for 45 s while three test runs shared the machine; 6 later runs under a full-suite load and 30 CI jobs passed), so
  a request that gets no answer within 30 s is now sent once more — timeouts only, and every assertion still runs
  on a real answer.
- **Secret scan in a folder inside another repository.** A folder under an enclosing repository's ignored path was
  scanned in git mode, which listed 0 files and printed "clean". The scanner now falls back to walk mode with a
  notice when the folder is ignored by the enclosing repository, has no file tracked there, or git lists no files
  (`secret-scan.test.ts`: a planted key under this repository's `tmp/`, a throw-away enclosing repository, and a
  repository whose local exclude file hides every file).
- **Startup message.** A direct start without `--production` said to open the Vite URL although Vite was not
  running. Only the `dev:server` script (`npm run dev`) now passes `--dev-runner`, and only then is that URL
  printed; a build in `dist/web` is described as "a production build from dist/web (may be out of date)"
  (`src/server/index.test.ts` starts the real entry point both ways).
- **Node.js range.** `engines` is now `^22.22.2 || ^24.15.0 || >=26.0.0` — the test tools' own range — in
  `package.json` and the lock file's root entry; both start scripts refuse 23.x and 25.x
  (`tests/security/node-engines.test.ts` runs both scripts' checks on fake versions).
- **Docs.** CLI disclosure completed (`model`, `total_tokens_reminder`, `budget_usd`); the checklist no longer
  calls the output-token cap optional (it is always set: default 1000, editable); the Laya explanation examples
  use the current format; a dangling evidence reference (I3) now points to Live checks.

## Third fix round — findings of the second closure check

Two independent verifiers re-checked every round-two item against the pushed code: all runtime, server and UI
items closed; the new defects below were fixed.

- **macOS CI (medium).** All 5 macOS jobs of `566620c` failed two sandbox assertions in `claudeCli.test.ts`: the
  test folder had moved to the OS temp folder, which on macOS is under `/var`, a link to `/private/var`, and the
  fake CLI reports its working directory with links resolved. The paths are now compared after resolving links
  (`04c13ac`, CI 17/17 green), and the test folder is back under the repository's `tmp/`.
- **CLI sessions with an app spending limit stopped at about half of it (medium-low).** The worst case of the next
  CLI turn was at least the session's total CLI cost so far, so a turn was only sent while spent + spent fit the
  limit. It is now a cold re-write of the conversation bounded from the last turn's reported cost and tokens (see
  [providers-cli-laya.md](providers-cli-laya.md#maintained-conversation-and-connection-check-added-after-live-testing));
  the old rule remains only when the CLI reports no tokens. **The first version of this fix was wrong** — see the
  fourth round below.
- **"Reset to default", then "Add" with the same key, silently cancelled the reset (low).** Adding a key that is
  already in the table now changes nothing (`useSettingsForm.test.ts`); an App-level test now clicks "Reset to
  default", saves and checks the row is back at its built-in value.
- **A runtime limit was not applied during a pacing wait (low).** With a 600 s pacing and a 5 s runtime limit the
  session ran on until the wait ended. The wait now ends when the runtime limit is reached (`runner.test.ts`).
- **A settings re-read could replace typing that began while it was in flight (very low).** The "no unsaved
  changes" check now also runs when the answer arrives (`useLuck.settings.test.tsx`).
- **Test runs at the same time deleted each other's fixtures (low).** `static.test.ts` and
  `validate-components.test.ts` used fixed folders and removed them wholesale; each run now has its own folder
  (two overlapping runs of both files pass). The other tests already used unique files.
- **Docs.** The CI file and README no longer say Node 26 is outside the test matrix (it is in it); `testing.md`
  lists the per-run test folders.

## Fourth fix round — adversarial review of the third round

A third reviewer tried to refute the third round's changes with numeric probes.

- **The new CLI bound was not an upper bound (high).** It assumed cache reads cost at least 0.1× input, but the
  bundled Claude API reference prices them at 0.025× on Claude Fable 5.1 and 0.05× on Claude Opus 5.5, so for a
  mostly-read turn the price derived from its cost came out too low (the reviewer's probes: 1.3–2.8× under a real
  cold turn on Fable 5.1). The same review found: unreported cache counts treated as 0; a turn with tokens but a
  cost of 0 giving a bound of 0; the context taken from the newest priced turn instead of the newest turn; the
  first turn bounded only by the $0.05 floor (a cold first turn on Fable 5.1 costs about $0.08–0.15); and a turn made
  with another model used as the price of the next one. The bound now uses each model's stated cache-read rate
  (0.025× for any model whose rate is not stated), never derives a price from a turn without all four token counts
  and a positive cost, takes the context from the newest turn with all four counts, prices the first turn at the
  configured model's built-in price or the highest known Claude price, and ignores a turn made with a different
  model than the configured one (see [providers-cli-laya.md](providers-cli-laya.md#maintained-conversation-and-connection-check-added-after-live-testing)).
  `units.test.ts` now checks it against a cold turn's real cost for 6 models (Fable 5.1, Opus 5.5, Sonnet 5,
  Haiku 4.5, Mythos 5.1 and an unknown $25/MTok model) × both cache lifetimes × 4 token mixes × 3 output caps,
  and the first turn for every model priced up to $10/MTok. Remaining limit (documented): with no model
  configured, the CLI's default model could change to a dearer one between two turns; the CLI's own
  `--max-budget-usd` stop still ends such a turn after the API call in progress.
- **A retry could be sent after the runtime limit (low).** The backoff between attempts of one decision (up to
  30 s) was not capped; a failed attempt is now not retried when the retry would start after the runtime limit,
  and the session completes with "runtime limit" (`runner.test.ts`).
- **Two pricing actions in one batch could disagree (low).** The rows and the removals are now one state, so
  e.g. "remove" then "add" of the same key in one batch keeps the row (`useSettingsForm.test.ts`).
- **The dev-server test's retry could discard a partial leak (low).** Only a request that got no response at all
  is retried; a response that started and then stalled fails the test, and the warm-up no longer retries inside
  its own retry loop.

## Outstanding

- **Old commits are still viewable by SHA on GitHub.** The history was rewritten and the CI runs of the 5 commits
  from before the rewrite were deleted; no branch, tag, pull request or release points at them. GitHub still
  serves those commits by SHA (commit page and REST API) until GitHub Support processes the owner's request to
  purge them. Nothing in these docs refers to them.

## Not verified yet

- A ZIP downloaded from github.com itself (the `git archive` equivalent was run — see Clean checkout).

- A keyboard-only walkthrough and a screen-reader pass of the running UI.
- A live wheel animation watched end to end in a visible tab (the automation tab reports `hidden`, so reveals were immediate).
- Zero as a live outcome (covered by the exhaustive unit test only).
- `scripts/start.ps1` / `start.sh` were dry-run tested by the setup agent, not run on real macOS/Linux.

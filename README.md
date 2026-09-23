# Luck — AI Roulette Lab

A local European roulette simulator where **you**, a **rule-based demo player**, or an **AI model** place
bets with **virtual credits**. Everything runs on your own computer.

> **Licence: NOT YET CHOSEN.** The project owner has not picked a licence yet, so no open-source licence
> applies at the moment. Third-party credits and licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

More documentation: [architecture](docs/architecture.md) · [AI providers](docs/providers.md) ·
[configuration](docs/configuration.md) · [troubleshooting](docs/troubleshooting.md)

---

## 1. What Luck does

- Shows a European single-zero roulette wheel (numbers 0–36) above a complete betting table.
- Lets a player place bets for each round: you (manual), a simple rule-based demo player, or an AI model
  (Ollama, Anthropic, an OpenAI-compatible endpoint, the Claude Code CLI, or the optional Laya classifier).
- The server decides everything that matters: which bets are legal, the balance, the winning number
  (from a secure random generator) and the payout. The wheel animation only shows the result.
- Records every round, AI decision and token usage in a local database, and lets you export a session as
  JSON or CSV.

**Important:**

- **Virtual credits only.** No real money is involved, nothing can be deposited or withdrawn.
- **Random roulette outcomes cannot be reliably predicted by these models** (or by anyone). Luck is a lab
  for watching how models behave — it is not a strategy tool, and no betting system removes the house edge.

## 2. Prerequisites & supported versions

| What | Version |
|---|---|
| Operating system | **Windows 10 / 11 first**; macOS and Linux also work |
| Node.js | **22.13 or newer (22 LTS)**, or **24** — download from <https://nodejs.org/> |
| npm | comes with Node.js |
| Git | to download the project (or download the ZIP from GitHub) |

Optional, only if you want to use them as players: [Ollama](https://ollama.com/) for local models, an
Anthropic or OpenAI-compatible API key, the Claude Code CLI, or a local `laya-serve`.
See [docs/providers.md](docs/providers.md).

Check your Node.js version with `node --version`.

## 3. Install

**Windows (PowerShell):**

```powershell
git clone https://github.com/leelaravind/Luck.git
cd Luck
npm ci
```

**macOS / Linux (bash):**

```bash
git clone https://github.com/leelaravind/Luck.git
cd Luck
npm ci
```

Nothing is installed globally. (Shortcut: the start scripts in step 5 run `npm ci` for you if needed.)

## 4. Configure

Copy the example settings file to `.env`:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

That is enough to play manually or with the demo player. **API keys are optional** — add them to `.env`
only for the AI providers you want (for example `ANTHROPIC_API_KEY=` or `OPENAI_API_KEY=` plus
`OPENAI_BASE_URL=`). Keys stay on the server: they are never sent to the browser and are removed from
logs, errors and exports. **Never commit `.env`** (it is already in `.gitignore`).
Restart Luck after editing `.env`. Every setting is explained in [docs/configuration.md](docs/configuration.md).

## 5. Run

One command starts both the server and the web page:

```
npm run dev
```

Or use the start script, which also checks Node.js, runs `npm ci` if needed and creates `.env` if missing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

```bash
sh scripts/start.sh
```

Stop it with **Ctrl+C**. To build and run the optimised version on a single port instead, use `npm start`
(or `start.ps1 -Prod` / `start.sh --prod`).

## 6. Browser URL

| How you started it | Open this address |
|---|---|
| `npm run dev` (development) | **<http://127.0.0.1:5717>** |
| `npm start` (single port) | **<http://127.0.0.1:3717>** |

If you changed `LUCK_WEB_PORT` or `LUCK_PORT` in `.env`, use those numbers instead. Luck only listens on your
own computer (127.0.0.1); it cannot be reached from other devices.

## 7. Choose a player & start/stop

In the sidebar, pick who plays:

- **Manual** — you place chips on the betting table and spin yourself, one round at a time.
- **Demo (rule-based, not AI)** — a simple built-in rule set. No account or key needed. It is clearly
  labelled as not being AI.
- **AI providers** — Ollama, Anthropic, OpenAI-compatible, Claude Code CLI or Laya. Choose the model
  yourself and use the connection test first. If a provider is unreachable, the session pauses — it never
  silently switches to the demo player.

Controls for demo and AI sessions:

| Button | What it does |
|---|---|
| **Start** | Starts automatic play. Nothing runs until you press it (also not after a restart). |
| **Pause after round** | Lets the current round finish and settle, then pauses. |
| **Stop** | Ends the session. A pending model request is cancelled and its late answer ignored; bets already committed are still settled. |
| **Next round** | Plays exactly one round, then pauses. |

By default a session has **no stopping limits**: it keeps playing until the balance can no longer cover the
minimum stake, or until you press **Stop**. AI players name the strategy they say they follow, and by default
they cannot end the session themselves. In the New session dialog you can optionally set a maximum number of
rounds, a running time, an app spending limit (USD), or let the model end the session.

> Virtual credits cost nothing, but model requests may: with an Anthropic/OpenAI **API key** every request is
> billed to your account, and Claude Code on a subscription uses your plan quota. Set an app spending limit if
> you want Luck to stop before that.

## 8. Run tests

```
npm test
npm run typecheck
npm run build
```

`npm test` runs the automated test suite (vitest); `typecheck` and `build` check that everything compiles.

## 9. Troubleshooting

- **`node` is not recognised / version too old** — install Node.js 22.13+ or 24 from nodejs.org and open a new terminal.
- **"Port 3717 is already in use"** — Luck may already be running in another window. Close it, or set another `LUCK_PORT` in `.env`. Luck never stops other programs for you.
- **Scripts are blocked in PowerShell** — run `powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1` (this only affects that one run).
- **A provider shows "not configured"** — check its key / URL in `.env`, restart, then use the connection test.
- **403 "Unexpected Host header"** — open the exact address from step 6 (`127.0.0.1`), not a network name.

More help: [docs/troubleshooting.md](docs/troubleshooting.md).

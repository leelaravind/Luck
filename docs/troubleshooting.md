# Troubleshooting

Commands are shown for **PowerShell** first, then **bash** (macOS / Linux / Git Bash).

## Installing

### `node` is not recognised, or "Node.js … is not supported"

Luck needs Node.js **22.22.2 or newer 22.x** (22 LTS), **24.15 or newer 24.x** (24 LTS) or **26 or newer**
(`package.json` → `engines`: `^22.22.2 || ^24.15.0 || >=26.0.0`, the same range as the test tools). The
short-lived 23.x and 25.x lines are **not** supported, and the start scripts refuse them. Install a supported
release from <https://nodejs.org/>, then open a **new** terminal window and check:

```
node --version
```

### `npm ci` fails with `ENOENT` / "no such file or directory" for a cache folder (e.g. on a `G:` drive)

npm's cache setting points to a folder or drive that no longer exists. Check it:

```
npm config get cache
```

To use a temporary cache just for the current terminal window (nothing global changes):

```powershell
$env:npm_config_cache = "$PWD\tmp\npm-cache"
npm ci
```

```bash
export npm_config_cache="$PWD/tmp/npm-cache"
npm ci
```

(`tmp/` is ignored by git.) To fix it permanently, point the setting at a folder that exists with
`npm config set cache <folder>` — that changes your user-wide npm configuration, so only do it if you want to.

### `npm ci` fails with "package-lock.json … out of sync" or network errors

Make sure you are in the Luck folder (it contains `package.json`), check your internet connection or proxy,
then run `npm ci` again. Do not delete `package-lock.json`.

## Starting

### PowerShell says running scripts is disabled

Windows blocks `.ps1` files by default. Run the script for this one time only:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Or skip the script and run `npm run dev` directly.

### "Port 3717 is already in use" (or 5717)

Another program — often a Luck window you already started — is using the port. Luck never stops other
programs. Either close that window, or choose free ports in `.env`:

```
LUCK_PORT=3727
LUCK_WEB_PORT=5727
```

Then start again and open the new address (for `npm run dev`: `http://127.0.0.1:5727`).

### "Configuration error: LUCK_HOST must be a loopback address"

Luck only runs on your own computer. Set `LUCK_HOST` to `127.0.0.1` (or leave it empty). Values such as
`0.0.0.0` or `192.168.x.x` are refused on purpose.

### "Configuration error: … must be a full http:// or https:// URL"

A `*_BASE_URL` value in `.env` is not a complete URL. Write it with the scheme, e.g.
`OLLAMA_BASE_URL=http://127.0.0.1:11434`. URLs must not contain `user:password@`.

### The page is blank, or says "This is the API server"

- With `npm run dev`, open **<http://127.0.0.1:5717>** (the web UI), not 3717.
- With `npm start`, open **<http://127.0.0.1:3717>**. `npm start` builds the frontend first; if the build
  failed, scroll up in the terminal for the error.

### `ExperimentalWarning: SQLite is an experimental feature`

Harmless. The server hides exactly this warning; you may still see it when running tests. See
[configuration.md](configuration.md#nodejs-warnings).

## In the browser

### `403` with "Unexpected Host header" or "Cross-origin requests are not allowed"

These are Luck's protections against other websites talking to your local server. Open Luck at exactly
`http://127.0.0.1:<port>` (or `http://localhost:<port>`). Browser extensions that rewrite requests can also
trigger this.

### `400` "Missing Idempotency-Key header" / `403` "Missing X-Luck-Client"

You are calling the API by hand (curl, a script). State-changing requests need these headers — see the
"HTTP API" block in `src/shared/contracts.ts`.

### The session paused by itself

Sessions pause instead of guessing when something goes wrong: the provider was unreachable, rate-limited,
timed out, or returned output that was not a valid decision. The message in the sidebar says which. Fix
the cause and press **Start** again. After a server restart, sessions are always paused and nothing resumes
until you press **Start**.

## AI providers

### A provider shows "not configured"

- Anthropic / OpenAI-compatible: set the key (and for OpenAI-compatible also `OPENAI_BASE_URL`) in `.env`,
  then restart.
- Ollama: make sure Ollama is running (`ollama list` should work) and `OLLAMA_BASE_URL` is correct.
- Claude Code CLI: install it, or set `CLAUDE_CLI_PATH` to the absolute path of the native executable
  (`claude.exe` on Windows — not `claude.cmd`).
- Laya: start `laya-serve` and check `LAYA_BASE_URL`.

Use the connection test in the app after each change. Details per provider: [providers.md](providers.md).

### Costs or token counts show "not reported"

Some providers do not report usage for every request (for example after a timeout). Luck shows that
honestly instead of guessing. Cost figures for paid APIs are **estimates** from pricing assumptions and are
labelled as such.

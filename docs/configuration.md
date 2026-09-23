# Configuration

Luck reads its settings from environment variables. The easy way to set them is a `.env` file in the
project folder (copy `.env.example` to `.env`; the start scripts do this for you and never overwrite an
existing `.env`).

- `.env` is loaded by the server at startup (`src/server/index.ts`) and by the development web server
  (`npm run dev:web` runs Vite with `node --env-file-if-exists=.env`, so it sees `LUCK_PORT` /
  `LUCK_WEB_PORT`).
- Real environment variables win over values in `.env`.
- Empty values mean "use the default". Surrounding quotes are removed.
- **Restart Luck after editing `.env`.**
- `.env` is in `.gitignore`. Never commit it and never put real keys in `.env.example`.

Invalid values stop the server with a message that names the variable, for example
`LUCK_HOST must be a loopback address (127.0.0.1, ::1 or localhost); got "0.0.0.0"`.

## Server

| Variable | Default | Notes |
|---|---|---|
| `LUCK_HOST` | `127.0.0.1` | Must be `127.0.0.1`, `::1` (or `[::1]`) or `localhost`. Anything else — `0.0.0.0`, a LAN address such as `192.168.x.x`, a host name — is refused. There is no override: Luck is local only. |
| `LUCK_PORT` | `3717` | API port, and the single port used by `npm start`. 1–65535. |
| `LUCK_WEB_PORT` | `5717` | Port of the Vite development server (`npm run dev`). Must differ from `LUCK_PORT` in development. |
| `LUCK_DATA_DIR` | `data` | Folder for `luck.db` (SQLite). Relative paths are resolved against the **project folder**, not the current directory. Created if missing. |
| `LUCK_DEV` | *(empty)* | `1` = also accept the development web origin when `NODE_ENV=production`. |
| `NODE_ENV` | *(unset)* | Do not set it in `.env`. `npm start` / `npm run serve` pass `--production`, which sets it to `production`; `npm run dev` leaves it unset. |

Derived values (not configurable): database file `<LUCK_DATA_DIR>/luck.db`; built frontend `<project>/dist/web`;
version from `package.json`.

### Development vs production mode

- **Development** (`NODE_ENV` is not `production`, or `LUCK_DEV=1`): the API additionally accepts browser
  requests from `http://127.0.0.1:<LUCK_WEB_PORT>` and `http://localhost:<LUCK_WEB_PORT>` (the Vite dev
  server, which proxies `/api` to the API port).
- **Production** (`npm start`): only the app's own origin on `LUCK_PORT` is accepted. If `dist/web` exists the
  server also serves the built frontend, with a fallback to `index.html` for client-side routes.

## AI providers

All provider settings are optional. Only configure the ones you want to use. Base URLs must be full
`http://` or `https://` URLs **without** a username or password inside them (put keys in the `*_API_KEY`
variables). Trailing slashes are removed. See [providers.md](providers.md) for what each provider reports.

| Variable | Default | Notes |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Local Ollama server. |
| `OLLAMA_MODEL` | *(empty)* | Optional default model; you can also pick one in the app. |
| `ANTHROPIC_API_KEY` | *(empty)* | Secret. Needed for the Anthropic player. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | |
| `ANTHROPIC_MODEL` | *(empty)* | Optional default model id. |
| `OPENAI_API_KEY` | *(empty)* | Secret. |
| `OPENAI_BASE_URL` | *(none)* | **No default** — you must name the OpenAI-compatible endpoint explicitly. |
| `OPENAI_MODEL` | *(empty)* | Optional default model. |
| `CLAUDE_CLI_PATH` | *(empty)* | Absolute path to the native `claude` executable (`claude.exe` on Windows; `.cmd`/`.ps1` shims are refused). Empty = search `PATH`. Only this setting can choose the executable — never the browser. |
| `CLAUDE_CLI_ENABLED` | `true` | `false` hides the Claude Code CLI player. Accepts `true/false/1/0/yes/no/on/off`. |
| `CLAUDE_CLI_MODEL` | *(empty)* | Optional model alias or id for the CLI. |
| `CLAUDE_CLI_USE_SUBSCRIPTION` | `true` | `true` = the CLI uses your existing Claude Code login and is not given `ANTHROPIC_API_KEY`; `false` = the CLI is given `ANTHROPIC_API_KEY`. |
| `LAYA_BASE_URL` | `http://127.0.0.1:8000` | Local `laya-serve`. |
| `LAYA_API_KEY` | *(empty)* | Secret, if your `laya-serve` requires one. |
| `LAYA_CHECKPOINT` | `english` | Letters, digits, `.`, `_`, `-` only (e.g. `english`, `multilingual`, `typed-decisions`). |

## Secrets

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `LAYA_API_KEY` are read only by the server. At startup each value
is registered with the redactor (`src/server/redact.ts`), which replaces it with `[redacted]` in logs, error
messages and exports. The redactor also removes common key shapes it was never told about (`sk-ant-…`,
`sk-…`, `Bearer …`, `x-api-key` values, `?key=` query parameters). Keys are never part of any API response,
and the API refuses a `PlayerConfig` that contains extra fields such as `apiKey`.

## HTTP security (for reference)

These are fixed, not configurable:

- The server only binds to a loopback address.
- Every request must use an allowed `Host` header (`127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`,
  plus the dev web host in development) — this blocks DNS-rebinding attacks.
- API requests with an `Origin` header must come from an allowed origin; `Sec-Fetch-Site: cross-site` and
  `same-site` are refused; every non-GET request must send `X-Luck-Client: 1`; creating sessions, placing
  rounds and control actions need an `Idempotency-Key` header. No CORS headers are ever sent.
- JSON bodies only, at most 64 KB.
- Every response carries a Content-Security-Policy (`default-src 'self'` …), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`.

## Node.js warnings

Luck uses Node's built-in `node:sqlite`, which prints
`ExperimentalWarning: SQLite is an experimental feature…` when it loads. The server entry point wraps
`process.emitWarning` and drops **only that one warning** (type `ExperimentalWarning` whose message mentions
SQLite). All other warnings — deprecations, other experimental features — are still printed. No
`--disable-warning` flag is used, and `process.removeAllListeners('warning')` is not used. Test runs (vitest)
do not install this filter, so you may see the warning there.

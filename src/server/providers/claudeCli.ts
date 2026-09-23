/**
 * OWNER: agent 8. Claude Code CLI adapter (PlayerKind 'claude-cli').
 *
 * Runs the locally installed, unmodified `claude` binary in headless print mode and asks it for one
 * PlayerDecision as structured output. The CLI is treated as an untrusted child process:
 *
 *  - The executable comes ONLY from server config (CLAUDE_CLI_PATH) or a PATH search for
 *    `claude.exe` / `claude`. Nothing from the HTTP API can choose it. `.cmd` / `.bat` / `.ps1`
 *    shims are refused (Node cannot spawn them without a shell, and a shell is never used).
 *  - spawn(..., { shell: false }) with a fixed argv. The only caller-controlled argv values are the
 *    model (validated by MODEL_RE, so it can never look like a flag), the system prompt, the JSON
 *    schema and the budget number. The user prompt goes on STDIN, never on the command line.
 *  - Every built-in tool, MCP server, settings file, slash command/skill and session persistence is
 *    switched off by flags + env. The resulting stream is still checked: if the CLI reports any tool
 *    (other than its own synthetic StructuredOutput tool), any MCP server or non-built-in plugin,
 *    emits any other tool_use block, or reports permission denials, the call fails with
 *    'boundary_violation' and the adapter is disabled for the rest of this server process.
 *  - The child runs in an empty sandbox directory with a minimal, allow-listed environment.
 *
 * Adapters never throw for provider problems and never retry (the session runner owns retries).
 * The adapter returns raw text/structured output; the runner parses and validates the decision.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ConnectionTestResult,
  ProviderCapabilities,
  ProviderError,
  ProviderErrorCode,
  RateLimitInfo,
  UsageNumbers,
} from '../../shared/contracts.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import { redact } from '../redact.js';

// ───────────────────────────── constants ─────────────────────────────

/** Model alias ("haiku") or full id ("claude-haiku-4-5", "claude-opus-4-1[1m]"). No leading dash → never a flag. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,80}$/;

/**
 * Tool names the CLI itself adds for --json-schema. The structured-output mechanism is a synthetic
 * tool the model "calls" with the final JSON; it has no side effects (the CLI answers it with
 * "Structured output provided successfully"). Anything else is a violation.
 * Verified live with Claude Code 2.1.280: init.tools was exactly ["StructuredOutput"] — see docs/providers-cli-laya.md.
 */
const INTERNAL_STRUCTURED_OUTPUT_TOOLS: ReadonlySet<string> = new Set(['StructuredOutput']);

/**
 * --max-turns value. With --json-schema the model returns its answer through the synthetic
 * StructuredOutput tool call, and the CLI counts that call + its tool_result as 2 turns even though
 * only ONE API request is made. Verified live with 2.1.280 + haiku: --max-turns 2 → subtype
 * "success", num_turns 2, usage.iterations 1, structured_output present. (--max-turns 1 was never
 * observed producing a decision, so it is not used.) See docs/providers-cli-laya.md.
 */
export const CLI_MAX_TURNS = 2;

/** Environment variables copied from the server process (when set). Everything else is dropped. */
const ENV_ALLOW_LIST = [
  'PATH',
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  // POSIX equivalents (macOS/Linux temp dir and user name for the login keychain lookup).
  'TMPDIR',
  'USER',
  'LOGNAME',
  // Where the CLI keeps its login when the user moved it; without it the child would look "logged out".
  'CLAUDE_CONFIG_DIR',
  // Network plumbing some users need to reach the API at all. Never logged.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
] as const;

/** Fixed env flags added to every CLI child. */
const CLI_FIXED_ENV: Readonly<Record<string, string>> = {
  // Do not load claude.ai connector MCP servers (Docs, Canva, …) that --strict-mcp-config may not cover.
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  // The session runner owns retries; keep the CLI's own API retry loop short.
  CLAUDE_CODE_MAX_RETRIES: '1',
  // Never let a game request update the shared CLI binary other sessions are running.
  DISABLE_AUTOUPDATER: '1',
  // Live check 1 (2.1.280, haiku): thinking was on by default and used the whole output cap on
  // every turn (1542 of 1600 output tokens), so no decision was produced. A decision needs no thinking.
  MAX_THINKING_TOKENS: '0',
};

/** Windows CreateProcess command-line limit is 32767 chars; keep a safety margin. */
const MAX_COMMAND_LINE_CHARS = 30_000;
/** Hard cap on stdout we are willing to buffer from one call. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 4_000;
const VERSION_TIMEOUT_MS = 15_000;
/** After kill(), how long to wait for the child's pipes to close before giving up on them. */
const KILL_GRACE_MS = 3_000;

export const CLAUDE_CLI_CAPABILITIES: ProviderCapabilities = {
  kind: 'claude-cli',
  label: 'Claude Code CLI',
  local: false,
  // Conservative: API-key auth is billed per token; subscription usage counts against plan limits.
  paid: true,
  generatesText: true,
  reportsTokenUsage: 'full',
  reportsCost: true,
  listsModels: false,
  structuredOutput: true,
  quotaInfo: 'rate-limit-events',
  requiresApiKey: false,
  notes: [
    "Cost shown is the CLI's own estimate (total_cost_usd), not billing",
    'Plan limits are only shown if the CLI emits rate-limit events',
    'Personal use of your own Claude Code login only; anything offered to other people should use the Anthropic API with an API key',
    'All tools, MCP servers and settings are disabled; each Luck session keeps one Claude Code conversation (resumed every round)',
    'Type a model alias such as "haiku" or "sonnet", or a full model id',
  ],
};

// ───────────────────────────── process-wide boundary state ─────────────────────────────

/**
 * Once the CLI shows it could use a tool or MCP server, it is disabled for the lifetime of this
 * server process (module-level on purpose: a fresh adapter instance must not re-enable it).
 */
let boundaryDisabled: { reason: string; at: string } | null = null;

function disableForBoundary(reason: string): void {
  if (!boundaryDisabled) boundaryDisabled = { reason, at: new Date().toISOString() };
}

// ───────────────────────────── binary resolution ─────────────────────────────

export type BinaryResolution =
  | { ok: true; path: string; source: 'CLAUDE_CLI_PATH' | 'PATH' }
  | { ok: false; issue: string };

const REFUSED_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return path.extname(p).toLowerCase() === '.exe';
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the CLI executable. `cliPath` must come from server config (.env CLAUDE_CLI_PATH) only.
 * Exported for tests.
 */
export function resolveClaudeBinary(
  cliPath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): BinaryResolution {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (cliPath !== undefined && cliPath.trim() !== '') {
    const p = cliPath.trim();
    const ext = pathApi.extname(p).toLowerCase();
    if (REFUSED_EXTENSIONS.has(ext)) {
      return { ok: false, issue: `CLAUDE_CLI_PATH points to a ${ext} shim; point it at the native claude executable instead` };
    }
    if (!pathApi.isAbsolute(p)) return { ok: false, issue: 'CLAUDE_CLI_PATH must be an absolute path' };
    if (!isRegularFile(p)) return { ok: false, issue: 'CLAUDE_CLI_PATH does not point to an existing file' };
    if (!isExecutable(p, platform)) {
      return {
        ok: false,
        issue: platform === 'win32' ? 'CLAUDE_CLI_PATH must point to a .exe file' : 'CLAUDE_CLI_PATH is not executable',
      };
    }
    return { ok: true, path: p, source: 'CLAUDE_CLI_PATH' };
  }

  // PATH search: only the native binary name. The npm shim directory (claude.cmd / claude.ps1) is skipped.
  const exeName = platform === 'win32' ? 'claude.exe' : 'claude';
  const rawPath = env.PATH ?? env.Path ?? '';
  for (const dir of rawPath.split(platform === 'win32' ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !pathApi.isAbsolute(d)) continue;
    const candidate = pathApi.join(d, exeName);
    if (isRegularFile(candidate) && isExecutable(candidate, platform)) {
      return { ok: true, path: candidate, source: 'PATH' };
    }
  }
  return { ok: false, issue: `Claude Code CLI (${exeName}) not found on PATH; install it or set CLAUDE_CLI_PATH in .env` };
}

export function isValidCliModel(model: string): boolean {
  return MODEL_RE.test(model);
}

// ───────────────────────────── maintained conversations ─────────────────────────────

/**
 * Truthful context sent once when a Luck session opens its Claude Code conversation. It states what
 * the app really is; it does not ask the model to set aside any of its guidelines.
 */
export const CLI_SESSION_OPENING = [
  'Session start — Luck AI Roulette Lab.',
  'This conversation is a software simulation for an AI decision-making experiment. All amounts are virtual',
  'credits with no cash value: nothing is deposited, won or withdrawn and no real gambling takes place.',
  'For the rest of this conversation you will receive one game observation per round and reply with one JSON',
  'decision each time, following the rules in the system prompt.',
  '',
].join('\n');

/** Luck session id → Claude Code session id. In memory: after a server restart a new conversation starts. */
const conversations = new Map<string, { cliSessionId: string; turns: number }>();

/** Test helper: forget all maintained conversations. */
export function resetClaudeCliConversations(): void {
  conversations.clear();
}

// ───────────────────────────── argv / env ─────────────────────────────

/** Format --max-budget-usd without exponent notation. Returns null when it rounds to <= 0. */
export function formatBudgetUsd(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const fixed = usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return Number(fixed) > 0 ? fixed : null;
}

/**
 * The exact argv passed to the CLI (after the executable). Exported so tests and docs can assert it.
 * Flags and their reasons are documented in docs/providers-cli-laya.md.
 */
export function buildClaudeArgs(input: {
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
  model?: string;
  maxBudgetUsd?: string | null;
  /** One Claude Code conversation per Luck session: first turn --session-id, later turns --resume. */
  conversation?: { sessionId: string; resume: boolean };
}): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    input.systemPrompt,
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--permission-mode',
    'dontAsk',
    ...(input.conversation
      ? [input.conversation.resume ? '--resume' : '--session-id', input.conversation.sessionId]
      : ['--no-session-persistence']),
    '--max-turns',
    String(CLI_MAX_TURNS),
    '--json-schema',
    JSON.stringify(input.jsonSchema),
  ];
  if (input.model) args.push('--model', input.model);
  if (input.maxBudgetUsd) args.push('--max-budget-usd', input.maxBudgetUsd);
  return args;
}

/** Minimal child environment. API keys are only passed when the user turned subscription auth off. */
export function buildChildEnv(
  cfg: ResolvedProviderConfig,
  parentEnv: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): { env: Record<string, string>; issue: string | null } {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW_LIST) {
    const v = parentEnv[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  Object.assign(env, CLI_FIXED_ENV, extra);
  // Never inherit auth from the server env unless explicitly asked to use API-key auth.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (cfg.useSubscriptionAuth === false) {
    const key = cfg.apiKey ?? parentEnv.ANTHROPIC_API_KEY;
    if (!key) return { env, issue: 'Subscription auth is off but no ANTHROPIC_API_KEY is configured on the server' };
    env.ANTHROPIC_API_KEY = key;
  }
  return { env, issue: null };
}

/** Rough Windows command-line length after quoting (backslashes/quotes may double). */
function commandLineLength(command: string, args: string[]): number {
  let n = command.length + 3;
  for (const a of args) n += a.length + 3 + (a.match(/["\\]/g)?.length ?? 0);
  return n;
}

// ───────────────────────────── child process runner ─────────────────────────────

interface RunOutcome {
  exitCode: number | null;
  exitSignal: string | null;
  stderrTail: string;
  killedFor: 'timeout' | 'abort' | 'boundary' | 'overflow' | null;
  spawnError: string | null;
}

/**
 * Spawn once, feed stdin, stream stdout lines to onLine. onLine returning 'kill' terminates the
 * child immediately (boundary violation). Never throws.
 */
function runChild(opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  onLine: (line: string) => 'kill' | void;
}): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let killedFor: RunOutcome['killedFor'] = null;
    let stderrTail = '';
    let stdoutBytes = 0;
    let buffer = '';
    let done = false;
    let spawnError: string | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ exitCode: null, exitSignal: null, stderrTail: '', killedFor: null, spawnError: String(e) });
      return;
    }

    const finish = (exitCode: number | null, exitSignal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal.removeEventListener('abort', onAbort);
      if (buffer.trim() !== '' && killedFor === null) opts.onLine(buffer);
      buffer = '';
      resolve({ exitCode, exitSignal, stderrTail, killedFor, spawnError });
    };

    const kill = (reason: NonNullable<RunOutcome['killedFor']>) => {
      if (killedFor !== null || done) return;
      killedFor = reason;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      // If a grandchild keeps the pipes open, do not hang the session runner.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, 'SIGTERM');
      }, KILL_GRACE_MS);
    };

    const onAbort = () => kill('abort');
    const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
    if (opts.signal.aborted) kill('abort');
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      spawnError = err.message;
      // A spawn failure never produces 'close' on some platforms; resolve here as well.
      if (child.pid === undefined) finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (killedFor !== null) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        kill('overflow');
        return;
      }
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        if (opts.onLine(line) === 'kill') {
          kill('boundary');
          return;
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    child.stdin?.on('error', () => {
      /* child exited before reading stdin; the exit code tells the story */
    });
    if (opts.stdin !== null) child.stdin?.end(opts.stdin, 'utf8');
    else child.stdin?.end();
  });
}

// ───────────────────────────── stream-json interpretation ─────────────────────────────

/** Loose shapes of the stream-json events we read. Unknown fields are ignored. */
interface CliResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  num_turns?: unknown;
  duration_ms?: unknown;
  duration_api_ms?: unknown;
  permission_denials?: unknown;
  errors?: unknown;
  stop_reason?: unknown;
  /** HTTP status of the failing API call, when the CLI reports one (null otherwise). */
  api_error_status?: unknown;
}

interface StreamState {
  sawInit: boolean;
  initModel: string | null;
  assistantModel: string | null;
  violation: string | null;
  malformedLines: number;
  apiRetries: number;
  lastRetryStatus: number | null;
  rateLimits: Map<string, RateLimitInfo['entries'][number]>;
  rateLimitCapturedAt: string | null;
  rejectedResetAtMs: number | null;
  result: CliResultEvent | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nameOf(v: unknown): string {
  if (typeof v === 'string') return v;
  const r = asRecord(v);
  return r && typeof r.name === 'string' ? r.name : JSON.stringify(v).slice(0, 60);
}

/** resetsAt from the CLI is epoch seconds; accept ms or ISO defensively. */
function toResetMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Inspect one stdout line. Returns 'kill' on a boundary violation. */
function handleLine(line: string, st: StreamState): 'kill' | void {
  let ev: Record<string, unknown> | null;
  try {
    ev = asRecord(JSON.parse(line));
  } catch {
    ev = null;
  }
  if (!ev || typeof ev.type !== 'string') {
    st.malformedLines++;
    return;
  }

  if (ev.type === 'system' && ev.subtype === 'init') {
    st.sawInit = true;
    if (typeof ev.model === 'string') st.initModel = ev.model;
    const tools = Array.isArray(ev.tools) ? ev.tools.map(nameOf) : [];
    const extraTools = tools.filter((t) => !INTERNAL_STRUCTURED_OUTPUT_TOOLS.has(t));
    if (extraTools.length > 0) {
      st.violation = `CLI init reported tools: ${extraTools.slice(0, 8).join(', ')}`;
      return 'kill';
    }
    const servers = Array.isArray(ev.mcp_servers) ? ev.mcp_servers.map(nameOf) : [];
    if (servers.length > 0) {
      st.violation = `CLI init reported MCP servers: ${servers.slice(0, 8).join(', ')}`;
      return 'kill';
    }
    // Built-in plugins (path "builtin", e.g. agents-md, telemetry) ship inside the CLI. Any other
    // plugin means user/project configuration leaked in — plugins can carry hooks that run commands.
    const plugins = Array.isArray(ev.plugins) ? ev.plugins : [];
    const foreign = plugins.filter((p) => {
      const r = asRecord(p);
      return !(r && (r.path === 'builtin' || (typeof r.source === 'string' && r.source.endsWith('@builtin'))));
    });
    if (foreign.length > 0) {
      st.violation = `CLI init reported non-built-in plugins: ${foreign.map(nameOf).slice(0, 8).join(', ')}`;
      return 'kill';
    }
    return;
  }

  if (ev.type === 'system' && ev.subtype === 'api_retry') {
    st.apiRetries++;
    st.lastRetryStatus = finiteNumber(ev.error_status);
    return;
  }

  if (ev.type === 'rate_limit_event') {
    const info = asRecord(ev.rate_limit_info);
    if (info) {
      const name = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'claude-cli';
      const resetMs = toResetMs(info.resetsAt);
      const status = typeof info.status === 'string' ? info.status : undefined;
      // Live 2.1.280 events carry per-window utilization (fraction 0–1) under unifiedWindows.
      const windows = asRecord(info.unifiedWindows) ?? {};
      const utilization = finiteNumber(info.utilization) ?? finiteNumber(asRecord(windows[name])?.utilization);
      st.rateLimits.set(name, {
        name,
        ...(status !== undefined ? { status } : {}),
        ...(resetMs !== null ? { resetAt: new Date(resetMs).toISOString() } : {}),
        ...(utilization !== null ? { utilization } : {}),
      });
      // Other windows (e.g. seven_day) as reported; no status is invented for them.
      for (const [wName, wRaw] of Object.entries(windows)) {
        if (wName === name) continue;
        const w = asRecord(wRaw);
        if (!w) continue;
        const wReset = toResetMs(w.resetsAt);
        const wUtil = finiteNumber(w.utilization);
        st.rateLimits.set(wName, {
          name: wName,
          ...(wReset !== null ? { resetAt: new Date(wReset).toISOString() } : {}),
          ...(wUtil !== null ? { utilization: wUtil } : {}),
        });
      }
      st.rateLimitCapturedAt = new Date().toISOString();
      if (status === 'rejected' && resetMs !== null) st.rejectedResetAtMs = resetMs;
    }
    return;
  }

  if (ev.type === 'assistant') {
    const msg = asRecord(ev.message);
    if (msg && typeof msg.model === 'string') st.assistantModel = msg.model;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      const b = asRecord(block);
      if (!b || typeof b.type !== 'string') continue;
      if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
        const toolName = typeof b.name === 'string' ? b.name : '(unnamed)';
        if (b.type !== 'tool_use' || !INTERNAL_STRUCTURED_OUTPUT_TOOLS.has(toolName)) {
          st.violation = `CLI model attempted tool use: ${toolName}`;
          return 'kill';
        }
      }
    }
    return;
  }

  if (ev.type === 'result') {
    st.result = ev as unknown as CliResultEvent;
    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    if (denials.length > 0) {
      const names = denials.map((d) => nameOf(asRecord(d)?.tool_name ?? d));
      st.violation = `CLI reported permission denials: ${names.slice(0, 8).join(', ')}`;
      return 'kill';
    }
  }
}

function mapUsage(u: Record<string, unknown> | undefined): UsageNumbers {
  const input = finiteNumber(u?.input_tokens);
  const output = finiteNumber(u?.output_tokens);
  if (!u || input === null || output === null) {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null, known: false };
  }
  return {
    inputTokens: input,
    // Includes thinking tokens (Anthropic counts them as output); reasoningTokens is that subset.
    outputTokens: output,
    cacheReadTokens: finiteNumber(u.cache_read_input_tokens),
    cacheWriteTokens: finiteNumber(u.cache_creation_input_tokens),
    reasoningTokens: finiteNumber(asRecord(u.output_tokens_details)?.thinking_tokens),
    known: true,
  };
}

const UNKNOWN_USAGE: UsageNumbers = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
};

function shortText(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  const cleaned = redact(s.replace(/\s+/g, ' ').trim());
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Map CLI error text (+ stream signals) to a typed ProviderError. Exported for tests. */
export function classifyCliError(
  text: string,
  hints: { subtype?: string; rejectedResetAtMs?: number | null; retryStatus?: number | null; now?: number } = {},
): ProviderError {
  const now = hints.now ?? Date.now();
  const message = shortText(text) || 'Claude Code CLI reported an error';
  const subtype = hints.subtype ?? '';

  if (subtype === 'error_max_budget_usd' || /max(imum)?[ -]budget/i.test(text)) {
    return { code: 'budget', message: `CLI stopped at --max-budget-usd: ${message}`, retryable: false };
  }
  if (subtype === 'error_max_turns' || subtype === 'error_max_structured_output_retries') {
    return { code: 'invalid_output', message: `CLI ended without a structured decision (${subtype})`, retryable: true };
  }
  // Seen live: "API Error: Claude's response exceeded the 400 output token maximum." (after the CLI's own continuations)
  if (/exceeded the \d+ output token maximum/i.test(text)) {
    return { code: 'invalid_output', message, retryable: true };
  }
  if (hints.retryStatus === 401 || hints.retryStatus === 403 ||
      /invalid api key|not logged in|please run \/login|\/login\b|authentication[_ ]error|unauthori[sz]ed|oauth token|invalid x-api-key|\b401\b/i.test(text)) {
    return { code: 'auth', message, retryable: false };
  }
  // Plan/usage limits (subscription). Retrying before the reset time cannot succeed.
  const planLimit = /usage limit|hit your limit|limit reached|limit will reset|resets? (at|in)\b/i.test(text);
  if (planLimit || hints.rejectedResetAtMs) {
    let resetMs = hints.rejectedResetAtMs ?? null;
    const pipe = /\|(\d{10,13})\b/.exec(text);
    if (resetMs === null && pipe) resetMs = toResetMs(Number(pipe[1]));
    const err: ProviderError = { code: 'rate_limited', message, retryable: false };
    if (resetMs !== null && resetMs > now) err.retryAfterMs = resetMs - now;
    return err;
  }
  if (/rate[ _]limit|too many requests|\b429\b/i.test(text) || hints.retryStatus === 429) {
    return { code: 'rate_limited', message, retryable: true };
  }
  if (/overloaded|\b529\b|\b50[0234]\b|internal server error|api error: 5\d\d|server error/i.test(text) ||
      (hints.retryStatus !== undefined && hints.retryStatus !== null && hints.retryStatus >= 500)) {
    return { code: 'server_error', message, retryable: true };
  }
  return { code: 'unknown', message, retryable: false };
}

// ───────────────────────────── sandbox ─────────────────────────────

function defaultBaseDir(): string {
  // Walk up from this module to the repo root (works for src/ under tsx/vitest and for dist/).
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      if ((JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string }).name === 'luck-ai-roulette-lab') return dir;
    } catch {
      /* not here */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Create the sandbox cwd; it must be empty so no project settings/CLAUDE.md/.mcp.json can appear in it. */
function prepareSandbox(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) return `CLI sandbox directory is not empty (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}); empty it before using the Claude Code CLI`;
    return null;
  } catch (e) {
    return `Cannot prepare CLI sandbox directory: ${shortText(e instanceof Error ? e.message : e)}`;
  }
}

// ───────────────────────────── adapter ─────────────────────────────

export interface ClaudeCliAdapterOptions {
  /**
   * TESTS ONLY: run `command prefixArgs... <cli args>` instead of the resolved binary, with extra
   * env vars. Never populated from config or HTTP.
   */
  spawnOverride?: { command: string; prefixArgs: string[]; env?: Record<string, string> };
  /** Base directory; the child's cwd is <baseDir>/tmp/cli-sandbox. Default: repo root. */
  baseDir?: string;
  /** DIAGNOSTICS ONLY (live verification script): receives every raw stdout line. Never set from config/HTTP. */
  debugTap?: (line: string) => void;
}

function failure(error: ProviderError, extra: Partial<ProviderCallResult> = {}): ProviderCallResult {
  return {
    ok: false,
    text: null,
    usage: UNKNOWN_USAGE,
    latencyMs: 0,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: null,
    rateLimit: null,
    error,
    ...extra,
  };
}

function err(code: ProviderErrorCode, message: string, retryable = false): ProviderError {
  return { code, message, retryable };
}

export function createClaudeCliAdapter(opts: ClaudeCliAdapterOptions = {}): ProviderAdapter {
  const sandboxDir = path.join(opts.baseDir ?? defaultBaseDir(), 'tmp', 'cli-sandbox');
  const override = opts.spawnOverride;

  /** Command + leading args to run, or an issue. */
  function resolveCommand(cfg: ResolvedProviderConfig): { command: string; prefix: string[]; source: string } | { issue: string } {
    if (override) return { command: override.command, prefix: override.prefixArgs, source: 'test override' };
    const bin = resolveClaudeBinary(cfg.cliPath);
    if (!bin.ok) return { issue: bin.issue };
    return { command: bin.path, prefix: [], source: bin.source };
  }

  return {
    kind: 'claude-cli',
    capabilities: CLAUDE_CLI_CAPABILITIES,

    check(cfg) {
      const issues: string[] = [];
      const cmd = resolveCommand(cfg);
      if ('issue' in cmd) issues.push(cmd.issue);
      const auth = buildChildEnv(cfg, process.env, {});
      if (auth.issue) issues.push(auth.issue);
      if (cfg.model !== undefined && cfg.model !== '' && !isValidCliModel(cfg.model)) {
        issues.push('Model must be an alias like "haiku" or a model id (letters, digits, . _ : - [ ])');
      }
      if (boundaryDisabled) {
        issues.push(`Disabled for this server run: ${boundaryDisabled.reason} (${boundaryDisabled.at}). Restart the server after fixing the CLI configuration.`);
      }
      const configured = !('issue' in cmd) && auth.issue === null;
      return { configured, enabled: configured && boundaryDisabled === null, issues };
    },

    async testConnection(cfg, signal): Promise<ConnectionTestResult> {
      const testedAt = new Date().toISOString();
      const cmd = resolveCommand(cfg);
      if ('issue' in cmd) return { ok: false, testedAt, latencyMs: null, message: cmd.issue };
      if (boundaryDisabled) {
        return { ok: false, testedAt, latencyMs: null, message: `Disabled for this server run: ${boundaryDisabled.reason}` };
      }
      const sandboxIssue = prepareSandbox(sandboxDir);
      if (sandboxIssue) return { ok: false, testedAt, latencyMs: null, message: sandboxIssue };
      const { env } = buildChildEnv({ ...cfg, useSubscriptionAuth: true }, process.env, override?.env ?? {});

      let stdout = '';
      const started = Date.now();
      const run = await runChild({
        command: cmd.command,
        args: [...cmd.prefix, '--version'],
        cwd: sandboxDir,
        env,
        stdin: null,
        timeoutMs: VERSION_TIMEOUT_MS,
        signal,
        onLine: (line) => {
          stdout += `${line}\n`;
        },
      });
      const latencyMs = Date.now() - started;
      if (run.spawnError) return { ok: false, testedAt, latencyMs, message: `Could not start the CLI: ${shortText(run.spawnError)}` };
      if (run.killedFor === 'abort') return { ok: false, testedAt, latencyMs, message: 'Cancelled' };
      if (run.killedFor === 'timeout') return { ok: false, testedAt, latencyMs, message: 'claude --version timed out' };
      const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)?.[1];
      if (run.exitCode !== 0 || !version) {
        return { ok: false, testedAt, latencyMs, message: `claude --version failed (exit ${run.exitCode ?? 'none'}): ${shortText(run.stderrTail || stdout)}` };
      }
      // Login check via the supported `claude auth status --json` (no prompt, no usage). Only the
      // login state, method and plan are kept — never the e-mail address or organisation.
      let authOut = '';
      const auth = await runChild({
        command: cmd.command,
        args: [...cmd.prefix, 'auth', 'status', '--json'],
        cwd: sandboxDir,
        env,
        stdin: null,
        timeoutMs: VERSION_TIMEOUT_MS,
        signal,
        onLine: (line) => {
          authOut += `${line}\n`;
        },
      });
      const totalMs = Date.now() - started;
      let status: Record<string, unknown> | null = null;
      try {
        status = asRecord(JSON.parse(authOut));
      } catch {
        status = null;
      }
      if (!status) {
        return {
          ok: false,
          testedAt,
          latencyMs: totalMs,
          version,
          message: `Claude Code CLI ${version} found, but "claude auth status" did not return JSON (exit ${auth.exitCode ?? 'none'}); login could not be verified.`,
        };
      }
      if (status.loggedIn !== true) {
        return {
          ok: false,
          testedAt,
          latencyMs: totalMs,
          version,
          message: `Claude Code CLI ${version} found but not logged in. Run "claude auth login" in a terminal, then test again.`,
        };
      }
      const method = typeof status.authMethod === 'string' ? status.authMethod : 'unknown method';
      const plan = typeof status.subscriptionType === 'string' ? `, ${status.subscriptionType} plan` : '';
      return {
        ok: true,
        testedAt,
        latencyMs: totalMs,
        version,
        message: `Connected: Claude Code CLI ${version} (${cmd.source}), logged in via ${method}${plan}. Checked with "claude auth status"; no prompt was sent and no usage was incurred.`,
      };
    },

    async decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult> {
      if (signal.aborted) return failure(err('cancelled', 'Cancelled before the CLI was started'));
      if (boundaryDisabled) {
        return failure(err('boundary_violation', `Claude Code CLI adapter is disabled for this server run: ${boundaryDisabled.reason}`));
      }
      const cmd = resolveCommand(cfg);
      if ('issue' in cmd) return failure(err('not_configured', cmd.issue));

      const model = req.model ?? cfg.model;
      if (model !== undefined && model !== '' && !isValidCliModel(model)) {
        return failure(err('bad_request', 'Model must be an alias like "haiku" or a model id (letters, digits, . _ : - [ ]); it may not start with "-"'));
      }
      let budget: string | null = null;
      if (req.maxBudgetUsd !== null) {
        budget = formatBudgetUsd(req.maxBudgetUsd);
        if (budget === null) return failure(err('budget', 'Remaining app budget is too small for another CLI call'));
      }
      const { env, issue: authIssue } = buildChildEnv(cfg, process.env, {
        ...(override?.env ?? {}),
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(Math.max(1, Math.floor(req.maxOutputTokens))),
      });
      if (authIssue) return failure(err('not_configured', authIssue));
      const sandboxIssue = prepareSandbox(sandboxDir);
      if (sandboxIssue) return failure(err('not_configured', sandboxIssue));

      // One maintained Claude Code conversation per Luck session (supported --session-id / --resume).
      let conv = req.conversationKey ? conversations.get(req.conversationKey) : undefined;
      if (req.conversationKey && !conv) {
        conv = { cliSessionId: randomUUID(), turns: 0 };
        conversations.set(req.conversationKey, conv);
      }
      const resume = conv !== undefined && conv.turns > 0;
      const stdinText = conv && !resume ? `${CLI_SESSION_OPENING}\n${req.userPrompt}` : req.userPrompt;
      const args = [
        ...cmd.prefix,
        ...buildClaudeArgs({
          systemPrompt: req.systemPrompt,
          jsonSchema: req.jsonSchema,
          model: model || undefined,
          maxBudgetUsd: budget,
          ...(conv ? { conversation: { sessionId: conv.cliSessionId, resume } } : {}),
        }),
      ];
      if (commandLineLength(cmd.command, args) > MAX_COMMAND_LINE_CHARS) {
        return failure(err('bad_request', 'System prompt + JSON schema are too long for a command line'));
      }

      const st: StreamState = {
        sawInit: false,
        initModel: null,
        assistantModel: null,
        violation: null,
        malformedLines: 0,
        apiRetries: 0,
        lastRetryStatus: null,
        rateLimits: new Map(),
        rateLimitCapturedAt: null,
        rejectedResetAtMs: null,
        result: null,
      };
      // setTimeout fires immediately for delays above 2^31-1 ms, so clamp.
      const timeoutMs = Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? Math.min(req.timeoutMs, 2_147_483_647) : 60_000;
      const started = Date.now();
      const run = await runChild({
        command: cmd.command,
        args,
        cwd: sandboxDir,
        env,
        stdin: stdinText,
        timeoutMs,
        signal,
        onLine: (line) => {
          opts.debugTap?.(line);
          return handleLine(line, st);
        },
      });
      const latencyMs = Date.now() - started;

      // Advance the conversation only when the CLI produced a result for this turn. If the very first
      // turn produced nothing, forget the id so the next attempt opens a fresh conversation.
      if (conv && req.conversationKey) {
        if (st.result) conv.turns += 1;
        else if (conv.turns === 0) conversations.delete(req.conversationKey);
      }

      // ── facts gathered regardless of outcome ──
      const rateLimit: RateLimitInfo | null =
        st.rateLimits.size > 0
          ? { source: 'cli-rate-limit-event', capturedAt: st.rateLimitCapturedAt ?? new Date().toISOString(), entries: [...st.rateLimits.values()] }
          : null;
      const r = st.result;
      const usage = r ? mapUsage(asRecord(r.usage) ?? undefined) : UNKNOWN_USAGE;
      const providerCostUsd = r ? finiteNumber(r.total_cost_usd) : null;
      const modelUsageKeys = r && asRecord(r.modelUsage) ? Object.keys(asRecord(r.modelUsage)!) : [];
      const modelReported = modelUsageKeys[0] ?? st.assistantModel ?? st.initModel;
      const apiMs = r ? finiteNumber(r.duration_api_ms) : null;
      const facts = {
        usage,
        latencyMs,
        generationMs: apiMs,
        providerCostUsd,
        modelReported,
        finishReason: r && typeof r.subtype === 'string' ? r.subtype : null,
        rateLimit,
      };
      const noteParts: string[] = [];
      if (conv) noteParts.push(`conversation ${conv.cliSessionId.slice(0, 8)} turn ${resume ? conv.turns : 1}${resume ? ' (resumed)' : ' (opened)'}`);
      if (r && finiteNumber(r.num_turns) !== null) noteParts.push(`CLI turns: ${r.num_turns}`);
      if (apiMs !== null) noteParts.push(`API time ${apiMs} ms (includes time to first token)`);
      if (providerCostUsd !== null) noteParts.push("cost is the CLI's own estimate, not billing");
      if (st.apiRetries > 0) noteParts.push(`CLI retried the API ${st.apiRetries}×`);
      const note = noteParts.length ? noteParts.join('; ') : undefined;

      // ── ordered outcome checks ──
      if (st.violation) {
        disableForBoundary(st.violation);
        return failure(
          err('boundary_violation', `${redact(st.violation)}. The Claude Code CLI adapter is now disabled for this server run.`),
          { ...facts, note },
        );
      }
      if (run.killedFor === 'abort') return failure(err('cancelled', 'Cancelled; the CLI process was terminated'), { ...facts, usage: UNKNOWN_USAGE, providerCostUsd: null });
      if (run.killedFor === 'timeout') {
        return failure(err('timeout', `No complete CLI response within ${timeoutMs} ms; the process was terminated`, true), {
          ...facts,
          usage: UNKNOWN_USAGE,
          providerCostUsd: null,
        });
      }
      if (run.killedFor === 'overflow') return failure(err('invalid_output', 'CLI produced more output than allowed; the process was terminated', true), facts);
      if (run.spawnError && !r) return failure(err('unavailable', `Could not start the Claude Code CLI: ${shortText(run.spawnError)}`), facts);

      if (r) {
        const isError = r.is_error === true || (typeof r.subtype === 'string' && r.subtype !== 'success');
        if (isError) {
          const errorsText = Array.isArray(r.errors) ? r.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ') : '';
          const text = [typeof r.result === 'string' ? r.result : '', errorsText].filter(Boolean).join(' — ') || run.stderrTail;
          const pe = classifyCliError(text, {
            subtype: typeof r.subtype === 'string' ? r.subtype : undefined,
            rejectedResetAtMs: st.rejectedResetAtMs,
            retryStatus: finiteNumber(r.api_error_status) ?? st.lastRetryStatus,
          });
          return failure(pe, { ...facts, note });
        }
        if (st.malformedLines > 0) {
          return failure(err('invalid_output', `CLI stream contained ${st.malformedLines} malformed line(s); result not trusted`, true), { ...facts, note });
        }
        if (!st.sawInit) {
          return failure(err('invalid_output', 'CLI stream had no init event, so the tool boundary could not be verified; result not trusted', true), { ...facts, note });
        }
        const structured = r.structured_output;
        const resultText = typeof r.result === 'string' && r.result.trim() !== '' ? r.result : null;
        if (structured === undefined || structured === null) {
          if (resultText === null) return failure(err('invalid_output', 'CLI returned neither structured output nor text', true), { ...facts, note });
          return { ok: true, text: resultText, ...facts, error: null, note };
        }
        return { ok: true, text: JSON.stringify(structured), structured, ...facts, error: null, note };
      }

      // No result event at all.
      if (st.malformedLines > 0 && run.exitCode === 0) {
        return failure(err('invalid_output', `CLI stream was malformed (${st.malformedLines} unparseable line(s), no result)`, true), facts);
      }
      const tail = run.stderrTail.trim();
      if (tail) {
        const pe = classifyCliError(tail, { rejectedResetAtMs: st.rejectedResetAtMs, retryStatus: st.lastRetryStatus });
        return failure(
          pe.code === 'unknown' ? { ...pe, message: `CLI exited with code ${run.exitCode ?? 'none'}: ${pe.message}` } : pe,
          facts,
        );
      }
      return failure(
        err(run.exitCode === 0 ? 'invalid_output' : 'unknown', `CLI exited with code ${run.exitCode ?? 'none'} without a result`, run.exitCode === 0),
        facts,
      );
    },
  };
}

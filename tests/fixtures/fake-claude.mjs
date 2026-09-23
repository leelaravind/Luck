#!/usr/bin/env node
/**
 * TEST FIXTURE — a fake Claude Code CLI. It is NOT the real CLI and never contacts any service.
 *
 * Emulates `claude -p --output-format stream-json --verbose …` closely enough to exercise
 * src/server/providers/claudeCli.ts. Tests spawn it through the adapter's test-only spawnOverride:
 *   { command: process.execPath, prefixArgs: [<this file>], env: { FAKE_CLAUDE_SCENARIO: 'ok', … } }
 *
 * Behaviour
 *  - `--version` → prints "9.9.9-fake (Claude Code)" and exits 0.
 *  - Otherwise validates that the restrictive flags are present; exits 2 with a message if not.
 *  - Reads the whole prompt from stdin, then emits stream-json lines for FAKE_CLAUDE_SCENARIO:
 *      ok, structured_output_tool, builtin_plugins, init_with_tools, init_with_mcp, init_with_plugin,
 *      tool_use, permission_denial, rate_limit_event_then_ok, auth_error, plan_limit, overloaded,
 *      max_budget, max_turns, malformed, no_init, hang, nonzero_exit, echo_env
 *  - FAKE_CLAUDE_RECORD_FILE (optional): writes { argv, stdin, cwd, envKeys, hasApiKey, hasAuthToken }.
 *  - FAKE_CLAUDE_META_RECORD_FILE (optional): appends one JSON line { argv, cwd, envKeys, hasApiKey,
 *    hasAuthToken } for every `--version` / `auth status` run (the connection test's children).
 *  - FAKE_CLAUDE_PID_FILE (optional): writes this process's pid (used to prove the child was killed).
 *
 * Conversations (like the real CLI 2.1.280, verified from its result schema and live transcripts):
 *  - With FAKE_CLAUDE_STATE_DIR set and --session-id <id> / --resume <id>, the fake keeps the
 *    conversation's RUNNING TOTALS in <dir>/<id>.json. total_cost_usd, duration_api_ms and modelUsage
 *    in a result are the totals for the whole conversation so far (a resumed run continues from the
 *    saved totals); result.usage and num_turns are for this run only.
 *  - --session-id with an existing id, or --resume with an unknown id, fails like the real CLI.
 *  - FAKE_CLAUDE_TURN_COSTS / FAKE_CLAUDE_TURN_API_MS: comma-separated per-turn increases (turn 1, 2, ...;
 *    the last value repeats). Defaults 0.00123 USD and 987 ms.
 *  - FAKE_CLAUDE_OMIT_TOTALS_ON_TURN=<n>: the result of conversation turn n carries no total_cost_usd /
 *    duration_api_ms (the totals still advance), to exercise an unknown baseline.
 *  - FAKE_CLAUDE_RESET_TOTALS_ON_TURN=<n>: the running totals restart from zero on conversation turn n
 *    (a resumed transcript without saved totals).
 *  - FAKE_CLAUDE_API_RETRIES=<n> (scenario ok): emits n `system/api_retry` events before the
 *    successful result (the CLI's own API retries that then succeeded).
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_CLAUDE_PID_FILE) fs.writeFileSync(env.FAKE_CLAUDE_PID_FILE, String(process.pid));

function recordMeta() {
  if (!env.FAKE_CLAUDE_META_RECORD_FILE) return;
  const rec = {
    argv,
    cwd: process.cwd(),
    envKeys: Object.keys(env).sort(),
    hasApiKey: Boolean(env.ANTHROPIC_API_KEY),
    hasAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
  };
  fs.appendFileSync(env.FAKE_CLAUDE_META_RECORD_FILE, `${JSON.stringify(rec)}\n`);
}

if (argv.includes('--version')) {
  recordMeta();
  process.stdout.write('9.9.9-fake (Claude Code)\n');
  process.exit(0);
}

// `auth status --json` → FIXTURE login state (FAKE_CLAUDE_LOGGED_OUT=1 simulates a logged-out CLI).
// With ANTHROPIC_API_KEY in the env it answers in the shape the real 2.1.280 CLI printed for an
// API key (apiKeySource set, subscriptionType null) — the key is not validated.
if (argv[0] === 'auth' && argv[1] === 'status') {
  recordMeta();
  const loggedIn = env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  const status = env.ANTHROPIC_API_KEY
    ? { loggedIn: true, authMethod: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', email: null, orgName: null, subscriptionType: null }
    : loggedIn
      ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'fixture', email: 'fixture@example.invalid', orgName: 'Fixture Org' }
      : { loggedIn: false };
  process.stdout.write(JSON.stringify(status) + '\n');
  process.exit(0);
}

/** Value following a flag, or undefined. */
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

// ── flag validation (the restrictive set the adapter must always send) ──
const problems = [];
if (!argv.includes('-p')) problems.push('-p');
if (flagValue('--output-format') !== 'stream-json') problems.push('--output-format stream-json');
if (!argv.includes('--verbose')) problems.push('--verbose');
if (!(argv.includes('--tools') && flagValue('--tools') === '')) problems.push('--tools ""');
if (!argv.includes('--strict-mcp-config')) problems.push('--strict-mcp-config');
if (flagValue('--disallowedTools') !== 'mcp__*') problems.push('--disallowedTools mcp__*');
if (!(argv.includes('--setting-sources') && flagValue('--setting-sources') === '')) problems.push('--setting-sources ""');
if (!argv.includes('--disable-slash-commands')) problems.push('--disable-slash-commands');
if (flagValue('--permission-mode') !== 'dontAsk') problems.push('--permission-mode dontAsk');
if (!argv.includes('--no-session-persistence') && !argv.includes('--session-id') && !argv.includes('--resume')) {
  problems.push('--no-session-persistence or --session-id/--resume');
}
if (!/^\d+$/.test(flagValue('--max-turns') ?? '')) problems.push('--max-turns <n>');
try {
  JSON.parse(flagValue('--json-schema') ?? '');
} catch {
  problems.push('--json-schema <valid JSON>');
}
if (argv.includes('--dangerously-skip-permissions')) problems.push('(forbidden) --dangerously-skip-permissions');
if (problems.length > 0) {
  process.stderr.write(`fake-claude: missing/invalid restrictive flags: ${problems.join(', ')}\n`);
  process.exit(2);
}

const scenario = env.FAKE_CLAUDE_SCENARIO ?? 'ok';
const model = flagValue('--model') ?? 'claude-fake-default';
const conversationId = flagValue('--resume') ?? flagValue('--session-id') ?? null;
const sessionId = conversationId ?? '00000000-0000-4000-8000-000000000000';

// ── conversation running totals (see header) ──
const statePath = env.FAKE_CLAUDE_STATE_DIR && conversationId ? path.join(env.FAKE_CLAUDE_STATE_DIR, `${conversationId}.json`) : null;
if (statePath && argv.includes('--session-id') && fs.existsSync(statePath)) {
  process.stderr.write(`Error: Session ID ${conversationId} is already in use.\n`);
  process.exit(1);
}
if (statePath && argv.includes('--resume') && !fs.existsSync(statePath)) {
  process.stderr.write(`No conversation found with session ID: ${conversationId}\n`);
  process.exit(1);
}
const state = statePath && fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { turns: 0, costUsd: 0, apiMs: 0, inputTokens: 0, outputTokens: 0 };

function perTurn(list, fallback) {
  const values = (list ?? '').split(',').map((v) => v.trim()).filter(Boolean).map(Number);
  if (values.length === 0) return fallback;
  return values[Math.min(state.turns, values.length - 1)];
}

/** Exit only after stdout/stderr are flushed (pipes can be asynchronous). */
function exitAfterFlush(code) {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function init(overrides = {}) {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: 'dontAsk',
    slash_commands: [],
    apiKeySource: env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none',
    ...overrides,
  });
}

const USAGE = {
  input_tokens: 812,
  output_tokens: 57,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 4096,
  output_tokens_details: { thinking_tokens: 0 },
};

function decisionFixture() {
  if (env.FAKE_CLAUDE_DECISION) return JSON.parse(env.FAKE_CLAUDE_DECISION);
  return { action: 'bet', bets: [{ type: 'red', stake: 10 }], explanation: 'fixture decision' };
}

function okResult(structured = decisionFixture()) {
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: { model, role: 'assistant', content: [{ type: 'text', text: 'Placing a small bet.' }] },
  });
  // Advance the running totals by this turn (stateless runs start from zero every time).
  if (statePath && env.FAKE_CLAUDE_RESET_TOTALS_ON_TURN === String(state.turns + 1)) {
    // A resumed transcript without saved totals: the CLI's running total restarts from zero.
    Object.assign(state, { costUsd: 0, apiMs: 0, inputTokens: 0, outputTokens: 0 });
  }
  const turnCost = perTurn(env.FAKE_CLAUDE_TURN_COSTS, 0.00123);
  const turnApiMs = perTurn(env.FAKE_CLAUDE_TURN_API_MS, 987);
  state.turns += 1;
  state.costUsd += turnCost;
  state.apiMs += turnApiMs;
  state.inputTokens += USAGE.input_tokens;
  state.outputTokens += USAGE.output_tokens;
  if (statePath) fs.writeFileSync(statePath, JSON.stringify(state));
  const omitTotals = statePath !== null && env.FAKE_CLAUDE_OMIT_TOTALS_ON_TURN === String(state.turns);
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    ...(omitTotals ? {} : { duration_api_ms: state.apiMs }),
    // Live 2.1.280 reports num_turns 2 for one StructuredOutput call and repeats the JSON in result.
    num_turns: 2,
    stop_reason: 'tool_use',
    result: JSON.stringify(structured),
    structured_output: structured,
    session_id: sessionId,
    ...(omitTotals ? {} : { total_cost_usd: state.costUsd }),
    // result.usage is per run; modelUsage is a running total like total_cost_usd.
    usage: USAGE,
    modelUsage: { [model]: { inputTokens: state.inputTokens, outputTokens: state.outputTokens, costUSD: state.costUsd } },
    permission_denials: [],
  });
}

function errorResult(subtype, text, extra = {}) {
  emit({
    type: 'result',
    subtype,
    is_error: true,
    duration_ms: 400,
    duration_api_ms: 300,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    permission_denials: [],
    ...extra,
  });
}

// Read the entire stdin prompt first (like the real CLI in -p mode).
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  stdin += c;
});
process.stdin.on('end', () => {
  if (env.FAKE_CLAUDE_RECORD_FILE) {
    fs.writeFileSync(
      env.FAKE_CLAUDE_RECORD_FILE,
      JSON.stringify({
        argv,
        stdin,
        cwd: process.cwd(),
        envKeys: Object.keys(env).sort(),
        hasApiKey: Boolean(env.ANTHROPIC_API_KEY),
        hasAuthToken: Boolean(env.ANTHROPIC_AUTH_TOKEN),
        maxOutputTokens: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
      }),
    );
  }
  run();
});

function run() {
  switch (scenario) {
    case 'ok':
      init();
      for (let i = 1; i <= Number(env.FAKE_CLAUDE_API_RETRIES ?? 0); i++) {
        emit({ type: 'system', subtype: 'api_retry', attempt: i, max_retries: 1, retry_delay_ms: 10, error_status: 529, error: 'overloaded' });
      }
      okResult();
      exitAfterFlush(0);
      break;
    case 'init_with_tools':
      init({ tools: ['Bash', 'Read', 'StructuredOutput'] });
      okResult();
      exitAfterFlush(0);
      break;
    case 'init_with_mcp':
      init({ mcp_servers: [{ name: 'some-server', status: 'connected' }] });
      okResult();
      exitAfterFlush(0);
      break;
    case 'builtin_plugins':
      // Shape observed live from 2.1.280: only built-in plugins → allowed.
      init({
        tools: ['StructuredOutput'],
        plugins: [
          { name: 'agents-md', path: 'builtin', source: 'agents-md@builtin' },
          { name: 'telemetry', path: 'builtin', source: 'telemetry@builtin' },
        ],
      });
      okResult();
      exitAfterFlush(0);
      break;
    case 'init_with_plugin':
      init({ plugins: [{ name: 'some-user-plugin', path: 'C:\\Users\\someone\\.claude\\plugins\\x', source: 'x@marketplace' }] });
      okResult();
      exitAfterFlush(0);
      break;
    case 'tool_use':
      init();
      emit({
        type: 'assistant',
        session_id: sessionId,
        message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fake', name: 'Bash', input: { command: 'dir' } }] },
      });
      okResult();
      exitAfterFlush(0);
      break;
    case 'structured_output_tool':
      // The CLI's own synthetic StructuredOutput tool is expected and allowed.
      init({ tools: ['StructuredOutput'] });
      emit({
        type: 'assistant',
        session_id: sessionId,
        message: { model, role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_so', name: 'StructuredOutput', input: decisionFixture() }] },
      });
      okResult();
      exitAfterFlush(0);
      break;
    case 'permission_denial':
      init();
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        result: '',
        structured_output: decisionFixture(),
        total_cost_usd: 0.001,
        usage: USAGE,
        permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_x', tool_input: {} }],
      });
      exitAfterFlush(0);
      break;
    case 'rate_limit_event_then_ok':
      init();
      emit({
        type: 'rate_limit_event',
        session_id: sessionId,
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1893456000,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: 1893456000 }, seven_day: { utilization: 0.4, resetsAt: 1893801600 } },
        },
      });
      okResult();
      exitAfterFlush(0);
      break;
    case 'auth_error':
      init();
      errorResult('success', 'Invalid API key · Please run /login');
      exitAfterFlush(1);
      break;
    case 'plan_limit': {
      init();
      const reset = Math.floor(Date.now() / 1000) + 3600;
      emit({
        type: 'rate_limit_event',
        session_id: sessionId,
        rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' },
      });
      errorResult('success', `Claude AI usage limit reached|${reset}`);
      exitAfterFlush(1);
      break;
    }
    case 'overloaded':
      init();
      emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 500, error_status: 529, error: 'overloaded' });
      errorResult('success', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      exitAfterFlush(1);
      break;
    case 'max_budget':
      init();
      errorResult('error_max_budget_usd', '', { errors: ['Reached maximum budget ($0.01)'], total_cost_usd: 0.0112, usage: USAGE });
      exitAfterFlush(1);
      break;
    case 'max_turns':
      init();
      errorResult('error_max_turns', '', { errors: ['Reached maximum number of turns (1)'] });
      exitAfterFlush(1);
      break;
    case 'malformed':
      process.stdout.write('this is not json\n{"type": "system", "subtype": "init", \n');
      exitAfterFlush(0);
      break;
    case 'no_init':
      okResult();
      exitAfterFlush(0);
      break;
    case 'hang':
      init();
      // Never finish: the adapter must time out / abort and kill this process.
      setInterval(() => {}, 1000);
      break;
    case 'nonzero_exit':
      process.stderr.write('fake-claude: fatal internal error\n');
      exitAfterFlush(3);
      break;
    case 'echo_env':
      init();
      okResult({
        action: 'skip',
        explanation: `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ? 'present' : 'absent'}`,
      });
      exitAfterFlush(0);
      break;
    default:
      process.stderr.write(`fake-claude: unknown scenario ${scenario}\n`);
      exitAfterFlush(4);
  }
}

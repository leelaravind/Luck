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
 *  - FAKE_CLAUDE_PID_FILE (optional): writes this process's pid (used to prove the child was killed).
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_CLAUDE_PID_FILE) fs.writeFileSync(env.FAKE_CLAUDE_PID_FILE, String(process.pid));

if (argv.includes('--version')) {
  process.stdout.write('9.9.9-fake (Claude Code)\n');
  process.exit(0);
}

// `auth status --json` → FIXTURE login state (FAKE_CLAUDE_LOGGED_OUT=1 simulates a logged-out CLI).
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(
    JSON.stringify(
      loggedIn
        ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'fixture', email: 'fixture@example.invalid', orgName: 'Fixture Org' }
        : { loggedIn: false },
    ) + '\n',
  );
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
const sessionId = '00000000-0000-4000-8000-000000000000';

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
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 987,
    // Live 2.1.280 reports num_turns 2 for one StructuredOutput call and repeats the JSON in result.
    num_turns: 2,
    stop_reason: 'tool_use',
    result: JSON.stringify(structured),
    structured_output: structured,
    session_id: sessionId,
    total_cost_usd: 0.00123,
    usage: USAGE,
    modelUsage: { [model]: { inputTokens: USAGE.input_tokens, outputTokens: USAGE.output_tokens, costUSD: 0.00123 } },
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

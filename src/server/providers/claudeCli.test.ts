/**
 * FIXTURE TESTS for the Claude Code CLI adapter. No real CLI is run here: every decide() spawns
 * tests/fixtures/fake-claude.mjs (a fake that emits stream-json) through the test-only
 * spawnOverride. Live verification with the real CLI is recorded separately in
 * docs/providers-cli-laya.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, ProviderAdapter, ResolvedProviderConfig } from '../types.js';

const FAKE = fileURLToPath(new URL('../../../tests/fixtures/fake-claude.mjs', import.meta.url));
const TMP_ROOT = fileURLToPath(new URL('../../../tmp/8/claudeCli-test/', import.meta.url));

type Mod = typeof import('./claudeCli.js');

/** Fresh module per test: the boundary-violation disable flag is process(module)-wide on purpose. */
async function freshModule(): Promise<Mod> {
  vi.resetModules();
  return import('./claudeCli.js');
}

let caseDir = '';
let counter = 0;
beforeEach(() => {
  caseDir = path.join(TMP_ROOT, `${process.pid}-${Date.now()}-${counter++}`);
  fs.mkdirSync(caseDir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function files() {
  return {
    record: path.join(caseDir, 'record.json'),
    pid: path.join(caseDir, 'pid.txt'),
    sandbox: path.join(caseDir, 'base', 'tmp', 'cli-sandbox'),
  };
}

async function fakeAdapter(scenario: string, extraEnv: Record<string, string> = {}, mod?: Mod): Promise<{ adapter: ProviderAdapter; mod: Mod }> {
  const m = mod ?? (await freshModule());
  const f = files();
  const adapter = m.createClaudeCliAdapter({
    baseDir: path.join(caseDir, 'base'),
    spawnOverride: {
      command: process.execPath,
      prefixArgs: [FAKE],
      env: { FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_RECORD_FILE: f.record, FAKE_CLAUDE_PID_FILE: f.pid, ...extraEnv },
    },
  });
  return { adapter, mod: m };
}

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    observation: {} as DecisionRequest['observation'], // adapter never reads it (prompts carry it)
    systemPrompt: 'You are a test player.',
    userPrompt: 'OBSERVATION-JSON-GOES-HERE',
    jsonSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    model: 'haiku',
    maxOutputTokens: 400,
    timeoutMs: 10_000,
    maxBudgetUsd: 0.05,
    ...overrides,
  };
}

const CFG: ResolvedProviderConfig = { kind: 'claude-cli', useSubscriptionAuth: true };

function readRecord(): { argv: string[]; stdin: string; cwd: string; envKeys: string[]; hasApiKey: boolean; hasAuthToken: boolean; maxOutputTokens: string | null } {
  return JSON.parse(fs.readFileSync(files().record, 'utf8'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

// ───────────────────────────── argv / validation ─────────────────────────────

describe('claude-cli argv and input validation (fixture)', () => {
  it('builds the exact restrictive argv', async () => {
    const m = await freshModule();
    const args = m.buildClaudeArgs({ systemPrompt: 'SYS', jsonSchema: { type: 'object' }, model: 'haiku', maxBudgetUsd: '0.05' });
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', 'SYS',
      '--tools', '',
      '--disallowedTools', 'mcp__*',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--max-turns', '2',
      '--json-schema', '{"type":"object"}',
      '--model', 'haiku',
      '--max-budget-usd', '0.05',
    ]);
    expect(m.buildClaudeArgs({ systemPrompt: 'S', jsonSchema: {} })).not.toContain('--model');
  });

  it('model validation rejects flag-like and malformed names', async () => {
    const m = await freshModule();
    for (const bad of ['--dangerously-skip-permissions', '-p', '--tools=default', 'haiku --tools default', 'a;b', 'a&b', '$(x)', 'x'.repeat(90), '', ' haiku']) {
      expect(m.isValidCliModel(bad), bad).toBe(false);
    }
    for (const good of ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5-20251001', 'claude-opus-4-1[1m]', 'us.anthropic.claude-x:0']) {
      expect(m.isValidCliModel(good), good).toBe(true);
    }
  });

  it('decide() refuses an invalid model without spawning anything', async () => {
    const { adapter } = await fakeAdapter('ok');
    const r = await adapter.decide(request({ model: '--dangerously-skip-permissions' }), CFG, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('bad_request');
    expect(fs.existsSync(files().pid)).toBe(false);
  });

  it('formats --max-budget-usd without exponent notation and refuses a zero budget', async () => {
    const m = await freshModule();
    expect(m.formatBudgetUsd(0.05)).toBe('0.05');
    expect(m.formatBudgetUsd(0.1234567)).toBe('0.123457');
    expect(m.formatBudgetUsd(1e-7)).toBeNull();
    expect(m.formatBudgetUsd(0)).toBeNull();
    const { adapter } = await fakeAdapter('ok', {}, m);
    const r = await adapter.decide(request({ maxBudgetUsd: 0 }), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('budget');
    expect(fs.existsSync(files().pid)).toBe(false);
  });

  it('the fake itself exits 2 when restrictive flags are missing (fixture self-check)', async () => {
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [FAKE, '-p', '--output-format', 'stream-json', '--verbose'], { input: 'x', encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('--tools ""');
    expect(res.stderr).toContain('--strict-mcp-config');
  });
});

// ───────────────────────────── binary resolution ─────────────────────────────

describe('claude-cli binary resolution (fixture files)', () => {
  it('refuses .cmd / .bat / .ps1 shims, relative paths, directories and missing files', async () => {
    const m = await freshModule();
    for (const ext of ['.cmd', '.bat', '.ps1']) {
      const p = path.join(caseDir, `claude${ext}`);
      fs.writeFileSync(p, '@echo off\n');
      const r = m.resolveClaudeBinary(p);
      expect(r.ok, ext).toBe(false);
      if (!r.ok) expect(r.issue).toContain(ext);
    }
    expect(m.resolveClaudeBinary('claude.exe').ok).toBe(false);
    expect(m.resolveClaudeBinary(caseDir).ok).toBe(false);
    expect(m.resolveClaudeBinary(path.join(caseDir, 'missing', process.platform === 'win32' ? 'claude.exe' : 'claude')).ok).toBe(false);
  });

  it('check() reports a .cmd CLAUDE_CLI_PATH as not configured (no override)', async () => {
    const m = await freshModule();
    const p = path.join(caseDir, 'claude.cmd');
    fs.writeFileSync(p, '@echo off\n');
    const adapter = m.createClaudeCliAdapter({ baseDir: path.join(caseDir, 'base') });
    const c = adapter.check({ kind: 'claude-cli', cliPath: p, useSubscriptionAuth: true });
    expect(c.configured).toBe(false);
    expect(c.enabled).toBe(false);
    expect(c.issues.join(' ')).toContain('.cmd');
    const r = await adapter.decide(request(), { kind: 'claude-cli', cliPath: p, useSubscriptionAuth: true }, new AbortController().signal);
    expect(r.error?.code).toBe('not_configured');
  });

  it('PATH search finds only the native binary name and skips shim directories', async () => {
    const m = await freshModule();
    const shimDir = path.join(caseDir, 'shims');
    const binDir = path.join(caseDir, 'bin');
    fs.mkdirSync(shimDir);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(shimDir, 'claude.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(shimDir, 'claude.ps1'), '#\n');
    const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(m.resolveClaudeBinary(undefined, { PATH: shimDir }).ok).toBe(false);
    fs.writeFileSync(path.join(binDir, exeName), '');
    if (process.platform !== 'win32') fs.chmodSync(path.join(binDir, exeName), 0o755);
    const r = m.resolveClaudeBinary(undefined, { PATH: [shimDir, binDir].join(sep) });
    expect(r).toEqual({ ok: true, path: path.join(binDir, exeName), source: 'PATH' });
  });
});

// ───────────────────────────── decide() scenarios ─────────────────────────────

describe('claude-cli decide() with the fake CLI (fixture)', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    delete process.env.LUCK_TEST_SENTINEL;
  });

  it('ok: structured output, usage, cost, latency and model are mapped', async () => {
    const { adapter } = await fakeAdapter('ok');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.structured).toEqual({ action: 'bet', bets: [{ type: 'red', stake: 10 }], explanation: 'fixture decision' });
    expect(JSON.parse(r.text!)).toEqual(r.structured);
    expect(r.usage).toEqual({ inputTokens: 812, outputTokens: 57, cacheReadTokens: 4096, cacheWriteTokens: 0, reasoningTokens: 0, known: true });
    expect(r.providerCostUsd).toBe(0.00123);
    expect(r.generationMs).toBe(987);
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.modelReported).toBe('haiku');
    expect(r.finishReason).toBe('success');
    expect(r.rateLimit).toBeNull();
    expect(r.note).toContain("CLI's own estimate");
  });

  it('ok: prompt goes on stdin, cwd is the empty sandbox, env is minimal, output cap is passed', async () => {
    process.env.LUCK_TEST_SENTINEL = 'must-not-leak';
    const { adapter } = await fakeAdapter('ok');
    const r = await adapter.decide(request({ maxOutputTokens: 321 }), CFG, new AbortController().signal);
    expect(r.ok).toBe(true);
    const rec = readRecord();
    expect(rec.stdin).toBe('OBSERVATION-JSON-GOES-HERE');
    expect(rec.argv.join(' ')).not.toContain('OBSERVATION-JSON-GOES-HERE');
    expect(path.resolve(rec.cwd).toLowerCase()).toBe(path.resolve(files().sandbox).toLowerCase());
    expect(fs.readdirSync(files().sandbox)).toEqual([]);
    expect(rec.maxOutputTokens).toBe('321');
    const keys = rec.envKeys.map((k) => k.toUpperCase());
    expect(keys).not.toContain('LUCK_TEST_SENTINEL');
    expect(keys).not.toContain('CLAUDECODE');
    expect(keys).not.toContain('CLAUDE_CODE_SESSION_ID');
    expect(keys).toContain('ENABLE_CLAUDEAI_MCP_SERVERS');
    expect(keys).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY');
    expect(keys).toContain('CLAUDE_CODE_MAX_RETRIES');
    expect(keys).toContain('MAX_THINKING_TOKENS');
  });

  it('keeps ONE Claude Code conversation per Luck session: --session-id + opening context, then --resume', async () => {
    const { adapter } = await fakeAdapter('ok');
    const m = await freshModule();
    const first = await adapter.decide(request({ conversationKey: 'luck-session-A' }), CFG, new AbortController().signal);
    expect(first.ok).toBe(true);
    const rec1 = readRecord();
    const i1 = rec1.argv.indexOf('--session-id');
    expect(i1).toBeGreaterThan(-1);
    const cliId = rec1.argv[i1 + 1];
    expect(cliId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec1.argv).not.toContain('--no-session-persistence');
    expect(rec1.argv).not.toContain('--resume');
    expect(rec1.stdin.startsWith('Session start')).toBe(true);
    expect(rec1.stdin).toMatch(/virtual/);
    expect(rec1.stdin.endsWith('OBSERVATION-JSON-GOES-HERE')).toBe(true);

    const second = await adapter.decide(request({ conversationKey: 'luck-session-A' }), CFG, new AbortController().signal);
    expect(second.ok).toBe(true);
    const rec2 = readRecord();
    expect(rec2.argv[rec2.argv.indexOf('--resume') + 1]).toBe(cliId);
    expect(rec2.argv).not.toContain('--session-id');
    expect(rec2.stdin).toBe('OBSERVATION-JSON-GOES-HERE');

    // A different Luck session gets its own conversation; no key keeps the stateless mode.
    await adapter.decide(request({ conversationKey: 'luck-session-B' }), CFG, new AbortController().signal);
    const rec3 = readRecord();
    expect(rec3.argv[rec3.argv.indexOf('--session-id') + 1]).not.toBe(cliId);
    await adapter.decide(request(), CFG, new AbortController().signal);
    expect(readRecord().argv).toContain('--no-session-persistence');
    void m;
  });

  it('strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN when useSubscriptionAuth is on', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-fixture-not-a-real-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token-value';
    const { adapter } = await fakeAdapter('echo_env');
    const r = await adapter.decide(request(), { kind: 'claude-cli', useSubscriptionAuth: true }, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect((r.structured as { explanation: string }).explanation).toBe('ANTHROPIC_API_KEY=absent');
    expect(readRecord().hasApiKey).toBe(false);
    expect(readRecord().hasAuthToken).toBe(false);
  });

  it('passes the API key only when subscription auth is explicitly off', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { adapter, mod } = await fakeAdapter('echo_env');
    const r = await adapter.decide(request(), { kind: 'claude-cli', useSubscriptionAuth: false, apiKey: 'sk-ant-api03-fixture-key' }, new AbortController().signal);
    expect((r.structured as { explanation: string }).explanation).toBe('ANTHROPIC_API_KEY=present');
    // …and refuses to run with API-key auth but no key.
    const { adapter: a2 } = await fakeAdapter('echo_env', {}, mod);
    const r2 = await a2.decide(request(), { kind: 'claude-cli', useSubscriptionAuth: false }, new AbortController().signal);
    expect(r2.error?.code).toBe('not_configured');
    expect(a2.check({ kind: 'claude-cli', useSubscriptionAuth: false }).configured).toBe(false);
  });

  it('allows the CLI-internal StructuredOutput tool and built-in plugins (live-observed shape)', async () => {
    const { adapter, mod } = await fakeAdapter('structured_output_tool');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.ok).toBe(true);
    const { adapter: a2 } = await fakeAdapter('builtin_plugins', {}, mod);
    const r2 = await a2.decide(request(), CFG, new AbortController().signal);
    expect(r2.ok).toBe(true);
    expect(a2.check(CFG).enabled).toBe(true);
  });

  for (const scenario of ['init_with_tools', 'init_with_mcp', 'init_with_plugin', 'tool_use', 'permission_denial']) {
    it(`${scenario}: boundary_violation and the adapter stays disabled for the process`, async () => {
      const { adapter, mod } = await fakeAdapter(scenario);
      const r = await adapter.decide(request(), CFG, new AbortController().signal);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('boundary_violation');
      expect(r.error?.retryable).toBe(false);
      const c = adapter.check(CFG);
      expect(c.enabled).toBe(false);
      expect(c.configured).toBe(true);
      expect(c.issues.join(' ')).toMatch(/Disabled for this server run/);

      // A NEW adapter instance from the same module is still disabled and never spawns.
      fs.rmSync(files().pid, { force: true });
      const { adapter: again } = await fakeAdapter('ok', {}, mod);
      const r2 = await again.decide(request(), CFG, new AbortController().signal);
      expect(r2.error?.code).toBe('boundary_violation');
      expect(fs.existsSync(files().pid)).toBe(false);
      const t = await again.testConnection(CFG, new AbortController().signal);
      expect(t.ok).toBe(false);
    });
  }

  it('rate_limit_event is captured (status, reset, utilization per window)', async () => {
    const { adapter } = await fakeAdapter('rate_limit_event_then_ok');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(r.rateLimit?.source).toBe('cli-rate-limit-event');
    expect(r.rateLimit?.entries).toEqual([
      { name: 'five_hour', status: 'allowed_warning', resetAt: new Date(1893456000 * 1000).toISOString(), utilization: 0.82 },
      { name: 'seven_day', resetAt: new Date(1893801600 * 1000).toISOString(), utilization: 0.4 },
    ]);
  });

  it('auth error → auth, not retryable', async () => {
    const { adapter } = await fakeAdapter('auth_error');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error).toMatchObject({ code: 'auth', retryable: false });
  });

  it('plan limit with reset time → rate_limited, not retryable, retryAfterMs from the reset', async () => {
    const { adapter } = await fakeAdapter('plan_limit');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('rate_limited');
    expect(r.error?.retryable).toBe(false);
    expect(r.error?.retryAfterMs).toBeGreaterThan(3_500_000);
    expect(r.error?.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    expect(r.rateLimit?.entries[0]).toMatchObject({ name: 'five_hour', status: 'rejected' });
  });

  it('overloaded → server_error, retryable', async () => {
    const { adapter } = await fakeAdapter('overloaded');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error).toMatchObject({ code: 'server_error', retryable: true });
    expect(r.note).toContain('retried the API 1×');
  });

  it('max budget → budget; tokens and cost of the stopped call are still reported', async () => {
    const { adapter } = await fakeAdapter('max_budget');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error).toMatchObject({ code: 'budget', retryable: false });
    expect(r.usage).toMatchObject({ inputTokens: 812, outputTokens: 57, known: true });
    expect(r.providerCostUsd).toBe(0.0112);
  });

  it('max turns → invalid_output', async () => {
    const { adapter } = await fakeAdapter('max_turns');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('invalid_output');
  });

  it('malformed stream → invalid_output', async () => {
    const { adapter } = await fakeAdapter('malformed');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('invalid_output');
    expect(r.usage.known).toBe(false);
  });

  it('result without an init event is not trusted → invalid_output', async () => {
    const { adapter } = await fakeAdapter('no_init');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('invalid_output');
  });

  it('nonzero exit without a result → unknown with the exit code', async () => {
    const { adapter } = await fakeAdapter('nonzero_exit');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('unknown');
    expect(r.error?.message).toContain('code 3');
  });

  it('timeout kills the child and reports timeout with unknown usage', async () => {
    const { adapter } = await fakeAdapter('hang');
    const r = await adapter.decide(request({ timeoutMs: 1500 }), CFG, new AbortController().signal);
    expect(r.error).toMatchObject({ code: 'timeout', retryable: true });
    expect(r.usage.known).toBe(false);
    expect(r.providerCostUsd).toBeNull();
    const pid = Number(fs.readFileSync(files().pid, 'utf8'));
    expect(await waitDead(pid)).toBe(true);
  });

  it('abort kills the child and reports cancelled', async () => {
    const { adapter } = await fakeAdapter('hang');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 700);
    const r = await adapter.decide(request({ timeoutMs: 30_000 }), CFG, ac.signal);
    expect(r.error).toMatchObject({ code: 'cancelled', retryable: false });
    const pid = Number(fs.readFileSync(files().pid, 'utf8'));
    expect(await waitDead(pid)).toBe(true);
  });

  it('an already-aborted signal never spawns', async () => {
    const { adapter } = await fakeAdapter('ok');
    const ac = new AbortController();
    ac.abort();
    const r = await adapter.decide(request(), CFG, ac.signal);
    expect(r.error?.code).toBe('cancelled');
    expect(fs.existsSync(files().pid)).toBe(false);
  });

  it('a non-empty sandbox directory is refused without spawning', async () => {
    const { adapter } = await fakeAdapter('ok');
    fs.mkdirSync(files().sandbox, { recursive: true });
    fs.writeFileSync(path.join(files().sandbox, 'CLAUDE.md'), 'injected instructions');
    const r = await adapter.decide(request(), CFG, new AbortController().signal);
    expect(r.error?.code).toBe('not_configured');
    expect(fs.existsSync(files().pid)).toBe(false);
  });
});

// ───────────────────────────── testConnection / classification ─────────────────────────────

describe('claude-cli testConnection and error classification (fixture)', () => {
  it('testConnection checks --version and "auth status" without sending a prompt or leaking identity', async () => {
    const { adapter } = await fakeAdapter('ok');
    const t = await adapter.testConnection(CFG, new AbortController().signal);
    expect(t.ok).toBe(true);
    expect(t.version).toBe('9.9.9-fake');
    expect(t.message).toMatch(/logged in via claude.ai, fixture plan/);
    expect(t.message).toMatch(/no prompt was sent/);
    expect(t.message).not.toMatch(/fixture@example.invalid|Fixture Org/);
    expect(fs.existsSync(files().record)).toBe(false); // the fake records only prompt runs
  });

  it('testConnection reports a logged-out CLI as not connected', async () => {
    const { adapter } = await fakeAdapter('ok', { FAKE_CLAUDE_LOGGED_OUT: '1' });
    const t = await adapter.testConnection(CFG, new AbortController().signal);
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/not logged in/);
  });

  it('capabilities are the honest, conservative set', async () => {
    const m = await freshModule();
    const c = m.CLAUDE_CLI_CAPABILITIES;
    expect(c).toMatchObject({ kind: 'claude-cli', local: false, paid: true, generatesText: true, reportsTokenUsage: 'full', reportsCost: true, listsModels: false, structuredOutput: true, quotaInfo: 'rate-limit-events', requiresApiKey: false });
    expect(c.notes.join(' ')).toMatch(/not billing/);
    expect(c.notes.join(' ')).toMatch(/Personal use/);
  });

  it('classifies CLI error texts', async () => {
    const m = await freshModule();
    const now = 1_700_000_000_000;
    const plan = m.classifyCliError(`Claude AI usage limit reached|${now / 1000 + 600}`, { now });
    expect(plan).toMatchObject({ code: 'rate_limited', retryable: false, retryAfterMs: 600_000 });
    expect(m.classifyCliError("You've hit your limit · resets 3pm (Europe/London)")).toMatchObject({ code: 'rate_limited', retryable: false });
    expect(m.classifyCliError('API Error: 429 Too Many Requests')).toMatchObject({ code: 'rate_limited', retryable: true });
    expect(m.classifyCliError("API Error: Claude's response exceeded the 400 output token maximum.")).toMatchObject({ code: 'invalid_output', retryable: true });
    expect(m.classifyCliError('Not logged in · Please run /login')).toMatchObject({ code: 'auth', retryable: false });
    expect(m.classifyCliError('', { subtype: 'error_max_budget_usd' }).code).toBe('budget');
    expect(m.classifyCliError('something odd')).toMatchObject({ code: 'unknown', retryable: false });
  });

  it('redacts secrets in error messages', async () => {
    const m = await freshModule();
    const e = m.classifyCliError('Invalid API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz · Please run /login');
    expect(e.code).toBe('auth');
    expect(e.message).not.toContain('abcdefghijklmnop');
  });
});

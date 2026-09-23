/**
 * FIXTURE TESTS for the Claude Code CLI adapter. No real CLI is run here: every decide() spawns
 * tests/fixtures/fake-claude.mjs (a fake that emits stream-json) through the test-only
 * spawnOverride. Live verification with the real CLI is recorded separately in
 * docs/providers-cli-laya.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRequest, ProviderAdapter, ResolvedProviderConfig } from '../types.js';

const FAKE = fileURLToPath(new URL('../../../tests/fixtures/fake-claude.mjs', import.meta.url));
const TMP_ROOT = fileURLToPath(new URL('../../../tmp/8/claudeCli-test/', import.meta.url));

type Mod = typeof import('./claudeCli.js');
type AdapterOptions = NonNullable<Parameters<Mod['createClaudeCliAdapter']>[0]>;

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
    meta: path.join(caseDir, 'meta.jsonl'),
    pid: path.join(caseDir, 'pid.txt'),
    sandbox: path.join(caseDir, 'sandbox'),
    /** The fake keeps each conversation's running totals here (like the real CLI's transcript). */
    state: caseDir,
  };
}

function fakeEnv(scenario: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  const f = files();
  return {
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_RECORD_FILE: f.record,
    FAKE_CLAUDE_META_RECORD_FILE: f.meta,
    FAKE_CLAUDE_PID_FILE: f.pid,
    FAKE_CLAUDE_STATE_DIR: f.state,
    ...extraEnv,
  };
}

async function fakeAdapter(
  scenario: string,
  extraEnv: Record<string, string> = {},
  mod?: Mod,
  extraOpts: Partial<AdapterOptions> = {},
): Promise<{ adapter: ProviderAdapter; mod: Mod }> {
  const m = mod ?? (await freshModule());
  const adapter = m.createClaudeCliAdapter({
    sandboxDir: files().sandbox,
    spawnOverride: { command: process.execPath, prefixArgs: [FAKE], env: fakeEnv(scenario, extraEnv) },
    ...extraOpts,
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

/** One entry per `--version` / `auth status` child the connection test started. */
function readMeta(): { argv: string[]; cwd: string; envKeys: string[]; hasApiKey: boolean; hasAuthToken: boolean }[] {
  return fs
    .readFileSync(files().meta, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const sig = () => new AbortController().signal;

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
    const adapter = m.createClaudeCliAdapter({ sandboxDir: files().sandbox });
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

// ───────────────────────────── running totals of a resumed conversation ─────────────────────────────

describe('claude-cli per-turn cost and API time in a resumed conversation (fixture)', () => {
  /** Raw result events the fake emitted, captured through the adapter's diagnostics tap. */
  function resultTap(): { opts: Partial<AdapterOptions>; results: Record<string, unknown>[] } {
    const results: Record<string, unknown>[] = [];
    return {
      results,
      opts: {
        debugTap: (line) => {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === 'result') results.push(ev);
        },
      },
    };
  }

  it('turns 2 and 3 report only the increase of the running total_cost_usd / duration_api_ms', async () => {
    const tap = resultTap();
    const { adapter } = await fakeAdapter(
      'ok',
      { FAKE_CLAUDE_TURN_COSTS: '0.004,0.0015,0.0021', FAKE_CLAUDE_TURN_API_MS: '1200,800,650' },
      undefined,
      tap.opts,
    );
    const key = { conversationKey: 'luck-session-totals' };
    const t1 = await adapter.decide(request(key), CFG, sig());
    const t2 = await adapter.decide(request(key), CFG, sig());
    const t3 = await adapter.decide(request(key), CFG, sig());
    for (const t of [t1, t2, t3]) expect(t.ok).toBe(true);

    // The fake (like the real CLI) reported RUNNING totals for the conversation…
    const reportedCost = tap.results.map((r) => r.total_cost_usd as number);
    expect(reportedCost).toHaveLength(3);
    expect(reportedCost[0]).toBeCloseTo(0.004, 12);
    expect(reportedCost[1]).toBeCloseTo(0.0055, 12);
    expect(reportedCost[2]).toBeCloseTo(0.0076, 12);
    expect(tap.results.map((r) => r.duration_api_ms)).toEqual([1200, 2000, 2650]);

    // …and the adapter reports each turn's share.
    expect(t1.providerCostUsd).toBeCloseTo(0.004, 12);
    expect(t1.generationMs).toBe(1200);
    expect(t2.providerCostUsd).toBeCloseTo(0.0015, 12);
    expect(t2.generationMs).toBe(800);
    expect(t3.providerCostUsd).toBeCloseTo(0.0021, 12);
    expect(t3.generationMs).toBe(650);
    // Summing the per-turn figures gives the CLI's own conversation total (no over-count).
    expect(t1.providerCostUsd! + t2.providerCostUsd! + t3.providerCostUsd!).toBeCloseTo(0.0076, 12);

    // Tokens come from result.usage, which is already per turn; modelUsage (a running total) only names the model.
    expect(t2.usage).toMatchObject({ inputTokens: 812, outputTokens: 57, known: true });
    expect(t2.modelReported).toBe('haiku');
    expect(t1.note).not.toMatch(/running conversation totals/);
    expect(t2.note).toMatch(/turn 2 \(resumed\)/);
    expect(t2.note).toMatch(/this turn's increase of the CLI's running conversation totals \(conversation total so far \$0\.0055\)/);
    expect(t3.note).toMatch(/API time 650 ms/);
  });

  it('an unknown previous total makes the resumed turn cost unknown (null + note), never the running total', async () => {
    const { adapter } = await fakeAdapter('ok', {
      FAKE_CLAUDE_TURN_COSTS: '0.004,0.0015',
      FAKE_CLAUDE_TURN_API_MS: '1200,800',
      FAKE_CLAUDE_OMIT_TOTALS_ON_TURN: '1',
    });
    const key = { conversationKey: 'luck-session-unknown-base' };
    const t1 = await adapter.decide(request(key), CFG, sig());
    expect(t1.ok).toBe(true);
    expect(t1.providerCostUsd).toBeNull(); // the CLI did not report a cost on this turn
    expect(t1.generationMs).toBeNull();

    const t2 = await adapter.decide(request(key), CFG, sig()); // CLI reports 0.0055 / 2000 ms (running totals)
    expect(t2.ok).toBe(true);
    expect(t2.providerCostUsd).toBeNull();
    expect(t2.generationMs).toBeNull();
    expect(t2.note).toMatch(/cost unknown: the CLI reports a running total for the conversation and the previous total is not known/);
    expect(t2.note).toMatch(/API time unknown/);

    // Once a total has been seen, the next turn is exact again.
    const t3 = await adapter.decide(request(key), CFG, sig());
    expect(t3.providerCostUsd).toBeCloseTo(0.0015, 12);
    expect(t3.generationMs).toBe(800);
  });

  it('a zeroed error result mid-conversation yields no negative cost and keeps the previous total', async () => {
    const { adapter, mod } = await fakeAdapter('ok', { FAKE_CLAUDE_TURN_COSTS: '0.004,0.0015', FAKE_CLAUDE_TURN_API_MS: '1200,800' });
    const key = { conversationKey: 'luck-session-zeroed' };
    expect((await adapter.decide(request(key), CFG, sig())).providerCostUsd).toBeCloseTo(0.004, 12);

    // Same module → same conversation map; this run resumes and gets an error result with zeroed totals.
    const { adapter: failing } = await fakeAdapter('auth_error', {}, mod);
    const bad = await failing.decide(request(key), CFG, sig());
    expect(bad.error?.code).toBe('auth');
    expect(readRecord().argv).toContain('--resume');
    expect(bad.providerCostUsd).toBeNull();
    expect(bad.note).toMatch(/cost unknown: the CLI's running total \(0\) is below the previous one \(0\.004\)/);

    const next = await adapter.decide(request(key), CFG, sig()); // CLI total 0.0055 continues from the transcript
    expect(next.ok).toBe(true);
    expect(next.providerCostUsd).toBeCloseTo(0.0015, 12);
    expect(next.generationMs).toBe(800);
  });

  it('a running total that restarts after a successful result: that turn is unknown, the next one exact again', async () => {
    const { adapter } = await fakeAdapter('ok', {
      FAKE_CLAUDE_TURN_COSTS: '0.004,0.0015,0.0021',
      FAKE_CLAUDE_TURN_API_MS: '1200,800,650',
      FAKE_CLAUDE_RESET_TOTALS_ON_TURN: '2',
    });
    const key = { conversationKey: 'luck-session-restart' };
    expect((await adapter.decide(request(key), CFG, sig())).providerCostUsd).toBeCloseTo(0.004, 12);
    const t2 = await adapter.decide(request(key), CFG, sig()); // CLI total restarts: 0.0015 < 0.004
    expect(t2.ok).toBe(true);
    expect(t2.providerCostUsd).toBeNull();
    expect(t2.generationMs).toBeNull();
    expect(t2.note).toMatch(/cost unknown: the CLI's running total \(0\.0015\) is below the previous one \(0\.004\)/);
    const t3 = await adapter.decide(request(key), CFG, sig()); // CLI total 0.0036 from the new base 0.0015
    expect(t3.providerCostUsd).toBeCloseTo(0.0021, 12);
    expect(t3.generationMs).toBe(650);
  });

  it('a resumed attempt that ended without a result is flagged on the next turn', async () => {
    const { adapter, mod } = await fakeAdapter('ok');
    const key = { conversationKey: 'luck-session-lost-attempt' };
    expect((await adapter.decide(request(key), CFG, sig())).ok).toBe(true);
    const { adapter: hanging } = await fakeAdapter('hang', {}, mod);
    const lost = await hanging.decide(request({ ...key, timeoutMs: 800 }), CFG, sig());
    expect(lost.error?.code).toBe('timeout');
    const next = await adapter.decide(request(key), CFG, sig());
    expect(next.ok).toBe(true);
    expect(readRecord().argv).toContain('--resume');
    expect(next.note).toMatch(/turn 2 \(resumed\)/);
    expect(next.note).toMatch(/earlier attempt in this conversation ended without a result/);
  });
});

// ───────────────────────────── check(): an invalid model is blocking ─────────────────────────────

describe('claude-cli check() and the model name', () => {
  it('an invalid model makes the adapter not configured / not enabled with a clear issue', async () => {
    const { adapter, mod } = await fakeAdapter('ok');
    for (const bad of ['--tools=Bash', '-p', 'haiku --tools default']) {
      const c = adapter.check({ ...CFG, model: bad });
      expect(c.configured, bad).toBe(false);
      expect(c.enabled, bad).toBe(false);
      expect(c.issues.join(' '), bad).toMatch(/Model name is not valid/);
    }
    expect(adapter.check({ ...CFG, model: 'haiku' })).toEqual({ configured: true, enabled: true, issues: [] });
    expect(adapter.check({ ...CFG, model: 'claude-opus-4-1[1m]' })).toEqual({ configured: true, enabled: true, issues: [] });
    expect(adapter.check(CFG)).toEqual({ configured: true, enabled: true, issues: [] }); // no model = CLI default
    // Still exported for create-time validation elsewhere.
    expect(mod.isValidCliModel('--tools=Bash')).toBe(false);
  });
});

// ───────────────────────────── sandbox location ─────────────────────────────

describe('claude-cli sandbox directory', () => {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to <OS temp dir>/luck-cli-sandbox: dedicated, empty and outside the repository', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const rel = path.relative(repoRoot, path.join(os.tmpdir(), 'luck-cli-sandbox'));
    expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);

    // Point the OS temp dir at this test's folder so the real default directory is not touched.
    const fakeTmp = path.join(caseDir, 'os-tmp');
    fs.mkdirSync(fakeTmp);
    process.env.TEMP = fakeTmp;
    process.env.TMP = fakeTmp;
    process.env.TMPDIR = fakeTmp;
    const m = await freshModule();
    const adapter = m.createClaudeCliAdapter({ spawnOverride: { command: process.execPath, prefixArgs: [FAKE], env: fakeEnv('ok') } });
    const r = await adapter.decide(request(), CFG, sig());
    expect(r.ok).toBe(true);
    const expected = path.join(fakeTmp, 'luck-cli-sandbox');
    expect(path.resolve(readRecord().cwd).toLowerCase()).toBe(path.resolve(expected).toLowerCase());
    expect(fs.readdirSync(expected)).toEqual([]);
  });
});

// ───────────────────────────── testConnection uses the real call environment ─────────────────────────────

describe('claude-cli testConnection auth matches real calls (fixture)', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });
  const KEY_CFG: ResolvedProviderConfig = { kind: 'claude-cli', useSubscriptionAuth: false, apiKey: 'sk-ant-api03-fixture-key' };

  it('subscription auth off: the test children get the API key, with the same env as decide()', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { adapter } = await fakeAdapter('ok');
    const t = await adapter.testConnection(KEY_CFG, sig());
    expect(t.ok).toBe(true);
    expect(t.message).toMatch(/API-key auth \(key source ANTHROPIC_API_KEY; subscription login not used\)/);
    expect(t.message).toMatch(/does not validate the key/);
    expect(t.message).not.toMatch(/logged in via/);
    const meta = readMeta();
    expect(meta.map((m) => m.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
    for (const m of meta) expect(m.hasApiKey).toBe(true);

    const r = await adapter.decide(request(), KEY_CFG, sig());
    expect(r.ok).toBe(true);
    const rec = readRecord();
    expect(rec.hasApiKey).toBe(true);
    // Identical environment apart from the per-call output cap.
    const callKeys = rec.envKeys.filter((k) => k !== 'CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    for (const m of meta) expect(m.envKeys).toEqual(callKeys);
    expect(path.resolve(meta[0]!.cwd).toLowerCase()).toBe(path.resolve(rec.cwd).toLowerCase());
  });

  it('subscription auth off without a key: fails with the same issue as decide(), without starting the CLI', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { adapter } = await fakeAdapter('ok');
    const noKey: ResolvedProviderConfig = { kind: 'claude-cli', useSubscriptionAuth: false };
    const t = await adapter.testConnection(noKey, sig());
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/no ANTHROPIC_API_KEY/);
    expect(fs.existsSync(files().pid)).toBe(false);
    const r = await adapter.decide(request(), noKey, sig());
    expect(r.error?.code).toBe('not_configured');
    expect(r.error?.message).toBe(t.message);
  });

  it('subscription auth on: a server ANTHROPIC_API_KEY never reaches the test children', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-server-key-must-not-leak';
    const { adapter } = await fakeAdapter('ok');
    const t = await adapter.testConnection(CFG, sig());
    expect(t.ok).toBe(true);
    expect(t.message).toMatch(/logged in via claude.ai, fixture plan/);
    const meta = readMeta();
    expect(meta).toHaveLength(2);
    for (const m of meta) expect(m.hasApiKey).toBe(false);
  });
});

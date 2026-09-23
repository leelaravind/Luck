import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, loadConfig } from './config.js';
import { clearRegisteredSecrets, redact } from './redact.js';

const repoRoot = findRepoRoot();

afterEach(() => clearRegisteredSecrets());

describe('loadConfig defaults', () => {
  it('uses loopback defaults and repo-relative paths', () => {
    const cfg = loadConfig({});
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3717);
    expect(cfg.dataDir).toBe(join(repoRoot, 'data'));
    expect(cfg.dbPath).toBe(join(repoRoot, 'data', 'luck.db'));
    expect(cfg.webDistDir).toBe(join(repoRoot, 'dist', 'web'));
    expect(cfg.providers.ollama).toEqual({ baseUrl: 'http://127.0.0.1:11434', model: undefined });
    expect(cfg.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.providers.anthropic.apiKey).toBeUndefined();
    expect(cfg.providers.openai.baseUrl).toBeUndefined(); // must be explicit
    expect(cfg.providers.claudeCli).toEqual({ path: undefined, enabled: true, model: undefined, useSubscriptionAuth: true });
    expect(cfg.providers.laya).toEqual({ baseUrl: 'http://127.0.0.1:8000', apiKey: undefined, checkpoint: 'english' });
  });

  it('reads the version from package.json', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    expect(loadConfig({}).version).toBe(pkg.version);
  });

  it('finds the repo root regardless of the current directory', () => {
    expect(readFileSync(join(repoRoot, 'package.json'), 'utf8')).toContain('"luck-ai-roulette-lab"');
  });
});

describe('LUCK_HOST must be loopback', () => {
  it.each(['0.0.0.0', '192.168.1.10', '192.168.0.1', '10.0.0.5', '::', '[::]', 'example.com', '127.0.0.2', '0'])('refuses %s', (host) => {
    expect(() => loadConfig({ LUCK_HOST: host })).toThrow(/LUCK_HOST must be a loopback address/);
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
    ['LOCALHOST', 'localhost'],
    ['::1', '::1'],
    ['[::1]', '::1'],
  ])('accepts %s', (host, expected) => {
    expect(loadConfig({ LUCK_HOST: host }).host).toBe(expected);
  });
});

describe('dev origins', () => {
  it('allows the Vite origins when NODE_ENV is not production', () => {
    const cfg = loadConfig({ LUCK_WEB_PORT: '5800' });
    expect(cfg.isDev).toBe(true);
    expect(cfg.devOrigins).toEqual(['http://127.0.0.1:5800', 'http://localhost:5800']);
  });

  it('has none in production unless LUCK_DEV=1', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).devOrigins).toEqual([]);
    expect(loadConfig({ NODE_ENV: 'production' }).isDev).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', LUCK_DEV: '1' }).devOrigins).toEqual(['http://127.0.0.1:5717', 'http://localhost:5717']);
  });

  it('refuses identical server and web ports in dev', () => {
    expect(() => loadConfig({ LUCK_PORT: '4000', LUCK_WEB_PORT: '4000' })).toThrow(/must be different/);
  });
});

describe('value validation', () => {
  it.each(['0', '65536', 'abc', '80.5', '-1'])('refuses LUCK_PORT=%s', (port) => {
    expect(() => loadConfig({ LUCK_PORT: port })).toThrow(/LUCK_PORT/);
  });

  it('resolves a relative LUCK_DATA_DIR against the repo root, not the cwd', () => {
    const cfg = loadConfig({ LUCK_DATA_DIR: 'my-data' });
    expect(cfg.dataDir).toBe(join(repoRoot, 'my-data'));
    expect(cfg.dbPath).toBe(join(repoRoot, 'my-data', 'luck.db'));
    const abs = resolve(repoRoot, 'tmp', '1', 'abs-data');
    expect(loadConfig({ LUCK_DATA_DIR: abs }).dataDir).toBe(abs);
  });

  it.each(['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '127.0.0.1:11434'])(
    'refuses non-http(s) OLLAMA_BASE_URL %s',
    (url) => {
      expect(() => loadConfig({ OLLAMA_BASE_URL: url })).toThrow(/OLLAMA_BASE_URL/);
    },
  );

  it('refuses credentials embedded in a base URL', () => {
    expect(() => loadConfig({ OPENAI_BASE_URL: 'https://user:pass@api.example.com/v1' })).toThrow(/must not contain a username or password/);
  });

  it('accepts explicit http(s) URLs and strips trailing slashes', () => {
    const cfg = loadConfig({ OPENAI_BASE_URL: 'https://api.example.com/v1/', LAYA_BASE_URL: 'http://127.0.0.1:9000' });
    expect(cfg.providers.openai.baseUrl).toBe('https://api.example.com/v1');
    expect(cfg.providers.laya.baseUrl).toBe('http://127.0.0.1:9000');
  });

  it('parses booleans strictly', () => {
    expect(loadConfig({ CLAUDE_CLI_ENABLED: 'false' }).providers.claudeCli.enabled).toBe(false);
    expect(loadConfig({ CLAUDE_CLI_USE_SUBSCRIPTION: '0' }).providers.claudeCli.useSubscriptionAuth).toBe(false);
    expect(() => loadConfig({ CLAUDE_CLI_ENABLED: 'maybe' })).toThrow(/CLAUDE_CLI_ENABLED/);
  });

  it('treats empty values as unset (as in a fresh .env copied from .env.example)', () => {
    const cfg = loadConfig({ ANTHROPIC_API_KEY: '', OPENAI_BASE_URL: '', OLLAMA_MODEL: '  ', LUCK_PORT: '' });
    expect(cfg.providers.anthropic.apiKey).toBeUndefined();
    expect(cfg.providers.openai.baseUrl).toBeUndefined();
    expect(cfg.providers.ollama.model).toBeUndefined();
    expect(cfg.port).toBe(3717);
  });

  it('strips surrounding quotes (e.g. a quoted Windows CLI path)', () => {
    const cfg = loadConfig({ CLAUDE_CLI_PATH: '"C:\\Program Files\\Claude\\claude.exe"' });
    expect(cfg.providers.claudeCli.path).toBe('C:\\Program Files\\Claude\\claude.exe');
  });

  it('refuses unsafe LAYA_CHECKPOINT names', () => {
    expect(() => loadConfig({ LAYA_CHECKPOINT: '../../etc' })).toThrow(/LAYA_CHECKPOINT/);
    expect(loadConfig({ LAYA_CHECKPOINT: 'typed-decisions' }).providers.laya.checkpoint).toBe('typed-decisions');
  });
});

describe('secrets', () => {
  it('registers every API key with the redactor', () => {
    const cfg = loadConfig({
      ANTHROPIC_API_KEY: 'anthropic-test-value-111',
      OPENAI_API_KEY: 'openai-test-value-222',
      LAYA_API_KEY: 'laya-test-value-333',
    });
    expect(cfg.providers.anthropic.apiKey).toBe('anthropic-test-value-111');
    const leaked = 'a=anthropic-test-value-111 b=openai-test-value-222 c=laya-test-value-333';
    expect(redact(leaked)).toBe('a=[redacted] b=[redacted] c=[redacted]');
  });
});

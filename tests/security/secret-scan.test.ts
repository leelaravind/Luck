/**
 * SECURITY — scripts/secret-scan.mjs (zero-dependency pre-commit scanner).
 *
 * The scanner runs as a real child process (exactly how it is used before a commit) against:
 *   1. a throw-away fixture directory in tmp/10 (walk mode) holding one planted secret per rule, forbidden
 *      files, placeholders and hand-written fakes;
 *   2. this repository in git mode (read-only `git ls-files`), which must be clean.
 *
 * Every planted secret is ASSEMBLED AT RUNTIME from fragments and a fixed pseudo-random generator, so this
 * source file itself never contains a string the scanner would flag.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, TMP_DIR } from '../e2e/harness.js';

const SCANNER = path.join(REPO_ROOT, 'scripts', 'secret-scan.mjs');

interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  preview: string;
}
interface Report {
  root: string;
  mode: 'git' | 'walk';
  filesListed: number;
  filesScanned: number;
  skipped: { file: string; reason: string }[];
  findings: Finding[];
}

function runScanner(args: string[], cwd = REPO_ROOT) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Deterministic "random-looking" string (fixed seed → identical every run, no flakiness). */
function pseudoRandom(seed: number, len: number, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'): string {
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}

const j = (...parts: string[]) => parts.join('');

// Planted secrets (realistic shapes, obviously invented values).
const SECRETS = {
  anthropic: j('sk-', 'ant-', 'api03-', pseudoRandom(1, 95)),
  openai: j('sk-', 'proj-', pseudoRandom(2, 56)),
  github: j('gh', 'p_', pseudoRandom(3, 36)),
  githubPat: j('github', '_pat_', pseudoRandom(4, 22), '_', pseudoRandom(5, 59)),
  aws: j('AK', 'IA', pseudoRandom(6, 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')),
  slack: j('xo', 'xb-', pseudoRandom(7, 12, '0123456789'), '-', pseudoRandom(8, 24)),
  generic: pseudoRandom(9, 32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'),
  envStyle: pseudoRandom(10, 40),
  inEnvExample: j('sk-', 'ant-', 'api03-', pseudoRandom(11, 95)),
  inBinary: j('sk-', 'ant-', 'api03-', pseudoRandom(12, 95)),
  suppressed: j('sk-', 'ant-', 'api03-', pseudoRandom(13, 95)),
};
const PEM_HEADER = j('-----BEGIN ', 'RSA ', 'PRIVATE KEY-----');

describe('SECURITY: secret-scan.mjs', () => {
  const fixture = path.join(TMP_DIR, `scan-fixture-${randomUUID()}`);
  const cleanOnly = path.join(TMP_DIR, `scan-clean-${randomUUID()}`);
  const put = (root: string, rel: string, content: string | Buffer) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  const CLEAN_TS = [
    '// ordinary code that must NOT be flagged',
    "const FAKE = 'sk-ant-test-SECRET123'; // the documented test fake",
    `const placeholder = '${j('sk-', 'ant-', 'api03-', 'x'.repeat(24))}';`,
    'const fromEnv = process.env.ANTHROPIC_API_KEY;',
    "const tokenCount = 'short';",
    "const slug = 'task-management-system-overview-document';",
    "const integrity = 'sha512-Xq3V9n4dYh1l5Q0p2Rk8sT7uW6vY9zA1bC3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lA==';",
    `const handWritten1 = '${j('sk-', 'ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz')}';`,
    `const handWritten2 = '${j('sk-', '1234567890', 'abcdefghij')}';`,
    `const handWritten3 = '${j('sk-', 'ant-', 'should-never-be-here')}';`,
    `const handWritten4 = '${j('sk-', 'ant-', 'api03-', 'fixture-key')}';`,
    `const suppressed = '${SECRETS.suppressed}'; // secret-scan:allow (documented example)`,
    "const url = 'https://example.invalid/path/to/something/long/enough';",
    `// prose: Anthropic keys look like ${j('sk-', 'ant-', 'api03-')}… and are never committed`,
    '',
  ].join('\n');

  const ENV_EXAMPLE = [
    '# copy to .env and fill in',
    'ANTHROPIC_API_KEY=',
    `OPENAI_API_KEY=${j('sk-', 'your-key-here')}`,
    'LAYA_API_KEY=changeme',
    'OLLAMA_BASE_URL=http://127.0.0.1:11434',
    '',
  ].join('\r\n'); // CRLF on purpose

  beforeAll(() => {
    // Planted findings (walk-mode fixture).
    put(fixture, 'src/anthropic.ts', `const fixtureKey = "${SECRETS.anthropic}";\n`);
    put(fixture, 'src/config.json', JSON.stringify({ provider: 'openai', key: SECRETS.openai }, null, 2));
    put(fixture, 'notes/github.txt', `clone with ${SECRETS.github}\nand ${SECRETS.githubPat}\n`);
    put(fixture, 'notes/aws.txt', `aws id ${SECRETS.aws}\n`);
    put(fixture, 'keys/deploy.txt', `${PEM_HEADER}\nMIIEowIBAAKCAQEA\n`);
    put(fixture, 'notes/slack.md', `token: ${SECRETS.slack}\n`);
    put(fixture, 'scripts/client.py', `api_key = '${SECRETS.generic}'\n`);
    put(fixture, 'config/settings.ini', `[svc]\nMY_SERVICE_TOKEN=${SECRETS.envStyle}\n`);
    // Placeholders are fine in .env.example, a real-looking vendor key is not.
    put(fixture, 'dist-config/.env.example', `ANTHROPIC_API_KEY=${SECRETS.inEnvExample}\n`);
    // Forbidden files, whatever they contain.
    put(fixture, '.env', 'NOTHING=here\n');
    put(fixture, 'app/.env.local', 'NOTHING=here\n');
    put(fixture, 'data/luck.db', 'SQLite format 3');
    put(fixture, 'certs/server.pem', 'not really a pem\n');
    put(fixture, 'client_secret_1234.apps.googleusercontent.com.json', '{}');
    // Binary content is not scanned (documented limitation) but binary NAMES still are.
    put(fixture, 'assets/blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(SECRETS.inBinary)]));
    // Things that must stay clean.
    put(fixture, 'src/clean.ts', CLEAN_TS);
    put(fixture, '.env.example', ENV_EXAMPLE);
    put(fixture, 'node_modules/pkg/leak.js', `const k = "${SECRETS.anthropic}";\n`); // skipped directory

    put(cleanOnly, 'src/clean.ts', CLEAN_TS);
    put(cleanOnly, '.env.example', ENV_EXAMPLE);
    put(cleanOnly, 'README.md', '# nothing secret here\n');
  });

  afterAll(() => {
    for (const d of [fixture, cleanOnly]) rmSync(d, { recursive: true, force: true });
  });

  it('flags one finding per planted secret rule and every forbidden file (exit 1)', () => {
    const r = runScanner(['--root', fixture, '--no-git', '--json']);
    expect(r.status, r.stderr).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.mode).toBe('walk');
    const byFile = (f: string) => report.findings.filter((x) => x.file === f).map((x) => x.rule);

    expect(byFile('src/anthropic.ts')).toEqual(['anthropic-api-key']);
    expect(byFile('src/config.json')).toEqual(['openai-style-key']);
    expect(byFile('notes/github.txt').sort()).toEqual(['github-fine-grained-pat', 'github-token']);
    expect(byFile('notes/aws.txt')).toEqual(['aws-access-key-id']);
    expect(byFile('keys/deploy.txt')).toEqual(['private-key-block']);
    expect(byFile('notes/slack.md')).toEqual(['slack-token']);
    expect(byFile('scripts/client.py')).toEqual(['generic-secret-assignment']);
    expect(byFile('config/settings.ini')).toEqual(['generic-env-assignment']);
    expect(byFile('dist-config/.env.example')).toEqual(['anthropic-api-key']);

    expect(byFile('.env')).toEqual(['forbidden-file:dotenv-file']);
    expect(byFile('app/.env.local')).toEqual(['forbidden-file:dotenv-file']);
    expect(byFile('data/luck.db')).toEqual(['forbidden-file:sqlite-database']);
    expect(byFile('certs/server.pem')).toEqual(['forbidden-file:pem-or-key-file']);
    expect(byFile('client_secret_1234.apps.googleusercontent.com.json')).toEqual(['forbidden-file:google-client-secret']);

    // Line/column point at the secret.
    const a = report.findings.find((x) => x.file === 'src/anthropic.ts')!;
    expect(a.line).toBe(1);
    expect(a.column).toBe('const fixtureKey = "'.length + 1);
    const env = report.findings.find((x) => x.file === 'config/settings.ini')!;
    expect(env.line).toBe(2);
  });

  it('does not flag placeholders, the documented test fake, hand-written fakes, suppressed lines, .env.example values or node_modules', () => {
    const report = JSON.parse(runScanner(['--root', fixture, '--no-git', '--json']).stdout) as Report;
    expect(report.findings.filter((x) => x.file === 'src/clean.ts')).toEqual([]);
    expect(report.findings.filter((x) => x.file === '.env.example')).toEqual([]);
    expect(report.findings.filter((x) => x.file.startsWith('node_modules/'))).toEqual([]);
    expect(report.findings.filter((x) => x.file === 'assets/blob.bin')).toEqual([]);
    expect(report.skipped).toContainEqual({ file: 'assets/blob.bin', reason: 'binary' });
  });

  it('never prints a full secret (JSON and human-readable output are redacted)', () => {
    const json = runScanner(['--root', fixture, '--no-git', '--json']);
    const human = runScanner(['--root', fixture, '--no-git']);
    expect(human.status).toBe(1);
    expect(human.stderr).toMatch(/finding\(s\)/);
    expect(human.stderr).toMatch(/src\/anthropic\.ts:1:\d+\s+\[anthropic-api-key\]/);
    for (const v of Object.values(SECRETS)) {
      expect(json.stdout.includes(v)).toBe(false);
      expect(human.stdout.includes(v) || human.stderr.includes(v)).toBe(false);
    }
    const report = JSON.parse(json.stdout) as Report;
    for (const f of report.findings.filter((x) => !x.rule.startsWith('forbidden-file'))) {
      expect(f.preview).toMatch(/…\(\d+ chars\)$/);
      expect(f.preview.length).toBeLessThan(24);
    }
  });

  it('a clean tree exits 0', () => {
    const r = runScanner(['--root', cleanOnly, '--no-git']);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toMatch(/secret-scan: clean/);
  });

  it('bad arguments exit 2', () => {
    expect(runScanner(['--frobnicate']).status).toBe(2);
  });

  it('this repository (git mode: tracked + untracked-not-ignored files) is clean', () => {
    const r = runScanner(['--json']);
    const report = JSON.parse(r.stdout || '{}') as Report;
    const summary = (report.findings ?? []).map((f) => `${f.file}:${f.line} [${f.rule}] ${f.preview}`).join('\n');
    expect(r.status, `secret-scan findings:\n${summary}\n${r.stderr}`).toBe(0);
    expect(report.mode).toBe('git');
    expect(report.filesListed).toBeGreaterThan(20);
    // gitignored scratch output (this suite's own fixtures, SQLite test files) is not listed
    expect(report.findings.some((f) => f.file.startsWith('tmp/'))).toBe(false);
  });
});

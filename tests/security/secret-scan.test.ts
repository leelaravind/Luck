/**
 * SECURITY — scripts/secret-scan.mjs (zero-dependency pre-commit scanner).
 *
 * The scanner runs as a real child process (exactly how it is used before a commit) against:
 *   1. a throw-away fixture directory in tmp/10 (walk mode) holding one planted secret per rule, forbidden
 *      files (incl. model weights), placeholders and hand-written fakes;
 *   2. fixtures with .gitignore files (walk mode honours them like git does);
 *   3. folders that are not a git repository, and a run without git on PATH (a ZIP download): the scanner
 *      falls back to walk mode with a notice instead of failing;
 *   4. this repository — git mode in a clone (read-only `git ls-files`), walk mode in a ZIP download — which
 *      must be clean, and whose walk-mode file list must equal git's;
 *   5. folders inside an enclosing repository they do not belong to (ignored there, or with no tracked file) and
 *      a repository where git lists 0 files: walk mode with a notice, so planted secrets are found instead of a
 *      false "clean — 0 files scanned".
 *
 * Every planted secret is ASSEMBLED AT RUNTIME from fragments and a fixed pseudo-random generator, so this
 * source file itself never contains a string the scanner would flag.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Computed here (not imported from the e2e harness) so this suite does not load any server module.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_DIR = path.join(REPO_ROOT, 'tmp', '10');
const SCANNER = path.join(REPO_ROOT, 'scripts', 'secret-scan.mjs');

/** Is `dir` inside a git work tree that git can read? (false for a ZIP download or without git) */
function insideGitWorkTree(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', env });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** Is a git executable on PATH? */
const GIT_INSTALLED = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

/** Environment in which git cannot see any repository above TMP_DIR (simulates a folder outside git). */
const NO_REPO_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: TMP_DIR };

/**
 * `git ls-files` of what a commit could publish, WITHOUT the user's global excludes file (core.excludesFile):
 * the scanner's walk mode reads only the .gitignore files in the tree, so a personal global ignore list must not
 * make the comparison differ between machines.
 */
function gitPublishableFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  mkdirSync(TMP_DIR, { recursive: true });
  const emptyExcludes = path.join(TMP_DIR, `empty-excludes-${randomUUID()}`);
  writeFileSync(emptyExcludes, '');
  try {
    const r = spawnSync('git', ['-c', `core.excludesFile=${emptyExcludes}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
    return [...new Set(r.stdout.split('\0').filter(Boolean))].sort();
  } finally {
    rmSync(emptyExcludes, { force: true });
  }
}

/** Environment without git on PATH (node itself is started by absolute path). */
function envWithoutGit(emptyDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^path$/i.test(k)) env[k] = v;
  env.PATH = emptyDir;
  return env;
}

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
  /** set when git was not usable and the scanner fell back to walk mode */
  fallbackReason?: string;
}

function runScanner(args: string[], cwd = REPO_ROOT, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The scanner's own file listing (walk or git mode), imported in-process. */
async function scannerListFiles(root: string, git: boolean): Promise<string[]> {
  const mod = (await import(pathToFileURL(SCANNER).href)) as { listFiles: (o: { root: string; git: boolean }) => string[] };
  return mod.listFiles({ root, git });
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
/** Model-weight file types that must never be committed (Laya / local models). */
const MODEL_WEIGHT_EXTS = ['safetensors', 'gguf', 'pt', 'pth', 'ckpt', 'onnx', 'h5'];

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
    put(fixture, 'data/luck.sqlite-wal', 'wal');
    put(fixture, 'data/other.sqlite3-journal', 'journal');
    for (const ext of MODEL_WEIGHT_EXTS) put(fixture, `models/weights.${ext}`, 'not really weights');
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
    expect(byFile('data/luck.sqlite-wal')).toEqual(['forbidden-file:sqlite-database']);
    expect(byFile('data/other.sqlite3-journal')).toEqual(['forbidden-file:sqlite-database']);
    for (const ext of MODEL_WEIGHT_EXTS) expect(byFile(`models/weights.${ext}`), ext).toEqual(['forbidden-file:model-weights']);

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

  it('a missing or non-folder --root exits 2 (not mistaken for "git is not installed")', () => {
    const missing = runScanner(['--root', path.join(TMP_DIR, `no-such-dir-${randomUUID()}`)]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/cannot scan .*ENOENT/);
    expect(missing.stderr).not.toMatch(/git is not installed/);
    expect(runScanner(['--root', SCANNER]).status).toBe(2);
  });

  it('this repository is clean (git mode in a clone; walk mode with a notice in a ZIP download)', () => {
    const inGit = insideGitWorkTree(REPO_ROOT);
    const r = runScanner(['--json']);
    const report = JSON.parse(r.stdout || '{}') as Report;
    const summary = (report.findings ?? []).map((f) => `${f.file}:${f.line} [${f.rule}] ${f.preview}`).join('\n');
    expect(r.status, `secret-scan findings:\n${summary}\n${r.stderr}`).toBe(0);
    expect(report.mode).toBe(inGit ? 'git' : 'walk');
    if (!inGit) expect(r.stderr).toMatch(/secret-scan: notice/);
    expect(report.filesListed).toBeGreaterThan(20);
    // gitignored scratch output (this suite's own fixtures, SQLite test files) is not listed
    expect(report.findings.some((f) => f.file.startsWith('tmp/'))).toBe(false);
  });

  it.skipIf(!insideGitWorkTree(REPO_ROOT))('walk mode lists exactly the files git mode lists for this repository', async () => {
    const [viaGit, viaWalk] = [gitPublishableFiles(REPO_ROOT), await scannerListFiles(REPO_ROOT, false)];
    const walk = new Set(viaWalk);
    const git = new Set(viaGit);
    // Tracked-but-deleted files are listed by git only; they cannot be walked.
    const onlyGit = viaGit.filter((f) => !walk.has(f) && spawnSync('git', ['ls-files', '--error-unmatch', '--', f], { cwd: REPO_ROOT }).status !== 0);
    const onlyWalk = viaWalk.filter((f) => !git.has(f));
    expect({ onlyGit, onlyWalk }).toEqual({ onlyGit: [], onlyWalk: [] });
    expect(viaWalk).toContain('scripts/secret-scan.mjs');
    expect(viaWalk.some((f) => f.startsWith('tmp/') || f.startsWith('data/') || f.startsWith('node_modules/'))).toBe(false);
  });
});

describe('SECURITY: secret-scan.mjs walk mode honours .gitignore (as git does for untracked files)', () => {
  const root = path.join(TMP_DIR, `scan-gitignore-${randomUUID()}`);
  const put = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const leak = (seed: number) => `const k = "${j('sk-', 'ant-', 'api03-', pseudoRandom(seed, 95))}";\n`;

  beforeAll(() => {
    put(
      '.gitignore',
      [
        '# comment line',
        'data/',
        '*.db',
        '!keep.db',
        '/build',
        '.vscode/*',
        '!.vscode/extensions.json',
        'logs/**/debug.txt',
        '*.log',
        '\\#literal.txt',
        'trailing-space.txt   ',
        '',
      ].join('\n'),
    );
    put('sub/.gitignore', '!keep.log\nlocal-only/\n');
    // ignored → not listed, so their planted secrets are not reported
    put('data/notes.txt', leak(101));
    put('data/luck.db', 'SQLite format 3');
    put('other/app.db', 'SQLite format 3');
    put('build/out.js', leak(102));
    put('.vscode/settings.json', leak(103));
    put('logs/debug.txt', leak(104));
    put('logs/a/b/debug.txt', leak(105));
    put('server.log', leak(106));
    put('#literal.txt', leak(107));
    put('trailing-space.txt', leak(108));
    put('sub/other.log', leak(109));
    put('sub/local-only/x.ts', leak(110));
    // listed
    put('keep.db', 'SQLite format 3'); // re-included by "!keep.db" → forbidden file
    put('src/build/out.js', leak(111)); // "/build" is anchored to the root
    put('.vscode/extensions.json', '{"recommendations": []}\n');
    put('logs/info.txt', 'fine\n');
    put('sub/keep.log', leak(112)); // re-included by the nested .gitignore
    put('src/app.ts', 'export const ok = true;\n');
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists only what git would list', async () => {
    expect(await scannerListFiles(root, false)).toEqual(
      ['.gitignore', '.vscode/extensions.json', 'keep.db', 'logs/info.txt', 'src/app.ts', 'src/build/out.js', 'sub/.gitignore', 'sub/keep.log'].sort(),
    );
  });

  it('reports findings only in listed files', () => {
    const r = runScanner(['--root', root, '--no-git', '--json']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.findings.map((f) => `${f.file} ${f.rule}`).sort()).toEqual(
      ['keep.db forbidden-file:sqlite-database', 'src/build/out.js anthropic-api-key', 'sub/keep.log anthropic-api-key'].sort(),
    );
  });

  it.skipIf(!GIT_INSTALLED)('matches git itself on the same fixture (git ls-files in a throw-away repository)', async () => {
    const repo = path.join(TMP_DIR, `scan-gitcmp-${randomUUID()}`);
    try {
      mkdirSync(repo, { recursive: true });
      const init = spawnSync('git', ['init', '-q'], { cwd: repo, env: NO_REPO_ENV });
      expect(init.status).toBe(0);
      // same tree: copy the fixture files
      for (const rel of [
        '.gitignore', 'sub/.gitignore', 'data/notes.txt', 'data/luck.db', 'other/app.db', 'build/out.js', '.vscode/settings.json',
        'logs/debug.txt', 'logs/a/b/debug.txt', 'server.log', '#literal.txt', 'trailing-space.txt', 'sub/other.log',
        'sub/local-only/x.ts', 'keep.db', 'src/build/out.js', '.vscode/extensions.json', 'logs/info.txt', 'sub/keep.log', 'src/app.ts',
      ]) {
        const src = path.join(root, rel);
        const dst = path.join(repo, rel);
        mkdirSync(path.dirname(dst), { recursive: true });
        writeFileSync(dst, readFileSync(src));
      }
      expect(await scannerListFiles(repo, false)).toEqual(gitPublishableFiles(repo, NO_REPO_ENV));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('SECURITY: secret-scan.mjs outside a git repository (ZIP download) falls back to walk mode', () => {
  const clean = path.join(TMP_DIR, `scan-nogit-clean-${randomUUID()}`);
  const dirty = path.join(TMP_DIR, `scan-nogit-dirty-${randomUUID()}`);
  const emptyBin = path.join(TMP_DIR, `scan-nogit-bin-${randomUUID()}`);

  beforeAll(() => {
    for (const [rel, content] of [
      ['README.md', '# clean\n'],
      ['.gitignore', 'data/\n'],
      ['data/luck.db', 'SQLite format 3'], // ignored by .gitignore → not a finding
    ] as const) {
      mkdirSync(path.dirname(path.join(clean, rel)), { recursive: true });
      writeFileSync(path.join(clean, rel), content);
    }
    mkdirSync(path.join(dirty, 'src'), { recursive: true });
    writeFileSync(path.join(dirty, 'src', 'k.ts'), `const k = "${j('sk-', 'ant-', 'api03-', pseudoRandom(201, 95))}";\n`);
    mkdirSync(emptyBin, { recursive: true });
  });

  afterAll(() => {
    for (const d of [clean, dirty, emptyBin]) rmSync(d, { recursive: true, force: true });
  });

  it('not a git repository: prints a notice, scans the folder (honouring .gitignore) and exits 0 when clean', () => {
    expect(insideGitWorkTree(clean, NO_REPO_ENV)).toBe(false);
    const human = runScanner(['--root', clean], REPO_ROOT, NO_REPO_ENV);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stderr).toMatch(/secret-scan: notice — not a git repository .*--no-git mode/);
    expect(human.stdout).toMatch(/secret-scan: clean — 2 files scanned \(walk mode/);

    const json = runScanner(['--root', clean, '--json'], REPO_ROOT, NO_REPO_ENV);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout) as Report;
    expect(report.mode).toBe('walk');
    expect(report.fallbackReason).toBe('not a git repository');
    expect(report.findings).toEqual([]);
  });

  it('not a git repository: planted secrets are still found (exit 1)', () => {
    const r = runScanner(['--root', dirty, '--json'], REPO_ROOT, NO_REPO_ENV);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.mode).toBe('walk');
    expect(report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['src/k.ts anthropic-api-key']);
  });

  it('git not installed: falls back the same way instead of exiting 2', () => {
    const r = runScanner(['--root', clean, '--json'], REPO_ROOT, envWithoutGit(emptyBin));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/secret-scan: notice — git is not installed/);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.mode).toBe('walk');
    expect(report.fallbackReason).toBe('git is not installed');
  });

  it('inside a git work tree nothing changes: git mode, no notice', () => {
    if (!insideGitWorkTree(REPO_ROOT)) return; // ZIP download: covered by the tests above
    const r = runScanner(['--root', path.join(REPO_ROOT, 'scripts'), '--json']);
    expect(r.stderr).not.toMatch(/notice/);
    expect((JSON.parse(r.stdout) as Report).mode).toBe('git');
  });
});

describe('SECURITY: secret-scan.mjs inside an enclosing repository it does not belong to → walk mode, never a false "clean"', () => {
  const REASON_IGNORED = 'ignored by the enclosing git repository';
  const REASON_UNTRACKED = 'no file in this folder is tracked by the enclosing git repository';
  const REASON_NO_FILES = 'git lists no files in this folder';
  const leak = (seed: number) => `const k = "${j('sk-', 'ant-', 'api03-', pseudoRandom(seed, 95))}";\n`;
  const put = (root: string, rel: string, content: string) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: NO_REPO_ENV });
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  };
  // Under this repository's tmp/ (gitignored): like a ZIP unpacked into another project's ignored folder.
  const nestedInThisRepo = path.join(TMP_DIR, `scan-nested-ignored-${randomUUID()}`);
  // Throw-away enclosing repositories (git init; files are only `git add`-ed, no commit needed).
  const outer = path.join(TMP_DIR, `scan-outer-repo-${randomUUID()}`);
  const excludeAll = path.join(TMP_DIR, `scan-exclude-all-${randomUUID()}`);

  beforeAll(() => {
    put(nestedInThisRepo, 'src/k.ts', leak(301));
    put(nestedInThisRepo, 'README.md', '# unpacked fixture download\n');
  });

  afterAll(() => {
    for (const d of [nestedInThisRepo, outer, excludeAll]) rmSync(d, { recursive: true, force: true });
  });

  it('a folder inside an ignored path of the enclosing repository: planted secret found, notice printed (exit 1)', () => {
    const human = runScanner(['--root', nestedInThisRepo]);
    expect(human.status, human.stdout + human.stderr).toBe(1);
    expect(human.stdout).not.toMatch(/clean/);
    expect(human.stderr).toMatch(/secret-scan: notice — .*--no-git mode/);

    const r = runScanner(['--root', nestedInThisRepo, '--json']);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.mode).toBe('walk');
    expect(report.filesListed).toBe(2);
    expect(report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['src/k.ts anthropic-api-key']);
    // in a clone, tmp/ is ignored by this repository; in a ZIP download there is no repository at all
    expect(report.fallbackReason).toBe(insideGitWorkTree(nestedInThisRepo) ? REASON_IGNORED : 'not a git repository');
  });

  it.skipIf(!GIT_INSTALLED)('ignored folder, untracked folder and tracked folder of a throw-away enclosing repository', () => {
    put(outer, '.gitignore', 'ignored-dir/\n');
    put(outer, 'README.md', '# enclosing fixture repository\n');
    put(outer, 'ignored-dir/unpacked/src/k.ts', leak(302));
    put(outer, 'untracked-dir/src/k.ts', leak(303));
    put(outer, 'tracked-dir/a.ts', 'export const a = 1;\n');
    put(outer, 'tracked-dir/b.ts', leak(304)); // untracked but not ignored: git mode lists it
    git(outer, 'init', '-q');
    git(outer, 'add', '.gitignore', 'README.md', 'tracked-dir/a.ts');

    const scanJson = (rel: string) => {
      const r = runScanner(['--root', path.join(outer, rel), '--json'], REPO_ROOT, NO_REPO_ENV);
      return { status: r.status, stderr: r.stderr, report: JSON.parse(r.stdout) as Report };
    };

    const ignored = scanJson('ignored-dir/unpacked');
    expect(ignored.status).toBe(1);
    expect(ignored.report.mode).toBe('walk');
    expect(ignored.report.fallbackReason).toBe(REASON_IGNORED);
    expect(ignored.stderr).toMatch(/secret-scan: notice — ignored by the enclosing git repository/);
    expect(ignored.report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['src/k.ts anthropic-api-key']);

    const untracked = scanJson('untracked-dir');
    expect(untracked.status).toBe(1);
    expect(untracked.report.mode).toBe('walk');
    expect(untracked.report.fallbackReason).toBe(REASON_UNTRACKED);
    expect(untracked.report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['src/k.ts anthropic-api-key']);

    // a folder that belongs to the repository keeps using git's list, without a notice
    const tracked = scanJson('tracked-dir');
    expect(tracked.status).toBe(1);
    expect(tracked.report.mode).toBe('git');
    expect(tracked.report.fallbackReason).toBeUndefined();
    expect(tracked.stderr).not.toMatch(/notice/);
    expect(tracked.report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['b.ts anthropic-api-key']);

    // and so does the repository's top folder (the ignored folder's secret is not published, so not reported)
    const top = scanJson('.');
    expect(top.report.mode).toBe('git');
    expect(top.report.findings.map((f) => `${f.file} ${f.rule}`).sort()).toEqual(
      ['tracked-dir/b.ts anthropic-api-key', 'untracked-dir/src/k.ts anthropic-api-key'].sort(),
    );
  });

  it.skipIf(!GIT_INSTALLED)('git lists 0 files (everything excluded locally): walks the folder instead of printing "clean — 0 files"', () => {
    mkdirSync(excludeAll, { recursive: true });
    git(excludeAll, 'init', '-q');
    // .git/info/exclude is local to this clone; the folder's own files would still be published from a copy
    writeFileSync(path.join(excludeAll, '.git', 'info', 'exclude'), '*\n');
    put(excludeAll, 'src/k.ts', leak(305));

    const r = runScanner(['--root', excludeAll, '--json'], REPO_ROOT, NO_REPO_ENV);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/secret-scan: notice — git lists no files in this folder/);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.mode).toBe('walk');
    expect(report.fallbackReason).toBe(REASON_NO_FILES);
    expect(report.findings.map((f) => `${f.file} ${f.rule}`)).toEqual(['src/k.ts anthropic-api-key']);
  });
});

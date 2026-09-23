/**
 * SECURITY / REPOSITORY HYGIENE — files that must never be committed, and the design exports that must stay
 * byte-for-byte.
 *
 *  - .gitignore covers local data (SQLite files and their journals), credentials (keys, certificates, SSH keys,
 *    .npmrc), Python environments and model weights. Checked with the secret scanner's own .gitignore matcher
 *    (works in a ZIP download too) and, when git is available, with `git check-ignore --no-index`.
 *  - .gitattributes: the design-references rule comes AFTER "* text=auto" (the last matching line wins), so git
 *    never converts line endings in the Stitch exports; their sha256 equal the owner's original files.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT_OK = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout?.trim() === 'true';

interface GitignoreRule {
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
}
async function repoGitignore(): Promise<(rel: string, isDir?: boolean) => boolean> {
  const mod = (await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'secret-scan.mjs')).href)) as {
    parseGitignore: (text: string, o?: { ignoreCase?: boolean }) => GitignoreRule[];
  };
  const rules = mod.parseGitignore(readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8'), { ignoreCase: false });
  return (rel, isDir = false) => {
    // a path is ignored when it, or one of its parent folders, is ignored (git never re-includes below an ignored folder)
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      const dir = i < parts.length || isDir;
      let ignored = false;
      for (const r of rules) if ((!r.dirOnly || dir) && r.re.test(p)) ignored = !r.negate;
      if (ignored) return true;
    }
    return false;
  };
}

const MUST_BE_IGNORED = [
  // local data
  'data/luck.db',
  'luck.db',
  'luck.db-wal',
  'luck.db-shm',
  'luck.db-journal',
  'x.sqlite',
  'x.sqlite3',
  'x.sqlite-wal',
  'x.sqlite-shm',
  'x.sqlite-journal',
  'x.sqlite3-journal',
  'x.sqlite3-wal',
  'tmp/cli-sandbox/CLAUDE.md',
  // secrets
  '.env',
  '.env.local',
  'cert.pem',
  'server.key',
  'cert.p12',
  'cert.pfx',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  '.ssh/id_ecdsa',
  '.npmrc',
  'credentials.json',
  'client_secret_123.json',
  // Python environments and model weights (optional Laya)
  '.venv-laya/pyvenv.cfg',
  'venv/pyvenv.cfg',
  'model.safetensors',
  'model.gguf',
  'model.onnx',
  'model.bin',
  'model.pt',
  'model.pth',
  'model.ckpt',
  'model.h5',
];
const MUST_NOT_BE_IGNORED = [
  '.env.example',
  'src/web/main.tsx',
  'src/server/db/sqlite.ts',
  'scripts/secret-scan.mjs',
  'design-references/stitch_ai_roulette_lab/code.html',
  '.vscode/extensions.json',
  'docs/configuration.md',
];

describe('REPO HYGIENE: .gitignore', () => {
  it('ignores local data, credentials, Python environments and model weights (scanner matcher)', async () => {
    const ignored = await repoGitignore();
    expect(MUST_BE_IGNORED.filter((p) => !ignored(p))).toEqual([]);
    expect(MUST_NOT_BE_IGNORED.filter((p) => ignored(p))).toEqual([]);
  });

  it.skipIf(!GIT_OK)('git agrees (git check-ignore --no-index)', () => {
    const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPO_ROOT, encoding: 'utf8', input: [...MUST_BE_IGNORED, ...MUST_NOT_BE_IGNORED].join('\n') + '\n' });
    const reported = new Set(r.stdout.split(/\r?\n/).filter(Boolean));
    expect(MUST_BE_IGNORED.filter((p) => !reported.has(p))).toEqual([]);
    expect(MUST_NOT_BE_IGNORED.filter((p) => reported.has(p))).toEqual([]);
  });
});

describe('REPO HYGIENE: design-references stay byte-for-byte', () => {
  const DIR = 'design-references/stitch_ai_roulette_lab';
  /** sha256 of the owner's original Stitch export (H:\LUCKY\stitch_ai_roulette_lab), recorded 2026-09-23. */
  const ORIGINAL_SHA256: Record<string, string> = {
    'code.html': '43c9d2f74dc6cd35c9ec359379737f192b86f9d0c0fd63d8379549d9ff2e86b0',
    'DESIGN.md': '7642fba5c6ba06e1adb411a504e97f707871af64e54475ef93e2d63884ce2c92',
    'screen.png': 'b2569bf372be24164328123414798c532cb81be4f5c0a3e512b1015e50ca5c9f',
  };

  it('the files equal the original export (sha256)', () => {
    for (const [name, sha] of Object.entries(ORIGINAL_SHA256)) {
      const actual = createHash('sha256').update(readFileSync(path.join(REPO_ROOT, DIR, name))).digest('hex');
      expect(actual, name).toBe(sha);
    }
  });

  it('.gitattributes: the design-references rule comes after "* text=auto" (last matching line wins)', () => {
    const lines = readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    const textAuto = lines.findIndex((l) => /^\*\s+text=auto\b/.test(l));
    const design = lines.findIndex((l) => /^design-references\/\*\*\s/.test(l) && /(^|\s)-text(\s|$)/.test(l));
    expect(textAuto).toBeGreaterThanOrEqual(0);
    expect(design).toBeGreaterThan(textAuto);
  });

  it.skipIf(!GIT_OK)('git check-attr: no text conversion for any design-references file', () => {
    for (const name of Object.keys(ORIGINAL_SHA256)) {
      const r = spawnSync('git', ['check-attr', 'text', '--', `${DIR}/${name}`], { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(r.stdout.trim(), name).toBe(`${DIR}/${name}: text: unset`);
    }
  });
});

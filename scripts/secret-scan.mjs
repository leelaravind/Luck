#!/usr/bin/env node
/**
 * secret-scan.mjs — zero-dependency pre-commit secret scanner for this repository.
 *
 * Scans every file git would publish: tracked files plus untracked files that are NOT ignored
 * (`git ls-files --cached --others --exclude-standard`). Flags
 *   - high-confidence credential patterns (Anthropic, OpenAI-style "sk-", GitHub, AWS, Slack, PEM private
 *     keys, and generic `api_key = '<long random>'` assignments), and
 *   - files that must never be committed (.env, SQLite databases, *.pem / *.key, client_secret*.json …).
 *
 * Usage:
 *   node scripts/secret-scan.mjs [--root <dir>] [--no-git] [--json]
 *     --root <dir>  directory to scan (default: current working directory)
 *     --no-git      walk the directory instead of asking git (used by the scanner's own tests)
 *     --json        machine-readable report on stdout
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error (e.g. git unavailable).
 *
 * Allow-list: the documented test fake `sk-ant-test-SECRET123`, obvious placeholders (xxxx, <...>, your-key,
 * changeme, …), generic `NAME=value` assignments in `.env.example` (vendor-shaped keys there ARE still flagged),
 * lines carrying the marker `secret-scan:allow`, and hand-written test values (see looksHandWritten():
 * a test/fixture/mock marker word, a words-only key body, a 6+ character sequence such as "123456"/"abcdef",
 * or a prefix followed by "…"). Real provider keys are long uniform random strings and match none of these.
 * Matched values are REDACTED in the output — the scanner never prints a full secret.
 * Limitations: binary files (NUL byte in the first 8 KiB) and files > 2 MiB are not content-scanned
 * (their NAMES are still checked); secrets split across lines or encoded are not detected.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ───────────────────────────── configuration ─────────────────────────────

/** Exact values that look like secrets but are known, harmless test fixtures. */
const ALLOWED_VALUES = new Set(['sk-ant-test-SECRET123']);

/** Inline suppression marker (put it in a comment on the same line). */
const ALLOW_MARKER = 'secret-scan:allow';

const MAX_BYTES = 2 * 1024 * 1024;

/** Placeholder-looking values are never findings. */
const PLACEHOLDER =
  /(x{4,}|\*{3,}|\.{3}|…|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|your[-_ ]?(api[-_ ]?)?(key|token|secret)|example|placeholder|change[-_]?me|replace[-_]?me|dummy|redacted|not[-_]?a[-_]?real|fake|sample)/i;

/**
 * Content rules. `validate` (optional) receives the matched value and returns false to drop low-confidence hits.
 * `group` selects the capture group holding the secret value (default: whole match).
 */
const RULES = [
  { id: 'anthropic-api-key', re: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  {
    // OpenAI-style keys: "sk-" + 20 or more key characters (not the Anthropic prefix handled above).
    id: 'openai-style-key',
    re: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    validate: (v) => /[0-9]/.test(v) && /[A-Za-z]/.test(v.slice(3)) && !/^sk-[a-z-]+$/.test(v),
  },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: 'github-fine-grained-pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    // api_key = '<long random>' / "clientSecret": "<long random>" / token: `...`
    id: 'generic-secret-assignment',
    re: /\b[A-Za-z0-9_]*?(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|private[_-]?key|auth[_-]?key)\b["']?\s*[:=]\s*(["'`])([^"'`\s]{20,})\1/gi,
    group: 2,
    validate: (v) => looksRandom(v),
  },
  {
    // .env style, unquoted: SOME_API_KEY=<long random>
    id: 'generic-env-assignment',
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY)[A-Z0-9_]*\s*=\s*([^\s#'"`]{20,})/gm,
    group: 1,
    validate: (v) => looksRandom(v),
  },
];

/** Files that must never be committed, whatever their content. */
const FORBIDDEN_FILES = [
  { id: 'dotenv-file', test: (b) => (b === '.env' || b.startsWith('.env.')) && !/^\.env\.(example|sample|template)$/.test(b) },
  { id: 'sqlite-database', test: (b) => /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/.test(b) },
  { id: 'pem-or-key-file', test: (b) => /\.(pem|key|p12|pfx)$/.test(b) },
  { id: 'ssh-private-key', test: (b) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(b) },
  { id: 'google-client-secret', test: (b) => /^client_secret.*\.json$/.test(b) },
  { id: 'credentials-json', test: (b) => /^credentials.*\.json$/.test(b) },
];

// ───────────────────────────── helpers ─────────────────────────────

/** Shannon entropy (bits per character). */
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Heuristic for "long random" values: high entropy and at least two character classes, not a path/URL/word. */
function looksRandom(v) {
  if (v.length < 20) return false;
  if (/^(https?:|\/|\.\/|\.\.\/|[A-Za-z]:\\)/.test(v)) return false; // URLs and paths
  if (/^[a-z]+([-_.][a-z]+)*$/i.test(v)) return false; // plain words / identifiers-with-separators
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  return classes >= 2 && entropy(v) >= 3.5;
}

function isPlaceholder(v) {
  return PLACEHOLDER.test(v);
}

/** Vendor prefixes stripped before judging the "body" of a key. */
const KEY_PREFIX = /^(sk-ant-(?:api|admin|oat)?\d*-?|sk-(?:proj-|svcacct-|admin-)?|gh[pousr]_|github_pat_|xox[baprs]-)/;

/** Longest run of consecutive ascending characters ("abcdef", "123456") or of one repeated character. */
function longestPatternRun(s) {
  let best = 1;
  let asc = 1;
  let rep = 1;
  for (let i = 1; i < s.length; i++) {
    const a = s.charCodeAt(i - 1);
    const b = s.charCodeAt(i);
    const sameClass = /[0-9]/.test(s[i - 1]) === /[0-9]/.test(s[i]) && /[a-z]/i.test(s[i - 1]) === /[a-z]/i.test(s[i]);
    asc = sameClass && (b | 32) === (a | 32) + 1 && /[a-z0-9]/i.test(s[i]) ? asc + 1 : 1;
    rep = b === a ? rep + 1 : 1;
    best = Math.max(best, asc, rep);
  }
  return best;
}

/**
 * Obvious hand-written test values (not real credentials). Deliberately narrow:
 *  - the value carries a test marker word (test, fixture, mock, stub, dummy …),
 *  - the key body is only lowercase words and separators ("should-never-be-here"),
 *  - the value contains a keyboard/sequence run of 6+ ("123456", "abcdef") or one character 6+ times,
 *  - it is immediately followed by an ellipsis in prose ("sk-ant-api03-…").
 * Real provider keys are long uniformly random strings, which none of these match (see the scanner's tests).
 */
export function looksHandWritten(v, after = '') {
  if (/(test|fixture|mock|stub|bogus|invalid|leaked|should[-_]?not|never)/i.test(v)) return true;
  const body = v.replace(KEY_PREFIX, '');
  if (body.length === 0 || /^[a-z]+([-_][a-z]+)*-?$/.test(body)) return true;
  if (longestPatternRun(v) >= 6) return true;
  if (/^(…|\.\.\.|\*|<)/.test(after)) return true;
  return false;
}

/** Never print a full secret: keep a short prefix and the length. */
export function redact(v) {
  const keep = Math.min(6, Math.max(2, Math.floor(v.length / 5)));
  return `${v.slice(0, keep)}…(${v.length} chars)`;
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), git: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = path.resolve(argv[++i] ?? '.');
    else if (a === '--no-git') opts.git = false;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

/** Files git would publish: tracked + untracked-not-ignored. Paths relative to root, forward slashes. */
function listGitFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

/** Plain directory walk (no git). Skips .git and node_modules. */
function walkFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile()) files.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return files.sort();
}

/** Scan one file's text; returns findings (without file). Exported for reuse. */
export function scanText(text, relPath) {
  const base = path.posix.basename(relPath);
  const isEnvExample = /^\.env\.(example|sample|template)$/.test(base);
  const findings = [];
  const lines = text.split(/\r?\n/);
  // Pre-compute line starts for (line, column) of multi-line regex matches.
  const starts = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const locate = (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
  const normalized = lines.join('\n');

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of normalized.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (!value) continue;
      const offset = rule.group ? m.index + m[0].lastIndexOf(value) : m.index;
      const { line, column } = locate(offset);
      const lineText = lines[line - 1] ?? '';
      if (lineText.includes(ALLOW_MARKER)) continue;
      if (ALLOWED_VALUES.has(value)) continue;
      if (isPlaceholder(value)) continue;
      if (looksHandWritten(value, normalized.slice(offset + value.length, offset + value.length + 3))) continue;
      if (isEnvExample && rule.id.startsWith('generic-')) continue; // .env.example documents names only
      if (rule.validate && !rule.validate(value)) continue;
      findings.push({ line, column, rule: rule.id, preview: redact(value) });
    }
  }
  return findings;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scan({ root, git }) {
  const files = git ? listGitFiles(root) : walkFiles(root);
  const findings = [];
  const skipped = [];
  let scanned = 0;
  for (const rel of files) {
    const base = path.posix.basename(rel).toLowerCase();
    for (const f of FORBIDDEN_FILES) {
      if (f.test(base)) findings.push({ file: rel, line: 0, column: 0, rule: `forbidden-file:${f.id}`, preview: base });
    }
    const abs = path.join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) {
      skipped.push({ file: rel, reason: 'larger than 2 MiB' });
      continue;
    }
    const buf = readFileSync(abs);
    if (isBinary(buf)) {
      skipped.push({ file: rel, reason: 'binary' });
      continue;
    }
    scanned++;
    for (const f of scanText(buf.toString('utf8'), rel)) findings.push({ file: rel, ...f });
  }
  return { root, mode: git ? 'git' : 'walk', filesListed: files.length, filesScanned: scanned, skipped, findings };
}

// ───────────────────────────── CLI ─────────────────────────────

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`secret-scan: ${e.message}`);
    return 2;
  }
  if (opts.help) {
    console.log('Usage: node scripts/secret-scan.mjs [--root <dir>] [--no-git] [--json]');
    return 0;
  }
  let report;
  try {
    report = scan(opts);
  } catch (e) {
    console.error(`secret-scan: could not list files (${e.message.split('\n')[0]})`);
    return 2;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (report.findings.length === 0) {
    console.log(`secret-scan: clean — ${report.filesScanned} files scanned (${report.mode} mode, ${report.skipped.length} binary/large skipped).`);
  } else {
    console.error(`secret-scan: ${report.findings.length} finding(s):`);
    for (const f of report.findings) {
      const where = f.line ? `${f.file}:${f.line}:${f.column}` : f.file;
      console.error(`  ${where}  [${f.rule}]  ${f.preview}`);
    }
    console.error('Remove the secret/file (and rotate any real credential) before committing.');
  }
  return report.findings.length ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) process.exitCode = main();

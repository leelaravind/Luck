/**
 * REPOSITORY HYGIENE — the supported Node.js range is the same everywhere.
 *
 * package.json "engines", the root entry of package-lock.json, and the version checks in scripts/start.sh and
 * scripts/start.ps1 must all accept exactly ^22.22.2 || ^24.15.0 || >=26.0.0. That is also the range of the test
 * tools (jsdom declares it), so the short-lived odd releases 23.x and 25.x are refused (final audit: the old range
 * ">=24.15.0" and the start scripts' "any major above 24" admitted Node 25, which the test toolchain does not support).
 *
 * The start scripts' checks are EXECUTED with fake version strings: the start.sh check is the JavaScript snippet
 * it passes to `node -e`, run with a stub `process`; the start.ps1 check runs in Windows PowerShell / pwsh when one
 * is installed (GitHub's Windows, Ubuntu and macOS runners have one).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';
const ACCEPTED = ['22.22.2', '22.22.10', '22.23.2', '22.30.0', '24.15.0', '24.15.1', '24.22.0', '26.0.0', '26.4.1', '27.0.0', '30.2.1'];
const REFUSED = ['18.20.8', '20.19.0', '22.13.0', '22.21.9', '22.22.1', '23.0.0', '23.11.1', '24.0.0', '24.14.9', '25.0.0', '25.9.9'];

/** PowerShell executable, if one is installed. */
const POWERSHELL = ['pwsh', 'powershell'].find((exe) => spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 }).status === 0);

describe('REPO HYGIENE: supported Node.js releases (engines, lock file, start scripts)', () => {
  it('package.json "engines" and the package-lock.json root entry', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, { engines?: { node?: string } }> };
    expect(pkg.engines?.node).toBe(ENGINES);
    expect(lock.packages['']?.engines?.node).toBe(ENGINES);
    // the reason for the range: the test tools declare the same one
    const jsdom = lock.packages['node_modules/jsdom']?.engines?.node;
    if (jsdom !== undefined) expect(jsdom).toBe(ENGINES);
  });

  it('scripts/start.sh: its check accepts exactly the supported releases', () => {
    const src = read('scripts/start.sh');
    expect(src).toContain(`"engines": ${ENGINES}`);
    const snippet = /if ! node -e '\n([\s\S]*?)\n'; then/.exec(src)?.[1];
    expect(snippet, 'the node -e version check in start.sh').toBeTruthy();
    const accepts = (version: string): boolean => {
      let code: number | undefined;
      const fakeProcess = { versions: { node: version }, exit: (c: number) => void (code = c) };
      // the script's own check, run on a fake version
      new Function('process', snippet!)(fakeProcess);
      expect(code === 0 || code === 1, `exit code for ${version}`).toBe(true);
      return code === 0;
    };
    for (const v of ACCEPTED) expect(accepts(v), v).toBe(true);
    for (const v of REFUSED) expect(accepts(v), v).toBe(false);
  });

  it.skipIf(!POWERSHELL)('scripts/start.ps1: its check accepts exactly the supported releases (run in PowerShell)', () => {
    const src = read('scripts/start.ps1');
    expect(src).toContain(`"engines": ${ENGINES}`);
    const lines = src.split(/\r?\n/);
    const minimums = lines.filter((l) => /^\$MinNode\d+ = \[version\]'[\d.]+'$/.test(l));
    const check = lines.find((l) => l.startsWith('$nodeSupported = '));
    expect(minimums.length).toBe(3);
    expect(check, 'the $nodeSupported line in start.ps1').toBeTruthy();
    const all = [...ACCEPTED, ...REFUSED];
    const script = [
      "$ErrorActionPreference = 'Stop'",
      ...minimums,
      `foreach ($v in @(${all.map((v) => `'${v}'`).join(', ')})) {`,
      '  $nodeVersion = [version]$v',
      `  ${check!}`,
      '  Write-Output "$v=$nodeSupported"',
      '}',
    ].join('\n');
    const r = spawnSync(POWERSHELL!, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    const result = new Map(
      r.stdout
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => {
          const [v, ok] = l.trim().split('=');
          return [v, ok] as const;
        }),
    );
    for (const v of ACCEPTED) expect(result.get(v), v).toBe('True');
    for (const v of REFUSED) expect(result.get(v), v).toBe('False');
  }, 60_000);

  it('README and troubleshooting state the same range', () => {
    const readme = read('README.md');
    const troubleshooting = read('docs/troubleshooting.md');
    expect(troubleshooting).toContain(`\`${ENGINES}\``);
    for (const doc of [readme, troubleshooting]) {
      expect(doc).toMatch(/22\.22\.2/);
      expect(doc).toMatch(/24\.15/);
      expect(doc).toMatch(/\b26\b/);
      expect(doc).toMatch(/23\.x.*25\.x|25\.x.*23\.x/s);
    }
  });
});
